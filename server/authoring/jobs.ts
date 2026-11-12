/**
 * 职责：出题队列：冻结步骤设置、当前有效Skill与题目冻结来源附件（脱敏或提取原文），执行出题并保存结果。
 * 关键方法与用途：`enqueueAuthoring()` 创建冻结输入任务；`runNextAuthoring()` 消费任务并提交当前版本结果。
 * 使用场景：`app.ts` 负责用户派发，`worker.ts` 负责后台消费和结果提交；新输入不向 Codex 暴露原始附件路径。
 */
import {resolveProjectPath} from '../paths';
import {emitProjectLifecycle as emitLifecycle} from '../lifecycle';
import {startAttemptHeartbeat} from '../attempt-heartbeat';
import {assertWorkflowNotArchived} from '../workflow-archive-guard';
import {localQueueEnabled,supersedeForeignPending,releaseRolledBackRegistrations,forgetLocalRegistrations,registerLocalJob,localClaimSql,localWaitingSql,deferLocalPublication,cachedExternalCall,resumeStepFailure,readStepFailure,saveStepFailure,RecordedStepFailure} from '../execution-queue/runtime';
import {frozenRevisionAdvice,validFrozenAdvice,assertRepairStepAllowed,type FrozenAdvice} from '../revision-advice/jobs';
import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {runExternalCall} from '../external-call';
import {isRegisteredAgentProvider,resolveAgentDriver,runAgent} from '../agent';
import {DEFAULT_AUTHORING_SETTINGS} from '../system-step-prompts';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import {mergeCodexDefaults,readProjectAgentDefaults} from '../agent/config';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {validateStepConfigForExecution} from '../project-folders';
import {validateWebAgentSettings,type WebAgentSettings} from '../../shared/web-agent';
import {webAuthoringExecutor} from '../web-executors/authoring';
import {readRuleFile,readProjectPrompt,resolveEffectiveProjectSkill,scanProjectPrompt,verifyRuleSnapshot,type ProjectPromptSnapshot} from '../rule-files';
import {freezeStageHooks,recoverInterruptedStageHooks,executeWithStageHooks,prepareCommittedStageHooks,runCommittedStageHooks,StageHookError,type FrozenStageHooks} from '../lifecycle/scripts';
import {canonicalJson,validateWorkflowConfig,type ScoringPolicy} from '../../shared/workflow-config';
import {hookAdditionText} from '../workflow-hooks';
import {AUTHORING_FIXED_PROMPT,DEFAULT_STEP_PROMPTS} from '../../shared/step-prompts';
import type {QuestionMaterialOrigin} from '../../shared/material-library';
import {readQuestionMaterials,type QuestionMaterials} from '../question-materials';
import {syncWorkflowMaterialScope} from '../material-library/preparation';
import type {AuthoringBatchContext,MaterialScopeSelection,MaterialScopeContext} from '../../shared/material-preparation-result';
import {renderPublicQuestionPackage,runAuthoring,FRESH_AUTHORING_CONTRACT,type AuthoringResult,type AuthoringRule} from './executor';
import {readAnswerToolPolicyFromStepConfig,type AnswerToolPolicy} from '../answer-models/tool-policy';

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const stableDesignContext=(context:NonNullable<FrozenInput['design_context']>)=>({...('scenario'in context?{scenario:context.scenario}:{}),...('role_perspective'in context?{role_perspective:context.role_perspective}:{}),...('target_level'in context?{target_level:context.target_level}:{}),...('question_tags'in context?{question_tags:context.question_tags}:{})});
const workflowSql="SELECT w.*,p.name AS project_name,p.local_skill_path,p.material_root,p.workspace_path,p.parent_name,p.material_backend,EXISTS(SELECT 1 FROM ai_distill.question_library_sources qls WHERE qls.workflow_id=w.id) AS has_library_snapshot,s1.status AS ingestion_status,s9.status AS redaction_status\n FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL\n LEFT JOIN ai_distill.steps s1 ON s1.workflow_id=w.id AND s1.ordinal=1 LEFT JOIN ai_distill.steps s9 ON s9.workflow_id=w.id AND s9.ordinal=9\n WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w";
interface FrozenInput {revision_advice?:FrozenAdvice;content_contract?:'work_legal_v1';hooks?:FrozenStageHooks;scoring_policy?:ScoringPolicy;system_authoring_prompt?:string;project_name?:string;answer_capabilities?:AnswerToolPolicy;authoring_contract?:string;title:string;authoring_direction?:string;material_scope?:MaterialScopeContext;batch_context?:AuthoringBatchContext;design_context?:{scenario?:string;role_perspective?:string;target_level?:string;question_tags?:string[]};question_id?:string;source_files?:{name:string;path:string}[];project_prompt?:ProjectPromptSnapshot;rule_version_id?:string;rule_attempt_id?:string;rule_source_digest?:string;rule_snapshot_path?:string;rule_files?:{path:string;sha256:string;size_bytes:number}[];redaction_attempt_id?:string;material_origin?:QuestionMaterialOrigin;materials:{id:string;sha256:string}[];model_materials?:{id:string;sha256:string}[];digest:string}
const materialIdentity=(input:Pick<FrozenInput,'redaction_attempt_id'|'material_origin'>)=>input.material_origin?.kind==='library_v1'?{material_origin:{kind:input.material_origin.kind,material_mode:input.material_origin.material_mode,...(input.material_origin.material_processing_mode?{material_processing_mode:input.material_origin.material_processing_mode}:{}),package_id:input.material_origin.package_id,revision_id:input.material_origin.revision_id,redaction_id:input.material_origin.redaction_id,snapshot_digest:input.material_origin.snapshot_digest}}:{redaction_attempt_id:input.material_origin?.kind==='legacy'?input.material_origin.redaction_attempt_id:input.redaction_attempt_id};
const designContext=(workflow:any)=>{const context={...(workflow.scenario?{scenario:String(workflow.scenario)}:{}),...(workflow.role_perspective?{role_perspective:String(workflow.role_perspective)}:{}),...(workflow.target_level?{target_level:String(workflow.target_level)}:{}),...(Array.isArray(workflow.question_tags)&&workflow.question_tags.length?{question_tags:workflow.question_tags.map(String)}:{})};return Object.keys(context).length?context:undefined;};
const sourceFiles=(workflow:any):{name:string;path:string}[]=>Array.isArray(workflow.source_manifest)?workflow.source_manifest.filter((file:any)=>typeof file?.name==='string'&&typeof file?.path==='string').map((file:any)=>({name:file.name,path:file.path})):[];
const questionId=(workflow:any)=>typeof workflow.source_key==='string'&&workflow.source_key.trim()?workflow.source_key:workflow.title;

