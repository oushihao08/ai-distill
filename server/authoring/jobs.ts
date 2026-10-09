import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {readRevisionSettings} from '../decisions/revision-binding';
import {runRevisionCall} from '../decisions/revision-calls';
import {runCodex} from '../codex/client';
import {mergeCodexDefaults,readProjectCodexDefaults} from '../codex/system-config';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {validateStepConfig} from '../project-folders';
import {readRuleFile,verifyRuleSnapshot} from '../rule-files';
import {loadWorkflowRules} from '../rule-loading';
import {runAuthoring,AuthoringQualityError,UnsupportedAnswerRequirementsError,type AuthoringResult,type AuthoringRule} from './executor';
import {readPrivateDraft} from './private-draft';
import {validateQuality,validateDraft,type Draft} from './validate';

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const workflowSql=`SELECT w.input_revision,w.project_id,w.title,w.source_key,w.source_manifest,w.rule_version_id,s1.status AS ingestion_status,s9.status AS redaction_status,s3.status AS rules_status
 FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL
 JOIN ai_distill.steps s1 ON s1.workflow_id=w.id AND s1.ordinal=1 JOIN ai_distill.steps s3 ON s3.workflow_id=w.id AND s3.ordinal=3 JOIN ai_distill.steps s9 ON s9.workflow_id=w.id AND s9.ordinal=9
 WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w`;
