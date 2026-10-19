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
