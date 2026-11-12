/**
 * 职责：模型作答队列：冻结题目与获准来源附件，为模型集合派发任务并按当前版本聚合答案状态。
 * 关键方法与用途：`readAnswerAttachment()` 兼容旧题数据库脱敏附件；`enqueueAnswer()` 冻结并创建尝试；`runNextAnswer()` 领取、调用供应商并保存结果。
 * 使用场景：`app.ts` 接收用户派发，`worker.ts` 持续调用消费入口。
 */
import {emitProjectLifecycle as emitLifecycle} from '../lifecycle';
import {startAttemptHeartbeat} from '../attempt-heartbeat';
import {assertWorkflowNotArchived} from '../workflow-archive-guard';
import {assertRepairStepAllowed} from '../revision-advice/jobs';
import {supersedeForeignPending,releaseRolledBackRegistrations,forgetLocalRegistrations,registerLocalJobs,localClaimSql,localWaitingSql,deferLocalPublication,resumeStepFailure,readStepFailure,saveStepFailure,RecordedStepFailure} from '../execution-queue/runtime';
import {readWorkflowModelSet} from './workflow-models';
import {canonicalJson,validateWorkflowConfig} from '../../shared/workflow-config';
import {freezeStageHooks,recoverInterruptedStageHooks,executeWithStageHooks,prepareCommittedStageHooks,runCommittedStageHooks,StageHookError,stageHookAffinitySql,type StageWorkerMode} from '../lifecycle/scripts';
import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {runExternalCall} from '../external-call';
import {HTTPException} from 'hono/http-exception';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {dirname,resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {authoringQuestion,buildAnswerInput,buildAnswerMessage,inputDigest,matchesInputDigest,AnswerInputError,type AnswerPackage} from './input';
import {QwenError,type QwenAnswer} from './qwen';
import {DomesticError} from './domestic';
import {resolveAnswerConfig,createAnswerClient,type ResolvedAnswerConfig} from './dispatch';
import type {AnswerRequest,AnswerResult} from './provider';
import {answerModelSetDigest,readProjectModelSet,type RegisteredAnswerModel} from './model-set';
import {DEFAULT_ANSWER_GENERATION_POLICY,answerProviderConfigFromStepConfig,isQualifiedLongGenerationTimeout,readAnswerGenerationPolicyFromStepConfig,resolveAnswerCallSettings,resolveAnswerGenerationPolicy} from './generation-policy';
import {applyAnswerToolPolicy,readAnswerToolPolicyFromStepConfig,requiredAnswerToolPolicy} from './tool-policy';
import {readGeneratedAnswerArtifacts} from './local-tools';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import type {AnswerStepModelSummary,AnswerStepResult} from '../../shared/workflow-results';
import {SYSTEM_STEP_PROMPTS} from '../../shared/step-prompts';
import {readQuestionMaterials} from '../question-materials';
import {resolveEffectiveProjectSkill} from '../rule-files';
import {runAcceptance} from '../decisions/jobs';
import {isAgentProviderConfig,isRegisteredAgentProvider} from '../agent';
import type {QuestionMaterialOrigin} from '../../shared/material-library';
const activeWorkflow="SELECT w.project_id,p.local_skill_path,p.workspace_path,p.parent_name,p.material_backend,EXISTS(SELECT 1 FROM ai_distill.question_library_sources qls WHERE qls.workflow_id=w.id) AS has_library_snapshot FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w";
async function currentQuestion(db:PoolClient,id:string,project:import('../lifecycle/step-types').ProjectIdentity={}){
 const row=(await db.query("SELECT a.id,a.result,a.input FROM ai_distill.step_attempts a JOIN ai_distill.steps s4 ON s4.workflow_id=a.workflow_id AND s4.ordinal=4 AND s4.status='succeeded' WHERE a.workflow_id=$1 AND a.ordinal=4 AND a.status='succeeded' ORDER BY a.attempt DESC LIMIT 1 FOR UPDATE OF s4,a",[id])).rows[0];
 if(!row)throw new AnswerInputError('当前题目尚未出题成功');
 return {...authoringQuestion({...row.result,...(row.input?.material_origin?{material_origin:row.input.material_origin}:{})},project),...(row.result.deliverables!==undefined?{deliverables:row.result.deliverables}:{}),question_attempt_id:row.id};
}
export async function readAnswerAttachment(_root:string,artifact:{storage_path?:string;sha256:string;content?:string|null}){
 try{
  if(typeof artifact.content!=='string')throw new AnswerInputError('数据库中没有脱敏附件正文，不能作答');
  if(Buffer.byteLength(artifact.content)>24_000_000)throw new AnswerInputError('脱敏附件指纹不一致，不能作答');
  return artifact.content;
 }catch(error){if(error instanceof AnswerInputError)throw error;throw new AnswerInputError('脱敏附件无法读取，不能作答');}
}
/**
 * 只为当前成功题面和获准冻结附件创建作答尝试，并冻结题目、材料及模型集合配置。
 * 按模型分别去重和排队；作答输入不包含 rubric、标答或目标分数。
 */
export async function enqueueAnswer(pool:Pool,id:string,root:string,executionTarget:'local'|'server'='local',remoteRequestKey?:string){
 if(executionTarget==='server'&&!remoteRequestKey)throw new HTTPException(400,{message:'服务器作答需要固定请求标识'});
 if(remoteRequestKey&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(remoteRequestKey))throw new HTTPException(400,{message:'请求标识须为 UUID'});
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await assertWorkflowNotArchived(db,id);
  const workflow=(await db.query(activeWorkflow,[id])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  if(remoteRequestKey){
   const existing=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND execution_target='server' AND input->>'remote_request_key'=$2 ORDER BY attempt",[id,remoteRequestKey])).rows;
   if(existing.length){await db.query('COMMIT');forgetLocalRegistrations(db);return{ id:existing[0].id,ids:existing.map((row:any)=>row.id),reused:true };}
  }
  await assertRepairStepAllowed(db,id,5);
  await supersedeForeignPending(db,{kind:'step',id,ordinal:5},executionTarget);
  const activeTarget=(await db.query("SELECT DISTINCT execution_target FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND status IN ('waiting','running')",[id])).rows;
  if(activeTarget.some((row:any)=>row.execution_target!==executionTarget))throw new HTTPException(409,{message:'当前作答任务由另一执行位置处理'});
  if(remoteRequestKey&&activeTarget.length)throw new HTTPException(409,{message:'当前已有作答任务；使用原请求标识查询，或等待完成后用新标识提交'});
  const question=await currentQuestion(db,id,workflow);
  let sources:any[]=[],materialOrigin:QuestionMaterialOrigin|undefined;
  if(workflow.material_backend==='library_v1'||workflow.has_library_snapshot){
   const source=await readQuestionMaterials(db,id);
   if(JSON.stringify(question.attachment_ids)!==JSON.stringify(source.attachments.map(item=>item.id)))throw new AnswerInputError('题目附件与共享材料包私有快照不一致');
   const modelSources=source.model_attachments??source.attachments;
   if(source.model_attachments&&!modelSources.length)throw new AnswerInputError('材料整理结果中没有可供模型读取的文书正文');
   materialOrigin=source.origin;
   sources=modelSources.map(item=>({id:item.id,kind:source.origin.kind==='library_v1'&&source.origin.material_mode==='original'?'source_markdown':'redacted_markdown',sha256:item.sha256,text:item.content}));
  }else{
   const artifacts=await db.query("SELECT ar.id,ar.kind,ar.sha256,ar.storage_path,ar.content FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=9 WHERE ar.workflow_id=$1 AND ar.id=ANY($2::uuid[]) AND ar.kind='redacted_markdown' AND a.ordinal=9 AND a.status='succeeded' AND s.status='succeeded'",[id,question.attachment_ids]);
   for(const artifact of artifacts.rows)sources.push({...artifact,text:await readAnswerAttachment(root,artifact)});
  }
  const input=buildAnswerInput(question,sources,workflow);
  const rawStepConfig=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=5',[workflow.project_id])).rows[0]?.config??{};
  const systemPrompt=typeof rawStepConfig.prompt==='string'&&rawStepConfig.prompt.trim()?rawStepConfig.prompt:SYSTEM_STEP_PROMPTS[5];
  const answerInput={...input,system_prompt:systemPrompt,...(materialOrigin?{material_origin:materialOrigin}:{})};
  const snapshot={...answerInput,question_attempt_id:question.question_attempt_id,input_digest:inputDigest(answerInput)};
  const workflowConfig=validateWorkflowConfig(rawStepConfig.workflow);
  const needsHooks=!!(workflowConfig?.hooks.before.length||workflowConfig?.hooks.after.length);
  if(needsHooks&&executionTarget==='server')throw new HTTPException(409,{message:'服务器作答暂不支持项目步骤钩子'});
  const skill=needsHooks?await resolveEffectiveProjectSkill(workflow):undefined;
  const hooks=skill?await freezeStageHooks(dirname(skill.path),workflowConfig):undefined;
  const hookDigest=hooks?createHash('sha256').update(canonicalJson(hooks)).digest('hex'):undefined;
  const generationPolicy=readAnswerGenerationPolicyFromStepConfig(rawStepConfig),overrides=answerProviderConfigFromStepConfig(rawStepConfig);let toolPolicy;
  try{toolPolicy=requiredAnswerToolPolicy(readAnswerToolPolicyFromStepConfig(rawStepConfig),input.answer_requirements.tools);}catch(error){throw new HTTPException(409,{message:error instanceof Error?error.message:'题目需要的作答工具未启用'});}
  const selected=await readProjectModelSet(db,workflow.project_id);const hasModelSet=selected.length>0;
  if(executionTarget==='server'&&selected.some(model=>isRegisteredAgentProvider(model.config.provider)))throw new HTTPException(409,{message:'Codex Agent 作答只支持本机执行'});
  const models:RegisteredAnswerModel[]=(selected.length?selected:[{model_id:'',name:'',minimum_score:0,config:resolveAnswerConfig(overrides)}]).map(model=>({...model,config:isAgentProviderConfig(model.config)?model.config:applyAnswerToolPolicy(model.config,toolPolicy)}));
  if(input.answer_requirements.tools.length){
   const unsupported=models.filter(model=>{const config=model.config as any,enabled=new Set([...(config.server_tools??[]),...(config.local_tools??[])]);return isRegisteredAgentProvider(config.provider)||input.answer_requirements.tools.some(tool=>!enabled.has(tool));});
   if(unsupported.length)throw new HTTPException(409,{message:'当前作答模型不能执行题目声明的工具；请调整新尝试的模型或项目工具设置'});
  }
  const modelSetDigest=answerModelSetDigest(models);
  const modelSet=models.map(({model_id,name,minimum_score,config})=>({model_id,name,minimum_score,config}));
  const queued:{id:string;reused:boolean}[]=[];
  for(const model of models){
   const input={...snapshot,...(hooks?{hooks,hook_digest:hookDigest}:{}),...(remoteRequestKey?{remote_request_key:remoteRequestKey}:{}),model_id:model.model_id||null,model_name:model.name||null,answer_generation_policy:generationPolicy,...(hasModelSet?{model_set_digest:modelSetDigest,model_set:modelSet}:{})};
   // Workflow row lock serializes a whole model-set enqueue. Each model is deduplicated independently.
   const previous=remoteRequestKey?{rowCount:0,rows:[]} as any:await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND execution_target=$11 AND input->>'question_attempt_id'=$2 AND input->>'input_digest'=$3 AND input->>'model_id' IS NOT DISTINCT FROM $4 AND config=$5::jsonb AND (($6::boolean AND input->>'model_set_digest'=$7) OR (NOT $6::boolean AND input->>'model_set_digest' IS NULL)) AND COALESCE(input->'answer_generation_policy',$9::jsonb)=$8::jsonb AND COALESCE(input->'hooks','null'::jsonb)=$10::jsonb AND status IN ('waiting','running','succeeded') ORDER BY attempt DESC LIMIT 1",[id,question.question_attempt_id,snapshot.input_digest,model.model_id||null,JSON.stringify(model.config),hasModelSet,modelSetDigest,JSON.stringify(generationPolicy),JSON.stringify(DEFAULT_ANSWER_GENERATION_POLICY),JSON.stringify(hooks??null),executionTarget]);
 if(previous.rowCount){queued.push({id:previous.rows[0].id,reused:true});continue;}
   const attempt=crypto.randomUUID();
   await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,execution_target) SELECT $2,$1::uuid,5,COALESCE(max(attempt),0)+1,'waiting',$3,$4,$5 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=5",[id,attempt,JSON.stringify(input),JSON.stringify(model.config),executionTarget]);
   queued.push({id:attempt,reused:false});
  }
  const existingQueued=await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND execution_target=$5 AND status IN ('waiting','running') AND (input->>'model_set_digest' IS DISTINCT FROM $2 OR COALESCE(input->'hooks','null'::jsonb) IS DISTINCT FROM $4::jsonb) AND id<>ALL($3::uuid[]) LIMIT 1",[id,modelSetDigest,queued.map(item=>item.id),JSON.stringify(hooks??null),executionTarget]);
  if(existingQueued.rowCount)throw new HTTPException(409,{message:'另一组模型仍在作答，请等待完成后再修改项目模型集合'});
  await registerLocalJobs(db,queued.flatMap((item,index)=>item.reused?[]:[{id:item.id,kind:'step' as const,lane:isRegisteredAgentProvider(models[index]!.config.provider)?'agent' as const:'api' as const,route:'answer'}]));
  const allReused=queued.every(item=>item.reused);
  if(allReused){await db.query('COMMIT');forgetLocalRegistrations(db);for(const [index,item] of queued.entries()){const model=models[index];withLogContext({component:'answer',workflow_id:id,project_id:workflow.project_id,ordinal:5,attempt_id:item.id,operation:'answer_enqueue',provider:model?.config.provider,model:model?.config.model},()=>logEvent('attempt.reused',{level:'info',state:'reused'}));}return hasModelSet?{id:queued[0]!.id,ids:queued.map(item=>item.id),reused:true}:{id:queued[0]!.id,reused:true};}
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=5",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',error=NULL,result=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>5 AND ordinal<=8",[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='作答更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>5 AND ordinal<=8 AND status IN ('waiting','running')",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');forgetLocalRegistrations(db);for(const [index,item] of queued.entries()){const model=models[index];withLogContext({component:'answer',workflow_id:id,project_id:workflow.project_id,ordinal:5,attempt_id:item.id,operation:'answer_enqueue',provider:model?.config.provider,model:model?.config.model},()=>logEvent(item.reused?'attempt.reused':'attempt.enqueued',{level:'info',state:'waiting'}));}return hasModelSet?{id:queued[0]!.id,ids:queued.map(item=>item.id),reused:false}:{id:queued[0]!.id,reused:false};
 }catch(error){await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);if(error instanceof AnswerInputError)throw new HTTPException(409,{message:error.message});if((error instanceof QwenError||error instanceof DomesticError))throw new HTTPException(400,{message:error.message});throw error;}finally{db.release();}
}
async function matchesQuestion(db:PoolClient,job:any,project:import('../lifecycle/step-types').ProjectIdentity={}){
 try{
  const current=await currentQuestion(db,job.workflow_id,project);
  return current.question_attempt_id===job.input.question_attempt_id&&JSON.stringify(current.attachment_ids)===JSON.stringify(job.input.attachments.map((a:any)=>a.id));
 }catch(error){if(error instanceof AnswerInputError)return false;throw error;}
}
async function matchesModelSet(db:PoolClient,job:any){
 if(!Array.isArray(job.input.model_set)||!job.input.model_set.length)return true;
 const current=await readWorkflowModelSet(db,job.project_id,job.workflow_id);
 const digest=answerModelSetDigest(current);
 return digest===job.input.model_set_digest;
}
/** 聚合查询只读取这些白名单字段；旧结果允许缺失或为null。 */
type AnswerAggregationRow={
 id:string;status:import('../../shared/types').StepStatus;
 input:{model_id?:string|null}|null;
 result:{text?:string|null;answer_sha256?:string|null;outcome?:string;reason_code?:string;generation_activity?:unknown;reasoning_tokens?:number|null;completed_tool_calls?:number;execution_steps?:unknown;tool_trace?:unknown;source_citations?:unknown[]}|null;
};
type AnswerAggregationJob={
 id:string;workflow_id:string;status:import('../../shared/types').StepStatus;
 input:{model_set?:RegisteredAnswerModel[]|null;model_id?:string|null;model_name?:string;model_set_digest?:string;question_attempt_id?:string;input_digest?:string};
 config:{model?:string};
 result?:(Record<string,unknown>&{outcome?:string;reason_code?:string;generation_activity?:unknown})|null;
};
/** 聚合当前模型集合：全部终结且至少一个成功即可继续；不把局部失败误判为所有答案失效。 */
export async function refreshAnswerStep(db: PoolClient, job: AnswerAggregationJob) {
    if (!Array.isArray(job.input.model_set) || !job.input.model_set.length) {
        const result = job.status === 'skipped' && job.result?.outcome === 'qualified_timeout_unscored' ? { ...job.result, models: [{ model_id: job.input.model_id ?? null, name: job.input.model_name ?? job.config.model, attempt_id: job.id, status: 'skipped', outcome: job.result.outcome, reason_code: job.result.reason_code, generation_activity: job.result.generation_activity }] } : job.result;
        const latest = await db.query("UPDATE ai_distill.steps SET status=$2,result=$3,error=NULL,finished_at=CASE WHEN $2 IN ('succeeded','skipped','failed') THEN now() ELSE NULL END WHERE workflow_id=$1 AND ordinal=5 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1)", [job.workflow_id, job.status === 'succeeded' ? 'succeeded' : job.status === 'skipped' ? 'skipped' : 'failed', JSON.stringify(result)]);
        return latest.rowCount;
    }
    // 只传回同一输入下各模型最新尝试；完整当前答案仍供详情展示。
    const rows = await db.query<AnswerAggregationRow>("SELECT id,input,result,status FROM (SELECT DISTINCT ON (input->>'model_id') id,jsonb_build_object('model_id',input->'model_id') AS input,jsonb_build_object('text',result->'text','answer_sha256',result->'answer_sha256','outcome',result->'outcome','reason_code',result->'reason_code','generation_activity',result->'generation_activity','reasoning_tokens',result->'reasoning_tokens','completed_tool_calls',result->'completed_tool_calls','execution_steps',result->'execution_steps','tool_trace',result->'tool_trace','source_citations',result->'source_citations') AS result,status FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND input->>'model_set_digest'=$2 AND input->>'question_attempt_id'=$3 AND input->>'input_digest'=$4 ORDER BY input->>'model_id',attempt DESC) latest", [job.workflow_id, job.input.model_set_digest, job.input.question_attempt_id, job.input.input_digest]);
    const latest = new Map<string, AnswerAggregationRow>();
    for (const row of rows.rows) {
        const id = row.input?.model_id;
        if (typeof id === 'string' && id && !latest.has(id))
            latest.set(id, row);
    }
    const models: AnswerStepModelSummary[] = job.input.model_set.map((model: RegisteredAnswerModel) => { const row = latest.get(model.model_id); return { model_id: model.model_id, name: model.name, minimum_score: model.minimum_score, attempt_id: row?.id ?? null, status: row?.status ?? 'waiting', answer_sha256: row?.result?.answer_sha256 ?? null, answer: row?.status === 'succeeded' ? row.result!.text : null, ...(row?.status==='succeeded'?{reasoning_tokens:row.result?.reasoning_tokens??null,...(row.result?.completed_tool_calls===undefined?{}:{completed_tool_calls:row.result.completed_tool_calls}),execution_steps:row.result?.execution_steps,tool_trace:row.result?.tool_trace,source_citations:row.result?.source_citations}:{}), ...(row?.result?.outcome === 'qualified_timeout_unscored' ? { outcome: row.result.outcome, reason_code: row.result.reason_code, generation_activity: row.result.generation_activity } : {}) }; });
    const settled = models.every((model) => ['succeeded', 'failed', 'skipped'].includes(model.status));
    const active = models.some((model) => model.status === 'running');
    const status = settled ? (models.every((model) => model.status === 'succeeded') ? 'succeeded' : models.every((model) => model.status === 'skipped') ? 'skipped' : 'failed') : active ? 'running' : 'waiting';
    const result: AnswerStepResult = { model_set_digest: job.input.model_set_digest, models };
    return (await db.query("UPDATE ai_distill.steps SET status=$2,result=$3,error=NULL,finished_at=CASE WHEN $2 IN ('succeeded','skipped','failed') THEN now() ELSE NULL END WHERE workflow_id=$1 AND ordinal=5 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1)", [job.workflow_id, status, JSON.stringify(result)])).rowCount;
}
/** 安全失败载荷：保留供应商白名单字段和原检查点，不把供应商原始响应或密钥写入业务结果。 */
function buildAnswerFailure(error: unknown, job: {
    input: Record<string, unknown>;
    config: {
        model?: string;
    };
}, qualifiedTimeout: boolean): import('../execution-queue/store').StepFailure {
    if (error instanceof RecordedStepFailure)
        return error.failure;
    let message: string;
    if (error instanceof StageHookError)
        message = '项目钩子执行失败，可查看钩子记录后续跑';
    else if (qualifiedTimeout)
        message = '已观测到持续推理增量直至本地冻结请求上限；本次按免评分规则直接通过';
    else if (error instanceof QwenError || error instanceof DomesticError || error instanceof AnswerInputError)
        message = error.message;
    else
        message = '模型作答失败，请检查服务配置或存储状态';
    let result: unknown = null;
    if (qualifiedTimeout) {
        // 只格式化已由generation-policy严格认定的终态；本函数不能自行开启免评分。
        const activity = error as {
            generation_activity?: unknown;
            request_id?: unknown;
            generation_id?: unknown;
        };
        result = { outcome: 'qualified_timeout_unscored', reason_code: 'qualified_long_generation_timeout',
            generation_activity: activity.generation_activity, request_id: activity.request_id ?? null, generation_id: activity.generation_id ?? null,
            answer_generation_policy: job.input.answer_generation_policy, question_attempt_id: job.input.question_attempt_id,
            question_version: job.input.question_version, input_digest: job.input.input_digest,
            model_id: job.input.model_id ?? null, model_name: job.input.model_name ?? job.config.model,
        };
    }
    else if (error instanceof QwenError || error instanceof DomesticError) {
        result = { error: { kind: error.kind, retryable: error.retryable, http_status: error.http_status,
                provider_code: error.provider_code, request_id: error.request_id, generation_id: error.generation_id ?? null, reason_code: error.reason_code ?? null,
            } };
    }
    else if (error instanceof StageHookError)
        result = { error_code: 'project_hook_failed' };
    return { status: qualifiedTimeout ? 'skipped' : 'failed', message, result };
}
/**
 * 领取一个当前版本的单模型作答任务，校验冻结输入后调用对应供应商并保存完整答案及 usage。
 * 发布前再次核对题面、附件、模型集合和活动尝试，防止过期响应覆盖当前步骤状态。
 */
