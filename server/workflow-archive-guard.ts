/**
 * 职责：在工作流行锁内阻止已归档题目的再次派发，避免清空已交付结果。
 * 入口：assertWorkflowNotArchived()供出题、作答、评分、判定和归档派发复用。
 * 边界：调用方必须位于事务中；显式撤回归档仍使用原独立接口，下载导出不受影响。
 */
import type {PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';

export async function assertWorkflowNotArchived(db:PoolClient,workflowId:string){
 const workflow=await db.query('SELECT id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[workflowId]);
 if(!workflow.rowCount)throw new HTTPException(404,{message:'工作流不存在'});
 const archive=(await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=8',[workflowId])).rows[0];
 if(archive?.status==='succeeded')throw new HTTPException(409,{message:'当前题目已归档，已阻止重复执行；如需返修，请先明确撤回归档'});
}
