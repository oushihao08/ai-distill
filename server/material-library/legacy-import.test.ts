/** 文件职责：验证旧提取结果导入的来源绑定、正文结构一致性和识别问题保留；不执行模型或真实业务写库。 */
import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {parseImportedDocument,activateLegacyImports} from './legacy-import';
import type {Pool} from 'pg';
const source='a'.repeat(64);
function file(value:unknown){const content=JSON.stringify(value);return{id:'m',original_name:'a.pdf',storage_path:'m.source',sha256:source,size_bytes:1,content_type:'application/pdf',redaction_mode:'model' as const,artifact_id:'artifact',artifact_sha256:createHash('sha256').update(content).digest('hex'),artifact_content:content};}
test('历史导入保留全部页序、空页和OCR issues，不虚构脱敏结果',()=>{
 const result=parseImportedDocument(file({source_sha256:source,pages:[{page:1,text:'',method:'ocr',issues:['image_without_text']},{page:2,text:'正文',method:'text'}]}));
 expect(result?.pages.length).toBe(2);expect(result?.pages[0].issues).toEqual(['image_without_text']);expect(result?.pages[1].text).toBe('正文');
});
test('拒绝旧原件摘要、内容摘要或页序不一致',()=>{
 expect(()=>parseImportedDocument(file({source_sha256:'b'.repeat(64),pages:[]}))).toThrow('原件');
 expect(()=>parseImportedDocument({...file({}),artifact_sha256:'0'.repeat(64)})).toThrow('摘要');
 expect(()=>parseImportedDocument(file({source_sha256:source,pages:[{page:3,text:'x',method:'text'}]}))).toThrow('页序');
});
test('结构正文不一致时不导入；没有成功提取产物时保持待识别',()=>{
 expect(()=>parseImportedDocument(file({source_sha256:source,pages:[{page:1,text:'正文',method:'text',structure:[{kind:'paragraph',text:'其他正文'}]}]}))).toThrow('不一致');
 expect(parseImportedDocument({...file({}),artifact_id:undefined})).toBe(null);
});
test('同原件历史导入沿用原期规范使用账和加载，不重复占用且保留版本映射',async()=>{
 const writes:{sql:string;values:any[]}[]=[];
 const use={id:'use',package_id:'canonical',owner_phase_id:'phase',status:'submitted'};
 const client={release(){},async query(sql:string,values:any[]=[]){
  writes.push({sql,values});
  if(sql.includes('FROM ai_distill.legacy_material_imports'))return{rows:[{id:'import',package_id:'imported',revision_id:'revision',source_workflow_id:'source',manifest:{material_signature:source},use_id:null}]};
  if(sql.includes('FROM ai_distill.project_material_uses u'))return{rows:[use]};
  if(sql.startsWith('SELECT id FROM ai_distill.library_packages'))return{rowCount:2,rows:[{id:'canonical'},{id:'imported'}]};
  if(sql.includes('SELECT * FROM ai_distill.projects'))return{rows:[{id:'phase',project_group_id:'group'}]};
  if(sql.includes('FROM ai_distill.project_library_packages'))return{rows:[{id:'link'}]};
  if(sql.startsWith('UPDATE ai_distill.legacy_material_imports'))return{rowCount:1,rows:[{id:'import'}]};
  return{rows:[],rowCount:0};
 }};
 const result=await activateLegacyImports({connect:async()=>client} as unknown as Pool,'phase','import');
 expect(result.use_id).toBe('use');expect(result.package_id).toBe('imported');expect(result.use_package_id).toBe('canonical');
 expect(writes.find(w=>w.sql.includes('FROM ai_distill.project_library_packages'))?.values).toEqual(['phase','canonical']);
 expect(writes.some(w=>w.sql.startsWith('INSERT INTO ai_distill.project_library_packages'))).toBe(false);
 expect(writes.some(w=>w.sql.startsWith('INSERT INTO ai_distill.project_material_uses'))).toBe(false);
 expect(writes.some(w=>w.sql.includes('project_material_use_events'))).toBe(true);
 expect(writes.some(w=>w.sql.includes('UPDATE ai_distill.workflows'))).toBe(false);
});
