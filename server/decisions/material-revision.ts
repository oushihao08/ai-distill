import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {classifyRevisionSource} from './revision-source';
import {readRevisionSettings,bindRevisionAttempt} from './revision-binding';
export async function enqueueMaterialRevision(pool:Pool,workflowId:string,roundId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query('SELECT input_revision FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  await readRevisionSettings(db,workflowId,workflow.input_revision,roundId);
  const source=(await db.query('SELECT a.* FROM ai_distill.revision_rounds r JOIN ai_distill.step_attempts a ON a.id=r.source_attempt_id WHERE r.id=$1 AND a.workflow_id=$2 AND a.input_revision=$3',[roundId,workflowId,workflow.input_revision])).rows[0];
  const evidence=source?classifyRevisionSource(source):null;
  if(evidence?.kind!=='material'||!evidence.evidence.materials?.length||source.config?.ocr_version!=='glm-ocr-layout-v1')throw new HTTPException(409,{message:'材料返修缺少当前OCR协议及异常页原件依据'});
  const materialIds=evidence.evidence.materials.map(item=>item.material_id);
  const originals=(await db.query("SELECT id FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2 AND id=ANY($3::uuid[]) AND lower(original_name) LIKE '%.pdf'",[workflowId,workflow.input_revision,materialIds])).rows;
  if(originals.length!==materialIds.length)throw new HTTPException(409,{message:'异常页原件缺失，需补齐材料后处理'});
  const previous=(await db.query('SELECT id FROM ai_distill.step_attempts WHERE revision_round_id=$1 AND ordinal=2',[roundId])).rows[0];
  if(previous){await db.query('COMMIT');return{id:previous.id,reused:true};}
  const attempt=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,input_revision) SELECT $2,$1::uuid,2,COALESCE(max(attempt),0)+1,'waiting',$3,$4,$5 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=2",[workflowId,attempt,JSON.stringify({workflow_id:workflowId,input_revision:workflow.input_revision,material_repair:{source_attempt_id:source.id,material_ids:materialIds}}),JSON.stringify(source.config),workflow.input_revision]);
  await bindRevisionAttempt(db,workflowId,workflow.input_revision,attempt,roundId);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal IN (1,2,4,5,6,7,8,9)",[workflowId]);
  await db.query('COMMIT');return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
