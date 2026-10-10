/**
 * 职责：出题队列：记录步骤设置、当前项目文件与数据库脱敏附件，执行出题并维护返修血缘。
 * 关键方法与用途：`enqueueAuthoring()` 创建冻结输入任务；`runNextAuthoring()` 消费出题任务；`findRubricBaseline()` 查找可继承题面基线。
 * 使用场景：`app.ts` 负责用户派发，`worker.ts` 负责后台消费和结果提交；新输入不向 Codex 暴露原始附件路径。
 */
import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {readRevisionSettings} from '../decisions/revision-binding';
import {runRevisionCall} from '../decisions/revision-calls';
import {runAgent} from '../agent';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import {mergeCodexDefaults,readConfiguredAgentModelCatalog,readProjectAgentDefaults} from '../agent/config';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {validateStepConfig} from '../project-folders';
import {readRuleFile,readProjectPrompt,scanProjectPrompt,verifyRuleSnapshot,type ProjectPromptSnapshot} from '../rule-files';
import {DEFAULT_STEP_PROMPTS} from '../../shared/step-prompts';
import {renderPublicQuestionPackage,runAuthoring,UnsupportedAnswerRequirementsError,FRESH_AUTHORING_CONTRACT,type AuthoringResult,type AuthoringRule} from './executor';
import {readPrivateDraft} from './private-draft';
import {validateDraft,type Draft} from './validate';

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const workflowSql="SELECT w.project_id,w.title,w.source_key,w.source_manifest,w.rule_version_id,p.name AS project_name,p.local_skill_path,p.material_root,s1.status AS ingestion_status,s9.status AS redaction_status\n FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL\n JOIN ai_distill.steps s1 ON s1.workflow_id=w.id AND s1.ordinal=1 JOIN ai_distill.steps s9 ON s9.workflow_id=w.id AND s9.ordinal=9\n WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w";
export interface RevisionAuthoringInput {mode:'question'|'rubric';source_attempt_id:string;chain_id:string;round_id:string;evidence:unknown}
interface FrozenInput {project_name?:string;revision?:RevisionAuthoringInput;authoring_contract?:string;evaluation_feedback?:unknown;input_revision?:number;title:string;question_id?:string;source_files?:{name:string;path:string}[];project_prompt?:ProjectPromptSnapshot;rule_version_id?:string;rule_attempt_id?:string;rule_source_digest?:string;rule_snapshot_path?:string;rule_files?:{path:string;sha256:string;size_bytes:number}[];redaction_attempt_id:string;materials:{id:string;sha256:string}[];digest:string}
const canonicalJSON=(value:unknown)=>JSON.stringify(value,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
const sourceFiles=(workflow:any)=>Array.isArray(workflow.source_manifest)?workflow.source_manifest.filter((file:any)=>typeof file?.name==='string'&&typeof file?.path==='string').map((file:any)=>({name:file.name,path:file.path})):[];
const questionId=(workflow:any)=>typeof workflow.source_key==='string'&&workflow.source_key.trim()?workflow.source_key:workflow.title;
export const inputDigest=(input:Omit<FrozenInput,'digest'>)=>hash(JSON.stringify(input.rule_version_id?{...(input.project_name!==undefined?{project_name:input.project_name}:{}),...(Number.isInteger(input.input_revision)&&input.input_revision!>0?{input_revision:input.input_revision}:{}),title:input.title,...(input.question_id?{question_id:input.question_id}:{}),...(input.source_files?{source_files:input.source_files}:{}),rule_version_id:input.rule_version_id,rule_attempt_id:input.rule_attempt_id,rule_source_digest:input.rule_source_digest,rule_snapshot_path:input.rule_snapshot_path,rule_files:(input.rule_files??[]).map(file=>({path:file.path,sha256:file.sha256,size_bytes:file.size_bytes})),redaction_attempt_id:input.redaction_attempt_id,materials:input.materials.map(item=>({id:item.id,sha256:item.sha256})),...(input.authoring_contract?{authoring_contract:input.authoring_contract}:{}),...(input.revision?{revision:JSON.parse(canonicalJSON(input.revision))}:{}),...(input.evaluation_feedback?{evaluation_feedback:JSON.parse(canonicalJSON(input.evaluation_feedback))}:{})}:{...(input.project_name!==undefined?{project_name:input.project_name}:{}),...(Number.isInteger(input.input_revision)&&input.input_revision!>0?{input_revision:input.input_revision}:{}),title:input.title,...(input.question_id?{question_id:input.question_id}:{}),...(input.source_files?{source_files:input.source_files}:{}),project_prompt:input.project_prompt?{workspace_path:input.project_prompt.workspace_path,skill_path:input.project_prompt.skill_path,source_digest:input.project_prompt.source_digest,files:input.project_prompt.files.map(file=>({path:file.path,sha256:file.sha256,size_bytes:file.size_bytes}))}:null,redaction_attempt_id:input.redaction_attempt_id,materials:input.materials.map(item=>({id:item.id,sha256:item.sha256})),...(input.authoring_contract?{authoring_contract:input.authoring_contract}:{}),...(input.revision?{revision:JSON.parse(canonicalJSON(input.revision))}:{}),...(input.evaluation_feedback?{evaluation_feedback:JSON.parse(canonicalJSON(input.evaluation_feedback))}:{})}));

/** Resolve accepted attempt references before freezing authoring input; old evaluations remain summary-only. */
export async function hydrateRevisionEvaluationEvidence(db:PoolClient,workflowId:string,evidence:unknown){
 if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))return evidence;
 const source=evidence as Record<string,unknown>,records=Array.isArray(source.evaluation_records)?source.evaluation_records:[];
 if(!records.length)return evidence;
 const refs=records.flatMap((record:any)=>Array.isArray(record?.models)?record.models:[]);
 const answerIds=[...new Set(refs.map((model:any)=>model?.answer_attempt_id).filter((id:any):id is string=>typeof id==='string'))];
 const scoreIds=[...new Set(refs.map((model:any)=>model?.score_attempt_id).filter((id:any):id is string=>typeof id==='string'))];
 const answers=answerIds.length?(await db.query("SELECT id,status,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND id=ANY($2::uuid[])",[workflowId,answerIds])).rows:[];
 const scores=scoreIds.length?(await db.query("SELECT id,status,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND id=ANY($2::uuid[])",[workflowId,scoreIds])).rows:[];
 const answerById=new Map(answers.map((row:any)=>[row.id,row])),scoreById=new Map(scores.map((row:any)=>[row.id,row]));
 const hydrated=records.map((record:any)=>({...record,models:(Array.isArray(record.models)?record.models:[]).map((model:any)=>{
  if(typeof model?.answer_attempt_id!=='string'||typeof model?.score_attempt_id!=='string')return {...model,details_available:false};
  const answer=answerById.get(model.answer_attempt_id),score=scoreById.get(model.score_attempt_id);
  if(!answer||!score||answer.status!=='succeeded'||score.status!=='succeeded')return {...model,details_available:false};
  const answerResult=answer.result as Record<string,any>,scoreInput=score.input as Record<string,any>,scoreResult=score.result as Record<string,any>,binding=scoreInput?.context?.binding;
  const answerText=answerResult?.text,scoreText=typeof scoreResult?.raw_text==='string'?scoreResult.raw_text:scoreResult?.report?JSON.stringify(scoreResult.report):undefined;
  const versionsMatch=(!model.question_version||answerResult?.question_version===model.question_version)&&(!model.rubric_version||binding?.rubric_version===model.rubric_version);
  if(typeof answerText!=='string'||typeof scoreText!=='string'||scoreResult?.validation?.valid!==true||binding?.answer_attempt_id!==answer.id||!versionsMatch||model.answer_sha256&&hash(answerText)!==model.answer_sha256||model.score_sha256&&hash(scoreText)!==model.score_sha256)return {...model,details_available:false};
  return {...model,details_available:true,answer_text:answerText,score_text:scoreText,score_text_source:typeof scoreResult.raw_text==='string'?'raw_text':'structured_report',score_report:scoreResult.report??null};
 })}));
 return {...source,evaluation_records:hydrated};
}

