/** 验证Codex模板导入事务、模板冻结/幂等和结构保存；使用临时设置库及替身SQL，不写业务数据库。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importPreparedLibraryMaterials} from './prepared-import';
import {saveLibraryProcessingSettings} from './settings';
import {resolveLibraryTemplate} from './templates';
import {canonicalJson} from '../../shared/workflow-config';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const rid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',file='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',ext='cccccccc-cccc-4ccc-8ccc-cccccccccccc',key='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const settings=()=>({version:1,extraction:{protocol:'v1',provider_config:{}},redaction:{provider:'codex',model:'existing',reasoning_effort:'medium',prompt:'原提示词'},execution:{task_timeout_ms:1000,request_timeout_ms:1000},policy:{preserve_dates:true,preserve_amounts:true}});
test('缺失计划结构或伪空模板身份在连接数据库前拒绝',async()=>{
 const pool={connect:async()=>{throw new Error('不得连接数据库');}} as any;
 const base={format:'codex-material-export-v1',revision_id:rid,extraction_job_id:ext,files:[{file_id:file,text_sha256:'a'.repeat(64)}],edits:[],documents:[{id:'d',title:'测试',segments:[]}]};
 for(const plan of [{...base,documents:undefined},{...base,template_id:'',template_digest:'a'.repeat(64)},{...base,template_digest:'a'.repeat(64)},{...base,files:[null]}]){
  try{await importPreparedLibraryMaterials(pool,rid,{request_key:key,plan});throw new Error('应拒绝');}
  catch(error){expect((error as {status:number}).status).toBe(400);}
 }
});
test('同版模板导入保留结构，配置变更后原请求仍幂等，新请求过期模板拒绝',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-template-'));const s=settings();saveLibraryProcessingSettings(root,0,s);
 const template=resolveLibraryTemplate(s,'aliases'),text='姓名\t张三',structure=[{id:'t',kind:'table',rows:[{cells:[{text:'姓名'},{text:'张三',columnSpan:2}]}]}];
 const doc=JSON.stringify({version:1,source_sha256:'source',pages:[{page:1,text,structure,issues:[]}]});
 const plan={format:'codex-material-export-v1',template_id:template.id,template_digest:template.digest,revision_id:rid,extraction_job_id:ext,files:[{file_id:file,text_sha256:sha(text)}],edits:[{file_id:file,page:1,start:3,end:5,source_text:'张三',replacement_text:'人员甲'}],documents:[{id:'d',title:'确认书',segments:[{file_id:file,page:1,start:0,end:6}]}]};
 let prior:any,frozen:any,index:any,inserts=0;
 const query=async(sql:string,values:any[]=[])=>{
  if(sql.startsWith('SELECT package_id'))return{rows:[{package_id:'package'}]};
  if(sql.startsWith('SELECT id,deleted_at'))return{rows:[{id:'package'}]};
  if(sql.startsWith('SELECT state,file_count'))return{rows:[{state:'ready',file_count:1}]};
  if(sql.startsWith('SELECT j.id,j.input_digest'))return{rows:prior?[prior]:[]};
  if(sql.startsWith('SELECT id FROM ai_distill.library_jobs WHERE id='))return{rows:[{id:ext}]};
  if(sql.startsWith('SELECT d.file_id'))return{rows:[{file_id:file,source_sha256:'source',text_sha256:sha(text),sha256:sha(doc),text_content:doc}]};
  if(sql.startsWith('INSERT INTO ai_distill.library_blobs')){if(values[3].includes('redacted-index'))index=JSON.parse(values[4]);return{rows:[{id:values[0]}]};}
  if(sql.startsWith('INSERT INTO ai_distill.library_jobs')){inserts++;frozen=JSON.parse(values[7]);prior={id:values[0],input_digest:values[4],redaction_id:'result'};}
  return{rows:[],rowCount:0};
 };
 const pool={connect:async()=>({query,release(){}})} as any;
 try{
  await importPreparedLibraryMaterials(pool,rid,{request_key:key,plan},root);
  expect(frozen.redaction_template.digest).toBe(template.digest);expect(index.preparation_layout).toBe('preserved-structure');
  expect(index.prepared_documents[0].document.pages[0].blocks[0].rows[0].cells[1]).toEqual({text:'人员甲',columnSpan:2});
  const changed={...s,redaction_templates:[{id:'aliases',name:template.name,workflow:'codex_plan',redaction:{provider:'codex',prompt:'新版规则'}}]};saveLibraryProcessingSettings(root,1,changed);
  expect((await importPreparedLibraryMaterials(pool,rid,{request_key:key,plan},root)).reused).toBe(true);expect(inserts).toBe(1);
  prior=undefined;await expect(importPreparedLibraryMaterials(pool,rid,{request_key:key,plan},root)).rejects.toThrow('摘要不匹配');expect(inserts).toBe(1);
  // 旧计划来自同一份带表格结构的提取结果；改名后不能再沿用编辑前结构。
  const legacyPlan:any={...plan};delete legacyPlan.template_id;delete legacyPlan.template_digest;
  const legacy=await importPreparedLibraryMaterials(pool,rid,{request_key:key,plan:legacyPlan},root);
  expect(legacy).toMatchObject({structure_mode:'extracted-page-text'});expect(inserts).toBe(2);
  expect(index.materials[0].document.pages[0].blocks).toEqual([{id:'prepared-1',kind:'paragraph',text:'姓名\t人员甲'}]);
  expect(index.preparation_layout).toBe('extracted-page-text');
 }finally{await rm(root,{recursive:true,force:true});}
});
