/** 验证材料库任务参数、消费 lane、租约领取、取消和终态写入边界。 */
import {test,expect} from 'bun:test';
import {assertLibraryExtractionUsable,validateLibraryJobRequest,chooseLibraryExecutor,hasLibraryQueueWork,claimLibraryJob,enqueueLibraryJob,failLibraryJob,finishLibraryJob} from './jobs';
import {withTaskSignal} from '../task-signal';

test('worker stop during publication rolls back without COMMIT or a successful terminal update',async()=>{
 const c=new AbortController(),queries:string[]=[];
 const client={query:async(sql:string)=>{queries.push(sql);return{rows:[{id:'job'}],rowCount:1};},release(){}};
 const pool={connect:async()=>client} as any;
 await expect(withTaskSignal(c.signal,()=>finishLibraryJob(pool,'job','lease',{},async()=>{c.abort(new Error('worker-stop'));}))).rejects.toThrow('worker-stop');
 expect(queries).toContain('ROLLBACK');expect(queries).not.toContain('COMMIT');expect(queries.some(x=>x.includes("status='succeeded'"))).toBe(false);
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

test('new extraction task freezes provider selection before worker execution',async()=>{
 const previous=process.env.PDF_EXTRACTION_PROVIDER;let frozen:any;
 const query=async(sql:string,values:any[]=[])=>{
  if(sql.startsWith('SELECT id,processing_settings'))return{rows:[{id:'package',processing_settings:{redaction:{provider:'api'},extraction:{protocol:'v1'},execution:{task_timeout_ms:1200000}},deleted_at:null}]};
  if(sql.startsWith('SELECT id,package_id,state'))return{rows:[{id:'revision',package_id:'package',state:'ready',manifest_sha256:'hash',file_count:1}]};
  if(sql.startsWith('SELECT f.id'))return{rows:[{id:'file',original_name:'synthetic.txt',storage_target:'local',position:1,sha256:'hash',size_bytes:1}]};
  if(sql.startsWith('INSERT INTO ai_distill.library_jobs')){frozen=JSON.parse(values[9]);return{rows:[{id:'new-job'}]};}
  return{rows:[],rowCount:0};
 };
 try{process.env.PDF_EXTRACTION_PROVIDER='mineru-cli';await enqueueLibraryJob({connect:async()=>({query,release(){}})} as any,'package','revision',{kind:'extract',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local'});process.env.PDF_EXTRACTION_PROVIDER='mineru-api';expect(frozen.pdf_provider).toBe('mineru-cli');}
 finally{if(previous===undefined)delete process.env.PDF_EXTRACTION_PROVIDER;else process.env.PDF_EXTRACTION_PROVIDER=previous;}
});

test('requires an explicit successful extraction reference for redaction requests',()=>{
 expect(validateLibraryJobRequest({kind:'redact',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',extraction_job_id:'123e4567-e89b-42d3-a456-426614174001'}).kind).toBe('redact');
 expect(()=>validateLibraryJobRequest({kind:'redact',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local'})).toThrow();
 expect(()=>validateLibraryJobRequest({kind:'intake',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',extraction_job_id:'123e4567-e89b-42d3-a456-426614174001'})).toThrow();
});

test('selects existing provider lanes from frozen files and settings',()=>{
 expect(chooseLibraryExecutor('intake',[],null)).toBe('internal');
 expect(chooseLibraryExecutor('extract',[{format:'txt'}],null)).toBe('internal');
 expect(chooseLibraryExecutor('extract',[{format:'pdf'}],null)).toBe('api');
 expect(chooseLibraryExecutor('redact',[{format:'docx',redaction_mode:'declared_redacted'}],{provider:'api'})).toBe('internal');
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