/**
 * 历史冻结摘要不变量：JSON.stringify 使用对象属性插入顺序参与 SHA-256。
 * prefix -> 规则来源分支(rule_version_id 或 project_prompt) -> suffix 的字段顺序与省略条件严禁重排、合并或字母序排序。
 */
const inputDigestPrefix=(input:Omit<FrozenInput,'digest'>)=>({
 ...(input.revision_advice?{revision_advice:JSON.parse(canonicalJson(input.revision_advice))}:{}),
 ...(input.content_contract?{content_contract:input.content_contract}:{}),
 ...(input.system_authoring_prompt?{system_authoring_prompt:input.system_authoring_prompt}:{}),
 ...(input.project_name!==undefined?{project_name:input.project_name}:{}),
 ...(input.answer_capabilities?{answer_capabilities:input.answer_capabilities}:{}),
 title:input.title,
 ...(input.design_context?{design_context:stableDesignContext(input.design_context)}:{}),
 ...(input.authoring_direction?{authoring_direction:input.authoring_direction}:{}),
 ...(input.question_id?{question_id:input.question_id}:{}),
 ...(input.source_files?{source_files:input.source_files}:{}),
});
const inputDigestSuffix=(input:Omit<FrozenInput,'digest'>)=>({
 ...materialIdentity(input),
 materials:input.materials.map(item=>({id:item.id,sha256:item.sha256})),
 ...(input.model_materials?{model_materials:input.model_materials.map(item=>({id:item.id,sha256:item.sha256}))}:{}),
 ...(input.material_scope?{material_scope:JSON.parse(canonicalJson(input.material_scope))}:{}),
 ...(input.batch_context?{batch_context:JSON.parse(canonicalJson({...input.batch_context,captured_at:undefined}))}:{}),
 ...(input.authoring_contract?{authoring_contract:input.authoring_contract}:{}),
 ...(input.scoring_policy?{scoring_policy:JSON.parse(canonicalJson(input.scoring_policy))}:{}),
 ...(input.hooks?{hooks:JSON.parse(canonicalJson(input.hooks))}:{}),
});
export const inputDigest = (input: Omit<FrozenInput, 'digest'>) => hash(JSON.stringify(input.rule_version_id ? {
    ...inputDigestPrefix(input),
    rule_version_id: input.rule_version_id,
    rule_attempt_id: input.rule_attempt_id,
    rule_source_digest: input.rule_source_digest,
    rule_snapshot_path: input.rule_snapshot_path,
    rule_files: (input.rule_files ?? []).map(file => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes })),
    ...inputDigestSuffix(input),
} : {
    ...inputDigestPrefix(input),
    project_prompt: input.project_prompt ? { workspace_path: input.project_prompt.workspace_path, skill_path: input.project_prompt.skill_path, source_digest: input.project_prompt.source_digest, files: input.project_prompt.files.map(file => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes })) } : null,
    ...inputDigestSuffix(input),
}));