export async function runNextAnswer(pool: Pool, root: string, answer: (input: AnswerRequest<ResolvedAnswerConfig>) => Promise<AnswerResult> = createAnswerClient().answer, signal?: AbortSignal, workerMode: StageWorkerMode = 'all', executionTarget: 'local' | 'server' = 'local', providerExecution: 'api' | 'codex' | 'all' = 'api', workflowIds?: string[]) {
    const affinity = stageHookAffinitySql(workerMode);
    const providerAffinity = providerExecution === 'all' ? 'TRUE' : providerExecution === 'codex' ? "a.config->>'provider'='codex'" : "COALESCE(a.config->>'provider','qwen')<>'codex'";
    const db = await pool.connect();
    let job: any, staleRows: any[] = [];
    try {
        await db.query('BEGIN');
        await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
        const stale = await db.query(`SELECT a.id,a.workflow_id,a.heartbeat_at,a.input,a.config,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=5 AND a.execution_target=$1 AND ($2::uuid[] IS NULL OR a.workflow_id=ANY($2)) AND ${providerAffinity} AND ${affinity} AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ${localClaimSql('a', true)}  ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED`, [executionTarget, workflowIds?.length ? workflowIds : null]);
        for (const row of stale.rows) {
            const hookInterrupted = await recoverInterruptedStageHooks(db, row);
            const updated = await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='作答进程中断，可重试',finished_at=now() WHERE id=$1 AND status='running' RETURNING id", [row.id]);
            if (updated.rowCount)
                staleRows.push({ ...row, status: 'failed', result: { ...(hookInterrupted ? { error_code: 'project_hook_failed' } : {}), error: { kind: 'unknown', message: '作答进程中断，可重试' } } });
        }
        for (const workflowId of new Set(staleRows.map(row => row.workflow_id))) {
            const row = staleRows.find(item => item.workflow_id === workflowId)!;
            if (await matchesQuestion(db, row) && await matchesModelSet(db, row))
                await refreshAnswerStep(db, row);
        }
        job = (await db.query(`SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=5 AND a.execution_target=$1 AND ($2::uuid[] IS NULL OR a.workflow_id=ANY($2)) AND ${providerAffinity} AND ${affinity} AND ${localWaitingSql('a')} ${localClaimSql('a', false)}  ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1`, [executionTarget, workflowIds?.length ? workflowIds : null])).rows[0];
        if (!job) {
            await db.query('COMMIT');forgetLocalRegistrations(db);
            for (const row of staleRows)
                withLogContext({ component: 'answer', project_id: row.project_id, workflow_id: row.workflow_id, ordinal: 5, attempt_id: row.id, operation: 'answer' }, () => logEvent('attempt.recovered_interrupted', { level: 'error', state: 'failed', threshold_ms: 300000, ...(row.heartbeat_at ? { last_heartbeat_at: new Date(row.heartbeat_at).toISOString() } : {}) }));
            return false;
        }
        await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=COALESCE(started_at,now()),heartbeat_at=now() WHERE id=$1", [job.id]);
        if (!readStepFailure())
            await db.query("UPDATE ai_distill.steps SET status='running',started_at=now(),error=NULL WHERE workflow_id=$1 AND ordinal=5", [job.workflow_id]);
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
        withLogContext({ component: 'answer', project_id: row.project_id, workflow_id: row.workflow_id, ordinal: 5, attempt_id: row.id, operation: 'answer' }, () => logEvent('attempt.recovered_interrupted', { level: 'error', state: 'failed', threshold_ms: 300000, ...(row.heartbeat_at ? { last_heartbeat_at: new Date(row.heartbeat_at).toISOString() } : {}) }));
    const restoreLogContext = enterLogContext({ component: 'answer', workflow_id: job.workflow_id, project_id: job.project_id, ordinal: 5, attempt_id: job.id, operation: 'answer', provider: job.config.provider, model: job.config.model });
    logEvent('attempt.claimed', { level: 'info', state: 'running' });
    logEvent('attempt.started', { level: 'info', state: 'running', material_count: job.input.materials?.length ?? 0 });
    const cancellation = watchTaskCancellation(pool, job.id, signal, false);
    signal = cancellation.signal;
    const stopHeartbeat = startAttemptHeartbeat(pool, { component: 'answer', project_id: job.project_id, workflow_id: job.workflow_id, ordinal: 5, attempt_id: job.id }, '作答任务心跳写入失败');
    let wrote = false;
    try {
        resumeStepFailure();
        // 调用前校验冻结请求；模型完成后直接保存返回结果，不再复核当前题目或模型集合。
        const packaged: AnswerPackage = { question_version: job.input.question_version, question: job.input.question, materials: job.input.materials, attachments: job.input.attachments, ...(job.input.answer_requirements?{answer_requirements:job.input.answer_requirements}:{}), ...(typeof job.input.system_prompt === 'string' ? { system_prompt: job.input.system_prompt } : {}), ...(job.input.presentation ? { presentation: job.input.presentation } : {}), ...(job.input.material_origin ? { material_origin: job.input.material_origin } : {}) };
        const before = await pool.connect();
        try {
            await before.query('BEGIN');
            const w = (await before.query(activeWorkflow, [job.workflow_id])).rows[0];
            if (!w || !await matchesQuestion(before, job,w))
                throw new AnswerInputError('题目或项目模型配置已变化');
            await before.query('COMMIT');
        }
        catch (error) {
            await before.query('ROLLBACK');
            throw error;
        }
        finally {
            before.release();
        }
        const generationPolicy = resolveAnswerGenerationPolicy(job.input.answer_generation_policy);
        const callSettings = resolveAnswerCallSettings(generationPolicy);
        await emitLifecycle(pool,'before', {stage:'answer',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal});
        const hookContext = { pool, attempt_id: job.id, workflow_id: job.workflow_id, stage: 'answer' as const, binding_digest: createHash('sha256').update(canonicalJson({ input: job.input.input_digest, config: job.config, generation_policy: generationPolicy })).digest('hex'), input: { question: buildAnswerMessage(packaged), materials: packaged.materials }, hooks: job.input.hooks, signal };
        const answerConfig = resolveAnswerConfig(job.config), attemptDirectory = join(resolve(root), job.workflow_id, job.id);
        const result = await executeWithStageHooks({ ...hookContext, runMain: () => runExternalCall({ attempt_id: job.id, operation: 'answer' }, call_id => answer({ config: answerConfig, question: buildAnswerMessage(packaged), materials: packaged.materials, system_prompt: job.input.system_prompt, signal, call_id, timeout_ms: callSettings.timeout_ms, ...((isAgentProviderConfig(answerConfig)||answerConfig.local_tools?.length) ? { directory: attemptDirectory } : {}), ...(callSettings.observe_reasoning ? { observe_reasoning: true } : {}) })), outputForHooks: value => ({ text: value.text }) });
        const directory = join(resolve(root), job.workflow_id, job.id);
        await mkdir(directory, { recursive: true });
        const bytes = Buffer.from(result.text);
        const path = join(directory, 'answer.txt');
        wrote = true;
        logEvent('file.write.started', { level: 'info', file_kind: 'model_answer', output_bytes: bytes.length });
        await writeFile(path, bytes, { mode: 0o600 });
        logEvent('file.write.completed', { level: 'info', file_kind: 'model_answer', output_bytes: bytes.length });
        const answer_sha256 = createHash('sha256').update(bytes).digest('hex');
        const generatedArtifacts=!isAgentProviderConfig(answerConfig)&&answerConfig.local_tools?.includes('artifact_write')?await readGeneratedAnswerArtifacts(attemptDirectory):[];
        if(job.input.answer_requirements?.output_mode==='file'){
            const calls=Array.isArray(result.tool_trace?.calls)?result.tool_trace.calls:[];
            if(!generatedArtifacts.length||!calls.some(call=>call.type==='artifact_write'&&call.status==='completed')||!calls.some(call=>call.type==='artifact_render'&&call.status==='completed'))throw new Error('文件型作答未完成受管生成与读回校验');
        }
        const artifactMetadata=generatedArtifacts.map(item=>({filename:item.filename,format:item.format,media_type:item.media_type,sha256:item.sha256,source_sha256:item.source_sha256,size_bytes:item.size_bytes}));
        const publication = { ...result, provider: answerConfig.provider ?? 'qwen', mode: result.execution_mode === 'agent' ? `agent:${result.reasoning_effort ?? 'configured'}` : job.config.enable_thinking === undefined ? 'provider_default' : job.config.enable_thinking ? 'thinking_enabled' : 'thinking_disabled', model_id: job.input.model_id ?? null, model_name: job.input.model_name ?? null, answer_sha256, input_digest: job.input.input_digest, question_version: job.input.question_version, question_attempt_id: job.input.question_attempt_id, output_mode: job.input.answer_requirements?.output_mode??'text', execution_steps: result.execution_steps ?? null,generated_artifacts:artifactMetadata, ...(job.input.presentation ? { answer_presentation: job.input.presentation } : {}) };
        const tx = await pool.connect();
        try {
            await tx.query('BEGIN');
            // 原样保存答案内容，但已取消/删除任务不再具有发布权；不重新审查当前题目或模型内容。
            const owner=await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE", [job.id]);
            if(!owner.rows.length)throw new Error('作答任务已取消或移除');
            await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [crypto.randomUUID(), job.workflow_id, job.id, 'model_answer', relative(resolve(root), path), answer_sha256, bytes.length, executionTarget === 'server' ? result.text : null]);
            for(const item of generatedArtifacts)await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),job.workflow_id,job.id,'model_answer_file',relative(resolve(root),join(attemptDirectory,'artifacts',item.filename)),item.sha256,item.size_bytes,item.content]);
            await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE id=$1", [job.id, JSON.stringify(publication)]);
            job.status = 'succeeded';
            job.result = publication;
            await refreshAnswerStep(tx, job);
            await prepareCommittedStageHooks({...hookContext,pool:tx}, { text: result.text });
            await tx.query('COMMIT');forgetLocalRegistrations(tx);
            logEvent('attempt.completed', { level: 'info', state: 'succeeded', output_bytes: bytes.length, token_usage: result.usage });
        }
        catch (error) {
            await tx.query('ROLLBACK');await releaseRolledBackRegistrations(tx);
            throw error;
        }
        finally {
            tx.release();
        }
        await runCommittedStageHooks(hookContext, { text: result.text });
        await emitLifecycle(pool,'committed', {stage:'answer',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal,data:{result:publication}});
    }
    catch (error) {
        deferLocalPublication(error);
        await emitLifecycle(pool,signal?.aborted?'cancelled':'failed', {stage:'answer',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal});
        let qualifiedTimeout = false;
        try {
            qualifiedTimeout = isQualifiedLongGenerationTimeout(error, resolveAnswerGenerationPolicy(job.input.answer_generation_policy));
        }
        catch {
            qualifiedTimeout = false;
        }
        if (qualifiedTimeout)
            logEvent('attempt.long_generation_timeout_unscored', { level: 'warn', state: 'skipped', ...classifyLogError(error) });
        else
            logEvent('attempt.failed', { level: 'error', state: 'failed', ...classifyLogError(error) });
        // 本地恢复直接复用原终态，随后仍核对当前题目/模型集合才更新步骤汇总。
        const failure = saveStepFailure(buildAnswerFailure(error, job, qualifiedTimeout));
        const { message, result, status: terminal } = failure;
        if (wrote)
            try {
                const published = await pool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 LIMIT 1', [job.id]);
                if (!published.rowCount)
                    await rm(join(resolve(root), job.workflow_id, job.id), { recursive: true, force: true });
            }
            catch (cleanupError) {
                logEvent('file.cleanup_or_commit_check_failed', { level: 'error', file_kind: 'model_answer', ...classifyLogError(cleanupError) });
                console.error('无法确认答案发布状态，保留文件等待核对');
            }
        const tx = await pool.connect();
        try {
            await tx.query('BEGIN');
            const w = (await tx.query(activeWorkflow, [job.workflow_id])).rows[0];
            const updated = await tx.query("UPDATE ai_distill.step_attempts SET status=$4,error=$2,result=$3,finished_at=now() WHERE id=$1 AND status='running'", [job.id, message, JSON.stringify(result), terminal]);
            if (updated.rowCount && w && await matchesQuestion(tx, job)) {
                job.status = terminal;
                job.result = result;
                await refreshAnswerStep(tx, job);
            }
            await tx.query('COMMIT');forgetLocalRegistrations(tx);
        }
        catch (failure) {
            await tx.query('ROLLBACK');await releaseRolledBackRegistrations(tx);
            throw failure;
        }
        finally {
            tx.release();
        }
        if (qualifiedTimeout)
            try {
                await runAcceptance(pool, job.workflow_id);
            }
            catch (decisionError) {
                logEvent('acceptance.auto_failed', { level: 'error', workflow_id: job.workflow_id, ...classifyLogError(decisionError) });
            }
    }
    finally {
        cancellation.dispose();
        stopHeartbeat();
        restoreLogContext();
    }
    return true;
}
