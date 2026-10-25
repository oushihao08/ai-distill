/** 结构化日志行为验证：字段白名单净化、JSONL写入/轮转/保留、并发进程写入、降级恢复及脱敏任务错误摘要。
 * 边界：日志文件与子进程写入限定在临时目录；脱敏worker使用SQL连接池替身和注入执行器，不连接真实数据库或模型/provider。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {expect,test} from 'bun:test';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REDACTION_PROTOCOL_VERSION} from './materials/redaction';
import {createWorkerShutdown} from './worker-pool';
import {classifyLogError,configureLogger,createStructuredLogger,currentLogger,installFatalErrorLogging,sanitizeLogRecord,withLogContext} from './logging';

test('容量查询的SQLite锁与并发配置错误保留固定诊断码，不泄露原始错误',()=>{
 const busy=classifyLogError({code:'SQLITE_BUSY',message:'private/path database is locked secret'});
 expect(busy).toEqual({error_kind:'unknown',reason_code:'sqlite_busy',retryable:true});
 expect(classifyLogError({code:'SQLITE_LOCKED',message:'private'})).toEqual({error_kind:'unknown',reason_code:'sqlite_locked',retryable:true});
 const mismatch=new Error('private configuration');mismatch.name='AgentConcurrencyConfigurationError';
 expect(classifyLogError(mismatch)).toEqual({error_kind:'configuration',reason_code:'worker_concurrency_mismatch',retryable:false});
 expect(JSON.stringify([busy,classifyLogError(mismatch)])).not.toContain('private');
});

test('shutdown events are durable, ordered and idempotent without enabling progress noise',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-stop-log-')),logger=configureLogger({root,service:'worker'}),controller=new AbortController(),shutdown=createWorkerShutdown(controller,10);
 try{
  shutdown.request('SIGTERM');shutdown.request('SIGTERM');logger.log('worker.progress',{level:'info'});
  await Bun.sleep(20);shutdown.dispose();logger.log('service.stopped',{level:'info',prompt:'PRIVATE'});await logger.flush();
  const directory=join(root,'logs',new Date().toISOString().slice(0,10));
  const records=(await Promise.all((await readdir(directory)).map(file=>readFile(join(directory,file),'utf8')))).join('').trim().split('\n').map(line=>JSON.parse(line));
  expect(records.map(x=>x.event)).toEqual(['service.shutdown_requested','service.shutdown_incomplete','service.stopped']);
  expect(records[0].signal).toBe('SIGTERM');expect(JSON.stringify(records)).not.toContain('PRIVATE');
 }finally{shutdown.dispose();await logger.close();await rm(root,{recursive:true,force:true});}
});

test('writes ordered, correlated JSONL events and drops unapproved private fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-logs-'));
 const logger=createStructuredLogger({root,service:'worker',instance_id:'instance-a',build_id:'build-2026-10-09'});
 try{
  await withLogContext({request_id:'request-a',attempt_id:'attempt-a',workflow_id:'workflow-a'},async()=>{
   logger.log('attempt.started',{level:'info',operation:'redaction',model:'gpt-6-luna',prompt:'PRIVATE MATERIAL'});
   logger.log('attempt.failed',{level:'error',operation:'redaction',model:'gpt-6-luna',prompt:'PRIVATE MATERIAL',error_kind:'timeout',reason_code:'codex_timeout',failure_phase:'agent_execution'});
  });
  await logger.flush();
  const files=await readdir(join(root,'logs',new Date().toISOString().slice(0,10)));
  expect(files).toHaveLength(1);
  const lines=(await readFile(join(root,'logs',new Date().toISOString().slice(0,10),files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({event:'attempt.failed',service:'worker',instance_id:'instance-a',build_id:'build-2026-10-09',request_id:'request-a',attempt_id:'attempt-a',workflow_id:'workflow-a',operation:'redaction',model:'gpt-6-luna',failure_phase:'agent_execution'});
  expect(JSON.stringify(lines)).not.toContain('PRIVATE MATERIAL');
  expect(await logger.health()).toMatchObject({status:'healthy',dropped_count:0});
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('persists only database latency warnings with safe metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-db-latency-'));
 const logger=createStructuredLogger({root,service:'api',instance_id:'instance-b'});
 try{
  logger.log('db.query.slow',{level:'warn',query_name:'select:ai_distill.workflows',duration_ms:1200,sql:'PRIVATE SQL',values:['PRIVATE VALUE']});
  logger.log('db.connection.waited',{level:'warn',duration_ms:300});
  logger.log('unrelated.warning',{level:'warn',duration_ms:900});
  await logger.flush();
  const files=await readdir(join(root,'logs',new Date().toISOString().slice(0,10)));
  expect(files).toHaveLength(1);
  const lines=(await readFile(join(root,'logs',new Date().toISOString().slice(0,10),files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines.map((line:any)=>line.event)).toEqual(['db.query.slow','db.connection.waited']);
  expect(lines[0]).toMatchObject({level:'warn',query_name:'select:ai_distill.workflows',duration_ms:1200});
  expect(JSON.stringify(lines)).not.toContain('PRIVATE');
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('isolates concurrent async log contexts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-logs-context-'));
 const logger=createStructuredLogger({root,service:'api',instance_id:'instance-b'});
 try{
  await Promise.all(['request-a','request-b'].map(request_id=>withLogContext({request_id},async()=>{
   await Promise.resolve();logger.log('request.failed',{level:'error'});
  })));
  await logger.flush();
  const files=await readdir(join(root,'logs',new Date().toISOString().slice(0,10)));
  const lines=(await readFile(join(root,'logs',new Date().toISOString().slice(0,10),files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(lines.map(line=>line.request_id).sort()).toEqual(['request-a','request-b']);
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('keeps concurrent process writers in separate complete JSONL segments',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-logs-processes-')),moduleUrl=new URL('./logging.ts',import.meta.url).href;
 try{
  const source=`import {createStructuredLogger} from ${JSON.stringify(moduleUrl)};const logger=createStructuredLogger({root:${JSON.stringify(root)},service:'worker'});for(let i=0;i<25;i++)logger.log('probe.concurrent',{level:'error',event_count:i});await logger.close();`;
  const launch=()=>new Promise<number>((resolve,reject)=>{const child=spawn(process.execPath,['-e',source],{stdio:'ignore'});child.once('error',reject);child.once('close',code=>resolve(code??1));});
  expect(await Promise.all([launch(),launch()])).toEqual([0,0]);
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await Promise.all(files.map(file=>readFile(join(directory,file),'utf8')))).flatMap(text=>text.split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  expect(records).toHaveLength(50);expect(new Set(records.map(record=>record.instance_id)).size).toBe(2);
  expect(new Set(records.map(record=>record.event_id)).size).toBe(50);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('coordinates retention cleanup across concurrent logger processes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-logs-retention-processes-')),moduleUrl=new URL('./logging.ts',import.meta.url).href;
 try{
  for(let day=1;day<=20;day++){
   const directory=join(root,'logs',`2026-08-${String(day).padStart(2,'0')}`);await mkdir(directory,{recursive:true});
   for(let index=0;index<10;index++)await writeFile(join(directory,`worker-${String(index).padStart(8,'0')}-1234-4234-8234-123456789abc-000.jsonl`),'{}\n');
  }
  const source=`import {createStructuredLogger} from ${JSON.stringify(moduleUrl)};const logger=createStructuredLogger({root:${JSON.stringify(root)},service:'worker'});logger.log('probe.retention',{level:'error'});await logger.flush();const health=await logger.health();await logger.close();if(health.status!=='healthy')process.exit(2);`;
  const launch=()=>new Promise<number>((resolve,reject)=>{const child=spawn(process.execPath,['-e',source],{stdio:'ignore'});child.once('error',reject);child.once('close',code=>resolve(code??1));});
  expect(await Promise.all([launch(),launch(),launch(),launch()])).toEqual([0,0,0,0]);
  expect(await readdir(join(root,'logs'))).toContain(new Date().toISOString().slice(0,10));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('rotates bounded JSONL files and removes only expired logger segments',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-logs-retention-'));
 let now=new Date('2026-01-01T12:00:00.000Z');
 const logger=createStructuredLogger({root,service:'worker',instance_id:'12345678-1234-1234-1234-123456789abc',max_file_bytes:1,retention_days:7,now:()=>now});
 try{
  logger.log('attempt.failed',{level:'error'});await logger.flush();
  const oldDay=join(root,'logs','2026-01-01');expect(await readdir(oldDay)).toHaveLength(1);
  now=new Date('2026-01-10T12:00:00.000Z');logger.log('attempt.failed',{level:'error'});await logger.flush();
  expect(await readdir(oldDay)).toHaveLength(0);
  expect(await readdir(join(root,'logs','2026-01-10'))).toHaveLength(1);
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('结束原因只保留白名单枚举',()=>{
 expect(classifyLogError({kind:'invalid_response',reason_code:'incomplete_finish_reason',finish_reason:'length'})).toMatchObject({finish_reason:'length'});
 expect(classifyLogError({kind:'invalid_response',reason_code:'incomplete_finish_reason',finish_reason:'provider said private text'})).toMatchObject({finish_reason:'unknown'});
 expect(classifyLogError({kind:'invalid_response',reason_code:'incomplete_finish_reason'})).not.toHaveProperty('finish_reason');
});
test('query sanitizer drops fields outside the normal log contract',async()=>{
 const raw={schema_version:1,event_id:'12345678-1234-1234-1234-123456789abc',seq:1,occurred_at:'2026-01-01T00:00:00.000Z',written_at:'2026-01-01T00:00:00.001Z',event:'request.failed',service:'api',instance_id:'12345678-1234-1234-1234-123456789abc',pid:1,level:'error',request_id:'request-a',prompt:'PRIVATE'};
 expect(sanitizeLogRecord(raw)).toMatchObject({event:'request.failed',request_id:'request-a',level:'error'});
 expect(JSON.stringify(sanitizeLogRecord(raw))).not.toContain('PRIVATE');
 expect(sanitizeLogRecord({...raw,event:'management.changed',changed_fields:'none'})).toMatchObject({event:'management.changed',changed_fields:'none'});
 expect(sanitizeLogRecord({...raw,event:'redaction.batch.retry',call_id:'12345678-1234-1234-1234-123456789abc',batch_index:2,reason_code:'page_count_mismatch'})).toMatchObject({event:'redaction.batch.retry',call_id:'12345678-1234-1234-1234-123456789abc',batch_index:2,reason_code:'page_count_mismatch'});
 expect(sanitizeLogRecord({...raw,event_id:'invalid'})).toBeUndefined();
});

test('marks logger degraded when its storage path cannot be written',async()=>{
 const root=join(await mkdtemp(join(tmpdir(),'ai-distill-logs-failure-')),'not-a-directory');
 await writeFile(root,'blocked');
 const logger=createStructuredLogger({root,service:'worker',build_id:'build-recovery'});
 try{
  logger.log('attempt.failed',{level:'error',reason_code:'storage_unavailable'});
  await logger.flush();
  expect(await logger.health()).toMatchObject({status:'degraded',error_kind:'filesystem',dropped_count:1});
 }finally{await logger.close();expect(await logger.health()).toMatchObject({status:'degraded',error_kind:'filesystem'});await rm(root.slice(0,root.lastIndexOf('/')),{recursive:true,force:true});}
});

test('persists failures after the logger storage becomes writable again without a recovery event',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'ai-distill-logs-recovery-')),root=join(parent,'blocked');await writeFile(root,'blocker');
 const logger=createStructuredLogger({root,service:'worker',build_id:'build-recovery'});
 try{
  logger.log('attempt.failed',{level:'error'});await logger.flush();expect(await logger.health()).toMatchObject({status:'degraded',error_kind:'filesystem'});
  await unlink(root);await mkdir(root);logger.log('attempt.failed',{level:'error',reason_code:'storage_recovered'});await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toHaveLength(1);expect(records[0]).toMatchObject({event:'attempt.failed',service:'worker',level:'error',reason_code:'storage_recovered',build_id:'build-recovery'});
  expect(await logger.health()).toMatchObject({status:'healthy',error_kind:'none'});
 }finally{await logger.close();await rm(parent,{recursive:true,force:true});}
});

test('marks bounded queue overflow degraded and counts dropped events',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-logs-overflow-'));
 const logger=createStructuredLogger({root,service:'worker',max_queue:0});
 try{
  logger.log('attempt.failed',{level:'error'});
  expect(await logger.health()).toMatchObject({status:'degraded',error_kind:'queue_full',dropped_count:1});
 }finally{await logger.close();expect(await logger.health()).toMatchObject({status:'degraded',error_kind:'queue_full'});await rm(root,{recursive:true,force:true});}
});

test('does not enqueue successful or progress events before persisting failures',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-logs-priority-'));
 const logger=createStructuredLogger({root,service:'worker',max_queue:1});
 try{
  logger.log('service.started',{level:'info'});logger.log('worker.progress',{level:'debug'});logger.log('attempt.failed',{level:'error'});await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.map(record=>record.event).filter(event=>['service.started','worker.progress','attempt.failed'].includes(event))).toEqual(['attempt.failed']);
  expect(await logger.health()).toMatchObject({dropped_count:0});
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('closing the configured logger detaches it from later application events',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-logs-close-'));
 const logger=configureLogger({root,service:'worker'});
 try{expect(currentLogger()).toBe(logger);await logger.close();expect(currentLogger()).toBeUndefined();}
 finally{await rm(root,{recursive:true,force:true});}
});

test('fatal process errors are written synchronously without suppressing the runtime exit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-distill-fatal-logs-'));
 try{
  const moduleUrl=new URL('./logging.ts',import.meta.url).href;
  for(const [failure,event,event_type] of [["setTimeout(()=>{throw new Error('private fatal marker')},0)",'process.uncaught','uncaughtException'],["Promise.reject(new Error('private fatal marker'))",'process.unhandled_rejection','unhandledRejection']] as const){
   const source=`import {configureLogger,installFatalErrorLogging} from ${JSON.stringify(moduleUrl)};configureLogger({root:${JSON.stringify(root)},service:'script'});installFatalErrorLogging();${failure};`;
   const result=spawnSync(process.execPath,['-e',source],{encoding:'utf8'});expect(result.status).not.toBe(0);
   await Bun.sleep(1);
   const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await Promise.all(files.map(file=>readFile(join(directory,file),'utf8')))).flatMap(text=>text.split('\n').filter(Boolean).map(line=>JSON.parse(line)));
   expect(records).toContainEqual(expect.objectContaining({event,service:'script',level:'error',component:'runtime',event_type}));
  }
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await Promise.all(files.map(file=>readFile(join(directory,file),'utf8')))).join('\n');
  expect(records).not.toContain('private fatal marker');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('redaction worker records stale-attempt recovery after committing the database update',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-recovery-logs-'));
 const logger=configureLogger({root,service:'worker'}),heartbeatAt='2026-10-09T00:00:00.000Z';
 const stale={id:'attempt-a',workflow_id:'workflow-a',heartbeat_at:heartbeatAt,project_id:'project-a'};
 const query=async(sql:string)=>{
  if(sql.startsWith('SELECT a.id,a.workflow_id,a.heartbeat_at,w.project_id'))return{rows:[stale],rowCount:1};
  if(sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))return{rows:[{id:stale.id}],rowCount:1};
  if(sql.startsWith('SELECT a.*'))return{rows:[],rowCount:0};
  return{rows:[],rowCount:1};
 };
 const client={query,release(){}};
 try{
  const {runNextRedaction}=await import('./materials/redaction-jobs');
  expect(await runNextRedaction({connect:async()=>client}as any,root)).toBe(false);await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory);
  const records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({event:'attempt.recovered_interrupted',component:'redaction',project_id:'project-a',workflow_id:'workflow-a',attempt_id:'attempt-a',ordinal:9,last_heartbeat_at:heartbeatAt,threshold_ms:300000,state:'failed'}));
  expect(records.find(record=>record.event==='attempt.recovered_interrupted')!.seq).toBeGreaterThan(0);
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('redaction heartbeat failures and recovery include the active attempt without database text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-heartbeat-logs-')),logger=configureLogger({root,service:'worker'}),timers:(()=>void)[]=[];
 const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval;
 let heartbeatWrites=0;
 const job={id:'attempt-a',workflow_id:'workflow-a',project_id:'project-a',input:{materials:[],digest:''},config:{}};
 job.input.digest=(await import('./materials/redaction-jobs')).redactionInputDigest([]);
 const client={release(){},async query(sql:string){
  if(sql.startsWith('SELECT a.id,a.workflow_id,a.heartbeat_at,w.project_id'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT a.*'))return{rows:[job],rowCount:1};
  if(sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))return{rows:[{id:job.id}],rowCount:1};
  return{rows:[],rowCount:1};
 }};
 const pool={connect:async()=>client,async query(sql:string){
  if(sql.startsWith('SELECT DISTINCT ON(m.id)'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT count(*)::int AS count')){
   timers[1]?.();await Bun.sleep(0);timers[1]?.();await Bun.sleep(0);return{rows:[{count:0}],rowCount:1};
  }
  if(sql.startsWith('UPDATE ai_distill.step_attempts SET heartbeat_at=now()'))return ++heartbeatWrites===1?{rows:[],rowCount:0}:{rows:[{id:job.id}],rowCount:1};
  return{rows:[],rowCount:1};
 }};
 globalThis.setInterval=((callback:()=>void)=>{timers.push(callback);return{unref(){}} as any;})as any;
 globalThis.clearInterval=(()=>{})as any;
 try{
  const {runNextRedaction}=await import('./materials/redaction-jobs');expect(await runNextRedaction(pool as any,root)).toBe(true);await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.some(record=>record.event==='heartbeat.write_failed')).toBe(false);
  expect(records.some(record=>record.event==='heartbeat.write_recovered')).toBe(false);
  expect(JSON.stringify(records)).not.toContain('database error text');
 }finally{globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;await logger.close();await rm(root,{recursive:true,force:true});}
});

test('redaction failure stores a safe Codex summary while keeping the user-facing error',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-failure-summary-')),catalogHome=join(root,'codex');await mkdir(catalogHome,{recursive:true});
 await writeFile(join(catalogHome,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',supported_reasoning_levels:[{effort:'low'}]}]}));
 const priorCodexHome=process.env.CODEX_HOME;process.env.CODEX_HOME=catalogHome;
 const sourceSha='a'.repeat(64),raw=JSON.stringify({source_sha256:sourceSha,pages:[{page:1,text:'private material'}]}),artifactSha=createHash('sha256').update(raw).digest('hex');
 const item={material_id:'material-a',source_sha256:sourceSha,artifact_id:'artifact-a',artifact_sha256:artifactSha},input={materials:[item]};
 const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const job={id:'attempt-a',workflow_id:'workflow-a',project_id:'project-a',input:{...input,digest},config:{provider:'codex',model:'fixture-model',reasoning_effort:'low',prompt:'redact',text_layout:REDACTION_PROTOCOL_VERSION}};
 const writes:{sql:string;values:unknown[]|undefined}[]=[];
 let executed=false;
 const client={release(){},async query(sql:string,values?:unknown[]){
  if(sql.startsWith('SELECT a.id,a.workflow_id,a.heartbeat_at,w.project_id'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT a.*'))return{rows:[job],rowCount:1};
  if(sql.startsWith('SELECT c.*,a.status'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return{rows:[{}],rowCount:1};
  if(sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'")){writes.push({sql,values});return{rows:[{id:job.id}],rowCount:1};}
  if(sql.startsWith("UPDATE ai_distill.steps SET status='failed'")){writes.push({sql,values});return{rows:[],rowCount:1};}
  return{rows:[],rowCount:1};
 }};
 const pool={connect:async()=>client,async query(query:string|{text:string}){
  const sql=typeof query==='string'?query:query.text;
  if(sql.startsWith('SELECT DISTINCT ON(m.id)'))return{rows:[item],rowCount:1};
  if(sql.startsWith('SELECT count(*)::int AS count'))return{rows:[{count:1}],rowCount:1};
  if(sql.startsWith('SELECT ar.content,ar.storage_path'))return{rows:[{content:raw,storage_path:null,sha256:artifactSha,source_sha256:sourceSha}],rowCount:1};
  return{rows:[],rowCount:1};
 }};
 try{
  const {runNextRedaction}=await import('./materials/redaction-jobs');
  await runNextRedaction(pool as any,root,undefined,async task=>{executed=true;throw Object.assign(new Error('private provider response'),{kind:'network',reason_code:'codex_network',call_id:task.call_id,call_ids:[task.call_id],expected_count:12,actual_count:11,expected_page:74,material_id:'12345678-1234-1234-1234-123456789abc',usage:{input_tokens:10,output_tokens:2},duration_ms:1000,retryable:true,occurred_at:'2026-10-09T00:00:00.000Z'});});
  expect(executed).toBe(true);
  const attemptWrite=writes.find(write=>write.sql.includes('ai_distill.step_attempts'))!,stepWrite=writes.find(write=>write.sql.includes('ai_distill.steps'))!;
  expect(attemptWrite.sql).toContain("result=COALESCE(result,'{}'::jsonb)");
  const attemptSummary=JSON.parse(String(attemptWrite.values?.[2]));
  expect(attemptSummary).toMatchObject({kind:'network',reason_code:'codex_network',call_id:expect.stringMatching(/^[0-9a-f-]{36}$/),call_ids:[expect.stringMatching(/^[0-9a-f-]{36}$/)],expected_count:12,actual_count:11,expected_page:74,material_id:'12345678-1234-1234-1234-123456789abc',usage:{input_tokens:10,output_tokens:2},duration_ms:1000,retryable:true,occurred_at:'2026-10-09T00:00:00.000Z'});
  expect(attemptWrite.values?.[1]).toBe('脱敏执行失败或结果校验未通过，可检查配置后重试');
  expect(stepWrite.sql).toContain("result=COALESCE(result,'{}'::jsonb)");
  expect(JSON.parse(String(stepWrite.values?.[2]))).toEqual(attemptSummary);
  expect(JSON.stringify(writes)).not.toContain('private provider response');
 }finally{if(priorCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=priorCodexHome;await rm(root,{recursive:true,force:true});}
});

test('registered SiliconFlow provider survives safe logging while unknown values remain hidden',()=>{
 const base={schema_version:1,event_id:'11111111-1111-4111-8111-111111111111',seq:1,occurred_at:'2026-10-23T00:00:00Z',written_at:'2026-10-23T00:00:00Z',service:'worker',instance_id:'22222222-2222-4222-8222-222222222222',pid:123,event:'attempt.failed'};
 const record=sanitizeLogRecord({...base,provider:'siliconflow',prompt:'PRIVATE'});
 expect(record?.provider).toBe('siliconflow');expect(record).not.toHaveProperty('prompt');
 expect(sanitizeLogRecord({...base,provider:'unregistered-private'})).not.toHaveProperty('provider');
});
test('persists bounded execution milestones while keeping progress and payloads out',async()=>{
 const root=await mkdtemp(join(tmpdir(),'milestone-logs-'));const logger=createStructuredLogger({root,service:'worker'});
 try{
  const milestones=['attempt.enqueued','attempt.claimed','attempt.input_validated','model_api.call.started','model_api.call.completed','attempt.completed'];
  for(const event of milestones)logger.log(event,{level:'info',attempt_id:'11111111-1111-4111-8111-111111111111',duration_ms:12,prompt:'PRIVATE',answer:'PRIVATE'});
  for(const event of ['worker.progress','token.received','file.write.started','transaction.started'])logger.log(event,{level:'info'});
  await logger.flush();const files=await readdir(join(root,'logs',new Date().toISOString().slice(0,10)));const records=(await readFile(join(root,'logs',new Date().toISOString().slice(0,10),files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.map(record=>record.event)).toEqual(milestones);expect(JSON.stringify(records)).not.toContain('PRIVATE');
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});
