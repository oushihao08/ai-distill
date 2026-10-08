import {test,expect} from 'bun:test';
import type {Pool} from 'pg';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkerMonitor,readWorkerMonitor} from './worker-monitor';
import {sampleResources,type MonitorInput} from './resources';
const db=(rows:any[]=[])=>({query:async(sql:string)=>{expect(sql).toContain('a.input_revision=w.input_revision');expect(sql).toContain('w.deleted_at IS NULL');expect(sql).not.toContain('a.error');return{rows};}} as unknown as Pool);
const sampler=(percent:number|null)=>async(input:MonitorInput)=>sampleResources(input,{platform:'darwin',read:async(file,args)=>file.endsWith('memory_pressure')?percent===null?'':`The system has 1000000 (100 pages).\nSystem-wide memory free percentage: ${percent}%\n`:`${args[1]} 100`});
async function directory(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'distill-monitor-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
test('low memory pauses and recovery resumes using shared cached sample',async()=>directory(async root=>{
 let percent=5,calls=0;
 const monitor=createWorkerMonitor(db(),root,{min_available_percent:10,sample_interval_ms:5,sample:async input=>{calls++;return sampler(percent)(input);}});
 try{
  await monitor.start();expect(await monitor.beforeDispatch()).toBe(false);expect((await readWorkerMonitor(root)).status).toBe('paused');
  expect(calls).toBe(1);percent=30;await Bun.sleep(15);expect(await monitor.beforeDispatch()).toBe(true);expect((await readWorkerMonitor(root)).status).toBe('running');
 }finally{await monitor.stop();}
 expect(await monitor.beforeDispatch()).toBe(false);expect((await readWorkerMonitor(root)).status).toBe('stopped');
}));
test('concurrent dispatch callers merge one sampling operation',async()=>directory(async root=>{
 let calls=0;const monitor=createWorkerMonitor(db(),root,{min_available_percent:10,sample:async input=>{calls++;await Bun.sleep(10);return sampler(30)(input);}});
 try{expect(await Promise.all(Array.from({length:8},()=>monitor.beforeDispatch()))).toEqual(Array(8).fill(true));expect(calls).toBe(1);}finally{await monitor.stop();}
}));
test('unknown memory permits existing dispatch but reports unknown readiness',async()=>directory(async root=>{
 const monitor=createWorkerMonitor(db([{status:'running',started_at:new Date(),heartbeat_at:new Date(),error:'SECRET'}]),root,{min_available_percent:10,sample:sampler(null)});
 try{
  await monitor.start();expect(await monitor.beforeDispatch()).toBe(true);const result=await readWorkerMonitor(root);
  expect(result.dispatch).toMatchObject({allowed:true,memory_state:'unknown',policy:'memory_only_unknown_allow',reason:'memory_unknown'});
  expect(result.advice?.decision).toBe('unknown');expect(JSON.stringify(result)).not.toContain('SECRET');
  if(result.snapshot?.tasks.status==='known')expect(result.snapshot.tasks.value.executors[0]).toMatchObject({authentication:'unknown',quota:'unknown',error:'unknown'});
 }finally{await monitor.stop();}
}));
test('database query failure is task unknown, not zero',async()=>directory(async root=>{
 const monitor=createWorkerMonitor({query:async()=>{throw new Error('DB_SECRET');}} as unknown as Pool,root,{min_available_percent:10,sample:sampler(30)});
 try{await monitor.start();const result=await readWorkerMonitor(root);expect(result.snapshot?.tasks.status).toBe('unknown');expect(JSON.stringify(result)).not.toContain('DB_SECRET');}finally{await monitor.stop();}
}));
test('failed write cannot bypass known low memory',async()=>directory(async root=>{
 const rootFile=join(root,'file');await writeFile(rootFile,'x');const monitor=createWorkerMonitor(db(),rootFile,{min_available_percent:10,sample:sampler(2)});
 await monitor.start();expect(await monitor.beforeDispatch()).toBe(false);expect((await readWorkerMonitor(rootFile)).status).toBe('unavailable');await monitor.stop();
}));
test('sampling failure produces unknown without crashing',async()=>directory(async root=>{
 const monitor=createWorkerMonitor(db(),root,{min_available_percent:10,sample:async()=>{throw new Error('SECRET');}});
 try{await monitor.start();expect(await monitor.beforeDispatch()).toBe(true);expect((await readWorkerMonitor(root)).dispatch?.memory_state).toBe('unknown');}finally{await monitor.stop();}
}));
test('strict projection drops tampered secrets and recomputes safe advice',async()=>directory(async root=>{
 const monitor=createWorkerMonitor(db(),root,{min_available_percent:10,sample:sampler(30)});
 await monitor.start();await monitor.stop();const path=join(root,'.worker-monitor.json');const value=JSON.parse(await readFile(path,'utf8'));
 value.secret='SECRET';value.snapshot.system.value.secret='SECRET';value.snapshot.processes[0].args='SECRET';value.advice={decision:'pause',reasons:['SECRET']};value.dispatch.secret='SECRET';
 await writeFile(path,JSON.stringify(value));const result=await readWorkerMonitor(root);expect(result.status).toBe('stopped');expect(JSON.stringify(result)).not.toContain('SECRET');expect(await readdir(root)).toEqual(['.worker-monitor.json']);
}));
test('stale, corrupt, missing and invalid nested records are not running',async()=>directory(async root=>{
 expect((await readWorkerMonitor(root)).status).toBe('unavailable');const monitor=createWorkerMonitor(db(),root,{min_available_percent:10,sample:sampler(30)});await monitor.start();await monitor.stop();const path=join(root,'.worker-monitor.json');const value=JSON.parse(await readFile(path,'utf8'));
 value.heartbeat_at=new Date(Date.now()-31000).toISOString();await writeFile(path,JSON.stringify(value));expect((await readWorkerMonitor(root)).status).toBe('stale');
 value.snapshot.system.value.available_percent='SECRET';await writeFile(path,JSON.stringify(value));expect((await readWorkerMonitor(root)).status).toBe('unavailable');
 await writeFile(path,'bad');expect((await readWorkerMonitor(root)).status).toBe('unavailable');
}));
test('stop waits for in-flight sample then persists stopped',async()=>directory(async root=>{
 const monitor=createWorkerMonitor(db(),root,{min_available_percent:10,sample:async input=>{await Bun.sleep(15);return sampler(30)(input);}});
 await Promise.all([monitor.start(),monitor.stop()]);expect(await monitor.beforeDispatch()).toBe(false);expect((await readWorkerMonitor(root)).status).toBe('stopped');
}));
