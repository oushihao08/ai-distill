/**
 * 职责：共用出题、作答及评分尝试的10秒心跳、写入防重及失败/恢复日志。
 * 入口：startAttemptHeartbeat()由三个jobs消费入口调用，返回finally使用的停止函数。
 * 不改变任务状态或重试模型；停止只清理定时器，已发出的写入按原行为完成。
 */
import type {Pool} from 'pg';
import {classifyLogError,logEvent,withLogContext} from './logging';

interface AttemptHeartbeatContext {
 component:'authoring'|'answer'|'scoring';
 project_id:string;
 workflow_id:string;
 ordinal:4|5|6;
 attempt_id:string;
}

export function startAttemptHeartbeat(pool:Pick<Pool,'query'>,context:AttemptHeartbeatContext,errorMessage:string){
 let failed=false,lastHeartbeatAt=new Date().toISOString(),inFlight=false;
 const timer=setInterval(()=>{
  if(inFlight)return;
  inFlight=true;
  void withLogContext(context,async()=>{
   try{
    const result=await pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running' RETURNING id",[context.attempt_id]);
    if(!result.rowCount){
     if(!failed)logEvent('heartbeat.write_failed',{level:'warn',reason_code:'attempt_not_running',last_heartbeat_at:lastHeartbeatAt});
     failed=true;
    }else{
     if(failed)logEvent('heartbeat.write_recovered',{level:'info',elapsed_ms:Math.max(0,Date.now()-Date.parse(lastHeartbeatAt))});
     failed=false;
     lastHeartbeatAt=new Date().toISOString();
    }
   }catch(error){
    if(!failed){
     logEvent('heartbeat.write_failed',{level:'error',last_heartbeat_at:lastHeartbeatAt,...classifyLogError(error)});
     console.error(errorMessage);
    }
    failed=true;
   }finally{inFlight=false;}
  });
 },10000);
 return()=>clearInterval(timer);
}
