import type {Pool,PoolClient} from 'pg';
export class RevisionCallBlocked extends Error {
 constructor(readonly reason:string){super(reason);this.name='RevisionCallBlocked';}
}

// Only terminal attempts can be reconciled: a quiet observer must not treat a
// still-running provider request as crashed. Uncertain calls consume elapsed
// time conservatively, capped at the entire configured chain time allowance.
export async function recoverRevisionCalls(db:PoolClient,chainId:string,maxDuration:number){
 const recovered=await db.query("UPDATE ai_distill.revision_calls c SET status='unknown',duration_ms=LEAST($2::bigint,GREATEST(0,ceil(extract(epoch FROM (now()-c.created_at))*1000)::bigint)),finished_at=now() FROM ai_distill.step_attempts a WHERE c.chain_id=$1 AND c.attempt_id=a.id AND c.status='reserved' AND a.status IN ('failed','skipped') RETURNING c.duration_ms",[chainId,maxDuration]);
 const duration=recovered.rows.reduce((sum,row)=>sum+Number(row.duration_ms),0);
 if(duration)await db.query('UPDATE ai_distill.revision_chains SET spent_duration_ms=spent_duration_ms+$2,updated_at=now() WHERE id=$1',[chainId,duration]);
 return duration;
}

// An attempt without a revision round is an ordinary manual task. Each real
// invocation in a revision attempt must use its own stable key (author/review,
// answer, score, or material page), not one reservation for a whole stage.
export async function runRevisionCall<T extends {usage?:unknown;duration_ms?:number}>(pool:Pool,attemptId:string,key:string,execute:(remainingMs?:number)=>Promise<T>):Promise<T>{
 const db=await pool.connect();let reservation:string|undefined,remainingMs:number|undefined;
 try{
  await db.query('BEGIN');
  const chain=(await db.query("SELECT c.*,a.status AS attempt_status,r.id AS round_id,w.input_revision AS current_revision,w.rule_version_id AS current_rule_version_id FROM ai_distill.step_attempts a JOIN ai_distill.revision_rounds r ON r.id=a.revision_round_id JOIN ai_distill.revision_chains c ON c.id=r.chain_id JOIN ai_distill.workflows w ON w.id=c.workflow_id WHERE a.id=$1 FOR UPDATE OF c",[attemptId])).rows[0];
  if(chain){
   chain.spent_duration_ms=Number(chain.spent_duration_ms)+await recoverRevisionCalls(db,chain.id,chain.budget.max_duration_ms);
   let reason:string|undefined;
   if(chain.attempt_status&&chain.attempt_status!=='running')reason='attempt_not_running';
   else if(chain.input_revision!==chain.current_revision)reason='input_revision_changed';
   else if(chain.current_rule_version_id!==undefined&&Object.hasOwn(chain.config_snapshot??{},'rule_version_id')&&chain.config_snapshot.rule_version_id!==chain.current_rule_version_id)reason='rule_version_changed';
   else if(!['waiting','running'].includes(chain.status))reason='revision_not_active';
   else if(chain.calls_reserved>=chain.budget.max_calls)reason='call_budget_exhausted';
   else if(Number(chain.spent_duration_ms)>=chain.budget.max_duration_ms)reason='time_budget_exhausted';
   const previous=(await db.query('SELECT id FROM ai_distill.revision_calls WHERE chain_id=$1 AND attempt_id=$2 AND call_key=$3',[chain.id,attemptId,key])).rows[0];
   if(previous)reason='call_already_reserved';
   if(reason){
    if(['call_budget_exhausted','time_budget_exhausted','input_revision_changed','rule_version_changed'].includes(reason))await db.query("UPDATE ai_distill.revision_chains SET status=$2,reason=$3,updated_at=now() WHERE id=$1 AND status IN ('waiting','running')",[chain.id,reason==='input_revision_changed'?'stale':'isolated',reason]);
    await db.query('COMMIT');throw new RevisionCallBlocked(reason);
   }
   reservation=crypto.randomUUID();remainingMs=chain.budget.max_duration_ms-Number(chain.spent_duration_ms);
   await db.query('INSERT INTO ai_distill.revision_calls(id,chain_id,round_id,attempt_id,call_key) VALUES($1,$2,$3,$4,$5)',[reservation,chain.id,chain.round_id,attemptId,key]);
   await db.query('UPDATE ai_distill.revision_chains SET calls_reserved=calls_reserved+1,updated_at=now() WHERE id=$1',[chain.id]);
  }
  await db.query('COMMIT');
 }catch(error){if(!(error instanceof RevisionCallBlocked))await db.query('ROLLBACK');throw error;}finally{db.release();}
 const started=performance.now();
 async function finish(status:'completed'|'unknown',usage?:unknown){
  if(!reservation)return;
  const tx=await pool.connect();
  try{
   await tx.query('BEGIN');
   const duration=Math.max(0,Math.ceil(performance.now()-started));
   const settled=await tx.query("UPDATE ai_distill.revision_calls SET status=$2,usage=$3,duration_ms=$4,finished_at=now() WHERE id=$1 AND status='reserved' RETURNING chain_id",[reservation,status,usage===undefined?null:JSON.stringify(usage),duration]);
   if(settled.rowCount)await tx.query('UPDATE ai_distill.revision_chains SET spent_duration_ms=spent_duration_ms+$2,updated_at=now() WHERE id=$1',[settled.rows[0].chain_id,duration]);
   await tx.query('COMMIT');
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }
 try{const result=await execute(remainingMs);await finish('completed',result.usage);return result;}
 catch(error){await finish('unknown');throw error;}
}
