/** 验证库提取检查点、降级继续和停止；临时文件/假提取器/SQL替身，不连接业务库或外部模型，不代替PostgreSQL事务验收。 */
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executeExtraction,runClaimedJob,runNextLibraryJob} from './runner';
import {ensurePages,hash,jobDirectory} from './execution-shared';
import {readExtractionCheckpoint,writeExtractionCheckpoint} from './extraction-checkpoint';
import {currentTaskSignal} from '../task-signal';

const file={file_id:crypto.randomUUID(),source_sha256:hash('%PDF-fake'),format:'pdf'};
const doc=ensurePages([{page:1,text:'正文',method:'text',structure:[{id:'b1',kind:'paragraph',text:'正文'}],issues:['image_without_text']}],file.source_sha256);
function job(){return{id:crypto.randomUUID(),package_id:crypto.randomUUID(),revision_id:crypto.randomUUID(),config_digest:'config-v1',input_snapshot:{manifest_sha256:'manifest',files:[file]},lease_token:'lease',deadline_at:new Date(Date.now()+60000).toISOString(),config_snapshot:{pdf_provider:'mineru-api'},kind:'extract'};}

test('checkpoint resumes by stable file identity and content integrity without config or engine gates',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-checkpoint-')),first=job();
 try{
  expect(await writeExtractionCheckpoint(root,first,file,doc)).toBe(true);
  const retry={...first,id:crypto.randomUUID(),previous_job_id:first.id,input_snapshot:{...first.input_snapshot,request_digest:'new-request'}};
  expect((await readExtractionCheckpoint(root,retry,file))?.document).toEqual(doc);
  expect((await stat(join(jobDirectory(root,first.id),'extraction',file.file_id+'.json'))).mode&0o777).toBe(0o600);
  expect((await readExtractionCheckpoint(root,{...retry,config_digest:'changed-redaction-and-budget'},file))?.document).toEqual(doc);
  for(const changed of [{config_snapshot:{pdf_provider:'mineru-cli'}},{revision_id:crypto.randomUUID()},{input_snapshot:{...retry.input_snapshot,manifest_sha256:'new'}}])expect((await readExtractionCheckpoint(root,{...retry,...changed},file))?.document).toEqual(doc);
  expect(await readExtractionCheckpoint(root,retry,{...file,source_sha256:'changed'})).toBeUndefined();
  await writeFile(join(jobDirectory(root,first.id),'extraction',file.file_id+'.json'),'broken');
  expect(await readExtractionCheckpoint(root,retry,file)).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('legacy checkpoints ignore obsolete config identity but retain document and source integrity checks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'legacy-checkpoint-')),first=job();
 try{
  await writeExtractionCheckpoint(root,first,file,doc,'mineru-api');
  const path=join(jobDirectory(root,first.id),'extraction',file.file_id+'.json');
  await writeFile(path,JSON.stringify({identity:'legacy',sha256:hash(doc),document:doc,provider:'mineru-api'}));
  const retry={...first,id:crypto.randomUUID(),previous_job_id:first.id};
  expect((await readExtractionCheckpoint(root,retry,file))?.document).toEqual(doc);
  expect((await readExtractionCheckpoint(root,{...retry,config_digest:'changed'},file))?.document).toEqual(doc);
  await writeFile(path,JSON.stringify({identity:'another-old-engine',sha256:hash(doc),document:doc,provider:'mineru-api'}));
  expect((await readExtractionCheckpoint(root,retry,file))?.document).toEqual(doc);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('unsafe paths and unwritable checkpoint storage degrade without publishing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-unsafe-')),outside=await mkdtemp(join(tmpdir(),'library-outside-')),first=job();
 try{
  await symlink(outside,join(root,'material-library'));
  expect(await writeExtractionCheckpoint(root,first,file,doc)).toBe(false);
  expect(await readExtractionCheckpoint(root,{...first,previous_job_id:first.id},file)).toBeUndefined();
  expect(await writeExtractionCheckpoint(root,first,{...file,file_id:'../../escape'},doc)).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

function fakePool(){
 const published:unknown[][]=[];let commits=0;
 const query=async(sql:string,values:any[]=[])=>{
  if(sql.startsWith('SELECT id,revision_id'))return{rows:[{id:'job'}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.library_blobs'))return{rows:[{id:crypto.randomUUID()}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.library_documents'))published.push(values);
  if(sql==='COMMIT')commits++;
  return{rows:[{id:'job'}],rowCount:1};
 };
 return{pool:{query,connect:async()=>({query,release(){}})} as any,published,commits:()=>commits};
}

test('three-file retry calls completed provider once and publishes full package only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-recovery-')),first=job(),db=fakePool(),calls=[0,0,0];let fail=true;
 try{
  const files=await Promise.all([0,1,2].map(async i=>{
   const bytes=Buffer.from(`%PDF-fake-${i}`),storage_path=`source-${i}.pdf`;await writeFile(join(root,storage_path),bytes);
   return{file_id:crypto.randomUUID(),format:'pdf',source_sha256:hash(bytes),size_bytes:bytes.length,storage_path,original_name:`source-${i}.pdf`};
  }));
  const original={...first,input_snapshot:{manifest_sha256:'manifest',files}};
  const extractor={async extract(path:string){const index=files.findIndex(x=>path.includes(x.file_id));calls[index]++;if(index===1&&fail)throw new Error('injected provider failure');return{format:'pdf' as const,provider:'mineru-api' as const,sha256:files[index].source_sha256,pages:doc.pages};}};
  await expect(executeExtraction(db.pool,root,original,new AbortController().signal,extractor)).rejects.toThrow('injected');
  expect(db.published).toHaveLength(0);expect(db.commits()).toBe(0);
  fail=false;
  await executeExtraction(db.pool,root,{...original,id:crypto.randomUUID(),previous_job_id:original.id},new AbortController().signal,extractor);
  expect(calls).toEqual([1,2,1]);expect(db.published).toHaveLength(3);expect(db.commits()).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('checkpoint write failure does not block an otherwise valid extraction',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-degrade-')),first=job(),db=fakePool();
 try{
  const bytes=Buffer.from('正文'),storage_path='input.txt';await writeFile(join(root,storage_path),bytes);await writeFile(join(root,'material-library'),'not-a-directory');
  await executeExtraction(db.pool,root,{...first,input_snapshot:{files:[{...file,format:'txt',source_sha256:hash(bytes),size_bytes:bytes.length,storage_path,original_name:'input.txt'}]}},new AbortController().signal);
  expect(db.published).toHaveLength(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('claimed job interrupted before execution records worker stop, never calls extraction',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-stop-')),first=job(),controller=new AbortController();let saved:any[]=[];
 const pool={query:async(sql:string,values:any[])=>{saved=values;return{rowCount:1,rows:[{id:first.id}]};}} as any;
 try{controller.abort();await runClaimedJob(pool,root,first,controller.signal);expect(saved[2]).toBe('cancelled');expect(JSON.parse(saved[5]).reason_code).toBe('worker_shutdown');}
 finally{await rm(root,{recursive:true,force:true});}
});

test('expired task is failed with deadline reason, not labelled user cancellation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-deadline-')),first={...job(),deadline_at:new Date(Date.now()-1).toISOString()};let saved:any[]=[];
 const pool={query:async(sql:string,values:any[])=>{saved=values;return{rowCount:1,rows:[{id:first.id}]};}} as any;
 try{await runClaimedJob(pool,root,first,new AbortController().signal);expect(saved[2]).toBe('failed');expect(saved[3]).toBe('deadline_exceeded');}
 finally{await rm(root,{recursive:true,force:true});}
});

test('already-stopped consumer never queries or claims another job',async()=>{
 const c=new AbortController();c.abort();
 expect(await runNextLibraryJob({query(){throw new Error('must not query');}} as any,'unused','api','local',c.signal)).toBe(false);
});

test('stop racing with claim commit settles that lease without running the provider',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-claim-stop-')),c=new AbortController(),first=job();let settled=false;
 const client={query:async(sql:string)=>{
  if(sql.startsWith('SELECT j.*'))return{rows:[first],rowCount:1};
  if(sql.includes('RETURNING *'))return{rows:[first],rowCount:1};
  if(sql==='COMMIT')c.abort();
  return{rows:[],rowCount:0};
 },release(){}};
 const pool={connect:async()=>client,query:async(sql:string,values:any[]=[])=>{
  if(sql.includes('to_regclass'))return{rows:[{available:true}]};
  if(values[2]==='cancelled'){settled=true;expect(JSON.parse(values[5]).reason_code).toBe('worker_shutdown');}
  return{rows:[{id:first.id}],rowCount:1};
 }} as any;
 try{expect(await runNextLibraryJob(pool,root,'api','local',c.signal)).toBe(true);expect(settled).toBe(true);}
 finally{await rm(root,{recursive:true,force:true});}
});

for(const reason of ['user_cancelled','lease_lost','deadline_exceeded','heartbeat_unavailable'])test(`heartbeat stop preserves ${reason} instead of generic cancellation`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-heartbeat-')),bytes=Buffer.from('正文'),first=job();let saved:any[]=[];
 const item={...file,format:'txt',source_sha256:hash(bytes),size_bytes:bytes.length,storage_path:'input.txt',original_name:'input.txt'};
 const query=async(sql:string,values:any[]=[])=>{
  if(sql.startsWith('SELECT f.id'))return new Promise(resolve=>{currentTaskSignal()!.addEventListener('abort',()=>resolve({rows:[{id:item.file_id,sha256:item.source_sha256,size_bytes:bytes.length,storage_path:item.storage_path}]}),{once:true});});
  if(sql.startsWith('UPDATE ai_distill.library_jobs SET heartbeat')){if(reason==='heartbeat_unavailable')throw new Error('injected DB failure');return{rows:[],rowCount:0};}
  if(sql.startsWith('SELECT status,'))return{rows:[{status:'running',lease_token:reason==='lease_lost'?'other':first.lease_token,cancel_requested_at:reason==='user_cancelled'?new Date():null,lease_expires_at:new Date(Date.now()+60000),deadline_at:new Date(Date.now()+(reason==='deadline_exceeded'?-1:60000))}]};
  saved=values;return{rows:[{id:first.id}],rowCount:1};
 };
 try{
  await writeFile(join(root,item.storage_path),bytes);
  await runClaimedJob({query} as any,root,{...first,lease_expires_at:new Date(Date.now()+25).toISOString(),kind:'intake',input_snapshot:{files:[item]}},new AbortController().signal,2);
  expect(saved[2]).toBe(reason==='user_cancelled'?'cancelled':'failed');expect(saved[3]).toBe(reason);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a late heartbeat response cannot query or stop a job after its completion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-late-heartbeat-')),bytes=Buffer.from('正文'),first=job();let releaseHeartbeat:((value:any)=>void)|undefined,stateReads=0;
 const item={...file,format:'txt',source_sha256:hash(bytes),size_bytes:bytes.length,storage_path:'input.txt',original_name:'input.txt'};
 const query=async(sql:string,values:any[]=[])=>{
  if(sql.startsWith('SELECT f.id')){await Bun.sleep(10);return{rows:[{id:item.file_id,sha256:item.source_sha256,size_bytes:bytes.length,storage_path:item.storage_path}]};}
  if(sql.startsWith('UPDATE ai_distill.library_jobs SET heartbeat')&&!values[3])return new Promise(resolve=>{releaseHeartbeat=resolve;});
  if(sql.startsWith('SELECT status,'))stateReads++;
  return{rows:[{id:first.id}],rowCount:1};
 };
 const pool={query,connect:async()=>({query,release(){}})} as any;
 try{
  await writeFile(join(root,item.storage_path),bytes);
  await runClaimedJob(pool,root,{...first,kind:'intake',input_snapshot:{files:[item]}},new AbortController().signal,2);
  expect(releaseHeartbeat).toBeDefined();releaseHeartbeat!({rows:[],rowCount:0});await Bun.sleep(1);
  expect(stateReads).toBe(0);
 }finally{releaseHeartbeat?.({rows:[],rowCount:0});await rm(root,{recursive:true,force:true});}
});

test('known library failure survives settlement outage and resumes only original lease settlement',async()=>{
 const {LocalQueue}=await import('../execution-queue/store');
 const {withLocalExecution}=await import('../execution-queue/runtime');
 const root=await mkdtemp(join(tmpdir(),'library-failure-settlement-')),q=new LocalQueue(root),first={...job(),deadline_at:new Date(Date.now()-1).toISOString()};
 q.intent(first.id,'library','api','library:extract');q.confirm(first.id);const local=q.claim('api')!;
 let writes=0,claims=0;const params:any[][]=[];
 const pool={query:async(sql:string,values:any[]=[])=>{
  if(sql.includes('to_regclass'))claims++;
  if(sql.startsWith('UPDATE ai_distill.library_jobs SET status=CASE')){writes++;params.push(values);if(writes===1)throw Object.assign(new Error('settlement unavailable'),{code:'ECONNRESET'});return{rows:[{id:first.id}],rowCount:1};}
  throw new Error('must not read inputs or run a provider');
 }} as any;
 try{
  await expect(withLocalExecution(q,local,()=>runClaimedJob(pool,root,first,new AbortController().signal))).rejects.toThrow('settlement unavailable');
  expect(q.libraryFailure(local)?.code).toBe('deadline_exceeded');
  await withLocalExecution(q,local,()=>runNextLibraryJob(pool,root,'api','local',new AbortController().signal,first.id));
  expect(writes).toBe(2);expect(claims).toBe(0);expect(params[1]!.slice(0,5)).toEqual(params[0]!.slice(0,5));
  expect(JSON.parse(params[1]![5]).reason_code).toBe(JSON.parse(params[0]![5]).reason_code);
  expect(params[1]![1]).toBe(first.lease_token);expect(params[1]![2]).toBe('failed');
 }finally{q.close();await rm(root,{recursive:true,force:true});}
});

 test('transient heartbeat failure recovers within confirmed lease without cancelling work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-heartbeat-recover-')),bytes=Buffer.from('正文'),first=job();let beats=0,committed=false;
 const item={...file,format:'txt',source_sha256:hash(bytes),size_bytes:bytes.length,storage_path:'input.txt',original_name:'input.txt'};
 const query=async(sql:string,values:any[]=[])=>{
  if(sql.startsWith('SELECT f.id')){await Bun.sleep(35);expect(currentTaskSignal()?.aborted).toBe(false);return{rows:[{id:item.file_id,sha256:item.source_sha256,size_bytes:bytes.length,storage_path:item.storage_path}]};}
  if(sql.startsWith('UPDATE ai_distill.library_jobs SET heartbeat')){beats++;if(beats===1)throw new Error('temporary DB failure');return{rows:[{id:first.id}],rowCount:1};}
  if(sql.startsWith('SELECT id,revision_id'))return{rows:[{id:first.id,revision_id:first.revision_id}],rowCount:1};
  if(sql.startsWith("UPDATE ai_distill.library_jobs SET status='succeeded'"))committed=true;
  return{rows:[{id:first.id}],rowCount:1};
 };
 try{await writeFile(join(root,item.storage_path),bytes);await runClaimedJob({query,connect:async()=>({query,release(){}})} as any,root,{...first,lease_expires_at:new Date(Date.now()+25).toISOString(),kind:'intake',input_snapshot:{files:[item]}},new AbortController().signal,2);expect(beats).toBeGreaterThan(1);expect(committed).toBe(true);}
 finally{await rm(root,{recursive:true,force:true});}
});