async function basePrerequisites(db:PoolClient,id:string){
 const workflow=(await db.query(workflowSql,[id])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
 if(workflow.ingestion_status!=='succeeded'||workflow.redaction_status!=='succeeded')throw new HTTPException(409,{message:'请先完成当前附件入库与脱敏'});
 const redaction=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[id])).rows[0];
 if(!redaction)throw new HTTPException(409,{message:'当前题目没有成功的脱敏记录'});
 const artifacts=await db.query("SELECT ar.id,ar.sha256 FROM ai_distill.artifacts ar WHERE ar.workflow_id=$1 AND ar.attempt_id=$2 AND ar.kind='redacted_markdown' ORDER BY ar.created_at,ar.id",[id,redaction.id]);
 if(!artifacts.rowCount||artifacts.rows.some(row=>typeof row.sha256!=='string'||! /^[a-f0-9]{64}$/.test(row.sha256)))throw new HTTPException(409,{message:'当前版本没有可用于出题的脱敏文本'});
 return {workflow,redaction,materials:artifacts.rows as {id:string;sha256:string}[]};
}
async function prerequisites(db:PoolClient,id:string){
 const source=await basePrerequisites(db,id),workflow=source.workflow;
 if(typeof workflow.local_skill_path!=='string'||!workflow.local_skill_path)throw new HTTPException(409,{message:'请先为本项目设置本地 skill 目录'});
 const project_prompt=await scanProjectPrompt(dirname(workflow.material_root??workflow.local_skill_path),workflow.local_skill_path);
 return{...source,project_prompt};
}
async function legacyRules(db:PoolClient,id:string,workflow:any){
 const rules=(await db.query("SELECT id,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=3 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[id])).rows[0];
 if(!rules||rules.result?.rule_version_id!==workflow.rule_version_id||typeof rules.result?.source_digest!=='string'||!Array.isArray(rules.result?.files)||!rules.result?.snapshot_path)throw new HTTPException(409,{message:'旧任务绑定的规则快照不完整'});
 await verifyRuleSnapshot(rules.result.snapshot_path,rules.result.files);
 return rules;
}

/**
 * 校验当前项目文件与数据库脱敏材料后，固定题目、附件清单和步骤配置并创建 ordinal 4 尝试。
 * 相同输入的活动任务会复用；出题成功后再次点击会新建尝试，并使后续结果失效。
 */
export async function enqueueAuthoring(pool:Pool,id:string,revision?:RevisionAuthoringInput,roundId?:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');const source=await prerequisites(db,id);
  const settings=await readRevisionSettings(db,id,revision?.round_id??roundId);
  const raw=settings?settings.configs?.['4']:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=4',[source.workflow.project_id])).rows[0]?.config;
  const config=validateStepConfig(4,mergeCodexDefaults(raw,await readProjectAgentDefaults(db,source.workflow.project_id)),await readConfiguredAgentModelCatalog(db));
  const loggingConfig=config as {model?:string;reasoning_effort?:string};
  if(revision){
   const round=(await db.query("SELECT r.id FROM ai_distill.revision_rounds r JOIN ai_distill.revision_chains c ON c.id=r.chain_id WHERE r.id=$1 AND c.id=$2 AND c.workflow_id=$3 AND c.status IN ('waiting','running') AND r.status IN ('waiting','running')",[revision.round_id,revision.chain_id,id])).rows[0];
   if(!round||!revision.source_attempt_id||!['question','rubric'].includes(revision.mode)||!revision.evidence)throw new HTTPException(409,{message:'返修轮次或来源无效'});
  }
  const frozenRevision=revision?{...revision,evidence:await hydrateRevisionEvaluationEvidence(db,id,revision.evidence)}:undefined;
  const frozen:Omit<FrozenInput,'digest'>={project_name:source.workflow.project_name,...(frozenRevision?{revision:frozenRevision}:{}),...(!revision?{authoring_contract:FRESH_AUTHORING_CONTRACT}:{}),title:source.workflow.title,question_id:questionId(source.workflow),source_files:sourceFiles(source.workflow),project_prompt:source.project_prompt,redaction_attempt_id:source.redaction.id,materials:source.materials};
  const input:FrozenInput={...frozen,digest:inputDigest(frozen)};
  const previous=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input->>'digest'=$2 AND config=$3::jsonb AND status IN ('waiting','running') ORDER BY attempt DESC LIMIT 1",[id,input.digest,JSON.stringify(config)])).rows[0];
  if(previous){await db.query('COMMIT');withLogContext({component:'authoring',workflow_id:id,project_id:source.workflow.project_id,ordinal:4,attempt_id:previous.id,operation:'authoring_enqueue',provider:'codex',model:loggingConfig.model,reasoning_effort:loggingConfig.reasoning_effort},()=>logEvent('attempt.reused',{level:'info',state:'reused'}));return{id:previous.id,reused:true};}
  if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status IN ('waiting','running') LIMIT 1",[id])).rowCount)throw new HTTPException(409,{message:'此题目已有出题任务'});
  const attempt=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config) SELECT $2,$1::uuid,4,COALESCE(max(attempt),0)+1,'waiting',$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=4",[id,attempt,JSON.stringify(input),JSON.stringify(config)]);
  if(revision||roundId)await db.query('UPDATE ai_distill.step_attempts SET revision_round_id=$2 WHERE id=$1',[attempt,revision?.round_id??roundId]);
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=4",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>4 AND ordinal<=8 AND ($2::boolean=false OR ordinal<>5)",[id,revision?.mode==='rubric']);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='题目或评分标准更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>4 AND ordinal<=8 AND ($2::boolean=false OR ordinal<>5) AND status IN ('waiting','running')",[id,revision?.mode==='rubric']);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');withLogContext({component:'authoring',workflow_id:id,project_id:source.workflow.project_id,ordinal:4,attempt_id:attempt,operation:'authoring_enqueue',provider:'codex',model:loggingConfig.model,reasoning_effort:loggingConfig.reasoning_effort},()=>logEvent('attempt.enqueued',{level:'info',state:'waiting',material_count:input.materials.length}));return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

