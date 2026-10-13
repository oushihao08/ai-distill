/** 任务等待单测：验证轻量投影、完整结果兼容、一秒轮询、截止和取消；只用内存连接池，不访问数据库或模型。 */
import {expect,spyOn,test} from 'bun:test';
import type {Pool} from 'pg';
import {waitForAttempt} from './attempts';

function fixture(states:string[]){
 const calls:string[]=[];
 const pool={query:async(sql:string)=>{
  calls.push(sql);
  return{rows:[{id:'attempt',workflow_id:'workflow',ordinal:5,status:states[Math.min(calls.length-1,states.length-1)],error:null,...(sql.includes('a.result')?{result:{text:'完整答案'}}:{})}]};
 }} as unknown as Pool;
 return{pool,calls};
}
test('轻量等待不查询结果正文，默认完整读取保持兼容',async()=>{
 const f=fixture(['succeeded']),signal=new AbortController().signal;
 const brief=await waitForAttempt(f.pool,'attempt',0,signal,'status');
 expect(brief).toMatchObject({id:'attempt',workflow_id:'workflow',ordinal:5,status:'succeeded',completed:true});
 expect(f.calls[0]).not.toContain('a.result');expect(brief).not.toHaveProperty('result');
 expect(await waitForAttempt(f.pool,'attempt',0,signal)).toHaveProperty('result.text','完整答案');
});
test('持续运行任务一秒后再查；剩余预算较短时只睡剩余时间',async()=>{
 const original=setTimeout,delays:number[]=[];
 const timer=spyOn(globalThis,'setTimeout').mockImplementation(((callback:any,ms:number,...args:any[])=>{delays.push(ms);return original(callback,0,...args);}) as typeof setTimeout);
 try{
  const f=fixture(['running','succeeded']);
  await waitForAttempt(f.pool,'attempt',10000,new AbortController().signal,'status');
  expect(delays).toEqual([1000]);expect(f.calls).toHaveLength(2);
  delays.length=0;
  const short=fixture(['running','succeeded']);
  await waitForAttempt(short.pool,'attempt',50,new AbortController().signal,'status');
  expect(delays).toHaveLength(1);expect(delays[0]).toBeGreaterThan(0);expect(delays[0]).toBeLessThanOrEqual(50);
 }finally{timer.mockRestore();}
});
test('等待预算结束仍返回运行状态，不写入或取消任务',async()=>{
 const f=fixture(['running']);
 const result=await waitForAttempt(f.pool,'attempt',20,new AbortController().signal,'status');
 expect(result).toMatchObject({status:'running',completed:false});
 expect(f.calls.every(sql=>sql.startsWith('SELECT'))).toBe(true);
});
test('睡眠中取消立即唤醒，不再查询或改写任务',async()=>{
 const f=fixture(['running']),controller=new AbortController();
 const waiting=waitForAttempt(f.pool,'attempt',10000,controller.signal,'status');
 queueMicrotask(()=>controller.abort());
 await expect(waiting).rejects.toMatchObject({status:408});
 expect(f.calls).toHaveLength(1);
});
