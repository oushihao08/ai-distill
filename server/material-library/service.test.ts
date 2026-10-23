/**
 * 文件职责：验证全局材料包、版本列表、使用摘要和共用处理设置的数据服务。
 * 主要边界：使用内存夹具断言查询投影、过滤和输入校验，不连接数据库实例。
 */
import {test,expect} from 'bun:test';
import {validateLibraryPackageInput,buildLibraryManifest,readLibraryPackage,readLibraryPackageUsage,readLibraryPackages,readLibraryRevisions,restoreLibraryPackage,validateProcessingSettings} from './service';

test('package detail returns revision rows instead of driver result metadata',async()=>{
 const pool={query:async(sql:string)=>sql.startsWith('SELECT p.id')?{rows:[{id:'package'}],rowCount:1}:{rows:[{id:'revision',files:[]}],rowCount:1,fields:[{name:'private-driver-metadata'}]}} as any;
 expect(await readLibraryPackage(pool,'package')).toEqual({id:'package',revisions:[{id:'revision',files:[]}]});
});

test('library package filters do not leave untyped gaps for the optional usage phase',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const pool={query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return{rows:[],rowCount:0};}} as any;
 await readLibraryPackages(pool);
 expect(calls[0]?.values).toHaveLength(8);
 expect(calls[0]?.sql).toContain("$8::text='any'");
 expect(calls[0]?.sql).not.toContain('$9');
 await readLibraryPackages(pool,{usage_project_id:'11111111-1111-4111-8111-111111111111'});
 expect(calls[1]?.values).toHaveLength(9);
 expect(calls[1]?.sql).toContain('requested_phase.id=$8::uuid');
 expect(calls[1]?.sql).toContain("$9::text='any'");
});

test('validates package metadata and preserves stable unique tags',()=>{
 expect(validateLibraryPackageInput({name:' 民事案件 ',description:'说明',tags:['合同','执行']})).toEqual({name:'民事案件',description:'说明',tags:['合同','执行']});
 expect(()=>validateLibraryPackageInput({name:' ',description:'',tags:[]})).toThrow();
 expect(()=>validateLibraryPackageInput({name:'有效',description:'',tags:['重复','重复']})).toThrow();
});

test('library manifest digest binds order, filename, redaction mode and source bytes',()=>{
 const files=[{original_name:'附件1.pdf',position:1,sha256:'a'.repeat(64),size_bytes:10,redaction_mode:'model' as const}];
 const first=buildLibraryManifest(files);
 expect(buildLibraryManifest(files).sha256).toBe(first.sha256);
 expect(buildLibraryManifest([...files,{...files[0]!,original_name:'附件2.pdf',position:2}]).sha256).not.toBe(first.sha256);
 expect(buildLibraryManifest([{...files[0]!,redaction_mode:'declared_redacted'}]).sha256).not.toBe(first.sha256);
});

test('processing settings preserve amounts and dates and reject embedded credentials',()=>{
 const settings={version:1,extraction:{provider_config:{protocol:'local'},protocol:'extract-v1'},redaction:{provider:'api',api:null,prompt:'保持币种金额和日期'},execution:{task_timeout_ms:1200000,request_timeout_ms:180000},policy:{preserve_amounts:true,preserve_dates:true}};
 expect(validateProcessingSettings(settings)).toEqual(settings);
 expect(()=>validateProcessingSettings({...settings,policy:{preserve_amounts:false,preserve_dates:true}})).toThrow();
 expect(()=>validateProcessingSettings({...settings,redaction:{...settings.redaction,api:{provider:'deepseek',model:'x',api_key:'secret'}}})).toThrow();
});

test('restores a soft-archived package with an optimistic version check',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const query=async(sql:string,values:unknown[]=[]):Promise<any>=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT lock_version'))return{rows:[{lock_version:4}],rowCount:1};
  if(sql.startsWith('UPDATE ai_distill.library_packages'))return{rows:[{id:'package',deleted_at:null,lock_version:5}],rowCount:1};
  return{rows:[],rowCount:0};
 };
 const pool={connect:async()=>({query,release(){}})} as any;
 expect(await restoreLibraryPackage(pool,'package',4)).toEqual({id:'package',deleted_at:null,lock_version:5});
 expect(calls.some(call=>call.sql==='COMMIT')).toBe(true);
});

test('package usage exposes every linked project and archived or withdrawn question event',async()=>{
 const calls:string[]=[];
 const pool={query:async(sql:string)=>{calls.push(sql);if(sql.startsWith('SELECT id FROM ai_distill.library_packages'))return{rows:[{id:'package'}],rowCount:1};if(sql.includes('project_library_packages'))return{rows:[{project_id:'project-a'}],rowCount:1};return{rows:[{workflow_id:'question-a',event_type:'withdrawn',current_publication_event:'withdrawn'}],rowCount:1};}} as any;
 const result=await readLibraryPackageUsage(pool,'package');
 expect(result.loaded_projects).toHaveLength(1);
 expect(result.publication_events).toMatchObject([{workflow_id:'question-a',event_type:'withdrawn',current_publication_event:'withdrawn'}]);
 expect(calls.some(sql=>sql.includes("provenance->'material_origin'->>'package_id'"))).toBe(true);
 expect(calls.some(sql=>sql.includes('LEFT JOIN LATERAL')&&sql.includes("ELSE 'superseded'")&&sql.includes("->>'revision_id'=e.provenance")&&sql.includes("->>'redaction_id'=e.provenance"))).toBe(true);
 expect(calls.some(sql=>sql.includes('LEFT JOIN ai_distill.workflows w')&&sql.includes('workflow_exists')&&sql.includes("THEN 'workflow_deleted'"))).toBe(true);
});

