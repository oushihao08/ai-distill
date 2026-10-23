/**
 * 职责：worker 安全监控：采集任务与资源心跳、写入共享快照并据内存阈值控制新任务派发。
 * 关键方法与用途：`createWorkerMonitor()` 管理启停、心跳和资源采样；`readWorkerMonitor()` 读取净化后的快照；`readActiveWorkflowTasks()` 查询运行中的 API／Agent 项目、题目与步骤。
 * 使用场景：`worker.ts` 控制任务领取，`app.ts` 提供本地资源状态与步骤占用明细。
 */
import type {Pool} from 'pg';
import {mkdir,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sampleResources,adviseDispatch,type ResourceSnapshot,type ExecutorStatus,type Reading,type SafeEvent} from './resources';
import {listAgentProcessIds} from '../agent/processes';
import {classifyLogError,logEvent} from '../logging';
export interface WorkerMonitorStatus {
 status:'running'|'paused'|'stopped'|'stale'|'unavailable';
 heartbeat_at:string|null;worker_pid:number|null;
 dispatch:{allowed:boolean;policy:'memory_only_unknown_allow';memory_state:'known'|'unknown';min_available_percent:number;reason:'low_available_memory'|'memory_above_threshold'|'memory_unknown'|'stopped'}|null;
 advice:ReturnType<typeof adviseDispatch>|null;snapshot:ResourceSnapshot|null;
}
export interface ActiveWorkflowTask {
 channel:'agent'|'api'|'unknown';project_id:string;workflow_id:string;project_name:string;question_title:string;step_name:string;
 state:'running';started_at:string|null;attempt_id:string;
}
export type MaterialLibraryQueueStatus=
 |{status:'unavailable'}
 |{status:'known';totals:{queued:number;running:number;succeeded:number;failed:number;cancelled:number};items:{job_id:string;package_id:string;revision_id:string;package_name:string;kind:'intake'|'extract'|'redact';state:'queued'|'running';executor_kind:'internal'|'api'|'agent';execution_target:'local'|'server';progress:Record<string,string|number>;error_code:string|null;created_at:string|null;started_at:string|null}[]};
