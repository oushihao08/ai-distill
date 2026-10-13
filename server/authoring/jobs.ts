/**
 * 职责：出题队列：冻结步骤设置、当前项目文件与数据库脱敏附件，执行出题并保存结果。
 * 关键方法与用途：`enqueueAuthoring()` 创建冻结输入任务；`runNextAuthoring()` 消费任务并提交当前版本结果。
 * 使用场景：`app.ts` 负责用户派发，`worker.ts` 负责后台消费和结果提交；新输入不向 Codex 暴露原始附件路径。
 */
import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {runExternalCall} from '../external-call';
import {runAgent} from '../agent';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import {mergeCodexDefaults,readProjectAgentDefaults} from '../agent/config';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {validateStepConfigForExecution} from '../project-folders';
import {readRuleFile,readProjectPrompt,scanProjectPrompt,verifyRuleSnapshot,type ProjectPromptSnapshot} from '../rule-files';
import {DEFAULT_STEP_PROMPTS} from '../../shared/step-prompts';
import {renderPublicQuestionPackage,runAuthoring,UnsupportedAnswerRequirementsError,FRESH_AUTHORING_CONTRACT,type AuthoringResult,type AuthoringRule} from './executor';

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const workflowSql="SELECT w.project_id,w.title,w.source_key,w.source_manifest,w.rule_version_id,p.name AS project_name,p.local_skill_path,p.material_root,s1.status AS ingestion_status,s9.status AS redaction_status\n FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL\n JOIN ai_distill.steps s1 ON s1.workflow_id=w.id AND s1.ordinal=1 JOIN ai_distill.steps s9 ON s9.workflow_id=w.id AND s9.ordinal=9\n WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w";
interface FrozenInput {project_name?:string;authoring_contract?:string;title:string;question_id?:string;source_files?:{name:string;path:string}[];project_prompt?:ProjectPromptSnapshot;rule_version_id?:string;rule_attempt_id?:string;rule_source_digest?:string;rule_snapshot_path?:string;rule_files?:{path:string;sha256:string;size_bytes:number}[];redaction_attempt_id:string;materials:{id:string;sha256:string}[];digest:string}
const sourceFiles=(workflow:any)=>Array.isArray(workflow.source_manifest)?workflow.source_manifest.filter((file:any)=>typeof file?.name==='string'&&typeof file?.path==='string').map((file:any)=>({name:file.name,path:file.path})):[];
const questionId=(workflow:any)=>typeof workflow.source_key==='string'&&workflow.source_key.trim()?workflow.source_key:workflow.title;
export const inputDigest=(input:Omit<FrozenInput,'digest'>)=>hash(JSON.stringify(input.rule_version_id?{...(input.project_name!==undefined?{project_name:input.project_name}:{}),title:input.title,...(input.question_id?{question_id:input.question_id}:{}),...(input.source_files?{source_files:input.source_files}:{}),rule_version_id:input.rule_version_id,rule_attempt_id:input.rule_attempt_id,rule_source_digest:input.rule_source_digest,rule_snapshot_path:input.rule_snapshot_path,rule_files:(input.rule_files??[]).map(file=>({path:file.path,sha256:file.sha256,size_bytes:file.size_bytes})),redaction_attempt_id:input.redaction_attempt_id,materials:input.materials.map(item=>({id:item.id,sha256:item.sha256})),...(input.authoring_contract?{authoring_contract:input.authoring_contract}:{})}:{...(input.project_name!==undefined?{project_name:input.project_name}:{}),title:input.title,...(input.question_id?{question_id:input.question_id}:{}),...(input.source_files?{source_files:input.source_files}:{}),project_prompt:input.project_prompt?{workspace_path:input.project_prompt.workspace_path,skill_path:input.project_prompt.skill_path,source_digest:input.project_prompt.source_digest,files:input.project_prompt.files.map(file=>({path:file.path,sha256:file.sha256,size_bytes:file.size_bytes}))}:null,redaction_attempt_id:input.redaction_attempt_id,materials:input.materials.map(item=>({id:item.id,sha256:item.sha256})),...(input.authoring_contract?{authoring_contract:input.authoring_contract}:{})}));

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
export async function enqueueAuthoring(pool:Pool,id:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');const source=await prerequisites(db,id);
  const raw=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=4',[source.workflow.project_id])).rows[0]?.config;
  const config=validateStepConfigForExecution(4,mergeCodexDefaults(raw,await readProjectAgentDefaults(db,source.workflow.project_id)));
  const loggingConfig=config as {model?:string;reasoning_effort?:string};
  const frozen:Omit<FrozenInput,'digest'>={project_name:source.workflow.project_name,authoring_contract:FRESH_AUTHORING_CONTRACT,title:source.workflow.title,question_id:questionId(source.workflow),source_files:sourceFiles(source.workflow),project_prompt:source.project_prompt,redaction_attempt_id:source.redaction.id,materials:source.materials};
  const input:FrozenInput={...frozen,digest:inputDigest(frozen)};
  const previous=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input->>'digest'=$2 AND config=$3::jsonb AND status IN ('waiting','running') ORDER BY attempt DESC LIMIT 1",[id,input.digest,JSON.stringify(config)])).rows[0];
  if(previous){await db.query('COMMIT');withLogContext({component:'authoring',workflow_id:id,project_id:source.workflow.project_id,ordinal:4,attempt_id:previous.id,operation:'authoring_enqueue',provider:'codex',model:loggingConfig.model,reasoning_effort:loggingConfig.reasoning_effort},()=>logEvent('attempt.reused',{level:'info',state:'reused'}));return{id:previous.id,reused:true};}
  if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status IN ('waiting','running') LIMIT 1",[id])).rowCount)throw new HTTPException(409,{message:'此题目已有出题任务'});
  const attempt=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config) SELECT $2,$1::uuid,4,COALESCE(max(attempt),0)+1,'waiting',$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=4",[id,attempt,JSON.stringify(input),JSON.stringify(config)]);
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=4",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>4 AND ordinal<=8",[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='题目更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>4 AND ordinal<=8 AND status IN ('waiting','running')",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='题目或评分标准更新',finished_at=now() WHERE project_id=$1 AND status IN ('running','succeeded')",[source.workflow.project_id]);
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
  candidate={...(job.input.project_name!==undefined?{project_name:source.workflow.project_name}:{}),title:source.workflow.title,...(job.input.question_id?{question_id:questionId(source.workflow),source_files:sourceFiles(source.workflow)}:{}),rule_version_id:rules.result.rule_version_id,rule_attempt_id:rules.id,rule_source_digest:rules.result.source_digest,rule_snapshot_path:rules.result.snapshot_path,rule_files:rules.result.files,redaction_attempt_id:source.redaction.id,materials:source.materials};
 }else{
  if(!source.project_prompt)return false;
  candidate={...(job.input.project_name!==undefined?{project_name:source.workflow.project_name}:{}),title:source.workflow.title,...(job.input.question_id?{question_id:questionId(source.workflow),source_files:sourceFiles(source.workflow)}:{}),project_prompt:source.project_prompt,redaction_attempt_id:source.redaction.id,materials:source.materials};
 }
 return source.workflow.title===job.input.title&&inputDigest({...candidate,...(job.input.authoring_contract?{authoring_contract:job.input.authoring_contract}:{})})===job.input.digest;
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

