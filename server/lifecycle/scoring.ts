/** 评分终态增强：同步接续既有达标判断，失败独立记录，不改写评分。供评分队列的正常完成/失联结算调用。 */
import {LifecycleRegistry} from './registry';
import {logEvent,classifyLogError} from '../logging';
export async function runScoringEnhancements(job:{id?:string;workflow_id:string;project_id?:string},status:string,judge:(workflowId:string)=>Promise<unknown>){
 if(!['succeeded','failed'].includes(status))return;
 const registry=new LifecycleRegistry();
 registry.register({id:'acceptance',stage:'scoring',event:'committed',run:async()=>{
  try{await judge(job.workflow_id);}catch(error){logEvent('acceptance.auto_failed',{level:'error',workflow_id:job.workflow_id,...classifyLogError(error)});throw error;}
 }});
 try{return await registry.emit('committed',{stage:'scoring',execution_id:job.id??job.workflow_id,workflow_id:job.workflow_id,project_id:job.project_id});}
 catch(error){throw error;}
}
