/** 验证 worker 资源采样合并、低内存派发暂停、状态净化及停止落盘。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import type {Pool} from 'pg';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkerMonitor,readMaterialLibraryQueue,readWorkerMonitor} from './worker-monitor';
import {sampleResources,type MonitorInput} from './resources';
import{configureLogger}from'../logging';
const db=(rows:any[]=[])=>{
 const query=async(sql:string)=>{if(sql.startsWith('SELECT')){expect(sql).toContain("a.status IN ('waiting','running')");expect(sql).toContain('w.deleted_at IS NULL');expect(sql).not.toContain('a.error');}return{rows};};
 return{query,connect:async()=>({query:(input:string|{text:string})=>query(typeof input==='string'?input:input.text),release(){}})} as unknown as Pool;
};
const sampler=(percent:number|null)=>async(input:MonitorInput)=>sampleResources(input,{platform:'darwin',read:async(file,args)=>file.endsWith('memory_pressure')?percent===null?'':`The system has 1000000 (100 pages).\nSystem-wide memory free percentage: ${percent}%\n`:`${args[1]} 100`});
async function directory(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'distill-monitor-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
test('projects material library queue counts and safe active job fields',async()=>{
 const queries:string[]=[];
 const pool={query:async(sql:string)=>{
  queries.push(sql);
  if(sql.includes('to_regclass'))return{rows:[{available:true}]};
  if(sql.includes('count(*) FILTER'))return{rows:[{queued:'2',running:'1',succeeded:'4',failed:'1',cancelled:'0',items:[{id:'job-1',package_id:'package-1',revision_id:'revision-1',package_name:'测试材料',kind:'extract',status:'running',executor_kind:'api',execution_target:'server',progress:{phase:'extract',completed_files:1,total_files:3,secret:'must drop'},error_code:null,created_at:new Date('2026-10-17T00:00:00Z'),started_at:new Date('2026-10-17T00:01:00Z')}] }]};
  return{rows:[{id:'job-1',package_id:'package-1',revision_id:'revision-1',package_name:'测试材料',kind:'extract',status:'running',executor_kind:'api',execution_target:'server',progress:{phase:'extract',completed_files:1,total_files:3,secret:'must drop'},error_code:null,created_at:new Date('2026-10-17T00:00:00Z'),started_at:new Date('2026-10-17T00:01:00Z')}]};
 }} as unknown as Pool;
 const result=await readMaterialLibraryQueue(pool);
 expect(result.status).toBe('known');
 if(result.status==='known'){
  expect(result.totals).toEqual({queued:2,running:1,succeeded:4,failed:1,cancelled:0});
  expect(result.items[0]).toMatchObject({job_id:'job-1',package_id:'package-1',kind:'extract',progress:{phase:'extract',completed_files:1,total_files:3}});
  expect(JSON.stringify(result)).not.toContain('must drop');
 }
 expect(queries).toHaveLength(2);
});
test('reports library queue unavailable before its migration exists',async()=>{
 let queryCount=0;const pool={query:async()=>{queryCount++;return{rows:[{available:false}]};}} as unknown as Pool;
 const result=await readMaterialLibraryQueue(pool);
 expect(result.status).toBe('unavailable');expect(queryCount).toBe(1);
});
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
test('dispatch memory check does not wait for a pending database task query',async()=>directory(async root=>{
 let releaseQuery!:()=>void,notifyQueryStarted!:()=>void,sampled=false,taskQueries=0;
 const queryStarted=new Promise<void>(resolve=>{notifyQueryStarted=resolve;});
 const pool={connect:async()=>({query:async(input:string|{text:string})=>{
  const sql=typeof input==='string'?input:input.text;
  if(sql.includes('FROM ai_distill.step_attempts')){taskQueries++;notifyQueryStarted();return new Promise<{rows:any[]}>(resolve=>{releaseQuery=()=>resolve({rows:[]});});}
  return{rows:[]};
 },release(){}})} as unknown as Pool;
 const monitor=createWorkerMonitor(pool,root,{min_available_percent:10,sample:async input=>{sampled=true;return sampler(30)(input);}});
 let starting:Promise<void>|undefined;
 try{
  starting=monitor.start();await queryStarted;
  const allowed=await Promise.race([monitor.beforeDispatch().then(value=>value),Bun.sleep(100).then(()=>false)]);
  expect(allowed).toBe(true);expect(sampled).toBe(true);expect(taskQueries).toBe(1);
  const stopping=monitor.stop();releaseQuery();await stopping;
  expect((await readWorkerMonitor(root)).status).toBe('stopped');
 }finally{
  releaseQuery?.();await starting;await monitor.stop();
 }
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
 const monitor=createWorkerMonitor({connect:async()=>({query:async()=>{throw new Error('DB_SECRET');},release(){}})} as unknown as Pool,root,{min_available_percent:10,sample:sampler(30)});
 try{await monitor.start();const result=await readWorkerMonitor(root);expect(result.snapshot?.tasks.status).toBe('unknown');expect(JSON.stringify(result)).not.toContain('DB_SECRET');}finally{await monitor.stop();}
}));
test('reads task status with a server-side timeout and releases its connection',async()=>directory(async root=>{
 const queries:string[]=[];let released=false;
 const client={query:async(input:string|{text:string})=>{queries.push(typeof input==='string'?input:input.text);return{rows:[]};},release:()=>{released=true;}};
 const pool={connect:async()=>client,query:async()=>{throw new Error('pool query should not be used');}} as unknown as Pool;
 const monitor=createWorkerMonitor(pool,root,{min_available_percent:10,sample:sampler(30)});
 try{
  await monitor.start();
  await monitor.stop();
  expect(queries).toContain("SET LOCAL statement_timeout = '2000ms'");
  expect(queries.some(sql=>sql.includes('FROM ai_distill.step_attempts'))).toBe(true);
  expect(released).toBe(true);
 }finally{await monitor.stop();}
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
test('corrupt monitor snapshots log one failure and a recovery event',async()=>directory(async root=>{
 const logger=configureLogger({root:join(root,'log-root'),service:'api'}),monitor=createWorkerMonitor(db(),root,{min_available_percent:10,sample:sampler(30)});
 try{
  await monitor.start();await monitor.stop();const path=join(root,'.worker-monitor.json'),valid=await readFile(path,'utf8');
  await writeFile(path,'private malformed snapshot');expect((await readWorkerMonitor(root)).status).toBe('unavailable');expect((await readWorkerMonitor(root)).status).toBe('unavailable');
  await writeFile(path,valid);expect((await readWorkerMonitor(root)).status).toBe('stopped');await logger.flush();
  const day=new Date().toISOString().slice(0,10),logDirectory=join(root,'log-root','logs',day),files=await readdir(logDirectory).catch(()=>[]),records=files.length?(await readFile(join(logDirectory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line)):[];
  expect(records).toContainEqual(expect.objectContaining({event:'monitor.snapshot_read_failed',component:'worker_monitor',level:'error',error_kind:'unknown'}));
  expect(records.some(record=>record.event==='monitor.snapshot_read_recovered')).toBe(false);
  expect(records.filter(record=>record.event==='monitor.snapshot_read_failed')).toHaveLength(1);expect(JSON.stringify(records)).not.toContain('private malformed snapshot');
 }finally{await monitor.stop();await logger.close();}
}));

test('active workflow monitor includes publication tasks so idle checks cannot miss delivery',async()=>{
 const {readActiveWorkflowTasks}=await import('./worker-monitor');let sql='';
 const pool={query:async(text:string)=>{sql=text;return{rows:[{attempt_id:'publication',project_id:'p',workflow_id:'w',project_name:'项目',question_title:'题目',step_name:'归档',state:'running',channel:'unknown',started_at:null}]};}} as unknown as Pool;
 expect((await readActiveWorkflowTasks(pool))[0]?.attempt_id).toBe('publication');expect(sql).toContain('a.ordinal IN (4,5,6,8,9)');
});

test('active task query filters local ownership before LIMIT and classifies frozen providers',async()=>{
 const {readActiveWorkflowTasks}=await import('./worker-monitor');let sql='',values:unknown;
 const pool={query:async(text:string,params:unknown)=>{sql=text;values=params;return{rows:[]};}} as unknown as Pool;
 const id='11111111-1111-4111-8111-111111111111';
 await readActiveWorkflowTasks(pool,[id]);expect(values).toEqual([[id]]);expect(sql.indexOf('a.id=ANY')).toBeLessThan(sql.indexOf('LIMIT 500'));
 expect(sql).toContain("a.ordinal=5 AND a.config->>'provider'='codex' THEN 'agent'");expect(sql).toContain("a.ordinal=6 AND a.config->>'provider'='api' THEN 'api'");
 await readActiveWorkflowTasks(pool,[]);expect(values).toEqual([[]]);await readActiveWorkflowTasks(pool);expect(values).toEqual([null]);
});