export async function readActiveWorkflowTasks(pool:Pool,attemptIds?:string[]):Promise<ActiveWorkflowTask[]>{
 const result=await pool.query("SELECT a.id AS attempt_id,w.project_id,a.workflow_id,p.name AS project_name,w.title AS question_title,s.name AS step_name,a.status AS state,a.started_at,CASE WHEN a.ordinal=5 AND a.config->>'provider'='codex' THEN 'agent' WHEN a.ordinal=5 THEN 'api' WHEN a.ordinal=6 AND a.config->>'provider'='api' THEN 'api' WHEN a.ordinal IN (4,6) THEN 'agent' WHEN a.ordinal=9 AND a.config->>'provider'='api' THEN 'api' WHEN a.ordinal=9 AND a.config->>'provider'='codex' THEN 'agent' ELSE 'unknown' END AS channel FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=a.ordinal WHERE w.deleted_at IS NULL AND p.deleted_at IS NULL AND a.status='running' AND a.ordinal IN (4,5,6,8,9) AND ($1::uuid[] IS NULL OR a.id=ANY($1::uuid[])) ORDER BY a.started_at,a.id LIMIT 500",[attemptIds??null]);
 return result.rows.map(row=>({attempt_id:String(row.attempt_id),project_id:String(row.project_id),workflow_id:String(row.workflow_id),project_name:String(row.project_name),question_title:String(row.question_title),step_name:String(row.step_name),state:row.state,channel:row.channel,started_at:row.started_at instanceof Date?row.started_at.toISOString():row.started_at?new Date(row.started_at).toISOString():null}));
}
function safeLibraryProgress(value:unknown):Record<string,string|number>{
 if(!value||typeof value!=='object'||Array.isArray(value))return{};
 const source=value as Record<string,unknown>,progress:Record<string,string|number>={};
 if(typeof source.phase==='string'&&['intake','extract','redact'].includes(source.phase))progress.phase=source.phase;
 for(const key of ['completed_files','total_files','issue_count','verified_bytes','page_count','file_count'])if(typeof source[key]==='number'&&Number.isSafeInteger(source[key])&&source[key]>=0)progress[key]=source[key];
 return progress;
}
function safeTimestamp(value:unknown):string|null{
 if(value instanceof Date)return Number.isFinite(value.getTime())?value.toISOString():null;
 if(typeof value!=='string'&&typeof value!=='number')return null;
 const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null;
}
/** 读取全局库任务摘要；旧数据库没有新表时返回 unavailable，不影响旧 worker/API。 */
export async function readMaterialLibraryQueue(pool:Pool):Promise<MaterialLibraryQueueStatus>{
 try{
  const schema=await pool.query("SELECT to_regclass('ai_distill.library_jobs') IS NOT NULL AS available");
  if(schema.rows[0]?.available!==true)return{status:'unavailable'};
  const result=await pool.query(`WITH totals AS (
    SELECT count(*) FILTER(WHERE status='queued')::int AS queued,count(*) FILTER(WHERE status='running')::int AS running,
     count(*) FILTER(WHERE status='succeeded')::int AS succeeded,count(*) FILTER(WHERE status='failed')::int AS failed,count(*) FILTER(WHERE status='cancelled')::int AS cancelled
    FROM ai_distill.library_jobs
   ), active_jobs AS (
    SELECT j.id,j.package_id,j.revision_id,COALESCE(p.name,'（材料包已归档）') AS package_name,j.kind,j.status,j.executor_kind,j.execution_target,j.progress,j.error_code,j.created_at,j.started_at
    FROM ai_distill.library_jobs j LEFT JOIN ai_distill.library_packages p ON p.id=j.package_id
    WHERE j.status IN ('queued','running') ORDER BY j.created_at,j.id LIMIT 100
   )
   SELECT totals.*,COALESCE((SELECT jsonb_agg(to_jsonb(active_jobs) ORDER BY active_jobs.created_at,active_jobs.id) FROM active_jobs),'[]'::jsonb) AS items FROM totals`);
  const row=result.rows[0]??{},number=(value:unknown)=>{const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<0)throw new Error('invalid library queue count');return parsed;};
  const totals={queued:number(row.queued),running:number(row.running),succeeded:number(row.succeeded),failed:number(row.failed),cancelled:number(row.cancelled)};
  if(!Array.isArray(row.items))throw new Error('invalid library queue items');
  const items=row.items.map((item:any)=>{
   if(!['intake','extract','redact'].includes(item.kind)||!['queued','running'].includes(item.status)||!['internal','api','agent'].includes(item.executor_kind)||!['local','server'].includes(item.execution_target))throw new Error('invalid library queue row');
   return{job_id:String(item.id),package_id:String(item.package_id),revision_id:String(item.revision_id),package_name:String(item.package_name),kind:item.kind,state:item.status,executor_kind:item.executor_kind,execution_target:item.execution_target,progress:safeLibraryProgress(item.progress),error_code:typeof item.error_code==='string'?item.error_code:null,created_at:safeTimestamp(item.created_at),started_at:safeTimestamp(item.started_at)};
  });
  return{status:'known',totals,items};
 }catch(error){logEvent('monitor.library_queue_read_failed',{level:'error',component:'worker_monitor',...classifyLogError(error)});return{status:'unavailable'};}
}
const unavailable=():WorkerMonitorStatus=>({status:'unavailable',heartbeat_at:null,worker_pid:null,dispatch:null,advice:null,snapshot:null});
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const timestamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
let snapshotReadFailed=false;

