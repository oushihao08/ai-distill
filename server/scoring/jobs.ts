import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {bindRevisionAttempt,readRevisionSettings} from '../decisions/revision-binding';
import {runRevisionCall} from '../decisions/revision-calls';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {readScoreContext} from './context';
import {buildAnonymousInput,runIndependentScore} from './executor';
import {validateScore,type ScoreContext} from './validate';
import {validateStepConfig} from '../project-folders';
import {mergeCodexDefaults,readProjectCodexDefaults} from '../codex/system-config';
export function scoreContextDigest(context:ScoreContext){
 const b=context.binding;
 return createHash('sha256').update(JSON.stringify({binding:{question_version:b.question_version,input_revision:b.input_revision,input_digest:b.input_digest,rubric_version:b.rubric_version,rubric_digest:b.rubric_digest,answer_attempt_id:b.answer_attempt_id,answer_sha256:b.answer_sha256},input:buildAnonymousInput(context)})).digest('hex');
}
const workflowSql='SELECT w.input_revision,w.project_id FROM ai_distill.workflows w WHERE w.id=$1 AND w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) FOR UPDATE OF w';
export async function enqueueScore(pool:Pool,id:string,revisionRoundId?:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');const w=(await db.query(workflowSql,[id])).rows[0];if(!w)throw new HTTPException(404,{message:'工作流不存在'});
  const answerStep=(await db.query("SELECT status,result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=5",[id])).rows[0];
  if(answerStep?.status!=='succeeded')throw new HTTPException(409,{message:'请先完成当前题目作答'});
  const bundle=Array.isArray(answerStep.result?.models)?answerStep.result.models as any[]:null;
  let answerIds:string[];
  if(bundle){
   const requested=bundle.filter(item=>item?.status==='succeeded'&&typeof item.attempt_id==='string').map(item=>item.attempt_id as string);
   const available=await db.query("SELECT a.id FROM ai_distill.step_attempts a WHERE a.workflow_id=$1 AND a.ordinal=5 AND a.input_revision=$2 AND a.status='succeeded' AND a.id=ANY($3::uuid[])",[id,w.input_revision,requested]);
   answerIds=available.rows.map(row=>row.id);
  }else{
   const answer=(await db.query("SELECT a.id FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=5 WHERE a.workflow_id=$1 AND a.ordinal=5 AND a.status='succeeded' AND a.input_revision=$2 AND s.status='succeeded' AND s.result->>'answer_sha256'=a.result->>'answer_sha256' AND s.result->>'input_digest'=a.result->>'input_digest' ORDER BY a.attempt DESC LIMIT 1",[id,w.input_revision])).rows[0];
   answerIds=answer?[answer.id]:[];
  }
  if(!answerIds.length)throw new HTTPException(409,{message:'当前模型集合没有成功答案可评分'});
  const settings=await readRevisionSettings(db,id,w.input_revision,revisionRoundId);
  const raw=settings?settings.configs?.['6']:(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=6',[w.project_id])).rows[0]?.config;
  const config=validateStepConfig(6,mergeCodexDefaults(raw,await readProjectCodexDefaults(db,w.project_id))),queued:{id:string;reused:boolean;answer_attempt_id:string}[]=[];
  for(const answerId of answerIds){
   const context=await readScoreContext(db,id,answerId);buildAnonymousInput(context);
   const input={context,digest:scoreContextDigest(context)};
   const previous=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND input_revision=$2 AND input->>'digest'=$3 AND config=$4::jsonb AND status IN ('waiting','running','succeeded') ORDER BY attempt DESC LIMIT 1",[id,w.input_revision,input.digest,JSON.stringify(config)])).rows[0];
   if(previous){queued.push({id:previous.id,reused:true,answer_attempt_id:answerId});continue;}
   if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND input_revision=$2 AND input->'context'->'binding'->>'answer_attempt_id'=$3 AND status IN ('waiting','running') LIMIT 1",[id,w.input_revision,answerId])).rowCount)throw new HTTPException(409,{message:'此答案已有评分任务'});
   const attempt=crypto.randomUUID();
   await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,input_revision) SELECT $2,$1::uuid,6,COALESCE(max(attempt),0)+1,'waiting',$3,$4,$5 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=6",[id,attempt,JSON.stringify(input),JSON.stringify(config),w.input_revision]);
   await bindRevisionAttempt(db,id,w.input_revision,attempt,revisionRoundId);
   queued.push({id:attempt,reused:false,answer_attempt_id:answerId});
  }
  if(queued.every(item=>item.reused)){await db.query('COMMIT');return bundle?{id:queued[0]!.id,ids:queued.map(item=>item.id),reused:true}:{id:queued[0]!.id,reused:true};}
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=6",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>6 AND ordinal<=8",[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='评分更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>6 AND ordinal<=8 AND status IN ('waiting','running')",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');return bundle?{id:queued[0]!.id,ids:queued.map(item=>item.id),reused:false}:{id:queued[0]!.id,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
interface ScoreRun {report:unknown;session_id:string;usage:unknown;duration_ms:number}
type Grader=(context:ScoreContext,options:{root:string;model:string;reasoning_effort:string;signal?:AbortSignal;timeout_ms?:number})=>Promise<ScoreRun>;
async function stillCurrent(db:PoolClient,job:any){
 const w=(await db.query(workflowSql,[job.workflow_id])).rows[0];if(w?.input_revision!==job.input_revision)return false;
 try{return scoreContextDigest(await readScoreContext(db,job.workflow_id,job.input.context.binding.answer_attempt_id))===job.input.digest;}
 catch(error){if(error instanceof HTTPException&&[404,409].includes(error.status))return false;throw error;}
}
async function refreshScoreStep(db:PoolClient,job:any){
 const answerStep=(await db.query("SELECT result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=5",[job.workflow_id])).rows[0];
 const answers=Array.isArray(answerStep?.result?.models)?answerStep.result.models as any[]:null;
 if(!answers){
  return db.query('UPDATE ai_distill.steps SET status=$2,result=$3,error=$4,finished_at=now() WHERE workflow_id=$1 AND ordinal=6',[job.workflow_id,job.status,JSON.stringify(job.result),job.status==='failed'?'评分存在争议或执行失败':null]);
 }
 const rows=await db.query("SELECT id,input,result,status FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND input_revision=$2 ORDER BY attempt DESC",[job.workflow_id,job.input_revision]);
 const latest=new Map<string,any>();
 for(const row of rows.rows){const answerId=row.input?.context?.binding?.answer_attempt_id;if(typeof answerId==='string'&&!latest.has(answerId))latest.set(answerId,row);}
 const models=answers.map((answer:any)=>{
  if(answer.status!=='succeeded'||typeof answer.attempt_id!=='string')return {model_id:answer.model_id,name:answer.name,answer_attempt_id:answer.attempt_id??null,answer_status:answer.status,score_attempt_id:null,score_status:'skipped'};
  const score=latest.get(answer.attempt_id);
  const report=score?.result?.report;const validation=score?.result?.validation;
  return {model_id:answer.model_id,name:answer.name,answer_attempt_id:answer.attempt_id,answer_status:answer.status,score_attempt_id:score?.id??null,score_status:score?.status??'waiting',score:typeof report?.total==='number'?report.total:null,max_score:typeof report?.max_score==='number'?report.max_score:null,valid:validation?.valid===true,binding:score?.result?.binding??null,disputes:Array.isArray(report?.disputes)?report.disputes:[]};
 });
 const expected=models.filter((model:any)=>model.answer_status==='succeeded');
 const settled=expected.length>0&&expected.every((model:any)=>['succeeded','failed','skipped'].includes(model.score_status));
 const running=expected.some((model:any)=>model.score_status==='running');
 const status=settled?'succeeded':running?'running':'waiting';
 return db.query("UPDATE ai_distill.steps SET status=$3,result=$4,error=NULL,finished_at=CASE WHEN $3='succeeded' THEN now() ELSE NULL END WHERE workflow_id=$1 AND ordinal=6 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1 AND input_revision=$2)",[job.workflow_id,job.input_revision,status,JSON.stringify({models})]);
}
export async function runNextScore(pool:Pool,root:string,grade:Grader=runIndependentScore,signal?:AbortSignal){
 if(signal?.aborted)return false;
 const db=await pool.connect();let job:any;
 try{
  await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
  const stale=await db.query("SELECT a.id,a.workflow_id,a.input_revision FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=6 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED");
  for(const row of stale.rows){await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='评分进程中断，可重试',finished_at=now() WHERE id=$1",[row.id]);await db.query("UPDATE ai_distill.steps SET status='failed',error='评分进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=6 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1 AND w.input_revision=$2)",[row.workflow_id,row.input_revision]);}
  job=(await db.query("SELECT a.* FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id AND w.input_revision=a.input_revision WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=6 AND a.status='waiting' ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1")).rows[0];
  if(!job){await db.query('COMMIT');return false;}
  await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=now(),heartbeat_at=now() WHERE id=$1",[job.id]);await db.query("UPDATE ai_distill.steps SET status='running',error=NULL,started_at=now() WHERE workflow_id=$1 AND ordinal=6",[job.workflow_id]);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 const cancellation=watchTaskCancellation(pool,job.id,signal,false);signal=cancellation.signal;
 const heartbeat=setInterval(()=>{pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id]).catch(()=>console.error('评分心跳写入失败'));},10000);
 let wrote=false;const directory=join(resolve(root),job.workflow_id,job.id);
 try{
  if(scoreContextDigest(job.input.context)!==job.input.digest||job.input.context.binding.input_revision!==job.input_revision)throw new Error('invalid snapshot');
  buildAnonymousInput(job.input.context);
  const before=await pool.connect();try{await before.query('BEGIN');if(!await stillCurrent(before,job))throw new Error('obsolete');await before.query('COMMIT');}catch(error){await before.query('ROLLBACK');throw error;}finally{before.release();}
  const config=job.config;
  if(config?.provider!=='codex'||typeof config.model!=='string'||!config.model.trim()||typeof config.reasoning_effort!=='string'||!['low','medium','high','xhigh','max','ultra'].includes(config.reasoning_effort))throw new Error('invalid frozen config');
  const invocation=await runRevisionCall(pool,job.id,'score',remaining=>grade(job.input.context,{root:join(directory,'private'),model:config.model,reasoning_effort:config.reasoning_effort,signal,timeout_ms:Math.min(1800000,remaining??1800000)}));
  if(signal?.aborted)throw new Error('cancelled');
  const validation=validateScore(invocation.report,job.input.context);
  const publication={question_version:job.input.context.binding.question_version,rubric_version:job.input.context.binding.rubric_version,project_rule_version_id:job.input.context.project_rules.version_id,project_rule_source_digest:job.input.context.project_rules.source_digest,project_rule_files:job.input.context.project_rules.files.map(({path,sha256,size_bytes})=>({path,sha256,size_bytes})),report:invocation.report,validation,binding:job.input.context.binding,session_id:invocation.session_id,usage:invocation.usage,duration_ms:invocation.duration_ms,model:config.model,reasoning_effort:config.reasoning_effort};
  const bytes=Buffer.from(JSON.stringify(publication,null,2)+'\n'),path=join(directory,'score.json');await mkdir(directory,{recursive:true});wrote=true;await writeFile(path,bytes,{mode:0o600});
  const tx=await pool.connect();try{
   await tx.query('BEGIN');if(!await stillCurrent(tx,job)||!(await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE",[job.id])).rowCount)throw new Error('obsolete');
   await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),job.workflow_id,job.id,'score_report',relative(resolve(root),path),createHash('sha256').update(bytes).digest('hex'),bytes.length]);
   const status=validation.valid?'succeeded':'failed',error=validation.valid?null:'评分存在争议或证据/结构无效，详见校验结果';
   await tx.query('UPDATE ai_distill.step_attempts SET status=$2,result=$3,session_id=$4,error=$5,finished_at=now() WHERE id=$1',[job.id,status,JSON.stringify(publication),invocation.session_id,error]);
   job.status=status;job.result=publication;await refreshScoreStep(tx,job);await tx.query('COMMIT');
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }catch{
  if(wrote)try{if(!(await pool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 LIMIT 1',[job.id])).rowCount)await rm(join(directory,'score.json'),{force:true});}catch{console.error('评分发布状态未知，保留文件等待核对');}
  const tx=await pool.connect();try{await tx.query('BEGIN');const current=await stillCurrent(tx,job);const failed=await tx.query("UPDATE ai_distill.step_attempts SET status='failed',error='评分执行失败或版本已失效，可检查后重试',finished_at=now() WHERE id=$1 AND status='running'",[job.id]);if(current&&failed.rowCount){job.status='failed';job.result=null;await refreshScoreStep(tx,job);}await tx.query('COMMIT');}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }finally{cancellation.dispose();clearInterval(heartbeat);}
 return true;
}
