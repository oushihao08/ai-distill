import {enqueueMaterialRevision} from './material-revision';
import {enqueueRedaction} from '../materials/redaction-jobs';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {enqueueAuthoring} from '../authoring/jobs';
import {enqueueAnswer} from '../answer-models/jobs';
import {enqueueScore} from '../scoring/jobs';
import {runAcceptance} from './jobs';
import {classifyRevisionSource} from './revision-source';
import {decideRevision} from './revision';
import {recoverRevisionCalls} from './revision-calls';

async function nextRound(pool:Pool,chain:any,round:any,source:any){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 FOR UPDATE',[chain.workflow_id])).rows[0];
  const current=(await db.query('SELECT * FROM ai_distill.revision_chains WHERE id=$1 FOR UPDATE',[chain.id])).rows[0];
  if(workflow?.input_revision!==chain.input_revision||!current||!['waiting','running'].includes(current.status)){await db.query('COMMIT');return;}
  current.spent_duration_ms=Number(current.spent_duration_ms)+await recoverRevisionCalls(db,chain.id,current.budget.max_duration_ms);
  if((await db.query('SELECT id FROM ai_distill.revision_rounds WHERE chain_id=$1 AND source_attempt_id=$2',[chain.id,source.id])).rowCount){await db.query('COMMIT');return;}
  const classified=classifyRevisionSource(source)??{kind:'unknown' as const,evidence:{error:'source_not_repairable'}};
  const decision=decideRevision(classified.kind,{...current.budget,content_revisions:current.content_revisions,technical_retries:current.technical_retries,calls:current.calls_reserved,spent_duration_ms:Number(current.spent_duration_ms)});
  const status=decision.action==='isolate'?'isolated':decision.action==='wait'?'blocked':'waiting';
  const versions=(await db.query("SELECT result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input_revision=$2 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[chain.workflow_id,chain.input_revision])).rows[0]?.result;
  const versionSnapshot={input_revision:chain.input_revision,question_version:versions?.question_version??null,rubric_version:versions?.rubric_version??null};
  await db.query("UPDATE ai_distill.revision_rounds SET status='failed',after_versions=$2,after_scores=$3,finished_at=now() WHERE id=$1",[round.id,JSON.stringify(versionSnapshot),JSON.stringify(source.result?.model_scores??{})]);
  await db.query('UPDATE ai_distill.revision_chains SET status=$2,reason=$3,content_revisions=$4,technical_retries=$5,updated_at=now() WHERE id=$1',[chain.id,status,decision.reason,decision.content_revisions,decision.technical_retries]);
  await db.query('INSERT INTO ai_distill.revision_rounds(id,chain_id,round,parent_round_id,source_attempt_id,issue_kind,evidence,decision,status,stage,before_scores,before_versions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[crypto.randomUUID(),chain.id,round.round+1,round.id,source.id,classified.kind,JSON.stringify(classified.evidence),JSON.stringify(decision),status,decision.return_step??source.ordinal,JSON.stringify(source.result?.model_scores??{}),JSON.stringify(versionSnapshot)]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

async function cloneRetry(pool:Pool,chain:any,round:any,source:any){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const w=(await db.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[chain.workflow_id])).rows[0];
  const c=(await db.query("SELECT id FROM ai_distill.revision_chains WHERE id=$1 AND status IN ('waiting','running') FOR UPDATE",[chain.id])).rows[0];
  if(!c||w?.input_revision!==chain.input_revision)throw new HTTPException(409,{message:'返修链已失效'});
  if(!(await db.query('SELECT id FROM ai_distill.step_attempts WHERE revision_round_id=$1 AND ordinal=$2',[round.id,source.ordinal])).rowCount){
   const input=structuredClone(source.input);
   // Keep the original digest and frozen authoring snapshot on technical retry;
   // revision pointers are unchanged because this is the same content operation.
   await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,input_revision,revision_round_id) SELECT $2,$1::uuid,$3,COALESCE(max(attempt),0)+1,'waiting',$4,$5,$6,$7 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=$3",[chain.workflow_id,crypto.randomUUID(),source.ordinal,JSON.stringify(input),JSON.stringify(source.config),chain.input_revision,round.id]);
   await db.query("UPDATE ai_distill.steps SET status='waiting',error=NULL WHERE workflow_id=$1 AND ordinal=$2",[chain.workflow_id,source.ordinal]);
  }
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function runRevisionTick(pool:Pool,root:string){
 const chains=(await pool.query("SELECT c.* FROM ai_distill.revision_chains c JOIN ai_distill.workflows w ON w.id=c.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id WHERE c.status IN ('waiting','running') AND w.deleted_at IS NULL AND p.deleted_at IS NULL AND NOT p.execution_paused ORDER BY c.created_at LIMIT 100")).rows;
 for(const chain of chains){
  const lock=await pool.connect();let acquired=false;
  try{
   await lock.query('BEGIN');
   acquired=(await lock.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',[`revision:${chain.id}`])).rows[0]?.acquired;
   if(!acquired)continue;
   if((await pool.query("SELECT ai_distill.dispatch_allowed($1,'revision') AS allowed",[chain.workflow_id])).rows[0]?.allowed===false)continue;
   const current=(await pool.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1',[chain.workflow_id])).rows[0];
   if(current?.input_revision!==chain.input_revision){await pool.query("UPDATE ai_distill.revision_chains SET status='stale',reason='input_revision_changed',updated_at=now() WHERE id=$1",[chain.id]);continue;}
   const round=(await pool.query('SELECT * FROM ai_distill.revision_rounds WHERE chain_id=$1 ORDER BY round DESC LIMIT 1',[chain.id])).rows[0];
   if(!round||!['waiting','running'].includes(round.status))continue;
   const attempts=(await pool.query('SELECT * FROM ai_distill.step_attempts WHERE revision_round_id=$1 AND ordinal=$2 ORDER BY attempt DESC',[round.id,round.stage])).rows;
   if(attempts.some(a=>a.status==='waiting'||a.status==='running'))continue;
   const failure=attempts.find(a=>a.status==='failed'||a.status==='skipped'||round.stage===2&&a.result?.issues?.length);
   if(failure){await nextRound(pool,chain,round,failure);continue;}
   const steps=(await pool.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1',[chain.workflow_id])).rows;
   const done=(ordinal:number)=>steps.find(s=>s.ordinal===ordinal)?.status==='succeeded';
   if(round.stage===7){
    const result=await runAcceptance(pool,chain.workflow_id,round.id);
    if(result.decision==='accepted'){
     const tx=await pool.connect();try{
      await tx.query('BEGIN');
      const w=(await tx.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 FOR UPDATE',[chain.workflow_id])).rows[0];
      if(w?.input_revision!==chain.input_revision)throw new HTTPException(409,{message:'返修结果材料版本已变化'});
      const versions=(await tx.query("SELECT result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input_revision=$2 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[chain.workflow_id,chain.input_revision])).rows[0]?.result;
      const accepted=await tx.query("UPDATE ai_distill.revision_chains SET status='accepted',reason=NULL,updated_at=now() WHERE id=$1 AND status IN ('waiting','running')",[chain.id]);
      if(!accepted.rowCount){await tx.query('COMMIT');continue;}
      await tx.query("UPDATE ai_distill.revision_rounds SET status='succeeded',after_scores=$2,after_versions=$3,finished_at=now() WHERE id=$1",[round.id,JSON.stringify(result.model_scores),JSON.stringify({input_revision:chain.input_revision,question_version:versions?.question_version??null,rubric_version:versions?.rubric_version??null})]);
      await tx.query('COMMIT');
     }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
    }else if(result.decision==='waiting')await pool.query("UPDATE ai_distill.revision_chains SET status='blocked',reason='acceptance_waiting',updated_at=now() WHERE id=$1",[chain.id]);
    else {const source=(await pool.query('SELECT * FROM ai_distill.step_attempts WHERE id=$1',[result.id])).rows[0];await nextRound(pool,chain,round,source);}
    continue;
   }
   if(attempts.length&&done(round.stage)){
    const next=round.stage===2?9:round.stage===9?4:round.stage===4?((round.issue_kind==='rubric'||attempts[0]?.input?.revision?.mode==='rubric')&&done(5)?6:5):round.stage===5?6:7;
    await pool.query("UPDATE ai_distill.revision_rounds SET stage=$2,status='running' WHERE id=$1",[round.id,next]);continue;
   }
   const source=(await pool.query('SELECT * FROM ai_distill.step_attempts WHERE id=$1',[round.source_attempt_id])).rows[0];
   if(!source)throw new HTTPException(409,{message:'返修来源不存在'});
   if(round.decision.action==='retry'&&source.ordinal===round.stage)await cloneRetry(pool,chain,round,source);
   else if(round.stage===4){
    const old=source.ordinal===4?source:(await pool.query('SELECT * FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND input_revision=$2 ORDER BY attempt DESC LIMIT 1',[chain.workflow_id,chain.input_revision])).rows[0];
    if(!old&&round.issue_kind==='material')await enqueueAuthoring(pool,chain.workflow_id,undefined,round.id);
    else {if(!old)throw new HTTPException(409,{message:'缺少可返修题目'});
    await enqueueAuthoring(pool,chain.workflow_id,{mode:round.issue_kind==='rubric'?'rubric':'question',source_attempt_id:old.id,chain_id:chain.id,round_id:round.id,evidence:round.evidence});}
   }else if(round.stage===5||round.stage===6){
    const queued=round.stage===5?await enqueueAnswer(pool,chain.workflow_id,root,round.id):await enqueueScore(pool,chain.workflow_id,round.id);
    // Reused successful tasks belong to earlier rounds and will never appear
    // in this round's attempt query. Advance only when the aggregate is done.
    if(queued.reused&&done(round.stage))await pool.query("UPDATE ai_distill.revision_rounds SET stage=$2,status='running' WHERE id=$1",[round.id,round.stage===5?6:7]);
   }
   else if(round.stage===2)await enqueueMaterialRevision(pool,chain.workflow_id,round.id);
   else if(round.stage===9){const queued=await enqueueRedaction(pool,chain.workflow_id,round.id);if(queued.reused&&done(9))await pool.query("UPDATE ai_distill.revision_rounds SET stage=4,status='running' WHERE id=$1",[round.id]);}
   else throw new HTTPException(409,{message:'返修阶段无对应执行器'});
   await pool.query("UPDATE ai_distill.revision_chains SET status='running',updated_at=now() WHERE id=$1 AND status='waiting'",[chain.id]);
  }catch(error){await pool.query("UPDATE ai_distill.revision_chains SET status='blocked',reason=$2,updated_at=now() WHERE id=$1 AND status IN ('waiting','running')",[chain.id,error instanceof HTTPException?error.message:'返修接续失败，请检查后恢复']);}
  finally{try{await lock.query('COMMIT');}finally{lock.release();}}
 }
 return chains.length>0;
}