export interface RevisionAuthoringInput {mode:'question'|'rubric';source_attempt_id:string;chain_id:string;round_id:string;evidence:unknown}
interface FrozenInput {revision?:RevisionAuthoringInput;input_revision:number;title:string;question_id?:string;source_files?:{name:string;path:string}[];rule_version_id:string;rule_attempt_id:string;rule_source_digest:string;rule_snapshot_path:string;rule_files:{path:string;sha256:string;size_bytes:number}[];redaction_attempt_id:string;materials:{id:string;sha256:string}[];digest:string}
const canonicalJSON=(value:unknown)=>JSON.stringify(value,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
const sourceFiles=(workflow:any)=>Array.isArray(workflow.source_manifest)?workflow.source_manifest.filter((file:any)=>typeof file?.name==='string'&&typeof file?.path==='string').map((file:any)=>({name:file.name,path:file.path})):[];
const questionId=(workflow:any)=>typeof workflow.source_key==='string'&&workflow.source_key.trim()?workflow.source_key:workflow.title;
export const inputDigest=(input:Omit<FrozenInput,'digest'>)=>hash(JSON.stringify({input_revision:input.input_revision,title:input.title,...(input.question_id?{question_id:input.question_id}:{}),...(input.source_files?{source_files:input.source_files}:{}),rule_version_id:input.rule_version_id,rule_attempt_id:input.rule_attempt_id,rule_source_digest:input.rule_source_digest,rule_snapshot_path:input.rule_snapshot_path,rule_files:input.rule_files.map(file=>({path:file.path,sha256:file.sha256,size_bytes:file.size_bytes})),redaction_attempt_id:input.redaction_attempt_id,materials:input.materials.map(item=>({id:item.id,sha256:item.sha256})),...(input.revision?{revision:JSON.parse(canonicalJSON(input.revision))}:{})}));

async function prerequisites(db:PoolClient,id:string){
 const workflow=(await db.query(workflowSql,[id])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
 if(workflow.ingestion_status!=='succeeded'||workflow.rules_status!=='succeeded'||workflow.redaction_status!=='succeeded')throw new HTTPException(409,{message:'请先完成当前版本的材料入库与脱敏，并确认项目规则已冻结'});
 const redaction=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9 AND status='succeeded' AND input_revision=$2 ORDER BY attempt DESC LIMIT 1",[id,workflow.input_revision])).rows[0];
 const rules=(await db.query("SELECT id,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=3 AND status='succeeded' AND input_revision=$2 ORDER BY attempt DESC LIMIT 1",[id,workflow.input_revision])).rows[0];
 if(!redaction||!rules||rules.result?.input_revision!==workflow.input_revision||rules.result?.rule_version_id!==workflow.rule_version_id||typeof rules.result?.source_digest!=='string'||!Array.isArray(rules.result?.files)||!rules.result?.snapshot_path)throw new HTTPException(409,{message:'当前脱敏材料或项目冻结规则版本不完整'});
 await verifyRuleSnapshot(rules.result.snapshot_path,rules.result.files);
 const artifacts=await db.query("SELECT ar.id,ar.sha256 FROM ai_distill.artifacts ar WHERE ar.workflow_id=$1 AND ar.attempt_id=$2 AND ar.kind='redacted_markdown' ORDER BY ar.created_at,ar.id",[id,redaction.id]);
 if(!artifacts.rowCount||artifacts.rows.some(row=>typeof row.sha256!=='string'||! /^[a-f0-9]{64}$/.test(row.sha256)))throw new HTTPException(409,{message:'当前版本没有可用于出题的脱敏文本'});
 return {workflow,redaction,rules,materials:artifacts.rows as {id:string;sha256:string}[]};
}

export async function enqueueAuthoring(pool:Pool,id:string,revision?:RevisionAuthoringInput,roundId?:string){
 await loadWorkflowRules(pool,id);
 const db=await pool.connect();
 try{
  await db.query('BEGIN');const source=await prerequisites(db,id);
  const settings=await readRevisionSettings(db,id,source.workflow.input_revision,revision?.round_id??roundId);
  const raw=settings?settings.configs?.['4']:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=4',[source.workflow.project_id])).rows[0]?.config;
  const config=validateStepConfig(4,mergeCodexDefaults(raw,await readProjectCodexDefaults(db,source.workflow.project_id)));
  if(revision){
   const round=(await db.query("SELECT r.id FROM ai_distill.revision_rounds r JOIN ai_distill.revision_chains c ON c.id=r.chain_id WHERE r.id=$1 AND c.id=$2 AND c.workflow_id=$3 AND c.input_revision=$4 AND c.status IN ('waiting','running') AND r.status IN ('waiting','running')",[revision.round_id,revision.chain_id,id,source.workflow.input_revision])).rows[0];
   if(!round||!revision.source_attempt_id||!['question','rubric'].includes(revision.mode)||!revision.evidence)throw new HTTPException(409,{message:'返修轮次或来源无效'});
  }
  const frozen:Omit<FrozenInput,'digest'>={...(revision?{revision}:{}),input_revision:source.workflow.input_revision,title:source.workflow.title,question_id:questionId(source.workflow),source_files:sourceFiles(source.workflow),rule_version_id:source.rules.result.rule_version_id,rule_attempt_id:source.rules.id,rule_source_digest:source.rules.result.source_digest,rule_snapshot_path:source.rules.result.snapshot_path,rule_files:source.rules.result.files,redaction_attempt_id:source.redaction.id,materials:source.materials};
  const input:FrozenInput={...frozen,digest:inputDigest(frozen)};
  const previous=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input_revision=$2 AND input->>'digest'=$3 AND config=$4::jsonb AND status IN ('waiting','running','succeeded') ORDER BY attempt DESC LIMIT 1",[id,input.input_revision,input.digest,JSON.stringify(config)])).rows[0];
  if(previous){await db.query('COMMIT');return{id:previous.id,reused:true};}
  if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input_revision=$2 AND status IN ('waiting','running') LIMIT 1",[id,input.input_revision])).rowCount)throw new HTTPException(409,{message:'此题目已有出题与质检任务'});
  const attempt=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,input_revision) SELECT $2,$1::uuid,4,COALESCE(max(attempt),0)+1,'waiting',$3,$4,$5 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=4",[id,attempt,JSON.stringify(input),JSON.stringify(config),input.input_revision]);
  if(revision||roundId)await db.query('UPDATE ai_distill.step_attempts SET revision_round_id=$2 WHERE id=$1',[attempt,revision?.round_id??roundId]);
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=4",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>4 AND ordinal<=8 AND ($2::boolean=false OR ordinal<>5)",[id,revision?.mode==='rubric']);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='题目或评分标准更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>4 AND ordinal<=8 AND status IN ('waiting','running') AND ($2::boolean=false OR ordinal<>5)",[id,revision?.mode==='rubric']);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

async function currentBindings(db:PoolClient,job:any){
 try{
 const source=await prerequisites(db,job.workflow_id);
 const candidate:Omit<FrozenInput,'digest'>={input_revision:source.workflow.input_revision,title:source.workflow.title,...(job.input.question_id?{question_id:questionId(source.workflow),source_files:sourceFiles(source.workflow)}:{}),rule_version_id:source.rules.result.rule_version_id,rule_attempt_id:source.rules.id,rule_source_digest:source.rules.result.source_digest,rule_snapshot_path:source.rules.result.snapshot_path,rule_files:source.rules.result.files,redaction_attempt_id:source.redaction.id,materials:source.materials};
 return source.workflow.input_revision===job.input_revision&&source.workflow.title===job.input.title&&inputDigest({...candidate,...(job.input.revision?{revision:job.input.revision}:{})})===job.input.digest;
 }catch(error){if(error instanceof HTTPException&&[404,409].includes(error.status))return false;throw error;}
}

async function readMaterials(pool:Pool,root:string,job:any){
 const base=await realpath(resolve(root));const result=[];
 for(const item of job.input.materials){
  const row=(await pool.query("SELECT storage_path,sha256,content FROM ai_distill.artifacts WHERE id=$1 AND workflow_id=$2 AND attempt_id=$3 AND kind='redacted_markdown'",[item.id,job.workflow_id,job.input.redaction_attempt_id])).rows[0];
  if(!row||row.sha256!==item.sha256)throw new Error('stale material');
  let bytes:Buffer;
  if(typeof row.content==='string'){bytes=Buffer.from(row.content);if(bytes.length>30*1024*1024)throw new Error('invalid material content');}
  else{
   if(typeof row.storage_path!=='string'||isAbsolute(row.storage_path))throw new Error('unsafe material path');
   const candidate=await realpath(join(base,row.storage_path));if(!candidate.startsWith(`${base}/`))throw new Error('unsafe material path');
   const info=await stat(candidate);if(!info.isFile()||info.size>30*1024*1024)throw new Error('invalid material file');
   bytes=await readFile(candidate);
  }
  if(hash(bytes)!==item.sha256)throw new Error('changed material');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.trim())throw new Error('empty material');result.push({id:item.id,sha256:item.sha256,text});
 }
 return result;
}
async function readRules(job:any):Promise<AuthoringRule[]>{
 const root=job.input.rule_snapshot_path,files=job.input.rule_files;
 await verifyRuleSnapshot(root,files);
 const result:AuthoringRule[]=[];
 for(const file of files){const bytes=await readRuleFile(root,file.path);if(hash(bytes)!==file.sha256)throw new Error('changed rules');result.push({path:file.path,bytes});}
 if(!result.some(file=>file.path==='skill/SKILL.md'))throw new Error('missing frozen skill');
 return result;
}

export async function findRubricBaseline(pool:Pool,workflowId:string,inputRevision:number,source:any,draft:Draft){
 const visited=new Set<string>();let candidate=source;
 while(candidate?.status!=='succeeded'&&candidate?.input?.revision?.mode==='rubric'){
  if(visited.has(candidate.id))throw new Error('cyclic rubric revision lineage');
  visited.add(candidate.id);
  candidate=(await pool.query('SELECT id,result,status,input FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2 AND ordinal=4 AND input_revision=$3',[candidate.input.revision.source_attempt_id,workflowId,inputRevision])).rows[0];
 }
 if(candidate?.status==='succeeded'&&draft.task_name===candidate.result.task_name&&draft.task_type===candidate.result.task_type&&canonicalJSON(draft.header)===canonicalJSON(candidate.result.header)&&draft.question===candidate.result.question&&JSON.stringify(draft.attachment_ids)===JSON.stringify(candidate.result.attachment_ids)&&canonicalJSON(draft.answer_requirements)===canonicalJSON(candidate.result.answer_requirements))return candidate;
 return undefined;
}

type Authorer=(options:Parameters<typeof runAuthoring>[0])=>Promise<AuthoringResult>;
async function stillCurrent(pool:Pool,job:any){
 const db=await pool.connect();try{await db.query('BEGIN');const current=await currentBindings(db,job);await db.query('COMMIT');return current;}catch(error){await db.query('ROLLBACK');if(error instanceof HTTPException&&[404,409].includes(error.status))return false;throw error;}finally{db.release();}
}
export async function runNextAuthoring(pool:Pool,root:string,author:Authorer=runAuthoring,signal?:AbortSignal){
 if(signal?.aborted)return false;
 const db=await pool.connect();let job:any;
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.workflow_id,a.input_revision FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=4 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED");
  for(const row of stale.rows){await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='出题与质检进程中断，可重试',finished_at=now() WHERE id=$1",[row.id]);await db.query("UPDATE ai_distill.steps SET status='failed',error='出题与质检进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=4 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1 AND w.input_revision=$2)",[row.workflow_id,row.input_revision]);}
  job=(await db.query("SELECT a.* FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id AND w.input_revision=a.input_revision WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=4 AND a.status='waiting' ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1")).rows[0];
  if(!job){await db.query('COMMIT');return false;}
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);await db.query("UPDATE ai_distill.steps SET status='running',error=NULL,started_at=now() WHERE workflow_id=$1 AND ordinal=4",[job.workflow_id]);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 const cancellation=watchTaskCancellation(pool,job.id,signal,false);signal=cancellation.signal;
 const heartbeat=setInterval(()=>{pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id]).catch(()=>console.error('第四步任务心跳写入失败'));},10000);
 const directory=join(resolve(root),job.workflow_id,job.id);let wrote=false;
 try{
  if(!job.input||inputDigest((( {digest,...frozen}:FrozenInput)=>frozen)(job.input))!==job.input.digest||job.input_revision!==job.input.input_revision)throw new Error('invalid snapshot');
  if(!await stillCurrent(pool,job))throw new Error('stale input');
  const materials=await readMaterials(pool,root,job);const rules=await readRules(job);
  if(job.config?.provider!=='codex'||typeof job.config.model!=='string'||!job.config.model.trim()||typeof job.config.reasoning_effort!=='string'||!['low','medium','high','xhigh','max','ultra'].includes(job.config.reasoning_effort))throw new Error('invalid frozen config');
  let revisionSource:any;
  let revisionOptions:Parameters<typeof runAuthoring>[0]['revision'];
  if(job.input.revision){
   const old=(await pool.query("SELECT id,result,status,input FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2 AND ordinal=4 AND input_revision=$3",[job.input.revision.source_attempt_id,job.workflow_id,job.input_revision])).rows[0];
   if(!old)throw new Error('missing revision source');
   revisionSource=old;
   const sourceMaterials=job.input.revision.mode==='question'&&Array.isArray(old.input?.materials)?old.input.materials.map((item:any)=>({id:item.id,text:'历史附件引用，仅作版本校验'})):materials;
   const draft=await readPrivateDraft(root,job.workflow_id,old.id,sourceMaterials);
   if(old.status==='succeeded'&&(draft.task_name!==old.result.task_name||draft.task_type!==old.result.task_type||canonicalJSON(draft.header)!==canonicalJSON(old.result.header)||draft.question!==old.result.question||canonicalJSON(draft.rubric)!==canonicalJSON(old.result.rubric)||JSON.stringify(draft.attachment_ids)!==JSON.stringify(old.result.attachment_ids)))throw new Error('private source changed');
   if(old.status!=='succeeded'&&old.input?.revision?.mode==='rubric'){
    const baseline=await findRubricBaseline(pool,job.workflow_id,job.input_revision,old,draft);
    if(baseline)revisionSource=baseline;
   }
   revisionOptions={mode:job.input.revision.mode,source_attempt_id:old.id,evidence:job.input.revision.evidence,draft};
  }
  const result=await author({...(revisionOptions?{revision:revisionOptions}:{}),root:join(directory,'private'),input_revision:job.input_revision,question:job.input.title,question_id:job.input.question_id??job.input.title,source_files:job.input.source_files??[],materials,rules:{version_id:job.input.rule_version_id,source_digest:job.input.rule_source_digest,files:rules},model:job.config.model,reasoning_effort:job.config.reasoning_effort,signal,execute:options=>runRevisionCall(pool,job.id,options.directory.endsWith('/author')?'author':'review',remaining=>runCodex({...options,timeout_ms:Math.min(options.timeout_ms??1800000,remaining??1800000)}))});
  if(revisionOptions?.mode==='rubric'){
   const old=revisionOptions.draft;
   if(result.task_name!==old.task_name||result.task_type!==old.task_type||canonicalJSON(result.header)!==canonicalJSON(old.header)||result.question!==old.question||JSON.stringify(result.attachment_ids)!==JSON.stringify(old.attachment_ids)||JSON.stringify(result.answer_requirements)!==JSON.stringify(old.answer_requirements))throw new Error('rubric-only answer input changed');
   if(result.question_version!==revisionSource.result?.question_version&&revisionSource.status==='succeeded')throw new Error('rubric-only question version changed');
   if(revisionSource.status==='succeeded')result.answer_source_attempt_ids=[revisionSource.id,...(Array.isArray(revisionSource.result.answer_source_attempt_ids)?revisionSource.result.answer_source_attempt_ids:[])];
  }
  if(!validateQuality(result.quality_check).valid)throw new AuthoringQualityError(result.quality_check);
  if(result.input_revision!==job.input_revision||!result.codex.author.session_id||!result.codex.review.session_id||result.codex.author.session_id===result.codex.review.session_id)throw new Error('invalid authoring binding or independent sessions');
  if(signal?.aborted)throw new Error('cancelled');if(!await stillCurrent(pool,job))throw new Error('stale result');await readMaterials(pool,root,job);
  const {package_text,...storedResult}=result,bytes=Buffer.from(`${package_text}\n`),artifactPath=join(directory,'authoring.txt');await mkdir(directory,{recursive:true,mode:0o700});wrote=true;await writeFile(artifactPath,bytes,{mode:0o600,flag:'wx'});
  const tx=await pool.connect();try{await tx.query('BEGIN');if(signal?.aborted||!await currentBindings(tx,job)||!(await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id])).rowCount)throw new Error('inactive');if(revisionOptions?.mode==='rubric'&&revisionSource.status!=='succeeded')await tx.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=5",[job.workflow_id]);await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),job.workflow_id,job.id,'authored_question',relative(resolve(root),artifactPath),hash(bytes),bytes.length,bytes.toString('utf8')]);await tx.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,session_id=$3,error=NULL,finished_at=now() WHERE id=$1",[job.id,JSON.stringify(storedResult),result.codex.author.session_id]);await tx.query("UPDATE ai_distill.steps SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=4",[job.workflow_id,JSON.stringify(storedResult)]);await tx.query('COMMIT');}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch(error){
  if(wrote)try{const status=await pool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[job.id]);if(status.rows[0]?.status!=='succeeded')await rm(join(directory,'authoring.txt'),{force:true});}catch{console.error('无法确认第四步发布状态，保留产物等待核对');}
  const rejected=error instanceof AuthoringQualityError?error.report:null;const unsupported=error instanceof UnsupportedAnswerRequirementsError?error.requirements:null;const failureMessage=rejected?'独立质检未通过，题目未发布':unsupported?'当前出题执行器仅支持文字输入、文字答案且不执行工具；本次题目要求了不支持的作答形式':'出题或质检执行失败、取消或输入已变化，可检查后重试';const failureResult=rejected?{quality_check:rejected}:unsupported?{error_code:'unsupported_answer_requirements',answer_requirements:unsupported}:null;const tx=await pool.connect();try{await tx.query('BEGIN');await currentBindings(tx,job);const failed=await tx.query("UPDATE ai_distill.step_attempts SET status='failed',result=$2,error=$3,finished_at=now() WHERE id=$1 AND status='running'",[job.id,failureResult?JSON.stringify(failureResult):null,failureMessage]);if(failed.rowCount)await tx.query("UPDATE ai_distill.steps SET status='failed',result=$2,error=$3,finished_at=now() WHERE workflow_id=$1 AND ordinal=4 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1 AND w.input_revision=$4 AND w.deleted_at IS NULL) AND (SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input_revision=$4 ORDER BY attempt DESC LIMIT 1)=$5",[job.workflow_id,failureResult?JSON.stringify(failureResult):null,failureMessage,job.input_revision,job.id]);await tx.query('COMMIT');}catch(failure){await tx.query('ROLLBACK');throw failure;}finally{tx.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);}
 return true;
}
