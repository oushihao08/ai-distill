/**
 * 职责：材料返修入队：依据已绑定轮次的问题材料重建提取任务，保留健康缓存与当前附件绑定。
 * 关键方法与用途：`enqueueMaterialRevision()` 按返修证据恢复问题原件并排入材料提取，复用健康缓存且绑定当前附件绑定。
 * 使用场景：由返修 runner 在材料问题轮次调用；缺少来源证据时不创建任务。
 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {classifyRevisionSource} from './revision-source';
import {readRevisionSettings,bindRevisionAttempt} from './revision-binding';
export async function enqueueMaterialRevision(pool:Pool,workflowId:string,roundId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query("SELECT id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  await readRevisionSettings(db,workflowId,roundId);
  const source=(await db.query("SELECT a.* FROM ai_distill.revision_rounds r JOIN ai_distill.step_attempts a ON a.id=r.source_attempt_id WHERE r.id=$1 AND a.workflow_id=$2",[roundId,workflowId])).rows[0];
  const evidence=source?classifyRevisionSource(source):null;
  if(evidence?.kind!=='material'||!evidence.evidence.materials?.length||source.config?.ocr_version!=='glm-ocr-layout-v1')throw new HTTPException(409,{message:'材料返修缺少当前OCR协议及异常页原件依据'});
  const materialIds=evidence.evidence.materials.map(item=>item.material_id);
  const originals=(await db.query("SELECT id FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL AND id=ANY($2::uuid[]) AND lower(original_name) LIKE '%.pdf'",[workflowId,materialIds])).rows;
  if(originals.length!==materialIds.length)throw new HTTPException(409,{message:'异常页原件缺失，需补齐材料后处理'});
  const previous=(await db.query('SELECT id FROM ai_distill.step_attempts WHERE revision_round_id=$1 AND ordinal=2',[roundId])).rows[0];
  if(previous){await db.query('COMMIT');return{id:previous.id,reused:true};}
  const materials=(await db.query("SELECT id,sha256 FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL AND lower(original_name) LIKE '%.pdf' ORDER BY id",[workflowId])).rows;
  const attempt=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config) SELECT $2,$1::uuid,2,COALESCE(max(attempt),0)+1,'waiting',$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=2",[workflowId,attempt,JSON.stringify({workflow_id:workflowId,materials,material_repair:{source_attempt_id:source.id,material_ids:materialIds}}),JSON.stringify(source.config)]);
  await bindRevisionAttempt(db,workflowId,attempt,roundId);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal IN (1,2,4,5,6,7,8,9)",[workflowId]);
  await db.query('COMMIT');return{id:attempt,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
