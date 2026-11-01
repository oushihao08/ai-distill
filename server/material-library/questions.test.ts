/**
 * 职责：验证独立材料建题请求的字段、标签和可重放摘要边界。
 * 主要边界：忽略预期版本对幂等语义的影响，但题目内容、材料关系或脱敏结果变化必须产生不同摘要。
 */
import {expect,test} from 'bun:test';
import {libraryQuestionReplay,libraryQuestionRequestDigest,libraryQuestionStepOrdinals,remapLibraryRedactedIndex,validateLibraryQuestionInput} from './questions';

const request={request_key:'11111111-1111-4111-8111-111111111111',redaction_id:'22222222-2222-4222-8222-222222222222',expected_link_version:3,title:'执行异议审查',scenario:'执行程序',role_perspective:'申请执行人代理律师',target_level:'L4' as const,question_tags:['执行']};

test('validates library question fields and project-owned tags',()=>{
 expect(validateLibraryQuestionInput(request,['执行','财产保全'])).toMatchObject({title:'执行异议审查',question_tags:['执行']});
 expect(()=>validateLibraryQuestionInput({...request,question_tags:['不属于本项目']},['执行'])).toThrow('当前项目');
 expect(()=>validateLibraryQuestionInput({...request,expected_link_version:0},['执行'])).toThrow('版本');
 expect(()=>validateLibraryQuestionInput({...request,request_key:'bad'},['执行'])).toThrow('幂等');
});

test('request digest binds question content, package link and redaction but not expected lock version',()=>{
 const input=validateLibraryQuestionInput(request,['执行']);
 const first=libraryQuestionRequestDigest({project_id:'p1',project_material_id:'link-a',input});
 expect(libraryQuestionRequestDigest({project_id:'p1',project_material_id:'link-a',input:{...input,expected_link_version:9}})).toBe(first);
 expect(libraryQuestionRequestDigest({project_id:'p2',project_material_id:'link-a',input})).not.toBe(first);
 expect(libraryQuestionRequestDigest({project_id:'p1',project_material_id:'link-b',input})).not.toBe(first);
 expect(libraryQuestionRequestDigest({project_id:'p1',project_material_id:'link-a',input:{...input,title:'不同题目'}})).not.toBe(first);
});

test('idempotent replay returns the same source identity as initial creation',()=>{
 const input=validateLibraryQuestionInput(request,['执行']);
 const requestDigest=libraryQuestionRequestDigest({project_id:'p1',project_material_id:'link-a',input});
 const row={workflow_id:'workflow-a',request_digest:requestDigest,source_digest:'a'.repeat(64),snapshot_digest:'b'.repeat(64)};
 expect(libraryQuestionReplay(row,requestDigest)).toEqual({id:'workflow-a',reused:true,source_digest:'a'.repeat(64),snapshot_digest:'b'.repeat(64)});
 expect(()=>libraryQuestionReplay(row,'c'.repeat(64))).toThrow('不同请求内容');
});

test('library questions create only visible workflow ordinals 4 through 8',()=>{
 expect(libraryQuestionStepOrdinals()).toEqual([4,5,6,7,8]);
});

test('private redaction index remaps every file reference without changing source text',()=>{
 const source={material_mode:'redacted' as const,index:JSON.stringify({format:'redacted-index-v2',pages:[{material_id:'file-a',page:1}],materials:[{material_id:'file-a',markdown:'脱敏正文',document:{format:'redacted-structure-v1'},structure_sha256:'a'.repeat(64)}],redacted_sha256:'b'.repeat(64)})};
 const result=JSON.parse(remapLibraryRedactedIndex(source,new Map([['file-a','private-material']]))) as {pages:{material_id:string}[];materials:{material_id:string;markdown:string}[]};
 expect(result.pages[0]?.material_id).toBe('private-material');
 expect(result.materials[0]).toMatchObject({material_id:'private-material',markdown:'脱敏正文'});
 expect(()=>remapLibraryRedactedIndex(source,new Map())).toThrow('不存在的附件');
});
test('Agent document segment references freeze to private question material ids',()=>{
 const source={material_mode:'redacted' as const,index:JSON.stringify({format:'redacted-index-v2',materials:[{material_id:'file-a',markdown:'正文'}],pages:[{material_id:'file-a',page:1}],prepared_documents:[{id:'doc',title:'申请书',text:'正文',segments:[{file_id:'file-a',page:1,start:0,end:2}]}]})};
 const index=JSON.parse(remapLibraryRedactedIndex(source,new Map([['file-a','private-material']])));
 expect(index.prepared_documents[0].segments[0].file_id).toBe('private-material');expect(index.prepared_documents[0].text).toBe('正文');
});