async function basePrerequisites(db:PoolClient,id:string){
 const workflow=(await db.query(workflowSql,[id])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
 if(workflow.workflow_kind==='material_package')throw new HTTPException(409,{message:'材料包只执行入库和脱敏，请先创建题目'});
 if(workflow.material_backend==='library_v1'||workflow.has_library_snapshot){
  const source=await readQuestionMaterials(db,id);
  if(source.origin.kind!=='library_v1')throw new HTTPException(409,{message:'共享材料题目来源类型无效'});
  if(source.model_attachments&&!source.model_attachments.length)throw new HTTPException(409,{message:'材料整理结果中没有可供模型读取的文书正文'});
  return{workflow,redaction:null,origin:source.origin,loaded_materials:source,material_scope:source.material_scope,materials:source.attachments.map(({id,sha256})=>({id,sha256})),...(source.model_attachments?{model_materials:source.model_attachments.map(({id,sha256})=>({id,sha256}))}:{}),source_files:sourceFiles(workflow)};
 }
 if(workflow.ingestion_status!=='succeeded'||workflow.redaction_status!=='succeeded')throw new HTTPException(409,{message:'请先完成当前附件入库与脱敏'});
 const redaction=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[id])).rows[0];
 if(!redaction)throw new HTTPException(409,{message:'当前题目没有成功的脱敏记录'});
 const artifacts=await db.query("SELECT ar.id,ar.sha256 FROM ai_distill.artifacts ar WHERE ar.workflow_id=$1 AND ar.attempt_id=$2 AND ar.kind='redacted_markdown' ORDER BY ar.created_at,ar.id",[id,redaction.id]);
 if(!artifacts.rowCount||artifacts.rows.some(row=>typeof row.sha256!=='string'||! /^[a-f0-9]{64}$/.test(row.sha256)))throw new HTTPException(409,{message:'当前版本没有可用于出题的脱敏文本'});
 return {workflow,redaction,origin:{kind:'legacy',redaction_attempt_id:String(redaction.id)} as QuestionMaterialOrigin,materials:artifacts.rows as {id:string;sha256:string}[]};
}
async function prerequisites(db:PoolClient,id:string){
 const source=await basePrerequisites(db,id),workflow=source.workflow;
 const skill=await resolveEffectiveProjectSkill(workflow);
 const project_prompt=await scanProjectPrompt(workflow.workspace_path??dirname(workflow.material_root??skill.path),skill.path);
 return{...source,skill_path:skill.path,project_prompt};
}
async function legacyRules(db:PoolClient,id:string,workflow:any){
 const rules=(await db.query("SELECT id,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=3 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[id])).rows[0];
 if(!rules||rules.result?.rule_version_id!==workflow.rule_version_id||typeof rules.result?.source_digest!=='string'||!Array.isArray(rules.result?.files)||!rules.result?.snapshot_path)throw new HTTPException(409,{message:'旧任务绑定的规则快照不完整'});
 return rules;
}

const scopeKey=(direction:string,scene:string)=>canonicalJson([direction.normalize('NFKC').trim().toLocaleLowerCase(),scene.normalize('NFKC').trim().toLocaleLowerCase()]);
export async function saveMaterialScopeSelection(db:PoolClient,projectId:string,workflowId:string,attemptId:string,selection:any){
 const exists=(await db.query("SELECT to_regclass('ai_distill.question_material_scope_uses') IS NOT NULL AS available")).rows[0]?.available===true;
 if(!exists)return;
 if(!selection||typeof selection!=='object')return;
 await db.query("SELECT pg_advisory_xact_lock(hashtext('material-scope:'||$1))",[projectId]);
 await db.query('DELETE FROM ai_distill.question_material_scope_uses WHERE workflow_id=$1',[workflowId]);
 const choices=[selection,...(Array.isArray(selection.additional_combinations)?selection.additional_combinations:[])];
 for(const choice of choices){
  if(typeof choice?.direction!=='string'||!choice.direction.trim()||!Array.isArray(choice.scenes))continue;
  const unique=new Map<string,string>();for(const scene of choice.scenes)if(typeof scene==='string'&&scene.trim())unique.set(scopeKey(choice.direction,scene),scene.trim());
  for(const [key,scene] of unique)await db.query(`INSERT INTO ai_distill.question_material_scope_uses(project_id,workflow_id,attempt_id,direction,scene,scope_key)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,scope_key) DO NOTHING`,[projectId,workflowId,attemptId,choice.direction.trim(),scene,hash(key)]);
 }
}
/** 只读取当前步骤成功投影，历史重出结果不混入；白名单字段限制参考内容。 */
export async function freezeAuthoringBatch(db:PoolClient,projectId:string,workflowId:string):Promise<AuthoringBatchContext>{
 const rows=(await db.query(`SELECT s.result->'material_scope_selection' AS selection
 FROM ai_distill.steps s JOIN ai_distill.workflows w ON w.id=s.workflow_id
 WHERE w.project_id=$1 AND w.id<>$2 AND w.deleted_at IS NULL
 AND s.ordinal=4 AND s.status='succeeded' ORDER BY w.id`,[projectId,workflowId])).rows;
 const clean=(value:any):MaterialScopeSelection|undefined=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const str=(v:unknown)=>typeof v==='string'?v.trim():'';
  const list=(v:unknown)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string').map(x=>x.trim()).filter(Boolean):[];
  const item:MaterialScopeSelection={direction:str(value.direction),party:str(value.party),scenes:list(value.scenes),deliverables:list(value.deliverables)};
  for(const key of ['business_goal','core_work','deliverable_use'] as const)if(str(value[key]))item[key]=str(value[key]);
  if(!item.direction&&!item.party&&!item.scenes.length&&!item.deliverables.length&&!item.core_work&&!item.business_goal&&!item.deliverable_use)return;
  return item;
 };
 const selections:MaterialScopeSelection[]=[];let missing=0;
 for(const row of rows){const item=clean(row.selection);if(!item){missing++;continue;}
  const extra=Array.isArray(row.selection.additional_combinations)?row.selection.additional_combinations.map(clean).filter(Boolean):[];
  if(extra.length)item.additional_combinations=extra;selections.push(item);
 }
 return{captured_at:new Date().toISOString(),total:rows.length,included:selections.length,missing,truncated:false,selections};
}
function freezeMaterialScope(prepared:any,batch:AuthoringBatchContext):MaterialScopeContext|undefined{
 if(!prepared||prepared.result?.format!=='material-preparation-v2')return undefined;
 const used=new Map<string,{direction:string;scene:string}>();
 for(const primary of batch.selections)for(const item of [primary,...(primary.additional_combinations??[])])for(const scene of item.scenes)if(item.direction)used.set(scopeKey(item.direction,scene),{direction:item.direction,scene});
 return{preparation_id:String(prepared.preparation_id),result:prepared.result,used_combinations:[...used.values()]};
}

/**
 * 校验当前有效Skill与题目冻结来源后，固定题目、附件清单和步骤配置并创建 ordinal 4 尝试。
 * 相同输入的活动任务会复用；出题成功后再次点击会新建尝试，并使后续结果失效。
 */
/** 把项目步骤配置转成网页出题配置：保留提示词/流程/材料模式/超时，去掉Codex模型字段。 */
function webStepConfig(raw:unknown,web:WebAgentSettings){
 const {model:_model,reasoning_effort:_effort,provider:_provider,web:_web,...rest}=(raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{}) as Record<string,unknown>;
 void _model;void _effort;void _provider;void _web;
 return{...rest,provider:'web',web};
}
export interface AuthoringDispatchOptions {
 web?: WebAgentSettings;
 provider?: 'codex' | 'agy' | string;
 model?: string;
 reasoning_effort?: string;
 prompt?: string;
 timeout_ms?: number;
}
/** options.web：仅本次派发改用网页Agent出题；options.provider/model/reasoning_effort：显式覆盖出题执行后端，避免读取数据库默认配置。 */
export async function enqueueAuthoring(pool:Pool,id:string,options?:AuthoringDispatchOptions){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await assertWorkflowNotArchived(db,id);await assertRepairStepAllowed(db,id,4);await syncWorkflowMaterialScope(db,id);const source=await prerequisites(db,id);
  const optProvider=options?.provider?(options.provider.trim().toLowerCase()==='antigravity'?'agy':options.provider.trim().toLowerCase()):undefined;
  const hasExplicitAgent=Boolean(optProvider||options?.model||options?.reasoning_effort);
  const skipDbStepConfig=Boolean(hasExplicitAgent&&options?.prompt);
  const raw=skipDbStepConfig?undefined:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=4',[source.workflow.project_id])).rows[0]?.config;
  let mergedConfig:Record<string,unknown>;
  if(options?.web){
   mergedConfig=webStepConfig(raw,options.web);
  }else if(hasExplicitAgent){
   const {model:_dbModel,reasoning_effort:_dbEffort,provider:_dbProvider,web:_dbWeb,...restRaw}=(raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{}) as Record<string,unknown>;
   void _dbModel;void _dbEffort;void _dbProvider;void _dbWeb;
   const inferredProvider=optProvider??(options?.model?(()=>{try{return resolveAgentDriver(options.model).driver.id;}catch{return 'codex';}})():'codex');
   const resolvedModel=options?.model??(inferredProvider==='agy'?DEFAULT_AUTHORING_SETTINGS.model:'gpt-5.4');
   const resolvedEffort=options?.reasoning_effort??DEFAULT_AUTHORING_SETTINGS.reasoning_effort;
   mergedConfig={
    ...restRaw,
    provider:inferredProvider,
    model:resolvedModel,
    reasoning_effort:resolvedEffort,
    ...(options?.prompt?{prompt:options.prompt}:{}),
    ...(options?.timeout_ms!==undefined?{timeout_ms:options.timeout_ms}:{}),
   };
  }else if(raw?.provider==='web'){
   mergedConfig=raw;
  }else{
   const defaults=await readProjectAgentDefaults(db,source.workflow.project_id);
   mergedConfig=mergeCodexDefaults(raw,defaults);
   if(options?.prompt)mergedConfig.prompt=options.prompt;
   if(options?.timeout_ms!==undefined)mergedConfig.timeout_ms=options.timeout_ms;
  }
  const config=validateStepConfigForExecution(4,mergedConfig);
  const scoreConfig=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=6',[source.workflow.project_id])).rows[0]?.config;
  const answerConfig=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=5',[source.workflow.project_id])).rows[0]?.config;
  const answerCapabilities=readAnswerToolPolicyFromStepConfig(answerConfig)??{server_tools:[],local_tools:[]};
  const scoreWorkflow=validateWorkflowConfig(scoreConfig?.workflow);
  const scoringPolicy:ScoringPolicy|undefined=scoreWorkflow?.contract==='model_report_v1'?{contract:scoreWorkflow.contract,rules_text:scoreWorkflow.rules_text,reference_answer:scoreWorkflow.reference_answer}:undefined;
  if(config.provider==='web'&&!localQueueEnabled())throw new HTTPException(409,{message:'网页Agent出题需要本机独立队列（EXECUTION_QUEUE_MODE=local）'});
  const hooks=await freezeStageHooks(dirname(source.skill_path),config.workflow);
  const loggingConfig=(config.provider==='web'?{model:`web:${config.web.provider}`,provider:'web'}:{model:config.model,reasoning_effort:config.reasoning_effort,provider:config.provider}) as {model?:string;reasoning_effort?:string;provider?:string};
  const advice=await frozenRevisionAdvice(db,id);
  const batchContext=await freezeAuthoringBatch(db,source.workflow.project_id,id);
  const materialScope=freezeMaterialScope('loaded_materials' in source?source.loaded_materials?.material_scope:undefined,batchContext);
  const frozen:Omit<FrozenInput,'digest'>={...(advice?{revision_advice:advice}:{}),...(config.workflow?.content_contract?{content_contract:config.workflow.content_contract}:{}),...(hooks?{hooks}:{}),...(scoringPolicy?{scoring_policy:scoringPolicy}:{}),system_authoring_prompt:AUTHORING_FIXED_PROMPT,project_name:source.workflow.project_name,answer_capabilities:answerCapabilities,authoring_contract:FRESH_AUTHORING_CONTRACT,title:source.workflow.title,...(designContext(source.workflow)?{design_context:designContext(source.workflow)}:{}),...(source.workflow.authoring_direction?{authoring_direction:source.workflow.authoring_direction}:{}),...(materialScope?{material_scope:materialScope}:{}),batch_context:batchContext,question_id:questionId(source.workflow),source_files:'source_files'in source?source.source_files:sourceFiles(source.workflow),project_prompt:source.project_prompt,...materialIdentity({material_origin:source.origin}),materials:source.materials,...('model_materials'in source&&source.model_materials?{model_materials:source.model_materials}:{})};
  const input:FrozenInput={...frozen,digest:inputDigest(frozen)};
  await supersedeForeignPending(db,{kind:'step',id,ordinal:4});
  const previous=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input->>'digest'=$2 AND config=$3::jsonb AND status IN ('waiting','running') ORDER BY attempt DESC LIMIT 1",[id,input.digest,JSON.stringify(config)])).rows[0];
  if(previous){await db.query('COMMIT');forgetLocalRegistrations(db);withLogContext({component:'authoring',workflow_id:id,project_id:source.workflow.project_id,ordinal:4,attempt_id:previous.id,operation:'authoring_enqueue',provider:loggingConfig.provider??'codex',model:loggingConfig.model,reasoning_effort:loggingConfig.reasoning_effort},()=>logEvent('attempt.reused',{level:'info',state:'reused'}));return{id:previous.id,reused:true};}
  if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status IN ('waiting','running') LIMIT 1",[id])).rowCount)throw new HTTPException(409,{message:'此题目已有出题任务'});
  const attempt=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config) SELECT $2,$1::uuid,4,COALESCE(max(attempt),0)+1,'waiting',$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=4",[id,attempt,JSON.stringify(input),JSON.stringify(config)]);
  await registerLocalJob(db,attempt,'step',config.provider==='web'?'web':'agent','authoring');
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=4",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>4 AND ordinal<=8",[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='题目更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>4 AND ordinal<=8 AND status IN ('waiting','running')",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='题目或评分标准更新',finished_at=now() WHERE project_id=$1 AND status IN ('running','succeeded')",[source.workflow.project_id]);
  await db.query('COMMIT');forgetLocalRegistrations(db);withLogContext({component:'authoring',workflow_id:id,project_id:source.workflow.project_id,ordinal:4,attempt_id:attempt,operation:'authoring_enqueue',provider:loggingConfig.provider??'codex',model:loggingConfig.model,reasoning_effort:loggingConfig.reasoning_effort},()=>logEvent('attempt.enqueued',{level:'info',state:'waiting',material_count:input.materials.length}));return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);throw error;}finally{db.release();}
}