test('package usage marks a prior source superseded when the latest archive uses another package or version',async()=>{
 const pool={query:async(sql:string)=>sql.startsWith('SELECT id FROM ai_distill.library_packages')?{rows:[{id:'package-a'}],rowCount:1}:sql.includes('project_library_packages')?{rows:[],rowCount:0}:{rows:[{workflow_id:'question-a',event_type:'archived',current_publication_event:'superseded'}],rowCount:1}} as any;
 const result=await readLibraryPackageUsage(pool,'package-a');
 expect(result.publication_events).toMatchObject([{event_type:'archived',current_publication_event:'superseded'}]);
});

test('revision detail exposes usable redaction ids so projects can select the exact frozen standard-material set',async()=>{
 const calls:string[]=[];
 const pool={query:async(sql:string)=>{calls.push(sql);return sql.startsWith('SELECT id FROM ai_distill.library_packages')?{rows:[{id:'package'}],rowCount:1}:{rows:[{id:'revision-a',redactions:[{id:'redaction-a',usable_for_question:'true'}]}],rowCount:1};}} as any;
 const revisions=await readLibraryRevisions(pool,'package');
 expect(revisions).toMatchObject([{id:'revision-a',redactions:[{id:'redaction-a',usable_for_question:'true'}]}]);
 expect(calls[1]).toContain('AS redactions');
});

test('同原文字节可在TXT和MD之间复用，其他类型冲突不放宽且不改旧对象',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {createLibraryRevision}=await import('./service');
 const root=await mkdtemp(join(tmpdir(),'library-text-mime-'));let storedType='text/markdown',path='',writes:string[]=[];
 const db={query:async(sql:string,values:any[]=[])=>{
  writes.push(sql);
  if(sql.startsWith('SELECT current_revision_id'))return{rows:[{lock_version:1}]};
  if(sql.startsWith('INSERT INTO ai_distill.library_blobs')){path=values[5];return{rows:[]};}
  if(sql.startsWith('SELECT id,size_bytes,content_type'))return{rows:[{id:'blob',size_bytes:Buffer.byteLength('测试正文'),content_type:storedType,storage_path:path}]};
  if(sql.startsWith('UPDATE ai_distill.library_packages'))return{rows:[{lock_version:2}],rowCount:1};
  return{rows:[],rowCount:0};
 },release(){}};const pool={connect:async()=>db} as any;
 try{
  for(const [name,mime] of [['测试.txt','text/markdown'],['测试.md','text/plain']]){
   storedType=mime!;
   expect((await createLibraryRevision(pool,root,'package',1,crypto.randomUUID(),[{original_name:name!,bytes:Buffer.from('测试正文')}])).reused).toBe(false);
  }
  storedType='application/pdf';
  await expect(createLibraryRevision(pool,root,'package',1,crypto.randomUUID(),[{original_name:'测试.txt',bytes:Buffer.from('测试正文')}])).rejects.toThrow('类型或摘要');
  expect(writes.some(sql=>sql.startsWith('UPDATE ai_distill.library_blobs'))).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('revision upload repairs a stale blob path only after the exact object is installed',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {createLibraryRevision}=await import('./service');
 const root=await mkdtemp(join(tmpdir(),'library-blob-path-repair-')),writes:string[]=[];
 const db={query:async(sql:string,values:any[]=[])=>{
  writes.push(sql);
  if(sql==='BEGIN'||sql==='COMMIT')return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT current_revision_id'))return{rows:[{current_revision_id:'parent',lock_version:2,deleted_at:null}],rowCount:1};
  if(sql.startsWith('SELECT id,request_digest'))return{rows:[],rowCount:0};
  if(sql.startsWith('INSERT INTO ai_distill.library_revisions'))return{rows:[],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.library_blobs'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT id,size_bytes,content_type,storage_path'))return{rows:[{id:'blob',size_bytes:Buffer.byteLength('%PDF-恢复原文'),content_type:'application/pdf',storage_path:'legacy/blob/location'}],rowCount:1};
  if(sql.startsWith('UPDATE ai_distill.library_blobs SET storage_path'))return{rows:[{id:'blob'}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.library_files'))return{rows:[],rowCount:1};
  if(sql.startsWith('UPDATE ai_distill.library_packages'))return{rows:[{lock_version:3}],rowCount:1};
  return{rows:[],rowCount:0};
 },release(){}};const pool={connect:async()=>db} as any;
 try{
  const result=await createLibraryRevision(pool,root,'package',2,crypto.randomUUID(),[{original_name:'恢复.pdf',bytes:Buffer.from('%PDF-恢复原文')}]);
  expect(result.reused).toBe(false);
  expect(writes.some(sql=>sql.startsWith('UPDATE ai_distill.library_blobs SET storage_path'))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
