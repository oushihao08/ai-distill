/**
 * 职责：注册单题步骤派发、项目批量派发和 attempt 等待 API。
 * 关键方法：registerWorkflowExecutionRoutes 连接 HTTP 输入／响应与就绪判定；业务派发由 app 提供。
 * 使用场景：createApp 完成全局中间件后注册工作流执行路由。
 */
import {Hono,type Context} from 'hono';
import {HTTPException} from 'hono/http-exception';
import type {Pool} from 'pg';
import {STEP_REGISTRY} from '../shared/step-registry';
import {logEvent} from './logging';
import {readBatchChunkSize,readProjectWorkflowStepRows,splitIntoBatches,workflowStepReadiness,type WorkflowStepState} from './project-folders';
import {waitDuration,waitForAttempt} from './attempts';
import {uuid} from './validation';
import type {StepDispatchTask,WorkflowStepOrdinal} from './step-dispatch';
import {validateAnswerScore} from './scoring/context';

interface RouteDependencies {
 pool:Pool;
 dispatch:(workflowId:string,ordinal:WorkflowStepOrdinal)=>Promise<StepDispatchTask>;
 batchChunkSize?:number;
 repository?:WorkflowExecutionRepository;
 waitForAttempt?:typeof waitForAttempt;
}

interface WorkflowExecutionStepRow extends WorkflowStepState {workflow_id:string}
interface WorkflowExecutionRepository {
 projectExists:(projectId:string)=>Promise<boolean>;
 selectWorkflows:(projectId:string,workflowIds?:string[])=>Promise<{id:string;project_id:string}[]>;
 readStepStates:(projectId:string,workflowIds:string[])=>Promise<WorkflowExecutionStepRow[]>;
}