type CurrentAuthoringBinding=false|{loaded_materials?:QuestionMaterials};
async function currentBindings(db:PoolClient,job:any):Promise<CurrentAuthoringBinding>{
 const workflow=(await db.query('SELECT id,project_id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL',[job.workflow_id])).rows[0];
 if(!workflow||workflow.project_id!==job.project_id)return false;
 // 材料以题目及附件ID定位；提示词、正文摘要和执行环境变化不阻断已派发任务。
 return job.input.material_origin?.kind==='library_v1'?{loaded_materials:await readQuestionMaterials(db,job.workflow_id)}:{};
}

async function readMaterials(pool:Pool,_root:string,job:any,loaded?:Awaited<ReturnType<typeof readQuestionMaterials>>){
 const result=[];
 if(job.input.material_origin?.kind==='library_v1'){
  const source=loaded??await readQuestionMaterials(pool,job.workflow_id);
  for(const key of ['package_id','revision_id','redaction_id'] as const)if((source.origin as any)[key]!==job.input.material_origin[key])throw new Error('材料来源ID不匹配');
  const selected=job.input.model_materials??job.input.materials,available=job.input.model_materials?source.model_attachments:source.attachments;
  for(const item of selected){
   const attachment=available?.find(file=>file.id===item.id);
   if(!attachment||Buffer.byteLength(attachment.content)>30*1024*1024||!attachment.content.trim())throw new Error('stale library material');
   result.push({id:item.id,sha256:item.sha256,text:attachment.content,...(attachment.source_names.length?{source_names:attachment.source_names}:{})});
  }
  if(result.length!==selected.length)throw new Error('incomplete library materials');
  return result;
 }
 for(const item of job.input.materials){
  const row=(await pool.query("SELECT sha256,content,(SELECT input->'materials' FROM ai_distill.step_attempts ra WHERE ra.id=ar.attempt_id) AS sources FROM ai_distill.artifacts ar WHERE id=$1 AND workflow_id=$2 AND attempt_id=$3 AND kind='redacted_markdown'",[item.id,job.workflow_id,job.input.redaction_attempt_id])).rows[0];
  if(!row)throw new Error('stale material');
  if(typeof row.content!=='string')throw new Error('redacted database content missing');
  const bytes=Buffer.from(row.content);if(bytes.length>30*1024*1024)throw new Error('invalid material content');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.trim())throw new Error('empty material');
  // redacted_markdown 是同次脱敏的合并产物，没有单份 material_id；文件名来自该次冻结来源。
  const source_names=Array.isArray(row.sources)?row.sources.flatMap((source:any)=>typeof source?.original_name==='string'&&source.original_name?[source.original_name]:[]):[];
  result.push({id:item.id,sha256:item.sha256,text,...(source_names.length?{source_names}:{})});
 }
 return result;
}
async function readRules(job:any):Promise<AuthoringRule[]>{
 const root=job.input.rule_snapshot_path,files=job.input.rule_files;
 if(files.some((file:{path:string})=>!file.path.startsWith('skill/')))throw new HTTPException(409,{message:'旧任务包含非 skill 项目资料，请重新出题'});

 const result:AuthoringRule[]=[];
 for(const file of files){const bytes=await readRuleFile(root,file.path);result.push({path:file.path,bytes});}
 if(!result.some(file=>file.path==='skill/SKILL.md'))throw new Error('missing frozen skill');
 return result;
}
async function readProjectContext(job:any):Promise<AuthoringRule[]>{
 if(!job.input?.project_prompt)return readRules(job);
 const files=await readProjectPrompt(job.input.project_prompt);
 return files.map(file=>({path:file.path,bytes:file.bytes}));
}
/**
 * 将一次出题错误投影为可持久化的安全终态；不做重试或状态写入。
 * 恢复优先使用原检查点；不得用新的异常包装覆盖第一次失败的原因及结构化结果。
 */
