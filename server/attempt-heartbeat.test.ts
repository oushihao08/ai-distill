/** 验证共用心跳的调度、查询防重、日志状态和停止；定时器/数据库/日志均为替身，不访问业务数据。 */
import {test,expect,spyOn} from 'bun:test';
import type {Pool} from 'pg';
import * as logging from './logging';
import {startAttemptHeartbeat} from './attempt-heartbeat';

const context={component:'authoring',project_id:'project',workflow_id:'workflow',ordinal:4,attempt_id:'attempt'} as const;
function fixture(){
 let tick:()=>void=()=>{throw new Error('timer not registered');};
 const interval=spyOn(globalThis,'setInterval').mockImplementation(((callback:()=>void)=>{tick=callback;return 123;}) as any);
 const clear=spyOn(globalThis,'clearInterval').mockImplementation(()=>{});
 const events=spyOn(logging,'logEvent').mockImplementation(()=>{});
 const contexts=spyOn(logging,'withLogContext').mockImplementation((_fields,run)=>run());
 const stderr=spyOn(console,'error').mockImplementation(()=>{});
 return{interval,clear,events,contexts,stderr,fire:()=>tick(),async flush(){for(let i=0;i<8;i++)await Promise.resolve();},restore(){interval.mockRestore();clear.mockRestore();events.mockRestore();contexts.mockRestore();stderr.mockRestore();}};
}

test('心跳延后10秒开始，仅更新对应running尝试，停止释放定时器',async()=>{
 const f=fixture(),calls:unknown[][]=[];
 const pool={query:async(...args:unknown[])=>{calls.push(args);return{rowCount:1};}} as unknown as Pool;
 let stop:(()=>void)|undefined;
 try{
  stop=startAttemptHeartbeat(pool,context,'原心跳错误');
  expect(f.interval.mock.calls[0]?.[1]).toBe(10000);expect(calls).toHaveLength(0);
  f.fire();await f.flush();
  expect(calls).toEqual([["UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running' RETURNING id",['attempt']]]);
  expect(f.contexts.mock.calls[0]?.[0]).toEqual(context);expect(f.events).not.toHaveBeenCalled();
  stop();expect(f.clear.mock.calls).toEqual([[123]]);
 }finally{stop?.();f.restore();}
});

test('上次心跳未结束时不重叠写入；停止不取消已发出的查询',async()=>{
 const f=fixture();let complete!:()=>void,calls=0;
 const pool={query:()=>{calls++;return new Promise(resolve=>{complete=()=>resolve({rowCount:1});});}} as unknown as Pool;
 let stop:(()=>void)|undefined;
 try{
  stop=startAttemptHeartbeat(pool,context,'原心跳错误');
  f.fire();f.fire();expect(calls).toBe(1);
  stop();complete();await f.flush();expect(f.events).not.toHaveBeenCalled();
  expect(f.clear.mock.calls[0]).toEqual([123]);
 }finally{stop?.();f.restore();}
});

test('非running只报告一次警告，恢复后下次失败重新报告',async()=>{
 const f=fixture();let rowCount=0;
 const pool={query:async()=>({rowCount})} as unknown as Pool;
 let stop:(()=>void)|undefined;
 try{
  stop=startAttemptHeartbeat(pool,{...context,component:'answer',ordinal:5},'作答任务心跳写入失败');
  f.fire();await f.flush();f.fire();await f.flush();
  expect(f.events).toHaveBeenCalledTimes(1);
  expect(f.events.mock.calls[0]).toEqual(['heartbeat.write_failed',expect.objectContaining({level:'warn',reason_code:'attempt_not_running',last_heartbeat_at:expect.any(String)})]);
  rowCount=1;f.fire();await f.flush();
  expect(f.events.mock.calls[1]).toEqual(['heartbeat.write_recovered',expect.objectContaining({level:'info',elapsed_ms:expect.any(Number)})]);
  rowCount=0;f.fire();await f.flush();expect(f.events).toHaveBeenCalledTimes(3);expect(f.stderr).not.toHaveBeenCalled();
 }finally{stop?.();f.restore();}
});

test('查询异常去重且不泄露原文，恢复后释放防重锁；三阶段保留自己的消息',async()=>{
 for(const [component,ordinal,message] of [['authoring',4,'第四步任务心跳写入失败'],['answer',5,'作答任务心跳写入失败'],['scoring',6,'评分心跳写入失败']] as const){
  const f=fixture();let fail=true;
  const pool={query:async()=>{if(fail)throw new Error('PRIVATE DATABASE ERROR');return{rowCount:1};}} as unknown as Pool;
  let stop:(()=>void)|undefined;
  try{
   stop=startAttemptHeartbeat(pool,{...context,component,ordinal},message);
   f.fire();await f.flush();f.fire();await f.flush();
   expect(f.events).toHaveBeenCalledTimes(1);expect(f.stderr.mock.calls).toEqual([[message]]);
   expect(JSON.stringify(f.events.mock.calls)).not.toContain('PRIVATE DATABASE ERROR');
   expect(f.events.mock.calls[0]?.[1]).toMatchObject({level:'error',error_kind:'unknown'});
   fail=false;f.fire();await f.flush();expect(f.events.mock.calls[1]?.[0]).toBe('heartbeat.write_recovered');
   expect(f.contexts.mock.calls[0]?.[0]).toMatchObject({component,ordinal,attempt_id:'attempt'});
  }finally{stop?.();f.restore();}
 }
});
