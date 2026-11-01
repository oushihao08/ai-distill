/**
 * 职责：注册单题/批量派发、attempt等待及显式取消 API；未知调用取消须用户确认原执行端停止。
 * 关键方法：registerWorkflowExecutionRoutes 连接 HTTP 输入／响应与就绪判定；业务派发由 app 提供。
 * 使用场景：createApp 完成全局中间件后注册工作流执行路由。
 */
import {Hono,type Context} from 'hono';
import {HTTPException} from 'hono/http-exception';
import type {Pool} from 'pg';
import {STEP_REGISTRY} from '../shared/step-registry';
import {logEvent} from './logging';
import {readBatchChunkSize,readProjectWorkflowStepRows,splitIntoBatches,workflowStepReadiness,type WorkflowStepState} from './project-folders';
import {cancelStoppedExecutorAttempt,cancelWaitingScore,waitDuration,waitForAttempt} from './attempts';
import {uuid} from './validation';
import type {StepDispatchTask,WorkflowStepOrdinal} from './step-dispatch';
import {validateAnswerScore} from './scoring/context';
import {restoreAnswerScoreResults} from './answer-models/restore';
import {restoreAuthoringResult,selectHistoricalAuthoringResult} from './authoring/restore';
import {storageDirectory} from './paths';
import {QueueCapacityError} from './execution-queue/store';
import {readActiveConcurrencyLimit,readConcurrencySettings} from './concurrency';