async function currentBindings(db:PoolClient,job:any){
 try{
 const source:Awaited<ReturnType<typeof basePrerequisites>>&{project_prompt?:ProjectPromptSnapshot}=job.input?.rule_version_id?await basePrerequisites(db,job.workflow_id):await prerequisites(db,job.workflow_id);
 let candidate:Omit<FrozenInput,'digest'>;
 if(job.input?.rule_version_id){
  const rules=await legacyRules(db,job.workflow_id,source.workflow);
  if(rules.id!==job.input.rule_attempt_id||rules.result?.source_digest!==job.input.rule_source_digest||rules.result?.snapshot_path!==job.input.rule_snapshot_path)return false;
  candidate={...(job.input.project_name!==undefined?{project_name:source.workflow.project_name}:{}),...(Number.isInteger(job.input.input_revision)&&job.input.input_revision>0?{input_revision:job.input.input_revision}:{}),title:source.workflow.title,...(job.input.question_id?{question_id:questionId(source.workflow),source_files:sourceFiles(source.workflow)}:{}),rule_version_id:rules.result.rule_version_id,rule_attempt_id:rules.id,rule_source_digest:rules.result.source_digest,rule_snapshot_path:rules.result.snapshot_path,rule_files:rules.result.files,redaction_attempt_id:source.redaction.id,materials:source.materials};
 }else{
  if(!source.project_prompt)return false;
  candidate={...(job.input.project_name!==undefined?{project_name:source.workflow.project_name}:{}),...(Number.isInteger(job.input.input_revision)&&job.input.input_revision>0?{input_revision:job.input.input_revision}:{}),title:source.workflow.title,...(job.input.question_id?{question_id:questionId(source.workflow),source_files:sourceFiles(source.workflow)}:{}),project_prompt:source.project_prompt,redaction_attempt_id:source.redaction.id,materials:source.materials};
 }
 return source.workflow.title===job.input.title&&inputDigest({...candidate,...(job.input.authoring_contract?{authoring_contract:job.input.authoring_contract}:{}),...(job.input.revision?{revision:job.input.revision}:{}),...(job.input.evaluation_feedback?{evaluation_feedback:job.input.evaluation_feedback}:{})})===job.input.digest;
 }catch(error){if(error instanceof HTTPException&&[404,409].includes(error.status))return false;throw error;}
}

