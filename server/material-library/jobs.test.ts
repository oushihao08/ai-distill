/** 验证材料库任务参数、消费 lane、租约领取、取消和终态写入边界。 */
import {test,expect} from 'bun:test';
import {assertLibraryExtractionUsable,validateLibraryJobRequest,chooseLibraryExecutor,hasLibraryQueueWork,claimLibraryJob,enqueueLibraryJob,failLibraryJob,finishLibraryJob,validateAtomicPublicationConstraints,libraryExternalExtractionTimeoutMs} from './jobs';
import {withTaskSignal} from '../task-signal';

test('worker stop during publication rolls back without COMMIT or a successful terminal update',async()=>{
 const c=new AbortController(),queries:string[]=[];
 const client={query:async(sql:string)=>{queries.push(sql);return{rows:[{id:'job'}],rowCount:1};},release(){}};
 const pool={connect:async()=>client} as any;
 await expect(withTaskSignal(c.signal,()=>finishLibraryJob(pool,'job','lease',{},async()=>{c.abort(new Error('worker-stop'));}))).rejects.toThrow('worker-stop');
 expect(queries).toContain('ROLLBACK');expect(queries).not.toContain('COMMIT');expect(queries.some(x=>x.includes("status='succeeded'"))).toBe(false);
});

test('atomic publication settles deferred constraints one by one and exposes the failing boundary',async()=>{
 const queries:string[]=[];
 const db={query:async(sql:string)=>{queries.push(sql);if(sql.includes('library_job_success_complete'))throw new Error('synthetic constraint failure');return{rows:[]};}} as any;
 await expect(validateAtomicPublicationConstraints(db)).rejects.toMatchObject({reason_code:'atomic_job_success_incomplete'});
 expect(queries).toEqual([
  'SET CONSTRAINTS ai_distill.library_job_success_complete IMMEDIATE',
 ]);
});

test('redaction retains OCR warnings without treating them as redaction content loss',()=>{
 const documents=[{page_count:1,issues:[{page:1,kind:'image_without_text'}],pages:[{text:'借款本金10000元，2023年1月1日。'}]}];
 const before=JSON.stringify(documents);
 expect(()=>assertLibraryExtractionUsable(documents)).not.toThrow();
 expect(JSON.stringify(documents)).toBe(before);
 expect(()=>assertLibraryExtractionUsable([{page_count:1,issues:null}])).toThrow('提取结果');
});

test('redaction preflight rejects empty files but permits blank pages alongside body text',()=>{
 expect(()=>assertLibraryExtractionUsable([])).toThrow('提取结果');
 expect(()=>assertLibraryExtractionUsable([{page_count:0,issues:[]}])).toThrow('提取结果');
 expect(()=>assertLibraryExtractionUsable([{issues:[],pages:[{text:'  '}]}])).toThrow('提取结果');
 expect(()=>assertLibraryExtractionUsable([{page_count:2,issues:[{page:2,kind:'empty_page'}],pages:[{text:'借款本金10000元'},{text:' '}]}])).not.toThrow();
});

test('complete issue-free extraction is eligible and retains the original documents',()=>{
 const documents=[{page_count:1,issues:[],pages:[{text:'完整测试正文'}]}];
 expect(()=>assertLibraryExtractionUsable(documents)).not.toThrow();
 expect(documents).toEqual([{page_count:1,issues:[],pages:[{text:'完整测试正文'}]}]);
});

