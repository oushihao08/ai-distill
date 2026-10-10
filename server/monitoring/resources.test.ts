/** 验证本机内存与进程采样、未知值表达、PID 白名单及派发建议。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {describe,test,expect} from 'bun:test';
import {parseMemoryPressure,parseProcessRss,sampleResources,adviseDispatch,type CommandReader,type ResourceSnapshot} from './resources';
const memory='The system has 1000000 (100 pages with a page size of 10000).\nSystem-wide memory free percentage: 40%\n';
const reader:CommandReader=async(file,args)=>file.endsWith('memory_pressure')?memory:args[1]!.split(',').map(pid=>`${pid} 100`).join('\n');
const options={read:reader,current_pid:42,platform:'darwin'};
const ready={state:'running',authentication:'ready',quota:'available',error:'none'} as const;
describe('resource sampling',()=>{
 test('system availability is an explicitly labeled estimate',()=>expect(parseMemoryPressure(memory)).toEqual({status:'known',value:{total_bytes:1000000,available_bytes_estimate:400000,available_percent:40,method:'macos_memory_pressure_percentage'}}));
 for(const value of ['',memory+'System-wide memory free percentage: 2%\n',memory.replace('40%','101%'),memory.replace('1000000','0'),memory.replace('40%','-1%')])test(`invalid system reading ${JSON.stringify(value)}`,()=>expect(parseMemoryPressure(value).status).toBe('unknown'));
 for(const value of ['','42 0','42 -1','43 10','42 x','42 1\n42 2','42 99999999999999999'])test(`invalid RSS ${value}`,()=>expect(parseProcessRss(value,42).status).toBe('unknown'));
 test('RSS uses kilobytes and matches PID',()=>expect(parseProcessRss(' 42 100\n',42)).toEqual({status:'known',value:102400}));
 test('only registered PID and self, duplicates removed, no args/environment reads',async()=>{
  const calls:[string,readonly string[]][]=[];
  const result=await sampleResources({registered_pids:[99,42,99],tasks:[]},{...options,read:async(file,args)=>{calls.push([file,args]);return reader(file,args);}});
  expect(result.processes.map(p=>p.pid)).toEqual([42,99]);
  expect(calls).toEqual([['/usr/bin/memory_pressure',['-Q']],['/bin/ps',['-p','42,99','-o','pid=,rss=']]]);
 });
 for(const pid of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'42;secret'])test(`reject PID ${pid}`,async()=>expect(sampleResources({registered_pids:[pid as number]},options)).rejects.toThrow('PID'));
 test('one process query handles missing, duplicate and unregistered rows',async()=>{
  const result=await sampleResources({registered_pids:[99,100]}, {...options,read:async(file)=>file.endsWith('memory_pressure')?memory:'42 100\n99 20\n99 30\n777 800'});
  expect(result.processes).toEqual([{pid:42,rss_bytes:{status:'known',value:102400}},{pid:99,rss_bytes:{status:'unknown'}},{pid:100,rss_bytes:{status:'unknown'}}]);
 });
 test('read failure stays unknown and never leaks error',async()=>{
  const result=await sampleResources({registered_pids:[99]},{...options,read:async()=>{throw new Error('SECRET');}});
  expect(result.system.status).toBe('unknown');expect(result.processes.every(p=>p.rss_bytes.status==='unknown')).toBe(true);expect(JSON.stringify(result)).not.toContain('SECRET');
 });
 test('non-mac system is unknown without misleading free memory fallback',async()=>expect((await sampleResources({registered_pids:[]},{...options,platform:'linux'})).system.status).toBe('unknown'));
 test('whitelists executor status and events',async()=>{
  const task={...ready,message:'SECRET',last_event:{type:'heartbeat' as const,at:'2026-10-08T10:00:00Z',body:'SECRET'}};
  const result=await sampleResources({registered_pids:[],tasks:[task]},options);
  expect(JSON.stringify(result)).not.toContain('SECRET');expect(result.tasks.status).toBe('known');
 });
 test('bad events, raw errors, missing auth do not pass through',async()=>{
  const result=await sampleResources({registered_pids:[],tasks:[{state:'running',last_event:{type:'SECRET',at:'SECRET'},error:'SECRET'} as any]},options);
  expect(result.tasks.status).toBe('known');expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(adviseDispatch(result,{min_available_percent:10}).decision).toBe('unknown');
 });
 test('actual shared skipped state remains known and counted',async()=>{
  const result=await sampleResources({registered_pids:[],tasks:[{state:'skipped',authentication:'ready',quota:'available',error:'none',last_event:{type:'cancelled',at:'2026-10-08T10:00:00Z'}}]},options);
  expect(result.tasks.status).toBe('known');
  if(result.tasks.status==='known'){
   expect(result.tasks.value.states).toEqual({waiting:0,running:0,succeeded:0,failed:0,skipped:1});
   expect(result.tasks.value.executors[0]!.last_event).toEqual({status:'known',value:{type:'cancelled',at:'2026-10-08T10:00:00.000Z'}});
  }
 });
 test('invalid task state or missing tasks are unknown',async()=>{
  for(const tasks of [undefined,[{state:'SECRET'}] as any])expect((await sampleResources({registered_pids:[],tasks},options)).tasks.status).toBe('unknown');
 });
});
describe('dispatch advice without side effects',()=>{
 test('healthy resources permit, low memory pauses at caller threshold',async()=>{
  const snap=await sampleResources({registered_pids:[],tasks:[ready]},options);
  expect(adviseDispatch(snap,{min_available_percent:40}).decision).toBe('allow');
  expect(adviseDispatch(snap,{min_available_percent:41})).toEqual({decision:'pause',reasons:['low_available_memory']});
  expect(adviseDispatch(snap,{min_available_percent:10,max_running_tasks:1}).reasons).toEqual(['running_task_limit']);
 });
 for(const patch of [{authentication:'blocked'},{quota:'exhausted'},{error:'authentication'},{error:'quota'},{error:'rate_limit'}])test(`blocking ${JSON.stringify(patch)}`,async()=>{
  const snap=await sampleResources({registered_pids:[],tasks:[{...ready,...patch} as any]},options);
  const before=JSON.stringify(snap);expect(adviseDispatch(snap,{min_available_percent:10}).decision).toBe('pause');expect(JSON.stringify(snap)).toBe(before);
 });
 test('unknown memory and processes remain unknown',async()=>{
  const snap=await sampleResources({registered_pids:[],tasks:[]},{...options,read:async()=>''});expect(adviseDispatch(snap,{min_available_percent:10}).decision).toBe('unknown');
 });
 for(const thresholds of [{min_available_percent:-1},{min_available_percent:101},{min_available_percent:NaN},{min_available_percent:10,max_running_tasks:0}])test('invalid threshold',async()=>expect(()=>adviseDispatch(awaitSnapshot,thresholds)).toThrow());
});
const awaitSnapshot:ResourceSnapshot={sampled_at:'',system:{status:'unknown'},tasks:{status:'unknown'},processes:[]};