async function readMaterials(pool:Pool,_root:string,job:any){
 const result=[];
 for(const item of job.input.materials){
  const row=(await pool.query("SELECT sha256,content FROM ai_distill.artifacts WHERE id=$1 AND workflow_id=$2 AND attempt_id=$3 AND kind='redacted_markdown'",[item.id,job.workflow_id,job.input.redaction_attempt_id])).rows[0];
  if(!row||row.sha256!==item.sha256)throw new Error('stale material');
  if(typeof row.content!=='string')throw new Error('redacted database content missing');
  const bytes=Buffer.from(row.content);if(bytes.length>30*1024*1024)throw new Error('invalid material content');
  if(hash(bytes)!==item.sha256)throw new Error('changed material');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.trim())throw new Error('empty material');result.push({id:item.id,sha256:item.sha256,text});
 }
 return result;
}
async function readRules(job:any):Promise<AuthoringRule[]>{
 const root=job.input.rule_snapshot_path,files=job.input.rule_files;
 if(files.some((file:{path:string})=>!file.path.startsWith('skill/')))throw new HTTPException(409,{message:'旧任务包含非 skill 项目资料，请重新出题'});
 await verifyRuleSnapshot(root,files);
 const result:AuthoringRule[]=[];
 for(const file of files){const bytes=await readRuleFile(root,file.path);if(hash(bytes)!==file.sha256)throw new Error('changed rules');result.push({path:file.path,bytes});}
 if(!result.some(file=>file.path==='skill/SKILL.md'))throw new Error('missing frozen skill');
 return result;
}
async function readProjectContext(job:any):Promise<AuthoringRule[]>{
 if(!job.input?.project_prompt)return readRules(job);
 const files=await readProjectPrompt(job.input.project_prompt);
 return files.map(file=>({path:file.path,bytes:file.bytes}));
}

