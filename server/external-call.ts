/**
 * 职责：为普通外部模型调用生成关联 ID、传递调用日志上下文并记录调用结果。
 * 关键方法：`runExternalCall()` 执行一次外部调用，不重试或访问数据库。
 * 使用场景：出题、作答、评分、材料提取和脱敏 worker 的普通任务。
 */
import {randomUUID} from 'node:crypto';
import {classifyLogError,logEvent,withLogContext} from './logging';

export interface ExternalCallContext {
 attempt_id:string;
 operation:string;
 call_id?:string;
 material_id?:string;
}

export async function runExternalCall<T extends {usage?:unknown;duration_ms?:number}>(
 context:ExternalCallContext,
 execute:(callId:string)=>Promise<T>,
):Promise<T>{
 const call_id=context.call_id??randomUUID();
 return withLogContext({...context,call_id},async()=>{
  const started=performance.now();
  logEvent('call.started',{level:'info'});
  try{
   const result=await execute(call_id);
   logEvent('call.completed',{level:'info',elapsed_ms:Math.round(performance.now()-started),token_usage:result.usage});
   return result;
  }catch(error){
   logEvent('call.failed',{level:'error',elapsed_ms:Math.round(performance.now()-started),...classifyLogError(error)});
   throw error;
  }
 });
}
