import type {PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
export async function readRevisionSettings(db:PoolClient,workflowId:string,revision:number,roundId?:string):Promise<any|undefined>{
 if(!roundId)return undefined;
 const row=(await db.query("SELECT c.config_snapshot,w.rule_version_id AS current_rule_version_id FROM ai_distill.revision_rounds r JOIN ai_distill.revision_chains c ON c.id=r.chain_id JOIN ai_distill.workflows w ON w.id=c.workflow_id WHERE r.id=$1 AND c.workflow_id=$2 AND c.input_revision=$3 AND c.status IN ('waiting','running') AND r.status IN ('waiting','running')",[roundId,workflowId,revision])).rows[0];
 if(!row)throw new HTTPException(409,{message:'返修轮次已停止或失效'});
 if(row.current_rule_version_id!==undefined&&Object.hasOwn(row.config_snapshot,'rule_version_id')&&row.config_snapshot.rule_version_id!==row.current_rule_version_id)throw new HTTPException(409,{message:'返修期间规则版本已变化，请按新规则重新启动'});
 return row.config_snapshot;
}
export async function bindRevisionAttempt(db:PoolClient,workflowId:string,revision:number,attemptId:string,roundId?:string){
 if(!roundId)return;
 const active=(await db.query("SELECT r.id FROM ai_distill.revision_rounds r JOIN ai_distill.revision_chains c ON c.id=r.chain_id JOIN ai_distill.workflows w ON w.id=c.workflow_id WHERE r.id=$1 AND c.workflow_id=$2 AND c.input_revision=$3 AND c.status IN ('waiting','running') AND r.status IN ('waiting','running')",[roundId,workflowId,revision])).rows[0];
 if(!active)throw new HTTPException(409,{message:'返修轮次已失效或停止'});
 await db.query('UPDATE ai_distill.step_attempts SET revision_round_id=$2 WHERE id=$1 AND workflow_id=$3 AND input_revision=$4 AND status=\'waiting\' AND revision_round_id IS NULL',[attemptId,roundId,workflowId,revision]);
}
