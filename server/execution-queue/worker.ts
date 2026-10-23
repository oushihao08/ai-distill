/** 本机队列消费入口：只对本机已确认业务ID调用既有执行器；不扫描云端等待队列。 */
import type {Pool} from 'pg';
import {join} from 'node:path';
import {runWorkerPool} from '../worker-pool';
import {getAgentConcurrencyGate,closeAgentConcurrencyGate} from '../concurrency';
import {runNextAuthoring} from '../authoring/jobs';
import {runNextAnswer} from '../answer-models/jobs';
import {createAnswerClient} from '../answer-models/dispatch';
import {runNextScore} from '../scoring/jobs';
import {runIndependentApiScore} from '../scoring/executor';
import {runNextProjectSkill} from '../skill-generation/jobs';
import {runNextIntake} from '../intake-jobs';
import {runNextExtraction} from '../materials/jobs';
import {runNextRedaction} from '../materials/redaction-jobs';
import {runNextLibraryJob} from '../material-library/runner';
import {runNextHook} from '../workflow-hook-worker';
import {runNextRemoteMaterialOperation} from '../remote-material-operations';
import {logEvent,classifyLogError} from '../logging';
import {localQueue,withLocalExecution,reconcileRegistrations,cloudJobState,isTransientCommitFailure,PendingLocalCommit,assertLocalQueueEnvironment,reconcileTerminalOutcome,synchronizeLocalCancellations,reconcileFinishedJobs} from './runtime';
import type {QueueJob,Lane} from './store';
async function dispatch(pool:Pool,root:string,job:QueueJob,signal:AbortSignal){
 const table=job.kind==='library'?'library_jobs':job.kind==='skill'?'project_skill_attempts':job.kind==='hook'?'hook_runs':job.kind==='remote'?'remote_material_operations':'step_attempts';
 const raw=(await pool.query(`SELECT to_jsonb(j) AS job FROM ai_distill.${table} j WHERE id=$1`,[job.id])).rows[0]?.job;
 if(!raw)return false;const target=raw.execution_target??'local';
 if(job.kind==='library')return runNextLibraryJob(pool,root,raw.executor_kind,target,signal,job.id);
 switch(job.route){
  case 'authoring':return runNextAuthoring(pool,root,undefined,signal);
  case 'answer':return runNextAnswer(pool,root,createAnswerClient().answer,signal,'all',target,raw.config?.provider==='codex'?'codex':'api');
  case 'score':return runNextScore(pool,root,raw.config?.provider==='api'?runIndependentApiScore:undefined,signal,undefined,raw.config?.provider==='api'?'api':'codex','all');
  case 'skill':return runNextProjectSkill(pool,root,undefined,signal);
  case 'intake':return runNextIntake(pool,root,undefined,signal,target);
  case 'extract':return runNextExtraction(pool,root,undefined,undefined,signal,target);
  case 'redact':return runNextRedaction(pool,root,signal,undefined,raw.config?.provider==='codex'?'codex':'api',target);
  case 'hook':return runNextHook(pool,signal,'all');
  case 'remote':return runNextRemoteMaterialOperation(pool);
  default:throw new Error('本机任务执行路由无效');
 }
}
export async function runLocalQueueWorker(pool:Pool,root:string,signal:AbortSignal,limits:{agent:number;llmApi:number},beforeDispatch:()=>Promise<boolean>,mode='all'){
 await assertLocalQueueEnvironment(pool,root);
 const q=localQueue(root);q.recover();const lanes:Lane[]=mode==='server'||mode==='materials'||mode==='api'?['api','internal','remote']:['agent','api','internal','hook','remote'];
 const laneLimit=(lane:Lane)=>lane==='agent'?limits.agent:lane==='api'||lane==='internal'?limits.llmApi:1;
 const gateRoot=(lane:Lane)=>lane==='agent'?root:join(root,`.execution-${lane}-slots`);
 const gates=new Map(lanes.map(lane=>[lane,getAgentConcurrencyGate(gateRoot(lane),laneLimit(lane))]));
 let reconciliation:Promise<void>|undefined,nextSync=0;
 // 单飞后台对账：慢查询不占据每个通道的领取前置，失败后退避，禁止叠加轮次。
 const sync=()=>{if(reconciliation||Date.now()<nextSync||signal.aborted)return;
  reconciliation=(async()=>{
   for(const reconcile of [reconcileRegistrations,synchronizeLocalCancellations,reconcileFinishedJobs]){
    if(signal.aborted)break;
    try{await reconcile(pool,q);}catch(error){logEvent('queue.reconciliation_failed',{level:'error',component:'local_execution_queue',...classifyLogError(error)});}
   }
  })().finally(()=>{nextSync=Date.now()+5000;reconciliation=undefined;});
 };
 const consume=async(lane:Lane)=>{
  sync();if(signal.aborted)return false;const job=q.claim(lane);if(!job)return false;
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const heartbeat=setInterval(()=>{if(!q.heartbeat(job.id,job.lease!))controller.abort(new Error('本机任务取消或失租'));},500);heartbeat.unref();
  try{
   const status=await cloudJobState(pool,q,job);
   if(!status){q.finish(job.id,job.lease!,'stale','业务记录或本机归属不存在');return true;}
   if(await reconcileTerminalOutcome(pool,q,job))return true;
   const worked=await withLocalExecution(q,job,()=>dispatch(pool,root,job,controller.signal));
   const final=await cloudJobState(pool,q,job);
   q.finish(job.id,job.lease!,q.get(job.id)?.cancel_requested?'cancelled':final==='succeeded'?'committed':final==='failed'?'failed':final==='cancelled'?'cancelled':final==='skipped'?'stale':controller.signal.aborted?'needs_review':job.kind==='remote'&&worked?'queued':'needs_review',worked?null:'业务前置条件未满足，未发起调用');
   return !(job.kind==='remote'&&['waiting','running'].includes(final??''));
  }catch(error){
   let recoverable=false;
   try{recoverable=isTransientCommitFailure(error)&&(Boolean(q.stepFailure(job))||(!q.hasUnknownCall(job.id)&&q.hasResult(job.id)));}catch(checkpointError){logEvent('queue.checkpoint_invalid',{level:'error',component:'local_execution_queue',...classifyLogError(checkpointError)});}
   q.finish(job.id,job.lease!,q.get(job.id)?.cancel_requested?'cancelled':error instanceof PendingLocalCommit||recoverable?'result_pending_commit':'needs_review',error instanceof PendingLocalCommit?error.message:'执行或业务回执待核实，不自动重复调用');
   logEvent('worker.dispatch.failed',{level:'error',component:'local_execution_queue',...classifyLogError(error)});return true;
  }finally{clearInterval(heartbeat);signal.removeEventListener('abort',abort);}
 };
 try{await Promise.all(lanes.map(lane=>runWorkerPool(async()=>{
  const permit=await gates.get(lane)!.run(()=>consume(lane),{signal});return permit.acquired?permit.value:false;
 },{component:`local_${lane}`,concurrency:laneLimit(lane),beforeDispatch,signal,idleMs:3000,errorDelayMs:5000})));}
 finally{if(reconciliation)await reconciliation;for(const lane of lanes)closeAgentConcurrencyGate(gateRoot(lane));}
}