interface RouteDependencies {
 pool:Pool;
 storageRoot?:string;
 dispatch:(workflowId:string,ordinal:WorkflowStepOrdinal,context?:{delivery_identity:{task_id:string;org:string}})=>Promise<StepDispatchTask>;
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

export function registerWorkflowExecutionRoutes(app:Hono,{pool,dispatch,storageRoot=storageDirectory(),batchChunkSize=readBatchChunkSize(),repository,waitForAttempt:wait=waitForAttempt}:RouteDependencies){
 app.post('/api/workflows/:id/answer-score-results/restore',async c=>{
  const raw=await c.req.text();
  let body:unknown={};
  if(raw.trim())try{body=JSON.parse(raw);}catch{throw new HTTPException(400,{message:'恢复参数须为有效JSON'});}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='answer_only')||('answer_only'in body&&typeof (body as {answer_only?:unknown}).answer_only!=='boolean'))throw new HTTPException(400,{message:'恢复参数只允许可选布尔值 answer_only'});
  return c.json(await restoreAnswerScoreResults(pool,uuid(c.req.param('id')),(body as {answer_only?:boolean}).answer_only===true));
 });
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
  let context:{delivery_identity:{task_id:string;org:string}}|undefined;
  if(ordinal===8){
   const raw=await c.req.text();
   if(raw.trim()){
    let body:unknown;try{body=JSON.parse(raw);}catch{throw new HTTPException(400,{message:'归档参数须为有效JSON'});}
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!('delivery_identity'in body))throw new HTTPException(400,{message:'归档参数只允许 delivery_identity'});
    const identity=(body as {delivery_identity?:unknown}).delivery_identity;
    if(!identity||typeof identity!=='object'||Array.isArray(identity)||Object.keys(identity).some(key=>!['task_id','org'].includes(key))||typeof (identity as any).task_id!=='string'||!(identity as any).task_id.trim()||(identity as any).task_id.length>180||typeof (identity as any).org!=='string'||!(identity as any).org.trim()||(identity as any).org.length>180)throw new HTTPException(400,{message:'交付身份需要非空的 task_id 和 org；具体格式由项目交付规则校验'});
    context={delivery_identity:{task_id:(identity as any).task_id,org:(identity as any).org}};
   }
  }
  const task=await dispatch(id,ordinal,context);
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
 app.post('/api/attempts/:id/cancel-waiting-score',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'取消参数须为JSON'});});
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||typeof body.workflow_id!=='string'||typeof body.executor_id!=='string')throw new HTTPException(400,{message:'必须明确指定workflow_id和executor_id'});
  return c.json(await cancelWaitingScore(pool,uuid(c.req.param('id')),uuid(body.workflow_id),uuid(body.executor_id)));
 });
 app.post('/api/attempts/:id/cancel-stopped-executor',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'取消参数须为JSON'});});
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==5||typeof body.workflow_id!=='string'||typeof body.executor_id!=='string'||body.executor_stopped!==true||body.acknowledge_unknown_result!==true||body.expected_heartbeat_at!==null&&(typeof body.expected_heartbeat_at!=='string'||!Number.isFinite(Date.parse(body.expected_heartbeat_at))))throw new HTTPException(400,{message:'须明确workflow_id/executor_id/expected_heartbeat_at，并确认executor_stopped与acknowledge_unknown_result'});
  return c.json(await cancelStoppedExecutorAttempt(pool,uuid(c.req.param('id')),uuid(body.workflow_id),uuid(body.executor_id),body.expected_heartbeat_at));
 });
 app.post('/api/workflows/:id/authoring-results/:attemptId/restore',async c=>c.json(await restoreAuthoringResult(pool,storageRoot,uuid(c.req.param('id')),uuid(c.req.param('attemptId')))));
 app.post('/api/workflows/:id/authoring-results/:attemptId/select',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'须提供当前最新尝试ID'});});
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.expected_latest_attempt_id!=='string')throw new HTTPException(400,{message:'仅接受expected_latest_attempt_id'});
  return c.json(await selectHistoricalAuthoringResult(pool,uuid(c.req.param('id')),uuid(c.req.param('attemptId')),uuid(body.expected_latest_attempt_id)));
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
  const results:{workflow_id:string;status:'queued'|'succeeded'|'not_ready'|'failed'|'not_found'|'capacity_exceeded'|'already_accepted'|'already_archived';attempt_id?:string;attempt_ids?:string[];reused?:boolean;reason?:string;decision?:StepDispatchTask['decision'];reasons?:string[]}[]=[];
  for(const workflowBatch of splitIntoBatches(workflowIds,batchChunkSize)){
   const validIds=workflowBatch.filter(workflowId=>byId.get(workflowId)?.project_id===projectId);
   const stateRows=validIds.length?await data.readStepStates(projectId,validIds):[];
   const statesByWorkflow=new Map<string,Map<number,WorkflowStepState>>();
   for(const row of stateRows){
    if(!statesByWorkflow.has(row.workflow_id))statesByWorkflow.set(row.workflow_id,new Map());
    statesByWorkflow.get(row.workflow_id)!.set(row.ordinal,{project_key:row.project_key,ordinal:row.ordinal,status:row.status,result:row.result,enabled:Boolean(row.enabled),active:Boolean(row.active),has_pdf:Boolean(row.has_pdf),extraction_status:row.extraction_status,workflow_kind:row.workflow_kind,source_workflow_id:row.source_workflow_id,library_source:Boolean(row.library_source),revision_advice_ready:row.revision_advice_ready===true});
   }
   // 入队并行跟随当前Agent容量，避免固定小批次拖慢worker补位。
   const batchResults=[];
   const admissionConcurrency=readActiveConcurrencyLimit(storageRoot)??readConcurrencySettings(process.env,storageRoot).agent;
   for(const admissionBatch of splitIntoBatches(workflowBatch,admissionConcurrency)){
   batchResults.push(...await Promise.all(admissionBatch.map(async workflowId=>{
    const row=byId.get(workflowId);
    if(!row||row.project_id!==projectId)return{workflow_id:workflowId,status:'not_found' as const};
    const states=statesByWorkflow.get(workflowId)??new Map<number,WorkflowStepState>(),acceptance=states.get(7);
    if([4,5,6,7,8].includes(ordinal)&&states.get(8)?.status==='succeeded')return{workflow_id:workflowId,status:'already_archived' as const,reason:'当前题目已归档，已跳过'};
    if([4,5,6].includes(ordinal)&&acceptance?.status==='succeeded'&&acceptance.result?.decision==='accepted')return{workflow_id:workflowId,status:'already_accepted' as const,reason:'当前题目已达标，已跳过'};
    const eligibility=workflowStepReadiness(ordinal,states);
    if(!eligibility.ready)return{workflow_id:workflowId,status:'not_ready' as const,reason:eligibility.reason};
    try{
     const task=await dispatch(workflowId,ordinal as WorkflowStepOrdinal);
     return{workflow_id:workflowId,status:task.completed?'succeeded' as const:'queued' as const,attempt_id:task.id,...(task.ids?{attempt_ids:task.ids}:{}),reused:task.reused??false,...(task.decision?{decision:task.decision,reasons:task.reasons??[]}: {})};
    }catch(error){
     if(error instanceof QueueCapacityError)return{workflow_id:workflowId,status:'capacity_exceeded' as const,reason:error.message};
     if(error instanceof HTTPException&&error.status===409)return{workflow_id:workflowId,status:'not_ready' as const,reason:error.message};
     if(error instanceof HTTPException&&error.status===404)return{workflow_id:workflowId,status:'not_found' as const};
     return{workflow_id:workflowId,status:'failed' as const,reason:'派发失败，请检查任务记录和服务端日志'};
    }
   })));
   }
   results.push(...batchResults);
  }
  for(const state of ['queued','succeeded','not_ready','failed','not_found','capacity_exceeded','already_accepted','already_archived'] as const){
   const count=results.filter(result=>result.status===state).length;
   logEvent('batch.result',{level:state==='failed'||state==='not_found'?'warn':'info',component:'batch_dispatch',project_id:projectId,ordinal,state,expected_count:workflowIds.length,actual_count:count,batch_size:batchChunkSize});
  }
  return c.json({results},202);
 });
}