export async function findRubricBaseline(pool:Pool,workflowId:string,source:any,draft:Draft){
 const visited=new Set<string>();let candidate=source;
 while(candidate?.status!=='succeeded'&&candidate?.input?.revision?.mode==='rubric'){
  if(visited.has(candidate.id))throw new Error('cyclic rubric revision lineage');
  visited.add(candidate.id);
  candidate=(await pool.query("SELECT id,result,status,input FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2 AND ordinal=4",[candidate.input.revision.source_attempt_id,workflowId])).rows[0];
 }
 if(candidate?.status==='succeeded'&&draft.task_name===candidate.result.task_name&&draft.task_type===candidate.result.task_type&&canonicalJSON(draft.header)===canonicalJSON(candidate.result.header)&&draft.question===candidate.result.question&&JSON.stringify(draft.attachment_ids)===JSON.stringify(candidate.result.attachment_ids)&&canonicalJSON(draft.answer_requirements)===canonicalJSON(candidate.result.answer_requirements))return candidate;
 return undefined;
}

type Authorer=(options:Parameters<typeof runAuthoring>[0])=>Promise<AuthoringResult>;
async function stillCurrent(pool:Pool,job:any){
 const db=await pool.connect();try{await db.query('BEGIN');const current=await currentBindings(db,job);await db.query('COMMIT');return current;}catch(error){await db.query('ROLLBACK');if(error instanceof HTTPException&&[404,409].includes(error.status))return false;throw error;}finally{db.release();}
}
/**
 * 领取当前版本出题尝试，普通模式在项目cwd执行、返修保持隔离，并将完整草稿存入数据库；作答输入单独筛选题面与附件。
 * 提交前再次核对任务输入、项目文件和材料绑定，只有仍匹配的结果才能更新 ordinal 4 状态。
 */