function buildAuthoringFailure(error: unknown, failurePhase: string): import('../execution-queue/store').StepFailure {
    if (error instanceof RecordedStepFailure)
        return { status: 'failed', message: error.failure.message, result: error.failure.result };
    const reasonCode = error && typeof error === 'object' && 'reason_code' in error ? error.reason_code : undefined;
    const safeCode = typeof reasonCode === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(reasonCode) ? reasonCode : null;
    let message: string;
    // 保留历史reason_code的安全消息映射；当前接收不再按作答能力拒收题包。
    if (error instanceof StageHookError)
        message = '项目钩子执行失败，可查看钩子记录后续跑';
    else if (reasonCode === 'authoring_contract_changed')
        message = '普通出题任务契约已更新，请重新派发';
    else if (reasonCode === 'unsupported_answer_requirements')
        message = '被测作答器仅支持文字输入和文字答案，且不调用工具；作者Codex的工具能力不受此限制';
    else
        switch (reasonCode) {
            case 'attachment_reference_invalid':
                message = '出题返回的附件 ID 缺失、重复或不属于本题材料，请检查后重试';
                break;
            case 'result_missing':
                message = '出题会话已结束，但未生成 result.json；请检查本次附件路径和私有执行记录';
                break;
            case 'result_validation_failed':
                message = '出题结果无法转换为可保存的JSON题包，请检查本次私有执行记录';
                break;
            case 'web_offline_pending':
                message = '已导出离线作业台任务，等待交回网页回复';
                break;
            case 'codex_timeout':
                message = '出题执行超过本次时限，未取得可接收的完整结果';
                break;
            case 'incomplete_turn':
                message = '出题会话未完整结束，结果未被接收';
                break;
            default: message = '出题执行失败、取消或输入已变化，可检查后重试';
        }
    const errorCode = error instanceof StageHookError ? 'project_hook_failed' : safeCode;
    return { status: 'failed', message, result: {
            ...(errorCode ? { error_code: errorCode } : {}),
            failure_phase: failurePhase,
        } };
}