test('new extraction rejects GLM OCR before accessing the database',async()=>{
 expect(()=>validateLibraryJobRequest({kind:'extract',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',pdf_provider:'glm-ocr'})).toThrow('MinerU');
 let connected=false;
 await expect(enqueueLibraryJob({connect:async()=>{connected=true;throw new Error('must not connect');}} as any,'package','revision',{kind:'extract',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',pdf_provider:'glm-ocr'})).rejects.toThrow('MinerU');
 expect(connected).toBe(false);
});

test('external extraction budget scales per file while retaining the thirty-minute single-file limit',async()=>{
 const previousQueue=process.env.EXECUTION_QUEUE_MODE,updates:any[]=[];
 let job={id:'job',kind:'extract',input_snapshot:{files:[{original_name:'case.pdf'}]},config_snapshot:{settings:{execution:{task_timeout_ms:6000000}}}};
 const client={query:async(sql:string,values:any[]=[])=>{
  if(sql.startsWith('SELECT j.*,p.name'))return{rows:[job]};
  if(sql.startsWith('UPDATE ai_distill.library_jobs SET status=\'running\'')){updates.push(values);return{rows:[{id:'job'}],rowCount:1};}
  return{rows:[],rowCount:0};
 },release(){}};
 try{process.env.EXECUTION_QUEUE_MODE='legacy';await claimLibraryJob({query:async()=>({rows:[{available:true}] }),connect:async()=>client} as any,'api','server');expect(updates[0]?.[2]).toBe(1800000);
  job={...job,input_snapshot:{files:[{original_name:'a.pdf'},{original_name:'b.docx'},{original_name:'c.png'}]},config_snapshot:{settings:{execution:{task_timeout_ms:6000000}}}};updates.length=0;
  await claimLibraryJob({query:async()=>({rows:[{available:true}] }),connect:async()=>client} as any,'api','server');expect(updates[0]?.[2]).toBe(5400000);
  expect(libraryExternalExtractionTimeoutMs(100)).toBe(24*60*60*1000);
 }
 finally{if(previousQueue===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previousQueue;}
});

test('requires an explicit successful extraction reference for redaction requests',()=>{
 expect(validateLibraryJobRequest({kind:'redact',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',extraction_job_id:'123e4567-e89b-42d3-a456-426614174001'}).kind).toBe('redact');
 expect(()=>validateLibraryJobRequest({kind:'redact',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local'})).toThrow();
 expect(()=>validateLibraryJobRequest({kind:'intake',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',extraction_job_id:'123e4567-e89b-42d3-a456-426614174001'})).toThrow();
 expect(()=>validateLibraryJobRequest({kind:'extract',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',pdf_provider:'glm-ocr'})).toThrow();
 expect(()=>validateLibraryJobRequest({kind:'redact',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',extraction_job_id:'123e4567-e89b-42d3-a456-426614174001',pdf_provider:'glm-ocr'})).toThrow();
 expect(()=>validateLibraryJobRequest({kind:'extract',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',pdf_provider:'unknown'})).toThrow();
});

test('selects existing provider lanes from frozen files and settings',()=>{
 expect(chooseLibraryExecutor('intake',[],null)).toBe('internal');
 expect(chooseLibraryExecutor('extract',[{format:'txt'}],null)).toBe('internal');
 expect(chooseLibraryExecutor('extract',[{format:'pdf'}],null)).toBe('api');
 expect(chooseLibraryExecutor('redact',[{format:'docx',redaction_mode:'declared_redacted'}],{provider:'api'})).toBe('api');
 expect(chooseLibraryExecutor('redact',[{format:'docx',redaction_mode:'model'}],{provider:'api'})).toBe('api');
 expect(chooseLibraryExecutor('redact',[{format:'docx',redaction_mode:'model'}],{provider:'codex'})).toBe('agent');
 expect(()=>chooseLibraryExecutor('redact',[{format:'docx',redaction_mode:'model'}],{provider:'codex'},'server')).toThrow();
});

test('detects queued and lease-expired work only in the requested executor lane',async()=>{
 const calls:{text:string;values:unknown[]}[]=[];
 const pool={query:async(text:string,values:unknown[])=>{calls.push({text,values});return{text,rows:[{available:true,pending:true}]};}} as any;

 expect(await hasLibraryQueueWork(pool,'api','server')).toBe(true);
 expect(calls[1]?.values).toEqual(['api','server']);
 expect(calls[1]?.text).toContain("status='queued'");
 expect(calls[1]?.text).toContain('lease_expires_at<now()');
});

test('skips library job claims when the optional queue schema is absent',async()=>{
 const pool={
  query:async()=>({rows:[{available:false}]}),
  connect:async()=>{throw new Error('must not open a transaction without the library schema');},
 } as any;
 expect(await claimLibraryJob(pool,'agent','local')).toBeNull();
});

test('running cancellation is persisted as cancelled rather than failed',async()=>{
 let saved:{sql:string;values:unknown[]}|undefined;
 const pool={query:async(sql:string,values:unknown[])=>{saved={sql,values};return{rowCount:1,rows:[{id:'job'}]};}} as any;
 expect(await failLibraryJob(pool,'job','lease','cancelled','材料任务已取消','cancelled')).toBe(true);
 expect(saved?.sql).toContain("status=CASE WHEN $3='cancelled' OR cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END");
 expect(saved?.sql).toContain("error_code=CASE WHEN $3='cancelled' OR cancel_requested_at IS NOT NULL THEN NULL ELSE $4 END");
 expect(saved?.values.slice(0,5)).toEqual(['job','lease','cancelled','cancelled','材料任务已取消']);
 expect(JSON.parse(saved!.values[5] as string).reason_code).toBe('cancelled');
 expect(saved?.sql).toContain("COALESCE(result_summary,'{}'::jsonb)");
});

test('expired leases become failed attempts and are never put back into running or queued state',async()=>{
 const statements:string[]=[];
 const client={query:async(sql:string)=>{statements.push(sql);return{rowCount:0,rows:[]};},release(){}};
 const pool={query:async()=>({rows:[{available:true}]}),connect:async()=>client} as any;
 expect(await claimLibraryJob(pool,'api','local')).toBeNull();
 const expire=statements.find(sql=>sql.includes("SET status='failed'")&&sql.includes("lease_expires_at<now()"));
 expect(expire).toBeDefined();expect(expire).toContain('lease_token=NULL');
 expect(statements.some(sql=>sql.includes("SET status='queued'")&&sql.includes("status='running'"))).toBe(false);
 expect(statements.at(-1)).toBe('COMMIT');
});

test('late completion after cancel or lease loss cannot publish output',async()=>{
 const statements:string[]=[];let published=false;
 const client={query:async(sql:string)=>{statements.push(sql);return{rowCount:0,rows:[]};},release(){}};
 const pool={connect:async()=>client} as any;
 await expect(finishLibraryJob(pool,'job','old-lease',{},async()=>{published=true;})).rejects.toThrow('已取消、失租或超过执行期限');
 expect(published).toBe(false);
 expect(statements.find(sql=>sql.startsWith('SELECT id,revision_id'))).toContain('cancel_requested_at IS NULL');
 expect(statements.find(sql=>sql.startsWith('SELECT id,revision_id'))).toContain('lease_expires_at>now()');
 expect(statements.at(-1)).toBe('ROLLBACK');
});

test('library status read overlays local review without changing business status or retrying',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {localQueue,withLocalQueueRoot}=await import('../execution-queue/runtime');const {readLibraryJob}=await import('./jobs');
 const root=await mkdtemp(join(tmpdir(),'library-status-')),previous=process.env.EXECUTION_QUEUE_MODE;process.env.EXECUTION_QUEUE_MODE='local';
 const q=localQueue(root),id=crypto.randomUUID();q.intent(id,'library','agent','library:redact');q.confirm(id);const claimed=q.claim('agent')!;q.finish(id,claimed.lease!,'needs_review');
 const row={id,status:'running',finished_at:null};let owner:any={job_id:id,executor_id:q.executorId,generation:0};const sqls:string[]=[];
 const pool={query:async(sql:string)=>{sqls.push(sql);return{rows:sql.includes('execution_dispatches')?[owner]:[row]};}} as any;
 try{
  const read=()=>withLocalQueueRoot(root,()=>readLibraryJob(pool,id));
  expect(await read()).toMatchObject({status:'running',finished_at:null,execution:{state:'needs_review',active:false}});
  owner={...owner,generation:1};expect((await read()).execution.state).toBe('generation_mismatch');
  owner={job_id:id,executor_id:crypto.randomUUID(),generation:0};expect((await read()).execution.scope).toBe('other_executor');
  row.status='succeeded';expect(await read()).not.toHaveProperty('execution');expect(sqls.every(sql=>sql.startsWith('SELECT'))).toBe(true);expect(q.get(id)?.state).toBe('needs_review');
 }finally{if(previous===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previous;q.close();await rm(root,{recursive:true,force:true});}
});

test('library history projects a whole active group in one SELECT and skips terminal-only groups',async()=>{
 const {projectLibraryJobExecutions}=await import('./jobs'),previous=process.env.EXECUTION_QUEUE_MODE;
 const {withLocalQueueRoot}=await import('../execution-queue/runtime');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'library-history-'));let count=0;
 const pool={query:async()=>{count++;return{rows:[]};}} as any;
 try{process.env.EXECUTION_QUEUE_MODE='local';await withLocalQueueRoot(root,async()=>{
  const jobs=[{id:crypto.randomUUID(),status:'running'},{id:crypto.randomUUID(),status:'queued'},{id:crypto.randomUUID(),status:'succeeded'}];
  const rows=await projectLibraryJobExecutions(pool,jobs);expect(count).toBe(1);expect(rows.map(row=>(row as any).execution?.scope)).toEqual(['unowned','unowned',undefined]);
  await projectLibraryJobExecutions(pool,[jobs[2]!]);expect(count).toBe(1);
 });}finally{if(previous===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previous;await rm(root,{recursive:true,force:true});}
});

test.each(['redact','prepare'])('%s claim uses the frozen one-hour budget without a second ceiling',async kind=>{
 const previous=process.env.EXECUTION_QUEUE_MODE;let timeout=0;
 const client={query:async(sql:string,v:any[]=[])=>{
  if(sql.startsWith('SELECT j.*,p.name'))return{rows:[{id:'job',kind,config_snapshot:{redaction_template:{workflow:'codex_plan'},settings:{execution:{task_timeout_ms:3600000}}}}]};
  if(sql.startsWith("UPDATE ai_distill.library_jobs SET status='running'")){timeout=v[2];return{rows:[{id:'job'}],rowCount:1};}
  return{rows:[],rowCount:0};
 },release(){}};
 try{process.env.EXECUTION_QUEUE_MODE='legacy';await claimLibraryJob({query:async()=>({rows:[{available:true}]}),connect:async()=>client} as any,'agent','local');expect(timeout).toBe(3600000);}
 finally{if(previous===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previous;}
});

test('Agent enqueue freezes the saved execution budget without reducing it to ten minutes',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {saveLibraryProcessingSettings}=await import('./settings');const root=await mkdtemp(join(tmpdir(),'library-budget-'));
 const previous=process.env.EXECUTION_QUEUE_MODE;let frozen:any;
 const settings={version:1,extraction:{protocol:'v1',provider_config:{}},redaction:{provider:'codex',model:'gpt-6-luna',reasoning_effort:'high',prompt:'合成模板'},execution:{task_timeout_ms:1200000,request_timeout_ms:1000},policy:{preserve_dates:true,preserve_amounts:true}};
 const query=async(sql:string,v:any[]=[])=>{
  if(sql.startsWith('SELECT id,processing_settings'))return{rows:[{id:'package'}]};
  if(sql.startsWith('SELECT id,package_id,state'))return{rows:[{id:'revision',package_id:'package',state:'ready',manifest_sha256:'hash',file_count:1}]};
  if(sql.startsWith('SELECT f.id'))return{rows:[{id:'file',original_name:'synthetic.txt',storage_target:'local',position:1,sha256:'hash',size_bytes:1}]};
  if(sql.startsWith('SELECT id,status,input_digest'))return{rows:[{id:'extraction',status:'succeeded'}]};
  if(sql.startsWith('SELECT d.id AS document_id'))return{rows:[{document_id:'doc',file_id:'file',source_sha256:'hash',document_sha256:'doc-hash',text_sha256:'text-hash',page_count:1,issues:[]}]};
  if(sql.startsWith('INSERT INTO ai_distill.library_jobs')){frozen=JSON.parse(v[9]);return{rows:[{id:'job'}]};}
  return{rows:[],rowCount:0};
 };
 try{process.env.EXECUTION_QUEUE_MODE='legacy';saveLibraryProcessingSettings(root,0,settings);
  await enqueueLibraryJob({connect:async()=>({query,release(){}})} as any,'package','revision',{kind:'redact',extraction_job_id:'11111111-1111-4111-8111-111111111111',request_key:'22222222-2222-4222-8222-222222222222',execution_target:'local',agent_settings:{model:'gpt-6-luna',reasoning_effort:'high'}},root);
  expect(frozen.settings.execution.task_timeout_ms).toBe(1200000);
 }finally{if(previous===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previous;await rm(root,{recursive:true,force:true});}
});

test('API enqueue freezes explicit model and uses API lane without consulting Agent defaults',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {saveLibraryProcessingSettings}=await import('./settings');const root=await mkdtemp(join(tmpdir(),'library-budget-'));
 const previous=process.env.EXECUTION_QUEUE_MODE;let frozen:any,lane:unknown;
 const settings={version:1,extraction:{protocol:'v1',provider_config:{}},redaction:{provider:'codex',model:'gpt-6-luna',reasoning_effort:'high',prompt:'合成模板'},execution:{task_timeout_ms:1200000,request_timeout_ms:1000},policy:{preserve_dates:true,preserve_amounts:true}};
 const query=async(sql:string,v:any[]=[])=>{
  if(sql.startsWith('SELECT id,processing_settings'))return{rows:[{id:'package'}]};
  if(sql.startsWith('SELECT id,package_id,state'))return{rows:[{id:'revision',package_id:'package',state:'ready',manifest_sha256:'hash',file_count:1}]};
  if(sql.startsWith('SELECT f.id'))return{rows:[{id:'file',original_name:'synthetic.txt',storage_target:'local',position:1,sha256:'hash',size_bytes:1}]};
  if(sql.startsWith('SELECT id,status,input_digest'))return{rows:[{id:'extraction',status:'succeeded'}]};
  if(sql.startsWith('SELECT d.id AS document_id'))return{rows:[{document_id:'doc',file_id:'file',source_sha256:'hash',document_sha256:'doc-hash',text_sha256:'text-hash',page_count:1,issues:[]}]};
  if(sql.startsWith('INSERT INTO ai_distill.library_jobs')){frozen=JSON.parse(v[9]);lane=v[10];return{rows:[{id:'job'}]};}
  return{rows:[],rowCount:0};
 };
 try{process.env.EXECUTION_QUEUE_MODE='legacy';saveLibraryProcessingSettings(root,0,settings);
  await enqueueLibraryJob({connect:async()=>({query,release(){}})} as any,'package','revision',{kind:'redact',extraction_job_id:'11111111-1111-4111-8111-111111111111',request_key:'22222222-2222-4222-8222-222222222222',execution_target:'local',api_settings:{provider:'siliconflow',base_url:'https://api.siliconflow.com/v1',model:'deepseek-ai/DeepSeek-V4.1-Flash'}},root);
  expect(frozen.settings.execution.task_timeout_ms).toBe(1200000);expect(lane).toBe('api');expect(frozen.settings.redaction.provider).toBe('api');expect(frozen.settings.redaction.api.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');expect(frozen.redaction_template.workflow).toBe('codex_plan');
 }finally{if(previous===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previous;await rm(root,{recursive:true,force:true});}
});