test('creates a private question from a usable redaction while retaining OCR warnings',async()=>{
 const {createLibraryQuestion}=await import('./questions');
 const {installLibraryBlob}=await import('./storage');
 const {createHash}=await import('node:crypto');
 const {mkdtemp,rm,readFile}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'library-question-warning-'));
 const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
 try{
  const blob=await installLibraryBlob(root,new TextEncoder().encode('原始案件材料'),'text/plain','local');
  const issues=[{page:1,kind:'image_without_text'}],text='借款10000元，2023年1月1日。';
  const document=JSON.stringify({version:1,source_sha256:blob.sha256,pages:[{page:1,text,structure:[{id:'b1',kind:'paragraph',text}],method:'ocr',issues:['image_without_text']}]});
  const index=JSON.stringify({format:'redacted-index-v2',redacted_sha256:sha(text),pages:[{material_id:'file-a',page:1}],materials:[{material_id:'file-a',markdown:text,document:{format:'redacted-structure-v1',pages:[]}}]});
  const file={id:'file-a',original_name:'材料.txt',position:1,redaction_mode:'model',source_sha256:blob.sha256,source_size_bytes:blob.size_bytes,source_content_type:'text/plain',source_storage_path:blob.storage_path,source_storage_target:'local',document_content:document,document_blob_sha256:sha(document),document_sha256:sha(text),document_issues:issues};
  const inserts:{sql:string;values:any[]}[]=[];
  const query=async(sql:string,values:any[]=[])=>{
   if(sql.startsWith('SELECT package_id FROM'))return{rows:[{package_id:'package-a'}]};
   if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:[{config:{material_processing_mode:'aliases'}}]};
   if(sql.startsWith('SELECT question_tags'))return{rows:[{question_tags:['执行']}]};
   if(sql.startsWith('SELECT id,name,deleted_at FROM'))return{rows:[{id:'package-a',name:'共享材料',deleted_at:null}]};
   if(sql.startsWith('SELECT id,name,material_backend'))return{rows:[{id:'project-a',name:'验证项目',material_backend:'legacy',question_tags:['执行'],deleted_at:null}]};
   if(sql.includes('FROM ai_distill.project_library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:'link-a',package_id:'package-a',project_id:'project-a',selected_revision_id:'revision-a',selected_redaction_id:request.redaction_id,lock_version:3,removed_at:null}]};
   if(sql.startsWith('SELECT r.id,r.package_id'))return{rows:[{id:request.redaction_id,revision_id:'revision-a',extraction_job_id:'extract-a',output_digest:'source-digest',validation_report:{usable_for_question:true,extraction_issue_count:1,redaction_template_workflow:'codex_plan'},revision_state:'ready',redact_status:'succeeded',extract_status:'succeeded',markdown:text,markdown_sha256:sha(text),redacted_index:index,index_sha256:sha(index)}]};
   if(sql.startsWith('SELECT f.id,f.original_name'))return{rows:[file]};
   if(sql.startsWith('SELECT file_count'))return{rows:[{file_count:1}]};
   if(sql.startsWith('INSERT'))inserts.push({sql,values});
   return{rows:[],rowCount:1};
  };
  const pool={query,connect:async()=>({query,release(){}})} as any;
  const result=await createLibraryQuestion(pool,root,'project-a','link-a',request);
  expect(result.reused).toBe(false);
  const frozen=inserts.find(item=>item.sql.includes("'private_extracted_pages'"));
  expect(JSON.parse(frozen!.values[6]).pages[0].issues).toEqual(['image_without_text']);
  // 脱敏题目按当前契约省略原件副本（original_copy=omitted），只冻结脱敏正文与提取结构。
  expect(inserts.some(item=>item.sql.includes("'source_document'"))).toBe(false);
  expect(inserts.filter(item=>item.sql.includes('INSERT INTO ai_distill.steps')).map(item=>item.values[1])).toEqual([4,5,6,7,8]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('creates a private question from extracted original without requiring redaction',async()=>{
 const {createLibraryQuestion}=await import('./questions');
 const {installLibraryBlob}=await import('./storage');
 const {createHash}=await import('node:crypto');
 const {mkdtemp,rm,readFile}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'library-question-original-'));
 const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
 try{
  const blob=await installLibraryBlob(root,new TextEncoder().encode('原始案件材料'),'text/plain','local');
  const text='借款10000元，2023年1月1日。';
  const document=JSON.stringify({version:1,source_sha256:blob.sha256,pages:[{page:1,text,structure:[{id:'b1',kind:'paragraph',text}],method:'mineru',issues:[]}]});
  const file={id:'file-a',original_name:'材料.txt',position:1,redaction_mode:'model',source_sha256:blob.sha256,source_size_bytes:blob.size_bytes,source_content_type:'text/plain',source_storage_path:blob.storage_path,source_storage_target:'local',document_content:document,document_blob_sha256:sha(document),document_sha256:sha(text),document_issues:[]};
  const inserts:{sql:string;values:any[]}[]=[];
  const query=async(sql:string,values:any[]=[])=>{
   if(sql.startsWith('SELECT package_id FROM'))return{rows:[{package_id:'package-a'}]};
   if(sql.startsWith('SELECT question_tags'))return{rows:[{question_tags:['执行']}]};
   if(sql.startsWith('SELECT id,name,deleted_at FROM'))return{rows:[{id:'package-a',name:'共享材料',deleted_at:null}]};
   if(sql.startsWith('SELECT id,name,material_backend'))return{rows:[{id:'project-a',name:'验证项目',material_backend:'legacy',question_tags:['执行'],deleted_at:null}]};
   if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:[{config:{material_source_mode:'original'}}]};
   if(sql.includes('FROM ai_distill.project_library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:'link-a',package_id:'package-a',project_id:'project-a',selected_revision_id:'44444444-4444-4444-8444-444444444444',selected_redaction_id:null,lock_version:3,removed_at:null}]};
   if(sql.startsWith('SELECT e.id,r.file_count'))return{rows:[{id:'extract-a',file_count:1}]};
   if(sql.startsWith('SELECT f.id,f.original_name'))return{rows:[file]};
   if(sql.startsWith('INSERT'))inserts.push({sql,values});
   return{rows:[],rowCount:1};
  };
  const pool={query,connect:async()=>({query,release(){}})} as any;
  const result=await createLibraryQuestion(pool,root,'project-a','link-a',{...request,request_key:'33333333-3333-4333-8333-333333333333',redaction_id:undefined,revision_id:'44444444-4444-4444-8444-444444444444'});
  expect(result.reused).toBe(false);
  // 原文题目保留原件副本，供原文模式归档与交付。
  expect(inserts.some(item=>item.sql.includes("'source_document'"))).toBe(true);
  expect(inserts.some(item=>item.values[2]==='source_markdown')).toBe(true);
  expect(inserts.some(item=>item.values[2]==='source_index')).toBe(true);
  expect(inserts.some(item=>item.values[2]==='redacted_markdown')).toBe(false);
  expect(inserts.some(item=>item.sql.includes('INSERT INTO ai_distill.question_library_sources')&&item.values[13]==='original')).toBe(true);
  expect(inserts.filter(item=>item.sql.includes('INSERT INTO ai_distill.steps')).map(item=>item.values[1])).toEqual([4,5,6,7,8]);
 }finally{await rm(root,{recursive:true,force:true});}
});


test('一包一道只由Work项目规则限定，不推广到其他主项目',async()=>{
 const {singleQuestionPerPackage}=await import('./questions');
 expect(singleQuestionPerPackage({parent_name:'Work法律全场景',name:'第一期'})).toBe(true);
 expect(singleQuestionPerPackage({name:'Work法律全场景 - 第一期'})).toBe(true);
 expect(singleQuestionPerPackage({parent_name:'豆包高经济价值',name:'Work法律全场景'})).toBe(false);
 expect(singleQuestionPerPackage({name:'其他项目'})).toBe(false);
});