type Authorer=(options:Parameters<typeof runAuthoring>[0])=>Promise<AuthoringResult>;
async function stillCurrent(pool:Pool,job:any):Promise<CurrentAuthoringBinding>{
 const db=await pool.connect();try{await db.query('BEGIN');const current=await currentBindings(db,job);await db.query('COMMIT');forgetLocalRegistrations(db);return current;}catch(error){await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);if(error instanceof HTTPException&&[404,409].includes(error.status))return false;throw error;}finally{db.release();}
}
/**
 * 领取当前版本出题尝试，在项目工作目录执行并将完整草稿存入数据库；作答输入单独筛选题面与附件。
 * 调用前核对冻结输入；返回后直接保存，仅按最新未取消任务身份写回，不复核材料/Skill指纹。
 */
export async function runNextAuthoring(pool: Pool, root: string, author: Authorer = runAuthoring, signal?: AbortSignal, workflowIds?: string[]) {
    if (signal?.aborted)
        return false;
    const db = await pool.connect();
    let job: any, staleRows: any[] = [];
    try {
        await db.query('BEGIN');
        await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
        const stale = await db.query(`SELECT a.id,a.workflow_id,a.heartbeat_at,a.input,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=4 AND ($1::uuid[] IS NULL OR a.workflow_id=ANY($1)) AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ${localClaimSql('a', true)}  ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED`, [workflowIds?.length ? workflowIds : null]);
        for (const row of stale.rows) {
            await recoverInterruptedStageHooks(db, row);
            const updated = await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='出题进程中断，可重试',finished_at=now() WHERE id=$1 AND status='running' RETURNING id", [row.id]);
            await db.query("UPDATE ai_distill.steps SET status='failed',error='出题进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=4 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1)", [row.workflow_id]);
            if (updated.rowCount)
                staleRows.push(row);
        }
        job = (await db.query(`SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=4 AND ($1::uuid[] IS NULL OR a.workflow_id=ANY($1)) AND ${localWaitingSql('a')} ${localClaimSql('a', false)}  ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1`, [workflowIds?.length ? workflowIds : null])).rows[0];
        if (!job) {
            await db.query('COMMIT');forgetLocalRegistrations(db);
            for (const row of staleRows)
                withLogContext({ component: 'authoring', project_id: row.project_id, workflow_id: row.workflow_id, ordinal: 4, attempt_id: row.id, operation: 'authoring' }, () => logEvent('attempt.recovered_interrupted', { level: 'error', state: 'failed', threshold_ms: 300000, ...(row.heartbeat_at ? { last_heartbeat_at: new Date(row.heartbeat_at).toISOString() } : {}) }));
            return false;
        }
        await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=COALESCE(started_at,now()),heartbeat_at=now() WHERE id=$1", [job.id]);
        if (!readStepFailure())
            await db.query("UPDATE ai_distill.steps SET status='running',error=NULL,started_at=now() WHERE workflow_id=$1 AND ordinal=4", [job.workflow_id]);
        await db.query('COMMIT');forgetLocalRegistrations(db);
    }
    catch (error) {
        await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);
        throw error;
    }
    finally {
        db.release();
    }
    for (const row of staleRows)
        withLogContext({ component: 'authoring', project_id: row.project_id, workflow_id: row.workflow_id, ordinal: 4, attempt_id: row.id, operation: 'authoring' }, () => logEvent('attempt.recovered_interrupted', { level: 'error', state: 'failed', threshold_ms: 300000, ...(row.heartbeat_at ? { last_heartbeat_at: new Date(row.heartbeat_at).toISOString() } : {}) }));
    const restoreLogContext = enterLogContext({ component: 'authoring', workflow_id: job.workflow_id, project_id: job.project_id, ordinal: 4, attempt_id: job.id, operation: 'authoring', provider: job.config?.provider === 'web' ? 'web' : (job.config?.provider ?? 'codex'), model: job.config?.provider === 'web' ? `web:${job.config.web?.provider}` : job.config?.model, reasoning_effort: job.config?.reasoning_effort });
    logEvent('attempt.claimed', { level: 'info', state: 'running' });
    logEvent('attempt.started', { level: 'info', state: 'running', material_count: job.input?.materials?.length ?? 0 });
    const cancellation = watchTaskCancellation(pool, job.id, signal, false);
    signal = cancellation.signal;
    const stopHeartbeat = startAttemptHeartbeat(pool, { component: 'authoring', project_id: job.project_id, workflow_id: job.workflow_id, ordinal: 4, attempt_id: job.id }, '第四步任务心跳写入失败');
    const directory = join(resolve(root), job.workflow_id, job.id);
    let output: string | undefined, packageBytes: Buffer | undefined, failurePhase = 'input_validation';
    try {
        resumeStepFailure();
        if (!job.input)
            throw Object.assign(new Error('invalid snapshot'), { reason_code: 'authoring_input_digest_invalid' });
        if (job.input.authoring_contract !== FRESH_AUTHORING_CONTRACT)
            throw Object.assign(new Error('出题任务契约已更新，请重新派发'), { reason_code: 'authoring_contract_changed' });
        const binding = await stillCurrent(pool, job);
        if (!binding)
            throw Object.assign(new Error('stale input'), { reason_code: 'authoring_input_binding_changed' });
        const materials = await readMaterials(pool, root, job, binding.loaded_materials);
        const projectContextFiles = await readProjectContext(job);
        if (job.config?.provider === 'web') {
            try {
                validateWebAgentSettings(job.config.web);
            }
            catch (error) {
                throw Object.assign(new Error('invalid frozen config', { cause: error }), { reason_code: 'authoring_frozen_config_invalid' });
            }
        }
        else if (!isRegisteredAgentProvider(job.config?.provider) || typeof job.config.model !== 'string' || !job.config.model.trim() || typeof job.config.reasoning_effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(job.config.reasoning_effort))
            throw new Error('invalid frozen config');
        logEvent('attempt.input_validated', { level: 'info', material_count: materials.length });
        const legacyRulesInput = job.input.rule_version_id ? { version_id: job.input.rule_version_id, source_digest: job.input.rule_source_digest, files: projectContextFiles } : undefined;
        failurePhase = 'agent_execution';
        await emitLifecycle(pool,'before', {stage:'authoring',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal});
        const hookContext = { pool, attempt_id: job.id, workflow_id: job.workflow_id, stage: 'authoring' as const, binding_digest: hash(canonicalJson({ input: job.input.digest, config: job.config })), input: { title: job.input.title, materials: materials.map((m, i) => ({ name: `附件${i + 1}`, text: m.text })), ...(job.input.scoring_policy ? { scoring_policy: job.input.scoring_policy } : {}) }, hooks: job.input.hooks, signal };
        const result = await executeWithStageHooks({
            ...hookContext,
            runMain: additions => cachedExternalCall('authoring_complete', () => {
                const authoringDirection = [
                    job.input.design_context?.scenario ? `任务场景：${job.input.design_context.scenario}` : null,
                    job.input.design_context?.role_perspective ? `角色视角：${job.input.design_context.role_perspective}` : null,
                    job.input.design_context?.target_level ? `目标等级：${job.input.design_context.target_level}（设计目标，不代表项目方认证）` : null,
                    job.input.design_context?.question_tags?.length ? `设计标签：${job.input.design_context.question_tags.join('、')}` : null,
                    job.input.authoring_direction
                ].filter(Boolean).join('\n') || undefined;
                const authorOptions: Parameters<Authorer>[0] = {
                    ...(job.input.content_contract ? {
                        content_contract: job.input.content_contract
                    } : {}),
                    ...(job.input.scoring_policy ? {
                        scoring_policy: job.input.scoring_policy
                    } : {}),
                    ...(job.input.material_scope?{material_scope:job.input.material_scope}:{}),
                    ...(job.input.batch_context?{batch_context:job.input.batch_context}:{}),
                    workspace_path: resolveProjectPath(job.input.project_prompt.workspace_path),
                    root: join(directory, 'private'),
                    project_name: job.input.project_name,
                    answer_capabilities: job.input.answer_capabilities,
                    question: job.input.title,
                    authoring_direction: authoringDirection,
                    question_id: job.input.question_id ?? job.input.title,
                    source_files: job.input.source_files ?? [],
                    materials,
                    ...(legacyRulesInput ? {
                        rules: legacyRulesInput
                    } : {
                        project_context: {
                            source_digest: job.input.project_prompt.source_digest, files: projectContextFiles
                        }
                    }),
                    system_authoring_prompt: job.input.system_authoring_prompt ?? '',
                    step_prompt: (job.config.prompt ?? DEFAULT_STEP_PROMPTS[4])
                        + (job.input.revision_advice ? `\n\n<本次手动返修建议>\n${job.input.revision_advice.text}\n以上建议仅供修正设计；案件事实以本次附件为准，不得以降低评分要求制造达标。\n</本次手动返修建议>` : '')
                        + hookAdditionText(additions),
                    model: job.config.provider === 'web' ? `web:${job.config.web.provider}` : job.config.model,
                    reasoning_effort: job.config.provider === 'web' ? 'none' : job.config.reasoning_effort,
                    provider: job.config.provider,
                    // 业务心跳只证明执行器存活，不能让始终没有完整结果的调用无限占槽。
                    // 出题单次墙钟时间硬限制为 30 分钟；到线后由现有失败结算释放本机容量。
                    timeout_ms: Math.min(job.config.timeout_ms ?? 1_800_000, 1_800_000),
                    signal,
                    execute: options => runExternalCall({
                        attempt_id: job.id, operation: 'author'
                    }, call_id => (job.config.provider === 'web' ? webAuthoringExecutor(job.config.web) : runAgent)({
                        ...options, call_id, task_type: 'question_authoring', provider: job.config.provider
                    }))
                };
                return author(authorOptions);
            }),
            outputForHooks: value => ({
                draft: value.draft
            })
        });
        const draft = result.draft;
        const storedResult = { ...draft, ...(job.input.scoring_policy ? { scoring_policy: job.input.scoring_policy } : {}), question_id: result.question_id, question_version: result.question_version, rubric_version: result.rubric_version, codex: { author: result.codex } };
        failurePhase = 'result_persistence';
        if (signal?.aborted)
            throw new Error('cancelled');
        const publicPackage = Buffer.from(renderPublicQuestionPackage({ project_name:job.input.project_name, question: job.input.title, question_id: job.input.question_id, source_files: job.input.source_files ?? [], materials }, draft));
        const packagePath = join(directory, 'authored_question.md');
        packageBytes = publicPackage;
        output = packagePath;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(packagePath, publicPackage, { mode: 0o600, flag: 'w' });
        const tx = await pool.connect();
        try {
            await tx.query('BEGIN');
            if (signal?.aborted || !(await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' AND id=(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$2 AND ordinal=4 ORDER BY attempt DESC LIMIT 1) FOR UPDATE", [job.id, job.workflow_id])).rowCount)
                throw new Error('inactive');
            if(job.input.material_scope)await saveMaterialScopeSelection(tx,job.project_id,job.workflow_id,job.id,draft.material_scope_selection);
            await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,session_id=$3,error=NULL,finished_at=now() WHERE id=$1", [job.id, JSON.stringify(storedResult), result.codex.session_id]);
            await tx.query("UPDATE ai_distill.steps SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=4", [job.workflow_id, JSON.stringify(storedResult)]);
            await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [crypto.randomUUID(), job.workflow_id, job.id, 'authored_question', relative(resolve(root), packagePath), hash(publicPackage), publicPackage.length, publicPackage.toString('utf8')]);
            await prepareCommittedStageHooks({...hookContext,pool:tx}, { draft: result.draft });
            await tx.query('COMMIT');forgetLocalRegistrations(tx);
            logEvent('attempt.completed', { level: 'info', state: 'succeeded' });
        }
        catch (error) {
            await tx.query('ROLLBACK');await releaseRolledBackRegistrations(tx);
            throw error;
        }
        finally {
            tx.release();
        }
        await runCommittedStageHooks(hookContext, { draft: result.draft });
        await emitLifecycle(pool,'committed', {stage:'authoring',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal,data:{result:storedResult}});
    }
    catch (error) {
        deferLocalPublication(error);
        await emitLifecycle(pool,signal?.aborted?'cancelled':'failed', {stage:'authoring',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal});
        logEvent('attempt.failed', { level: 'error', state: 'failed', ...classifyLogError(error), failure_phase: failurePhase });
        // 先保存终态，再清理产物/结算PG；断网后只补交同一次失败，不重跑作者。
        const failure = saveStepFailure(buildAuthoringFailure(error, failurePhase));
        const failureMessage = failure.message, failureResult = failure.result;
        if (output)
            try {
                const artifact = await pool.query("SELECT id FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind='authored_question'", [job.workflow_id, job.id]);
                if (!artifact.rowCount)
                    await rm(output, { force: true });
            }
            catch (cleanupError) {
                logEvent('file.cleanup_or_commit_check_failed', { level: 'error', file_kind: 'authored_question', ...classifyLogError(cleanupError) });
            }
        const tx = await pool.connect();
        try {
            await tx.query('BEGIN');
            const current = (await tx.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1", [job.workflow_id])).rows[0]?.id === job.id;
            const failed = await tx.query("UPDATE ai_distill.step_attempts SET status='failed',result=$2,error=$3,finished_at=now() WHERE id=$1 AND status='running'", [job.id, JSON.stringify(failureResult), failureMessage]);
            if (current && failed.rowCount)
                await tx.query("UPDATE ai_distill.steps SET status='failed',result=$2,error=$3,finished_at=now() WHERE workflow_id=$1 AND ordinal=4 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1 AND w.deleted_at IS NULL) AND (SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1)=$4", [job.workflow_id, JSON.stringify(failureResult), failureMessage, job.id]);
            await tx.query('COMMIT');forgetLocalRegistrations(tx);
        }
        catch (failure) {
            await tx.query('ROLLBACK');await releaseRolledBackRegistrations(tx);
            throw failure;
        }
        finally {
            tx.release();
        }
    }
    finally {
        cancellation.dispose();
        stopHeartbeat();
        restoreLogContext();
    }
    return true;
}
