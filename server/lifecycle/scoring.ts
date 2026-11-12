/**
 * 职责：评分终态后的达标判断接续执行。
 * 核心入口：`runScoringEnhancements()` 供评分队列在 `succeeded`/`failed` 结算后调用，异常独立记录日志并返回 `LifecycleOutcome[]`，不回滚已提交评分。
 */
import {runLifecycleTask,type LifecycleOutcome} from './registry';
import {logEvent,classifyLogError} from '../logging';
export async function runScoringEnhancements(
 job:{id?:string;workflow_id:string;project_id?:string},
 status:string,
 judge:(workflowId:string)=>Promise<unknown>
):Promise<LifecycleOutcome[]|undefined>{
 if(!['succeeded','failed'].includes(status))return;
 const outcome=await runLifecycleTask('acceptance',undefined,async()=>{
  try{
   await judge(job.workflow_id);
  }catch(error){
   logEvent('acceptance.auto_failed',{level:'error',workflow_id:job.workflow_id,...classifyLogError(error)});
   throw error;
  }
 });
 return [outcome];
}
