/**
 * 职责：结构化日志的字段筛选、上下文传递、持久化与保留策略。
 * 关键方法与用途：`createStructuredLogger()` 创建过滤、轮转的 JSONL logger；`withLogContext()`／`withIsolatedLogContext()`／`enterLogContext()` 传递或隔离上下文；`logEvent()` 写事件。
 * 使用场景：API、worker 和业务队列按事件边界调用；`loggerHealth()` 查询状态，敏感字段先经 `sanitizeLogRecord()` 过滤。
 */
import {MODEL_API_PROVIDERS} from '../shared/types';

import {appendFileSync,chmodSync,mkdirSync,statSync} from 'node:fs';
import {appendFile,chmod,mkdir,open,readFile,readdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

type LogFields=Record<string,unknown>;
type LogContext=Partial<Record<'method'|'route'|'request_id'|'operation_id'|'component'|'project_id'|'workflow_id'|'attempt_id'|'skill_attempt_id'|'ordinal'|'call_id'|'session_id'|'artifact_id'|'operation'|'provider'|'model'|'reasoning_effort'|'library_package_id'|'library_revision_id'|'library_job_id'|'library_file_id',unknown>>;
const context=new AsyncLocalStorage<LogContext>();
const safeErrors=new Set(['authentication','quota','rate_limit','network','timeout','provider','configuration','cancelled','invalid_response','unknown','none']);
const safeProviders=new Set(['codex',...MODEL_API_PROVIDERS,'glm-ocr','mineru-api','mineru-cli','unknown']);
const safeChangedFields=new Set(['credential_home','model','reasoning_effort','enabled','models','name','description','material_root','local_skill_path','provider','base_url','config','minimum_score','currency','input_per_million','output_per_million','cached_input_per_million','cache_write_per_million','source','valid_from','valid_until','ordinal','prompt','threshold','workspace_path','source_digest','expected_sha256','text','path','rubric','question','workflow_ids']);
const allowed=new Set(['lifecycle_event','callback_id','execution_id','request_id','operation_id','component','project_id','workflow_id','attempt_id','skill_attempt_id','ordinal','call_id','session_id','operation','provider','model','reasoning_effort','library_package_id','library_revision_id','library_job_id','library_file_id','build_id','child_pid','timeout_ms','elapsed_ms','wall_elapsed_ms','timer_lateness_ms','exit_code','signal','error_kind','reason_code','finish_reason','failure_phase','failure_stage','network_error_code','response_status','retryable','http_status','material_count','page_count','input_bytes','output_bytes','token_usage','method','route','status_code','duration_ms','query_name','transaction_name','artifact_id','target_id','changed_fields','file_kind','dropped_count','state','queue_wait_ms','attempt_count','batch_index','last_heartbeat_at','threshold_ms','error_code','error_constraint','process_state','event_type','event_count','level','material_id','page','expected_count','actual_count','expected_page','actual_page','source_empty','diagnostic_id','provider_task_submitted','local_aborted','parent_aborted'
]);
const correlationKeys=['request_id','operation_id','component','project_id','workflow_id','attempt_id','skill_attempt_id','library_package_id','library_revision_id','library_job_id','library_file_id','ordinal','call_id','operation','provider','model','reasoning_effort'] as const;
for(const field of ['query_count','db_elapsed_ms','non_db_elapsed_ms','max_query_ms','query_id','pool_total','pool_idle','pool_waiting','pool_total_before','pool_idle_before','pool_waiting_before','new_connection','stream_events','stream_bytes','saw_done','saw_finish','stream_eof'])allowed.add(field);
const lifecycleEvents=new Set(['service.shutdown_requested','service.stopped','library_job.cancelled','library_job.recovery_degraded']);
// 每次尝试的有限阶段回执；不开放逐token、工具、页级进度或逐条SQL事务日志。
const executionEvents=new Set(['attempt.enqueued','attempt.reused','attempt.claimed','attempt.input_validated','attempt.completed','call.started','call.completed','model_api.call.started','model_api.call.completed','heartbeat.write_failed','heartbeat.write_recovered','db.connection.recovered','extraction.api.phase','extraction.api.upload_completed','extraction.api.poll_observed','extraction.api.completed','extraction.cli.fallback.started','extraction.cli.fallback.skipped','material.snapshot.read']);
function shouldPersist(level:unknown,event:string){return level==='error'||lifecycleEvents.has(event)||executionEvents.has(event)||level==='warn'&&(event==='db.query.slow'||event==='db.connection.waited'||event==='db.connection.held');}
function safeString(key:string,value:string){
 if(value.length>(key==='route'?240:160)||/[\r\n\0]/.test(value)||/^(sk-[A-Za-z0-9_-]{12,}|Bearer\s|postgres(?:ql)?:\/\/)/i.test(value))return false;
 if(key==='route')return /^\/[A-Za-z0-9_./:-]*$/.test(value);
 if(key==='signal')return ['SIGTERM','SIGINT','SIGKILL','unknown'].includes(value);
 if(key==='error_kind')return safeErrors.has(value);
 if(key==='reason_code')return /^[a-z][a-z0-9_]{0,79}$/.test(value);
 if(key==='failure_stage')return ['download_request','download_http_response','response_body'].includes(value);
 if(key==='network_error_code')return /^(?:UND_ERR_[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,40}|E[A-Z0-9_]{1,30})$/.test(value);
 if(key==='finish_reason')return ['length','content_filter','tool_calls','unknown','missing'].includes(value);
 if(key==='changed_fields')return value==='none'||value.length<=512&&value.split(',').every(field=>safeChangedFields.has(field));
 if(key==='level')return ['debug','info','warn','error'].includes(value);
 if(key==='provider')return safeProviders.has(value);
 return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}
function projectFields(fields:LogFields){
 const output:LogFields={};
 for(const [key,value] of Object.entries(fields)){
  if(!allowed.has(key)||value===undefined||value===null)continue;
  if(key==='token_usage'){
   if(!value||typeof value!=='object'||Array.isArray(value))continue;
   const usage:Record<string,number>={};
   for(const [name,count] of Object.entries(value as Record<string,unknown>))if(/^(input|output|cached_input|reasoning_output)_tokens$/.test(name)&&Number.isSafeInteger(count)&&Number(count)>=0)usage[name]=Number(count);
   if(Object.keys(usage).length)output[key]=usage;
   continue;
  }
  if(typeof value==='string'){if(safeString(key,value))output[key]=value;}
  else if(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER)output[key]=value;
  else if(typeof value==='boolean')output[key]=value;
 }
 return output;
}
export function sanitizeLogRecord(raw:unknown):LogFields|undefined{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
 const value=raw as Record<string,unknown>;
 const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 if(value.schema_version!==1||typeof value.event_id!=='string'||!uuidPattern.test(value.event_id)||!Number.isSafeInteger(value.seq)||Number(value.seq)<1||typeof value.occurred_at!=='string'||!Number.isFinite(Date.parse(value.occurred_at))||typeof value.written_at!=='string'||!Number.isFinite(Date.parse(value.written_at))||typeof value.event!=='string'||!/^[a-z][a-z0-9_.-]{0,119}$/.test(value.event)||typeof value.service!=='string'||!/^[a-z0-9-]{1,32}$/.test(value.service)||typeof value.instance_id!=='string'||!uuidPattern.test(value.instance_id)||!Number.isSafeInteger(value.pid))return;
 return{schema_version:1,event_id:value.event_id,seq:value.seq,occurred_at:value.occurred_at,written_at:value.written_at,event:value.event,service:value.service,instance_id:value.instance_id,pid:value.pid,...projectFields(value)};
}
export function withLogContext<T>(fields:LogContext,run:()=>T):T{return context.run({...context.getStore(),...projectFields(fields)},run);}
export function withIsolatedLogContext<T>(fields:LogContext,run:()=>T):T{return context.run(projectFields(fields),run);}
export function enterLogContext(fields:LogContext){const previous=context.getStore();context.enterWith({...previous,...projectFields(fields)});return()=>context.enterWith(previous??{});}

export interface StructuredLoggerOptions {root:string;service:'api'|'worker'|'migration'|'script'|string;instance_id?:string;build_id?:string;max_file_bytes?:number;retention_days?:number;max_total_bytes?:number;max_queue?:number;now?:()=>Date}
export interface LoggerHealth {status:'healthy'|'degraded'|'closed';instance_id:string;last_success_at:string|null;dropped_count:number;error_kind:'none'|'filesystem'|'queue_full'|'closed'}
export function createStructuredLogger(options:StructuredLoggerOptions){
 const instance_id=options.instance_id??randomUUID(),service=options.service,rawBuildId=options.build_id??process.env.APP_BUILD_ID??'local',build_id=safeString('build_id',rawBuildId)?rawBuildId:'local',now=options.now??(()=>new Date());
 const maxFile=options.max_file_bytes??10*1024*1024,retentionDays=options.retention_days??7,maxTotal=options.max_total_bytes??200*1024*1024,maxQueue=options.max_queue??5000;
 let seq=0,rotation=0,queue:LogFields[]=[],inflight:Promise<void>|undefined,closed=false,retainedDay='',status:LoggerHealth['status']='healthy',errorKind:LoggerHealth['error_kind']='none',lastSuccess:string|null=null,dropped=0,reportedFailure=false,writeFailed=false,retentionFailed=false,queueFailed=false,closedFailure=false;
 function refreshHealth(){
  if(writeFailed||retentionFailed){status='degraded';errorKind='filesystem';}
  else if(queueFailed){status='degraded';errorKind='queue_full';}
  else if(closedFailure){status='degraded';errorKind='closed';}
  else if(!closed){status='healthy';errorKind='none';reportedFailure=false;}
 }
 function markFailure(kind:LoggerHealth['error_kind']){dropped++;if(kind==='filesystem')writeFailed=true;else if(kind==='queue_full')queueFailed=true;else if(kind==='closed')closedFailure=true;refreshHealth();if(!reportedFailure){reportedFailure=true;console.error('结构化日志写入不可用（未输出日志内容）');}}
 function markRetentionFailure(){retentionFailed=true;refreshHealth();if(!reportedFailure){reportedFailure=true;console.error('结构化日志保留清理失败（未输出日志内容）');}}
 async function trimRetention(today:string){
  if(retainedDay===today)return;const root=join(options.root,'logs'),lockPath=join(root,'.retention.lock');let locked=false;
  for(let attempt=0;attempt<2&&!locked;attempt++)try{
   const lock=await open(lockPath,'wx',0o600);await lock.writeFile(String(process.pid));await lock.close();locked=true;
  }catch(error){
   const code=error&&typeof error==='object'&&'code'in error?String(error.code):'unknown';
   if(code!=='EEXIST'){markRetentionFailure();return;}
   try{
    const lockInfo=await stat(lockPath);
    if(Date.now()-lockInfo.mtimeMs>10*60*1000){await rm(lockPath,{force:true});continue;}
    const owner=Number((await readFile(lockPath,'utf8')).trim());
    if(Number.isSafeInteger(owner)&&owner>0){try{process.kill(owner,0);return;}catch(ownerError){const ownerCode=ownerError&&typeof ownerError==='object'&&'code'in ownerError?String(ownerError.code):'unknown';if(ownerCode!=='ESRCH')return;}}
    else return;
    await rm(lockPath,{force:true});
   }catch(lockError){const lockCode=lockError&&typeof lockError==='object'&&'code'in lockError?String(lockError.code):'unknown';if(lockCode==='ENOENT')continue;markRetentionFailure();return;}
  }
  if(!locked)return;
  try{
   let dirs:string[]=[];
   try{dirs=(await readdir(root,{withFileTypes:true})).filter(item=>item.isDirectory()&&/^\d{4}-\d{2}-\d{2}$/.test(item.name)).map(item=>item.name);}catch{markRetentionFailure();return;}
   const files:{path:string;size:number;mtime:number;day:string}[]=[];
   for(const day of dirs)try{for(const entry of await readdir(join(root,day),{withFileTypes:true}))if(entry.isFile()&&/^[a-z0-9-]+-[a-f0-9-]+-\d{3}\.jsonl$/.test(entry.name)){const path=join(root,day,entry.name),info=await stat(path);files.push({path,size:info.size,mtime:info.mtimeMs,day});}}catch{markRetentionFailure();return;}
   files.sort((a,b)=>a.mtime-b.mtime);let total=files.reduce((sum,file)=>sum+file.size,0);
   for(const file of files){const age=(Date.parse(`${today}T00:00:00Z`)-Date.parse(`${file.day}T00:00:00Z`))/86400000;if(age<retentionDays&&total<=maxTotal)continue;try{await rm(file.path);total-=file.size;}catch{markRetentionFailure();return;}}
   retentionFailed=false;refreshHealth();retainedDay=today;
  }finally{try{await rm(lockPath,{force:true});}catch{markRetentionFailure();}}
 }
 async function persist(record:LogFields){
  const occurred=String(record.occurred_at),day=occurred.slice(0,10),directory=join(options.root,'logs',day);await mkdir(directory,{recursive:true,mode:0o700});
  let file=join(directory,`${service}-${instance_id}-${String(rotation).padStart(3,'0')}.jsonl`);
  try{if((await stat(file)).size>=maxFile){rotation++;file=join(directory,`${service}-${instance_id}-${String(rotation).padStart(3,'0')}.jsonl`);}}catch{/* New log segment. */}
  await appendFile(file,`${JSON.stringify({...record,written_at:now().toISOString()})}\n`,{encoding:'utf8',mode:0o600});await chmod(file,0o600);await trimRetention(day);
 }
 function pump(){
  if(inflight)return inflight;
    inflight=(async()=>{while(queue.length){const record=queue.shift()!;if(queue.length<maxQueue){queueFailed=false;refreshHealth();}try{await persist(record);lastSuccess=now().toISOString();writeFailed=false;refreshHealth();}catch{markFailure('filesystem');}}})().finally(()=>{inflight=undefined;if(queue.length&&!closed)pump();});return inflight;
 }
 const logger={
  instance_id,
  log(event:string,fields:LogFields={}){
   const occurred_at=now().toISOString(),extra=projectFields(fields),level=extra.level??'info';
   if(!shouldPersist(level,event))return;
   if(closed){markFailure('closed');return;}if(!/^[a-z][a-z0-9_.-]{0,119}$/.test(event)){markFailure('filesystem');return;}
   if(queue.length>=maxQueue){
    markFailure('queue_full');return;
   }
   queue.push({schema_version:1,event_id:randomUUID(),seq:++seq,occurred_at,level,event,service,instance_id,pid:process.pid,...projectFields(context.getStore()??{}),...extra,build_id});void pump();
  },
  logSync(event:string,fields:LogFields={}){
   const occurred_at=now().toISOString(),day=occurred_at.slice(0,10),directory=join(options.root,'logs',day),extra=projectFields(fields),level=extra.level??'info';
   if(level!=='error')return;
   if(closed){markFailure('closed');return;}if(!/^[a-z][a-z0-9_.-]{0,119}$/.test(event)){markFailure('filesystem');return;}
   const record={schema_version:1,event_id:randomUUID(),seq:++seq,occurred_at,level,event,service,instance_id,pid:process.pid,...projectFields(context.getStore()??{}),...extra,build_id};
   try{
    mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
    let file=join(directory,`${service}-${instance_id}-${String(rotation).padStart(3,'0')}.jsonl`);
    try{if(statSync(file).size>=maxFile){rotation++;file=join(directory,`${service}-${instance_id}-${String(rotation).padStart(3,'0')}.jsonl`);}}catch{/* New log segment. */}
    appendFileSync(file,`${JSON.stringify({...record,written_at:now().toISOString()})}\n`,{encoding:'utf8',mode:0o600});chmodSync(file,0o600);
    lastSuccess=now().toISOString();writeFailed=false;refreshHealth();
   }catch{markFailure('filesystem');}
  },
  async flush(){while(inflight)await inflight;},
  async close(){closed=true;let timer:ReturnType<typeof setTimeout>|undefined;const finished=await Promise.race([this.flush().then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);if(timer)clearTimeout(timer);if(!finished)markFailure('filesystem');else if(writeFailed||retentionFailed||queueFailed||closedFailure)refreshHealth();else status='closed';if(active===logger)active=undefined;},
  async health():Promise<LoggerHealth>{return{status,instance_id,last_success_at:lastSuccess,dropped_count:dropped,error_kind:errorKind};},
 };
 return logger;
}
type Logger=ReturnType<typeof createStructuredLogger>;
let active:Logger|undefined;
let fatalErrorMonitorInstalled=false;
export function configureLogger(options:StructuredLoggerOptions){active=createStructuredLogger(options);return active;}
export function currentLogger(){return active;}
export function logEvent(event:string,fields:LogFields={}){active?.log(event,fields);}
export function logEventSync(event:string,fields:LogFields={}){active?.logSync(event,fields);}
export function installFatalErrorLogging(){
 if(fatalErrorMonitorInstalled)return;fatalErrorMonitorInstalled=true;
 process.on('uncaughtExceptionMonitor',(error,origin)=>logEventSync('process.uncaught',{level:'error',component:'runtime',event_type:origin,...classifyLogError(error)}));
 process.on('unhandledRejection',reason=>{logEventSync('process.unhandled_rejection',{level:'error',component:'runtime',event_type:'unhandledRejection',...classifyLogError(reason)});process.exit(1);});
}
export function loggerHealth(){return active?.health()??Promise.resolve<LoggerHealth>({status:'degraded',instance_id:'unconfigured',last_success_at:null,dropped_count:0,error_kind:'filesystem'});}
export function classifyLogError(error:unknown):{error_kind:'authentication'|'quota'|'rate_limit'|'network'|'timeout'|'provider'|'configuration'|'cancelled'|'invalid_response'|'unknown';http_status?:number;retryable?:boolean;reason_code?:string;finish_reason?:string;stream_events?:number;stream_bytes?:number;saw_done?:boolean;saw_finish?:boolean;stream_eof?:string}{
 const value=error&&typeof error==='object'?error as {kind?:unknown;status?:unknown;message?:unknown;retryable?:unknown;code?:unknown;http_status?:unknown;reason_code?:unknown}:{};
 const status=value.http_status??value.status;
 const finish=typeof (value as {finish_reason?:unknown}).finish_reason==='string'?(value as {finish_reason:string}).finish_reason:'';
 const finish_reason=['length','content_filter','tool_calls','unknown','missing'].includes(finish)?finish:finish?'unknown':undefined;
 const streamValue=error&&typeof error==='object'?error as Record<string,unknown>:{};
 const stream={...(typeof streamValue.stream_events==='number'&&Number.isSafeInteger(streamValue.stream_events)&&streamValue.stream_events>=0?{stream_events:streamValue.stream_events}:{}),...(typeof streamValue.stream_bytes==='number'&&Number.isSafeInteger(streamValue.stream_bytes)&&streamValue.stream_bytes>=0?{stream_bytes:streamValue.stream_bytes}:{}),...(typeof streamValue.saw_done==='boolean'?{saw_done:streamValue.saw_done}:{}),...(typeof streamValue.saw_finish==='boolean'?{saw_finish:streamValue.saw_finish}:{}),...(typeof streamValue.stream_eof==='string'&&['reading','done','eof','error'].includes(streamValue.stream_eof)?{stream_eof:streamValue.stream_eof}:{})};
 const details={...stream,...(typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?{http_status:status}:{}),...(typeof value.reason_code==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(value.reason_code)?{reason_code:value.reason_code}:{}),...(finish_reason?{finish_reason}:{})};
 const kinds=['authentication','quota','rate_limit','network','timeout','provider','configuration','cancelled','invalid_response'] as const;
 if(typeof value.kind==='string'&&(kinds as readonly string[]).includes(value.kind))return{error_kind:value.kind as typeof kinds[number],...details,...(typeof value.retryable==='boolean'?{retryable:value.retryable}:{})};
 const message=typeof value.message==='string'?value.message.toLowerCase():'';
 const code=typeof value.code==='string'?value.code:'';
 // 只记录固定分类，不输出SQLite路径、原始错误或配置内容。
 if(code==='SQLITE_BUSY'||message.includes('database is locked')||message.includes('database is busy'))return{error_kind:'unknown',...details,reason_code:'sqlite_busy',retryable:true};
 if(code==='SQLITE_LOCKED'||message.includes('database table is locked'))return{error_kind:'unknown',...details,reason_code:'sqlite_locked',retryable:true};
 if(error instanceof Error&&error.name==='AgentConcurrencyConfigurationError')return{error_kind:'configuration',...details,reason_code:'worker_concurrency_mismatch',retryable:false};
 const error_kind=message.includes('超时')||message.includes('timeout')?'timeout':message.includes('取消')||message.includes('cancel')?'cancelled':message.includes('认证')||message.includes('登录')?'authentication':message.includes('quota')||message.includes('额度')?'quota':message.includes('网络')||message.includes('network')||message.includes('fetch failed')||/^ECONN|^EHOST|^ENET|^EPIPE/.test(code)?'network':message.includes('校验')||message.includes('invalid')?'invalid_response':'unknown';
 return{error_kind,...details,...(typeof value.retryable==='boolean'?{retryable:value.retryable}:{}),...(!value.retryable&&(error_kind==='network'||error_kind==='timeout')?{retryable:true}:{})};
}