export function registerWorkflowExecutionRoutes(app:Hono,{pool,dispatch,batchChunkSize=readBatchChunkSize(),repository,waitForAttempt:wait=waitForAttempt}:RouteDependencies){
 const data=repository??{
  projectExists:async(projectId:string)=>Boolean((await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[projectId])).rowCount),
  selectWorkflows:async(projectId:string,workflowIds?:string[])=>{
   const result=workflowIds
    ?await pool.query('SELECT id,project_id FROM ai_distill.workflows WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL',[workflowIds])
    :await pool.query('SELECT id,project_id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at,id',[projectId]);
   return result.rows;
  },
  readStepStates:async(projectId:string,workflowIds:string[])=>{
   const result=await readProjectWorkflowStepRows(pool,projectId,workflowIds);
   return result.rows as WorkflowExecutionStepRow[];
  },
 } satisfies WorkflowExecutionRepository;
 async function executeStep(c:Context,ordinal:WorkflowStepOrdinal){
  const waitMs=waitDuration(c.req.query('wait_ms'));
  const id=uuid(c.req.param('id')??'');
  const task=await dispatch(id,ordinal);
  if(task.completed)return c.json(task,200);
  if(!waitMs)return c.json(task,202);
  const attemptIds=task.ids;
  if(Array.isArray(attemptIds)&&attemptIds.length>1){
   const results=await Promise.all(attemptIds.map(attemptId=>wait(pool,attemptId,waitMs,c.req.raw.signal)));
   const completed=results.every(result=>result.completed);
   return c.json({...task,results,completed},completed?200:202);
  }
  const result=await wait(pool,task.id,waitMs,c.req.raw.signal);
  return c.json({...task,...result},result.completed?200:202);
 }
 app.post('/api/workflows/:id/intake',c=>executeStep(c,1));
 app.post('/api/workflows/:id/extract',c=>executeStep(c,2));
 app.post('/api/workflows/:id/redact',c=>executeStep(c,9));
 app.post('/api/workflows/:id/author',c=>executeStep(c,4));
 app.post('/api/workflows/:id/answer',c=>executeStep(c,5));
 app.post('/api/workflows/:id/score',c=>executeStep(c,6));
 app.post('/api/workflows/:id/accept',c=>executeStep(c,7));
 app.post('/api/workflows/:id/publish',c=>executeStep(c,8));
 app.post('/api/workflows/:id/answers/:attemptId/validate-score',async c=>{
  const report=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'评分结果须为有效JSON'});});
  const result=await validateAnswerScore(pool,uuid(c.req.param('id')),uuid(c.req.param('attemptId')),report);
  return c.json(result);
 });
 app.get('/api/attempts/:id',async c=>{
  const view=c.req.query('view');
  if(view!==undefined&&view!=='status'&&view!=='full')throw new HTTPException(400,{message:'任务视图须为status或full'});
  return c.json(await wait(pool,uuid(c.req.param('id')),waitDuration(c.req.query('wait_ms')),c.req.raw.signal,view));
 });
 app.post('/api/projects/:id/steps/:ordinal/run-batch',async c=>{
  const projectId=uuid(c.req.param('id'));
  const ordinal=Number(c.req.param('ordinal'));
  if(!Number.isInteger(ordinal)||!STEP_REGISTRY.some(stage=>stage.visible&&stage.ordinal===ordinal))throw new HTTPException(400,{message:'步骤序号无效'});
  let body:unknown={};
  try{body=await c.req.json();}catch{throw new HTTPException(400,{message:'批量执行参数须为有效JSON'});}
  const rawIds=(body as {workflow_ids?:unknown}|null)?.workflow_ids;
  if(rawIds!==undefined&&!Array.isArray(rawIds))throw new HTTPException(400,{message:'workflow_ids须为记录数组'});
  const requestedIds=rawIds===undefined?undefined:[...new Set(rawIds.map(value=>uuid(String(value))))];
  if(!await data.projectExists(projectId))throw new HTTPException(404,{message:'项目不存在'});
  const selected=await data.selectWorkflows(projectId,requestedIds);
  const byId=new Map(selected.map(row=>[row.id,row]));
  const workflowIds=requestedIds??selected.map(row=>row.id);
  const results:{workflow_id:string;status:'queued'|'succeeded'|'not_ready'|'failed'|'not_found';attempt_id?:string;attempt_ids?:string[];reused?:boolean;reason?:string}[]=[];
  for(const workflowBatch of splitIntoBatches(workflowIds,batchChunkSize)){
   const validIds=workflowBatch.filter(workflowId=>byId.get(workflowId)?.project_id===projectId);
   const stateRows=validIds.length?await data.readStepStates(projectId,validIds):[];
   const statesByWorkflow=new Map<string,Map<number,WorkflowStepState>>();
   for(const row of stateRows){
    if(!statesByWorkflow.has(row.workflow_id))statesByWorkflow.set(row.workflow_id,new Map());
    statesByWorkflow.get(row.workflow_id)!.set(row.ordinal,{ordinal:row.ordinal,status:row.status,result:row.result,enabled:Boolean(row.enabled),active:Boolean(row.active),has_pdf:Boolean(row.has_pdf),extraction_status:row.extraction_status});
   }
   const batchResults=await Promise.all(workflowBatch.map(async workflowId=>{
    const row=byId.get(workflowId);
    if(!row||row.project_id!==projectId)return{workflow_id:workflowId,status:'not_found' as const};
    const eligibility=workflowStepReadiness(ordinal,statesByWorkflow.get(workflowId)??new Map());
    if(!eligibility.ready)return{workflow_id:workflowId,status:'not_ready' as const,reason:eligibility.reason};
    try{
     const task=await dispatch(workflowId,ordinal as WorkflowStepOrdinal);
     return{workflow_id:workflowId,status:task.completed?'succeeded' as const:'queued' as const,attempt_id:task.id,...(task.ids?{attempt_ids:task.ids}:{}),reused:task.reused??false};
    }catch(error){
     if(error instanceof HTTPException&&error.status===409)return{workflow_id:workflowId,status:'not_ready' as const,reason:error.message};
     if(error instanceof HTTPException&&error.status===404)return{workflow_id:workflowId,status:'not_found' as const};
     return{workflow_id:workflowId,status:'failed' as const,reason:'派发失败，请检查任务记录和服务端日志'};
    }
   }));
   results.push(...batchResults);
  }
  for(const state of ['queued','succeeded','not_ready','failed','not_found'] as const){
   const count=results.filter(result=>result.status===state).length;
   logEvent('batch.result',{level:state==='failed'||state==='not_found'?'warn':'info',component:'batch_dispatch',project_id:projectId,ordinal,state,expected_count:workflowIds.length,actual_count:count,batch_size:batchChunkSize});
  }
  return c.json({results},202);
 });
}