type Authorer=(options:Parameters<typeof runAuthoring>[0])=>Promise<AuthoringResult>;
async function stillCurrent(pool:Pool,job:any){
 const db=await pool.connect();try{await db.query('BEGIN');const current=await currentBindings(db,job);await db.query('COMMIT');return current;}catch(error){await db.query('ROLLBACK');if(error instanceof HTTPException&&[404,409].includes(error.status))return false;throw error;}finally{db.release();}
}
/**
 * 领取当前版本出题尝试，在项目工作目录执行并将完整草稿存入数据库；作答输入单独筛选题面与附件。
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
 let heartbeatInFlight=false;
 const heartbeat=setInterval(()=>{if(heartbeatInFlight)return;heartbeatInFlight=true;withLogContext({component:'authoring',project_id:job.project_id,workflow_id:job.workflow_id,ordinal:4,attempt_id:job.id},()=>pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running' RETURNING id",[job.id]).then(result=>{if(!result.rowCount){if(!heartbeatFailed)logEvent('heartbeat.write_failed',{level:'warn',reason_code:'attempt_not_running',last_heartbeat_at:lastHeartbeatAt});heartbeatFailed=true;}else{if(heartbeatFailed)logEvent('heartbeat.write_recovered',{level:'info',elapsed_ms:Math.max(0,Date.now()-Date.parse(lastHeartbeatAt))});heartbeatFailed=false;lastHeartbeatAt=new Date().toISOString();}}).catch(error=>{if(!heartbeatFailed){logEvent('heartbeat.write_failed',{level:'error',last_heartbeat_at:lastHeartbeatAt,...classifyLogError(error)});console.error('第四步任务心跳写入失败');}heartbeatFailed=true;}).finally(()=>{heartbeatInFlight=false;}));},10000);
 const directory=join(resolve(root),job.workflow_id,job.id);let output:string|undefined,packageBytes:Buffer|undefined,failurePhase='input_validation';
 try{
  if(!job.input||inputDigest((( {digest,...frozen}:FrozenInput)=>frozen)(job.input))!==job.input.digest)throw new Error('invalid snapshot');
  if(job.input.authoring_contract!==FRESH_AUTHORING_CONTRACT)throw Object.assign(new Error('出题任务契约已更新，请重新派发'),{reason_code:'authoring_contract_changed'});
  if(!await stillCurrent(pool,job))throw new Error('stale input');
  const materials=await readMaterials(pool,root,job);const projectContextFiles=await readProjectContext(job);
  if(job.config?.provider!=='codex'||typeof job.config.model!=='string'||!job.config.model.trim()||typeof job.config.reasoning_effort!=='string'||!['low','medium','high','xhigh','max','ultra'].includes(job.config.reasoning_effort))throw new Error('invalid frozen config');
  logEvent('attempt.input_validated',{level:'info',material_count:materials.length});
  const legacyRulesInput=job.input.rule_version_id?{version_id:job.input.rule_version_id,source_digest:job.input.rule_source_digest,files:projectContextFiles}:undefined;
  failurePhase='agent_execution';
  const result=await author({workspace_path:job.input.project_prompt.workspace_path,root:join(directory,'private'),project_name:job.input.project_name,question:job.input.title,question_id:job.input.question_id??job.input.title,source_files:job.input.source_files??[],materials,...(legacyRulesInput?{rules:legacyRulesInput}:{project_context:{source_digest:job.input.project_prompt.source_digest,files:projectContextFiles}}),step_prompt:job.config.prompt??DEFAULT_STEP_PROMPTS[4],model:job.config.model,reasoning_effort:job.config.reasoning_effort,signal,execute:options=>runExternalCall({attempt_id:job.id,operation:'author'},call_id=>runAgent({...options,call_id,task_type:'question_authoring'}))});
  failurePhase='result_validation';
  const draft=result.draft;
  if(!result.codex.session_id)throw new Error('invalid authoring binding');
  const storedResult={...draft,question_id:result.question_id,question_version:result.question_version,rubric_version:result.rubric_version,codex:{author:result.codex}};
  failurePhase='result_persistence';
  if(signal?.aborted)throw new Error('cancelled');if(!await stillCurrent(pool,job))throw new Error('stale result');await readMaterials(pool,root,job);
  const publicPackage=Buffer.from(renderPublicQuestionPackage({question:job.input.title,question_id:job.input.question_id,source_files:job.input.source_files??[]},draft));
  const packagePath=join(directory,'authored_question.md');packageBytes=publicPackage;output=packagePath;await mkdir(directory,{recursive:true,mode:0o700});await writeFile(packagePath,publicPackage,{mode:0o600,flag:'w'});
  const tx=await pool.connect();try{await tx.query('BEGIN');if(signal?.aborted||!await currentBindings(tx,job)||!(await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id])).rowCount)throw new Error('inactive');await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,session_id=$3,error=NULL,finished_at=now() WHERE id=$1",[job.id,JSON.stringify(storedResult),result.codex.session_id]);await tx.query("UPDATE ai_distill.steps SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=4",[job.workflow_id,JSON.stringify(storedResult)]);await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),job.workflow_id,job.id,'authored_question',relative(resolve(root),packagePath),hash(publicPackage),publicPackage.length,publicPackage.toString('utf8')]);await tx.query('COMMIT');logEvent('attempt.completed',{level:'info',state:'succeeded'});}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch(error){
  if(output)try{const artifact=await pool.query("SELECT id FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind='authored_question'",[job.workflow_id,job.id]);if(!artifact.rowCount)await rm(output,{force:true});}catch(cleanupError){logEvent('file.cleanup_or_commit_check_failed',{level:'error',file_kind:'authored_question',...classifyLogError(cleanupError)});}
  logEvent('attempt.failed',{level:'error',state:'failed',...classifyLogError(error),failure_phase:failurePhase});
  const unsupported=error instanceof UnsupportedAnswerRequirementsError?error.requirements:null;const reasonCode=error&&typeof error==='object'&&'reason_code'in error?(error as {reason_code?:unknown}).reason_code:undefined;const invalidAttachmentReference=reasonCode==='attachment_reference_invalid';const unsupportedAnswerRequirements=reasonCode==='unsupported_answer_requirements';const failureMessage=reasonCode==='authoring_contract_changed'?'普通出题任务契约已更新，请重新派发':unsupported||unsupportedAnswerRequirements?'被测作答器仅支持文字输入和文字答案，且不调用工具；作者Codex的工具能力不受此限制':invalidAttachmentReference?'出题返回的附件 ID 缺失、重复或不属于本题材料，请检查后重试':'出题执行失败、取消或输入已变化，可检查后重试';const failureResult=unsupported?{error_code:'unsupported_answer_requirements',answer_requirements:unsupported}:unsupportedAnswerRequirements?{error_code:'unsupported_answer_requirements'}:invalidAttachmentReference?{error_code:'attachment_reference_invalid',error:'出题返回的附件 ID 缺失、重复或不属于本题材料'}:null;const tx=await pool.connect();try{await tx.query('BEGIN');await currentBindings(tx,job);const failed=await tx.query("UPDATE ai_distill.step_attempts SET status='failed',result=$2,error=$3,finished_at=now() WHERE id=$1 AND status='running'",[job.id,failureResult?JSON.stringify(failureResult):null,failureMessage]);if(failed.rowCount)await tx.query("UPDATE ai_distill.steps SET status='failed',result=$2,error=$3,finished_at=now() WHERE workflow_id=$1 AND ordinal=4 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1 AND w.deleted_at IS NULL) AND (SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1)=$4",[job.workflow_id,failureResult?JSON.stringify(failureResult):null,failureMessage,job.id]);await tx.query('COMMIT');}catch(failure){await tx.query('ROLLBACK');throw failure;}finally{tx.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);restoreLogContext();}
 return true;
}