export async function runNextAuthoring(pool:Pool,root:string,author:Authorer=runAuthoring,signal?:AbortSignal){
 if(signal?.aborted)return false;
 const db=await pool.connect();let job:any,staleRows:any[]=[];
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.workflow_id,a.heartbeat_at,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=4 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED");
  for(const row of stale.rows){const updated=await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='出题进程中断，可重试',finished_at=now() WHERE id=$1 AND status='running' RETURNING id",[row.id]);await db.query("UPDATE ai_distill.steps SET status='failed',error='出题进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=4 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1)",[row.workflow_id]);if(updated.rowCount)staleRows.push(row);}
  job=(await db.query("SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=4 AND a.status='waiting' ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1")).rows[0];
  if(!job){await db.query('COMMIT');for(const row of staleRows)withLogContext({component:'authoring',project_id:row.project_id,workflow_id:row.workflow_id,ordinal:4,attempt_id:row.id,operation:'authoring'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));return false;}
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);await db.query("UPDATE ai_distill.steps SET status='running',error=NULL,started_at=now() WHERE workflow_id=$1 AND ordinal=4",[job.workflow_id]);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 for(const row of staleRows)withLogContext({component:'authoring',project_id:row.project_id,workflow_id:row.workflow_id,ordinal:4,attempt_id:row.id,operation:'authoring'},()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Date(row.heartbeat_at).toISOString()}:{})}));
 const restoreLogContext=enterLogContext({component:'authoring',workflow_id:job.workflow_id,project_id:job.project_id,ordinal:4,attempt_id:job.id,operation:'authoring',provider:'codex',model:job.config?.model,reasoning_effort:job.config?.reasoning_effort});
 logEvent('attempt.claimed',{level:'info',state:'running'});logEvent('attempt.started',{level:'info',state:'running',material_count:job.input?.materials?.length??0});
 const cancellation=watchTaskCancellation(pool,job.id,signal,false);signal=cancellation.signal;
 let heartbeatFailed=false,lastHeartbeatAt=new Date().toISOString();
 const heartbeat=setInterval(()=>{withLogContext({component:'authoring',project_id:job.project_id,workflow_id:job.workflow_id,ordinal:4,attempt_id:job.id},()=>pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running' RETURNING id",[job.id]).then(result=>{if(!result.rowCount){if(!heartbeatFailed)logEvent('heartbeat.write_failed',{level:'warn',reason_code:'attempt_not_running',last_heartbeat_at:lastHeartbeatAt});heartbeatFailed=true;}else{if(heartbeatFailed)logEvent('heartbeat.write_recovered',{level:'info',elapsed_ms:Math.max(0,Date.now()-Date.parse(lastHeartbeatAt))});heartbeatFailed=false;lastHeartbeatAt=new Date().toISOString();}}).catch(error=>{if(!heartbeatFailed){logEvent('heartbeat.write_failed',{level:'error',last_heartbeat_at:lastHeartbeatAt,...classifyLogError(error)});console.error('第四步任务心跳写入失败');}heartbeatFailed=true;}));},10000);
 const directory=join(resolve(root),job.workflow_id,job.id);let output:string|undefined,packageBytes:Buffer|undefined;
 try{
  if(!job.input||inputDigest((( {digest,...frozen}:FrozenInput)=>frozen)(job.input))!==job.input.digest)throw new Error('invalid snapshot');
  if(!job.input.revision&&(job.input.authoring_contract!==FRESH_AUTHORING_CONTRACT||Object.hasOwn(job.input,'evaluation_feedback')))throw Object.assign(new Error('普通出题任务契约已更新，请重新派发'),{reason_code:'authoring_contract_changed'});
  if(!await stillCurrent(pool,job))throw new Error('stale input');
  const materials=await readMaterials(pool,root,job);const projectContextFiles=await readProjectContext(job);
  if(job.config?.provider!=='codex'||typeof job.config.model!=='string'||!job.config.model.trim()||typeof job.config.reasoning_effort!=='string'||!['low','medium','high','xhigh','max','ultra'].includes(job.config.reasoning_effort))throw new Error('invalid frozen config');
  let revisionSource:any;
  let revisionOptions:Parameters<typeof runAuthoring>[0]['revision'];
  if(job.input.revision){
   const old=(await pool.query("SELECT id,result,status,input FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2 AND ordinal=4",[job.input.revision.source_attempt_id,job.workflow_id])).rows[0];
   if(!old)throw new Error('missing revision source');
   revisionSource=old;
   const sourceMaterials=job.input.revision.mode==='question'&&Array.isArray(old.input?.materials)?old.input.materials.map((item:any)=>({id:item.id,text:'历史附件引用，仅作版本校验'})):materials;
   const draft=await readPrivateDraft(root,job.workflow_id,old.id,sourceMaterials,old.result);
   if(old.status==='succeeded'&&(draft.task_name!==old.result.task_name||draft.task_type!==old.result.task_type||canonicalJSON(draft.header)!==canonicalJSON(old.result.header)||draft.question!==old.result.question||canonicalJSON(draft.rubric)!==canonicalJSON(old.result.rubric)||JSON.stringify(draft.attachment_ids)!==JSON.stringify(old.result.attachment_ids)))throw new Error('private source changed');
   if(old.status!=='succeeded'&&old.input?.revision?.mode==='rubric'){
    const baseline=await findRubricBaseline(pool,job.workflow_id,old,draft);
    if(baseline)revisionSource=baseline;
   }
   revisionOptions={mode:job.input.revision.mode,source_attempt_id:old.id,evidence:job.input.revision.evidence,draft};
  }
  logEvent('attempt.input_validated',{level:'info',material_count:materials.length});
  const legacyRulesInput=job.input.rule_version_id?{version_id:job.input.rule_version_id,source_digest:job.input.rule_source_digest,files:projectContextFiles}:undefined;
  const result=await author({...(revisionOptions?{revision:revisionOptions}:{}),...(!revisionOptions?{workspace_path:job.input.project_prompt.workspace_path}:{}),root:join(directory,'private'),project_name:job.input.project_name,question:job.input.title,question_id:job.input.question_id??job.input.title,source_files:job.input.source_files??[],materials,...(legacyRulesInput?{rules:legacyRulesInput}:{project_context:{source_digest:job.input.project_prompt.source_digest,files:projectContextFiles}}),step_prompt:job.config.prompt??DEFAULT_STEP_PROMPTS[4],model:job.config.model,reasoning_effort:job.config.reasoning_effort,signal,execute:options=>runRevisionCall(pool,job.id,'author',(remaining,call_id)=>runAgent({...options,call_id,task_type:'question_authoring',timeout_ms:Math.min(options.timeout_ms??1800000,remaining??1800000)}))});
  const draft=result.draft;
  if(revisionOptions?.mode==='rubric'){
   const old=revisionOptions.draft;
   if(draft.task_name!==old.task_name||draft.task_type!==old.task_type||canonicalJSON(draft.header)!==canonicalJSON(old.header)||draft.question!==old.question||JSON.stringify(draft.attachment_ids)!==JSON.stringify(old.attachment_ids)||JSON.stringify(draft.answer_requirements)!==JSON.stringify(old.answer_requirements))throw new Error('rubric-only answer input changed');
   if(result.question_version!==revisionSource.result?.question_version&&revisionSource.status==='succeeded')throw new Error('rubric-only question version changed');
  }
  if(!result.codex.session_id)throw new Error('invalid authoring binding');
  const storedResult={...draft,question_id:result.question_id,question_version:result.question_version,rubric_version:result.rubric_version,codex:{author:result.codex},...(revisionOptions?.mode==='rubric'&&revisionSource.status==='succeeded'?{answer_source_attempt_ids:[revisionSource.id,...(Array.isArray(revisionSource.result.answer_source_attempt_ids)?revisionSource.result.answer_source_attempt_ids:[])]}:{})};
  if(signal?.aborted)throw new Error('cancelled');if(!await stillCurrent(pool,job))throw new Error('stale result');await readMaterials(pool,root,job);
  const publicPackage=Buffer.from(renderPublicQuestionPackage({question:job.input.title,question_id:job.input.question_id,source_files:job.input.source_files??[]},draft));
  const packagePath=join(directory,'authored_question.md');packageBytes=publicPackage;output=packagePath;await mkdir(directory,{recursive:true,mode:0o700});await writeFile(packagePath,publicPackage,{mode:0o600,flag:'w'});
  const tx=await pool.connect();try{await tx.query('BEGIN');if(signal?.aborted||!await currentBindings(tx,job)||!(await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id])).rowCount)throw new Error('inactive');if(revisionOptions?.mode==='rubric'&&revisionSource.status!=='succeeded')await tx.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=5",[job.workflow_id]);await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,session_id=$3,error=NULL,finished_at=now() WHERE id=$1",[job.id,JSON.stringify(storedResult),result.codex.session_id]);await tx.query("UPDATE ai_distill.steps SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=4",[job.workflow_id,JSON.stringify(storedResult)]);await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),job.workflow_id,job.id,'authored_question',relative(resolve(root),packagePath),hash(publicPackage),publicPackage.length,publicPackage.toString('utf8')]);await tx.query('COMMIT');logEvent('attempt.completed',{level:'info',state:'succeeded'});}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch(error){
  if(output)try{const artifact=await pool.query("SELECT id FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind='authored_question'",[job.workflow_id,job.id]);if(!artifact.rowCount)await rm(output,{force:true});}catch(cleanupError){logEvent('file.cleanup_or_commit_check_failed',{level:'error',file_kind:'authored_question',...classifyLogError(cleanupError)});}
  logEvent('attempt.failed',{level:'error',state:'failed',...classifyLogError(error)});
  const unsupported=error instanceof UnsupportedAnswerRequirementsError?error.requirements:null;const reasonCode=error&&typeof error==='object'&&'reason_code'in error?(error as {reason_code?:unknown}).reason_code:undefined;const invalidAttachmentReference=reasonCode==='attachment_reference_invalid';const failureMessage=reasonCode==='authoring_contract_changed'?'普通出题任务契约已更新，请重新派发':unsupported?'当前出题执行器仅支持文字输入、文字答案且不执行工具；本次题目要求了不支持的作答形式':invalidAttachmentReference?'出题返回的附件 ID 缺失、重复或不属于本题材料，请检查后重试':'出题执行失败、取消或输入已变化，可检查后重试';const failureResult=unsupported?{error_code:'unsupported_answer_requirements',answer_requirements:unsupported}:invalidAttachmentReference?{error_code:'attachment_reference_invalid',error:'出题返回的附件 ID 缺失、重复或不属于本题材料'}:null;const tx=await pool.connect();try{await tx.query('BEGIN');await currentBindings(tx,job);const failed=await tx.query("UPDATE ai_distill.step_attempts SET status='failed',result=$2,error=$3,finished_at=now() WHERE id=$1 AND status='running'",[job.id,failureResult?JSON.stringify(failureResult):null,failureMessage]);if(failed.rowCount)await tx.query("UPDATE ai_distill.steps SET status='failed',result=$2,error=$3,finished_at=now() WHERE workflow_id=$1 AND ordinal=4 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1 AND w.deleted_at IS NULL) AND (SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1)=$4",[job.workflow_id,failureResult?JSON.stringify(failureResult):null,failureMessage,job.id]);await tx.query('COMMIT');}catch(failure){await tx.query('ROLLBACK');throw failure;}finally{tx.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);restoreLogContext();}
 return true;
}
