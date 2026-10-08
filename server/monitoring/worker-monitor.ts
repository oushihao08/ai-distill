import type {Pool} from 'pg';
import {registeredProcesses} from './runtime';
import {mkdir,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sampleResources,adviseDispatch,type ResourceSnapshot,type ExecutorStatus,type Reading,type SafeEvent} from './resources';
export interface WorkerMonitorStatus {
 status:'running'|'paused'|'stopped'|'stale'|'unavailable';
 heartbeat_at:string|null;worker_pid:number|null;
 dispatch:{allowed:boolean;policy:'memory_only_unknown_allow';memory_state:'known'|'unknown';min_available_percent:number;reason:'low_available_memory'|'memory_above_threshold'|'memory_unknown'|'stopped'}|null;
 advice:ReturnType<typeof adviseDispatch>|null;snapshot:ResourceSnapshot|null;
}
const unavailable=():WorkerMonitorStatus=>({status:'unavailable',heartbeat_at:null,worker_pid:null,dispatch:null,advice:null,snapshot:null});
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const timestamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

function projectSnapshot(raw:any):ResourceSnapshot {
 if(!raw||!timestamp(raw.sampled_at)||!Array.isArray(raw.processes)||raw.processes.length>256)throw new Error('invalid');
 let system:ResourceSnapshot['system']={status:'unknown'};
 if(raw.system?.status==='known'){
  const v=raw.system.value;
  if(!v||!integer(v.total_bytes)||v.total_bytes<=0||!integer(v.available_bytes_estimate)||!integer(v.available_percent)||v.available_percent>100||v.available_bytes_estimate!==Math.floor(v.total_bytes*v.available_percent/100)||v.method!=='macos_memory_pressure_percentage')throw new Error('invalid');
  system={status:'known',value:{total_bytes:v.total_bytes,available_bytes_estimate:v.available_bytes_estimate,available_percent:v.available_percent,method:v.method}};
 }else if(raw.system?.status!=='unknown')throw new Error('invalid');
 const processes=raw.processes.map((p:any)=>{
  if(!integer(p.pid)||p.pid<=0)throw new Error('invalid');
  if(p.rss_bytes?.status==='unknown')return{pid:p.pid,rss_bytes:{status:'unknown' as const}};
  if(p.rss_bytes?.status!=='known'||!integer(p.rss_bytes.value)||p.rss_bytes.value<=0)throw new Error('invalid');
  return{pid:p.pid,rss_bytes:{status:'known' as const,value:p.rss_bytes.value}};
 });
 let tasks:ResourceSnapshot['tasks']={status:'unknown'};
 if(raw.tasks?.status==='known'){
  const v=raw.tasks.value,states=['waiting','running','succeeded','failed','skipped'] as const;
  if(!v||!integer(v.running)||!Array.isArray(v.executors)||v.executors.length>100000)throw new Error('invalid');
  const counts={waiting:0,running:0,succeeded:0,failed:0,skipped:0};
  const executors=v.executors.map((e:any)=>{
   if(!states.includes(e.state)||!['ready','blocked','unknown'].includes(e.authentication)||!['available','exhausted','unknown'].includes(e.quota)||!['none','authentication','quota','rate_limit','network','timeout','provider','configuration','cancelled','invalid_response','unknown'].includes(e.error))throw new Error('invalid');
   counts[e.state as keyof typeof counts]++;
   let last_event:Reading<{type:SafeEvent;at:string}>={status:'unknown'};
   if(e.last_event?.status==='known'){
    const event=e.last_event.value;
    if(!event||!['started','heartbeat','completed','failed','cancelled'].includes(event.type)||!timestamp(event.at))throw new Error('invalid');
    last_event={status:'known',value:{type:event.type,at:event.at}};
   }else if(e.last_event?.status!=='unknown')throw new Error('invalid');
   return{state:e.state,last_event,authentication:e.authentication,quota:e.quota,error:e.error};
  });
  if(v.running!==counts.running||states.some(state=>v.states?.[state]!==counts[state]))throw new Error('invalid');
  tasks={status:'known',value:{running:counts.running,states:counts,executors}};
 }else if(raw.tasks?.status!=='unknown')throw new Error('invalid');
 return{sampled_at:raw.sampled_at,system,processes,tasks};
}
function projectRecord(raw:any):WorkerMonitorStatus {
 if(!raw||!['running','paused','stopped'].includes(raw.status)||!timestamp(raw.heartbeat_at)||!integer(raw.worker_pid)||raw.worker_pid<=0)throw new Error('invalid');
 const snapshot=projectSnapshot(raw.snapshot),d=raw.dispatch;
 if(!d||d.policy!=='memory_only_unknown_allow'||typeof d.allowed!=='boolean'||!['known','unknown'].includes(d.memory_state)||typeof d.min_available_percent!=='number'||!Number.isFinite(d.min_available_percent)||d.min_available_percent<0||d.min_available_percent>100)throw new Error('invalid');
 const low=snapshot.system.status==='known'&&snapshot.system.value.available_percent<d.min_available_percent;
 const stopped=raw.status==='stopped';
 const reason=stopped?'stopped':low?'low_available_memory':snapshot.system.status==='known'?'memory_above_threshold':'memory_unknown';
 if(d.reason!==reason||d.allowed!==(!stopped&&!low)||d.memory_state!==snapshot.system.status||raw.status!==(stopped?'stopped':low?'paused':'running'))throw new Error('invalid');
 const advice=adviseDispatch(snapshot,{min_available_percent:d.min_available_percent});
 // Recompute all recommendation fields; raw messages/reasons are never returned.
 const age=Date.now()-Date.parse(raw.heartbeat_at);
 return{status:age>30000||age< -5000?'stale':raw.status,heartbeat_at:raw.heartbeat_at,worker_pid:raw.worker_pid,dispatch:{allowed:d.allowed,policy:'memory_only_unknown_allow',memory_state:d.memory_state,min_available_percent:d.min_available_percent,reason},advice,snapshot};
}
export async function readWorkerMonitor(root:string):Promise<WorkerMonitorStatus> {
 try{
  const path=join(root,'.worker-monitor.json');if((await stat(path)).size>16*1024*1024)return unavailable();
  return projectRecord(JSON.parse(await readFile(path,'utf8')));
 }catch{return unavailable();}
}
export function createWorkerMonitor(pool:Pool,root:string,options:{min_available_percent:number;sample_interval_ms?:number;sample?:typeof sampleResources}) {
 const threshold=options.min_available_percent,interval=options.sample_interval_ms??5000;
 if(!Number.isFinite(threshold)||threshold<0||threshold>100||!Number.isSafeInteger(interval)||interval<1)throw new Error('监控参数无效');
 let timer:ReturnType<typeof setTimeout>|undefined,inflight:Promise<void>|undefined,stopped=false,started=false,lastSample=0,record:WorkerMonitorStatus|undefined;
 const write=async()=>{
  const temporary=join(root,`.worker-monitor-${randomUUID()}.tmp`);
  try{await mkdir(root,{recursive:true});await writeFile(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});await rename(temporary,join(root,'.worker-monitor.json'));}
  catch{/* Safe monitoring persistence failure must not stop running tasks or erase the in-memory gate. */}
  finally{try{await rm(temporary,{force:true});}catch{/* No private diagnostics are emitted. */}}
 };
 const update=async()=>{
  let tasks:ExecutorStatus[]|undefined;
  try{
   const result=await pool.query(`SELECT a.status,a.started_at,a.heartbeat_at,a.result#>>'{error,kind}' AS error_kind,(SELECT reason FROM ai_distill.executor_blocks e WHERE e.executor=CASE WHEN a.ordinal IN (3,4,6,9) THEN 'codex' WHEN a.ordinal=2 THEN 'materials' WHEN a.ordinal=5 THEN 'answer:'||(a.config->>'provider') ELSE 'none' END) AS block_reason FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.deleted_at IS NULL AND p.deleted_at IS NULL AND a.input_revision=w.input_revision AND a.status IN ('waiting','running')`);
   tasks=result.rows.map(row=>{
    if(row.status!=='waiting'&&row.status!=='running')throw new Error('invalid');
    const at=row.heartbeat_at??row.started_at;
    const date=at instanceof Date?at:new Date(at);
    const reason=row.block_reason;
    return{state:row.status,authentication:reason==='authentication'?'blocked':'unknown',quota:reason==='quota'?'exhausted':'unknown',error:reason==='authentication'||reason==='quota'?reason:row.error_kind??'unknown',...(at&&Number.isFinite(date.getTime())?{last_event:{type:row.heartbeat_at?'heartbeat' as const:'started' as const,at:date.toISOString()}}:{})};
   });
  }catch{tasks=undefined;}
  let snapshot:ResourceSnapshot;
  try{snapshot=projectSnapshot(await (options.sample??sampleResources)({registered_pids:registeredProcesses(),tasks}));}
  catch{snapshot={sampled_at:new Date().toISOString(),system:{status:'unknown'},processes:[{pid:process.pid,rss_bytes:{status:'unknown'}}],tasks:{status:'unknown'}};}
  const low=snapshot.system.status==='known'&&snapshot.system.value.available_percent<threshold;
  record={status:stopped?'stopped':low?'paused':'running',heartbeat_at:new Date().toISOString(),worker_pid:process.pid,dispatch:{allowed:!stopped&&!low,policy:'memory_only_unknown_allow',memory_state:snapshot.system.status,min_available_percent:threshold,reason:stopped?'stopped':low?'low_available_memory':snapshot.system.status==='known'?'memory_above_threshold':'memory_unknown'},advice:adviseDispatch(snapshot,{min_available_percent:threshold}),snapshot};
  lastSample=Date.now();await write();
 };
 const refresh=async()=>{
  if(inflight)return inflight;
  inflight=update();try{await inflight;}finally{inflight=undefined;}
 };
 const schedule=()=>{if(stopped||!started)return;timer=setTimeout(()=>{void refresh().catch(()=>{/* Sampling failures are contained. */}).finally(schedule);},interval);timer.unref();};
 return{
  async start(){if(started||stopped)return;started=true;await refresh();schedule();},
  async beforeDispatch(){if(stopped)return false;if(inflight||!record||Date.now()-lastSample>=interval)await refresh();return record?.dispatch?.allowed??true;},
  async stop(){stopped=true;if(timer)clearTimeout(timer);if(inflight)await inflight;if(record){record={...record,status:'stopped',heartbeat_at:new Date().toISOString(),dispatch:record.dispatch?{...record.dispatch,allowed:false,reason:'stopped'}:null};await write();}},
 };
}