function projectSnapshot(raw:any):ResourceSnapshot {
 if(!raw||!timestamp(raw.sampled_at)||!Array.isArray(raw.processes)||raw.processes.length>256)throw new Error('invalid');
 let system:ResourceSnapshot['system']={status:'unknown'};
 if(raw.system?.status==='known'){
  const v=raw.system.value;
  if(!v||!integer(v.total_bytes)||v.total_bytes<=0||!integer(v.available_bytes_estimate)||!integer(v.available_percent)||v.available_percent>100||v.available_bytes_estimate!==Math.floor(v.total_bytes*v.available_percent/100)||!['macos_memory_pressure_percentage','windows_available_physical_memory'].includes(v.method))throw new Error('invalid');
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
 let path=join(root,'.worker-monitor.json');
 try{
  if((await stat(path)).size>16*1024*1024)throw new Error('monitor snapshot too large');
  const record=projectRecord(JSON.parse(await readFile(path,'utf8')));
  if(record.status==='unavailable')throw new Error('invalid monitor snapshot');
  if(snapshotReadFailed)logEvent('monitor.snapshot_read_recovered',{level:'info',component:'worker_monitor',operation:'read_snapshot'});
  snapshotReadFailed=false;return record;
 }catch(error){
  if(error&&typeof error==='object'&&'code'in error&&(error as {code?:unknown}).code==='ENOENT')return unavailable();
  if(!snapshotReadFailed)logEvent('monitor.snapshot_read_failed',{level:'error',component:'worker_monitor',operation:'read_snapshot',...classifyLogError(error)});
  snapshotReadFailed=true;return unavailable();
 }
}
export function createWorkerMonitor(pool:Pool,root:string,options:{min_available_percent:number;sample_interval_ms?:number;sample?:typeof sampleResources}) {
 const threshold=options.min_available_percent,interval=options.sample_interval_ms??5000;
 if(!Number.isFinite(threshold)||threshold<0||threshold>100||!Number.isSafeInteger(interval)||interval<1)throw new Error('监控参数无效');
 let timer:ReturnType<typeof setTimeout>|undefined,memoryInflight:Promise<void>|undefined,tasksInflight:Promise<void>|undefined,stopped=false,started=false,lastSample=0,record:WorkerMonitorStatus|undefined,lastDispatchAllowed:boolean|undefined,tasksReadFailed=false,resourceSampleFailed=false,snapshotWriteFailed=false,tasks:ExecutorStatus[]|undefined;
 const write=async()=>{
  const temporary=join(root,`.worker-monitor-${randomUUID()}.tmp`);
 try{await mkdir(root,{recursive:true});await writeFile(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});await rename(temporary,join(root,'.worker-monitor.json'));if(snapshotWriteFailed)logEvent('monitor.snapshot_write_recovered',{level:'info',component:'worker_monitor'});snapshotWriteFailed=false;}
  catch(error){if(!snapshotWriteFailed)logEvent('monitor.snapshot_write_failed',{level:'error',component:'worker_monitor',...classifyLogError(error)});snapshotWriteFailed=true;}
  finally{try{await rm(temporary,{force:true});}catch(error){logEvent('monitor.temporary_cleanup_failed',{level:'error',component:'worker_monitor',...classifyLogError(error)});}}
 };
 const refreshTasks=async()=>{
  if(stopped)return;
  if(tasksInflight)return tasksInflight;
  tasksInflight=(async()=>{
   let next:ExecutorStatus[]|undefined;
  try{
   const db=await pool.connect();let transaction=false;
   try{
    await db.query('BEGIN');transaction=true;
    await db.query("SET LOCAL statement_timeout = '2000ms'");
    const result=await db.query("SELECT a.status,a.started_at,a.heartbeat_at,a.result#>>'{error,kind}' AS error_kind FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.deleted_at IS NULL AND p.deleted_at IS NULL AND a.status IN ('waiting','running')");
    next=result.rows.map(row=>{
    if(row.status!=='waiting'&&row.status!=='running')throw new Error('invalid');
    const at=row.heartbeat_at??row.started_at;
    const date=at instanceof Date?at:new Date(at);
    return{state:row.status,authentication:'unknown',quota:'unknown',error:row.error_kind??'unknown',...(at&&Number.isFinite(date.getTime())?{last_event:{type:row.heartbeat_at?'heartbeat' as const:'started' as const,at:date.toISOString()}}:{})};
    });
    await db.query('COMMIT');transaction=false;
   }catch(error){
    if(transaction)try{await db.query('ROLLBACK');}catch(rollbackError){logEvent('monitor.tasks_read_rollback_failed',{level:'error',component:'worker_monitor',...classifyLogError(rollbackError)});}
    throw error;
   }finally{db.release();}
   }catch(error){next=undefined;if(!tasksReadFailed)logEvent('monitor.tasks_read_failed',{level:'error',component:'worker_monitor',...classifyLogError(error)});tasksReadFailed=true;}
   if(stopped)return;
   tasks=next;
   if(tasks&&tasksReadFailed){logEvent('monitor.tasks_read_recovered',{level:'info',component:'worker_monitor'});tasksReadFailed=false;}
  })();
  try{await tasksInflight;}finally{tasksInflight=undefined;}
 };
 const refreshMemory=async()=>{
  if(memoryInflight)return memoryInflight;
  if(stopped)return;
  memoryInflight=(async()=>{
  let snapshot:ResourceSnapshot;
  try{snapshot=projectSnapshot(await (options.sample??sampleResources)({registered_pids:listAgentProcessIds(),tasks}));}
  catch(error){if(!resourceSampleFailed)logEvent('monitor.resource_sample_failed',{level:'error',component:'worker_monitor',...classifyLogError(error)});resourceSampleFailed=true;snapshot={sampled_at:new Date().toISOString(),system:{status:'unknown'},processes:[{pid:process.pid,rss_bytes:{status:'unknown'}}],tasks:{status:'unknown'}};}
  if(!resourceSampleFailed||snapshot.system.status==='known'){if(resourceSampleFailed)logEvent('monitor.resource_sample_recovered',{level:'info',component:'worker_monitor'});resourceSampleFailed=false;}
  const low=snapshot.system.status==='known'&&snapshot.system.value.available_percent<threshold;
  record={status:stopped?'stopped':low?'paused':'running',heartbeat_at:new Date().toISOString(),worker_pid:process.pid,dispatch:{allowed:!stopped&&!low,policy:'memory_only_unknown_allow',memory_state:snapshot.system.status,min_available_percent:threshold,reason:stopped?'stopped':low?'low_available_memory':snapshot.system.status==='known'?'memory_above_threshold':'memory_unknown'},advice:adviseDispatch(snapshot,{min_available_percent:threshold}),snapshot};
  const dispatch=record.dispatch!;
  if(lastDispatchAllowed===undefined)logEvent('worker.dispatch.state',{level:'info',component:'worker_monitor',state:record.status,reason_code:dispatch.reason});
  else if(lastDispatchAllowed!==dispatch.allowed)logEvent(dispatch.allowed?'worker.dispatch.resumed':'worker.dispatch.paused',{level:dispatch.allowed?'info':'warn',component:'worker_monitor',state:record.status,reason_code:dispatch.reason});
  lastDispatchAllowed=dispatch.allowed;
  lastSample=Date.now();await write();
  })();
  try{await memoryInflight;}finally{memoryInflight=undefined;}
 };
 const schedule=()=>{if(stopped||!started)return;timer=setTimeout(()=>{void refreshTasks();void refreshMemory().catch(()=>{/* Sampling failures are contained. */});schedule();},interval);timer.unref();};
 return{
  async start(){if(started||stopped)return;started=true;await refreshMemory();void refreshTasks();schedule();},
  async beforeDispatch(){if(stopped)return false;if(memoryInflight)await memoryInflight;else if(!record||Date.now()-lastSample>=interval)await refreshMemory();return record?.dispatch?.allowed??true;},
  async stop(){stopped=true;if(timer)clearTimeout(timer);await Promise.all([memoryInflight,tasksInflight]);if(record){record={...record,status:'stopped',heartbeat_at:new Date().toISOString(),dispatch:record.dispatch?{...record.dispatch,allowed:false,reason:'stopped'}:null};logEvent('worker.dispatch.stopped',{level:'info',component:'worker_monitor',state:'stopped'});await write();}},
 };
}
