/** 验证 legacy 与 library_v1 题目材料来源、original/redacted 冻结快照及缺快照拒绝回退；使用假 PoolClient，不读取真实附件或数据库。 */
import {expect,test} from 'bun:test';
import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../shared/workflow-config';
import {readQuestionMaterials} from './question-materials';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const workflowId='11111111-1111-4111-8111-111111111111';
const markdown='案件脱敏文本';
const markdownSha=digest(markdown);
const index=JSON.stringify({format:'redacted-index-v2',redacted_sha256:markdownSha,materials:[]});
const indexSha=digest(index);
const manifest={version:2,origin:{kind:'library_v1',package_id:'p1',package_name:'标准材料',revision_id:'r1',redaction_id:'d1',source_digest:'a'.repeat(64)},files:[],redacted_markdown:{artifact_id:'markdown-1',sha256:markdownSha},redacted_index:{artifact_id:'index-1',sha256:indexSha}};

function mockDb(respond:(sql:string)=>unknown){
 const statements:string[]=[];
 const query=async(sql:string)=>{statements.push(sql);return respond(sql)??{rows:[],rowCount:0};};
 return{db:{query} as unknown as PoolClient,statements};
}
test('processing mode comes from the immutable question snapshot rather than current project settings',async()=>{
 for(const mode of ['mask','aliases','original'] as const){
  const snapshot={...manifest,origin:{...manifest.origin,material_processing_mode:mode}};
  const {db,statements}=mockDb(sql=>{
   if(sql.includes('FROM ai_distill.workflows w')&&sql.includes('JOIN ai_distill.projects'))return{rows:[{material_backend:'library_v1'}],rowCount:1};
   if(sql.includes('FROM ai_distill.question_library_sources'))return{rows:[{material_mode:'redacted',snapshot_manifest:snapshot,snapshot_digest:digest(canonicalJson(snapshot)),package_id:'p1',revision_id:'r1',redaction_id:'d1',source_digest:'a'.repeat(64),markdown_artifact_id:'markdown-1',index_artifact_id:'index-1'}],rowCount:1};
   if(sql.includes('FROM ai_distill.artifacts')&&sql.includes('ANY'))return{rows:[{id:'markdown-1',kind:'redacted_markdown',attempt_id:null,sha256:markdownSha,content:markdown},{id:'index-1',kind:'redacted_index',attempt_id:null,sha256:indexSha,content:index}],rowCount:2};
  });
  if(mode==='original')await expect(readQuestionMaterials(db,workflowId)).rejects.toThrow('正文来源不一致');
  else expect((await readQuestionMaterials(db,workflowId)).origin).toMatchObject({material_processing_mode:mode,material_mode:'redacted'});
  expect(statements.some(sql=>sql.includes('project_step_configs'))).toBe(false);
 }
});

test('reads library question snapshot without consulting legacy redaction steps',async()=>{
 const {db,statements}=mockDb(sql=>{
  if(sql.includes('FROM ai_distill.workflows w')&&sql.includes('JOIN ai_distill.projects'))return{rows:[{material_backend:'library_v1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.question_library_sources'))return{rows:[{snapshot_manifest:manifest,snapshot_digest:digest(canonicalJson(manifest)),package_id:'p1',revision_id:'r1',redaction_id:'d1',source_digest:'a'.repeat(64),markdown_artifact_id:'markdown-1',index_artifact_id:'index-1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.artifacts')&&sql.includes('ANY'))return{rows:[
   {id:'markdown-1',kind:'redacted_markdown',attempt_id:null,sha256:markdownSha,content:markdown},
   {id:'index-1',kind:'redacted_index',attempt_id:null,sha256:indexSha,content:index},
  ],rowCount:2};
  return undefined;
 });
 const result=await readQuestionMaterials(db,workflowId);
 expect(result.origin).toEqual({kind:'library_v1',material_mode:'redacted',package_id:'p1',revision_id:'r1',redaction_id:'d1',snapshot_digest:digest(canonicalJson(manifest))});
 expect(result.attachments).toEqual([{id:'markdown-1',sha256:markdownSha,content:markdown,source_names:[],attempt_id:null}]);
 expect(statements.some(sql=>sql.includes('ordinal=9'))).toBe(false);
});

test('reads a shared package snapshot in a legacy project without changing its project backend',async()=>{
 const {db,statements}=mockDb(sql=>{
  if(sql.includes('FROM ai_distill.workflows w')&&sql.includes('JOIN ai_distill.projects'))return{rows:[{material_backend:'legacy',has_library_snapshot:true}],rowCount:1};
  if(sql.includes('FROM ai_distill.question_library_sources'))return{rows:[{snapshot_manifest:manifest,snapshot_digest:digest(canonicalJson(manifest)),package_id:'p1',revision_id:'r1',redaction_id:'d1',source_digest:'a'.repeat(64),markdown_artifact_id:'markdown-1',index_artifact_id:'index-1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.artifacts')&&sql.includes('ANY'))return{rows:[
   {id:'markdown-1',kind:'redacted_markdown',attempt_id:null,sha256:markdownSha,content:markdown},
   {id:'index-1',kind:'redacted_index',attempt_id:null,sha256:indexSha,content:index},
  ],rowCount:2};
  return undefined;
 });
 const result=await readQuestionMaterials(db,workflowId);
 expect(result.origin.kind).toBe('library_v1');
 expect(result.attachments[0]?.content).toBe(markdown);
 expect(statements.some(sql=>sql.includes('ordinal=9'))).toBe(false);
});

test('reads and validates the frozen original extraction for a library question',async()=>{
 const originalText='原文借款材料';
 const sourceSha=digest('source-file-bytes');
 const document={version:1,source_sha256:sourceSha,pages:[{page:1,text:originalText,structure:[{id:'b1',kind:'paragraph',text:originalText}]}]};
 const documentSha=digest(originalText);
 const materialMarkdown=`# 材料.txt\n\n${originalText}`;
 const index=JSON.stringify({format:'source-index-v1',materials:[{material_id:'material-1',markdown:originalText,document}]});
 const markdownSha=digest(materialMarkdown),indexSha=digest(index);
 const originalManifest={version:2,origin:{kind:'library_v1',material_mode:'original',package_id:'p1',package_name:'标准材料',revision_id:'r1',redaction_id:null,source_digest:'b'.repeat(64)},files:[{material_id:'material-1',source_sha256:sourceSha,document_sha256:documentSha,original_name:'材料.txt'}],material_markdown:{artifact_id:'source-markdown-1',sha256:markdownSha,kind:'source_markdown'},material_index:{artifact_id:'source-index-1',sha256:indexSha,kind:'source_index'}};
 const {db,statements}=mockDb(sql=>{
  if(sql.includes('FROM ai_distill.workflows w')&&sql.includes('JOIN ai_distill.projects'))return{rows:[{material_backend:'library_v1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.question_library_sources'))return{rows:[{snapshot_manifest:originalManifest,snapshot_digest:digest(canonicalJson(originalManifest)),package_id:'p1',revision_id:'r1',redaction_id:null,material_mode:'original',source_digest:'b'.repeat(64),markdown_artifact_id:'source-markdown-1',index_artifact_id:'source-index-1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.artifacts')&&sql.includes('ANY'))return{rows:[
   {id:'source-markdown-1',kind:'source_markdown',attempt_id:null,sha256:markdownSha,content:materialMarkdown},
   {id:'source-index-1',kind:'source_index',attempt_id:null,sha256:indexSha,content:index},
  ],rowCount:2};
  return undefined;
 });
 const result=await readQuestionMaterials(db,workflowId);
 expect(result.origin).toEqual({kind:'library_v1',material_mode:'original',package_id:'p1',revision_id:'r1',redaction_id:null,snapshot_digest:digest(canonicalJson(originalManifest))});
 expect(result.attachments).toEqual([{id:'source-markdown-1',sha256:markdownSha,content:materialMarkdown,source_names:['材料.txt'],attempt_id:null}]);
 expect(statements.some(sql=>sql.includes('ordinal=9'))).toBe(false);
});

test('rejects a library question without a source snapshot instead of falling back to ordinal 9',async()=>{
 const {db,statements}=mockDb(sql=>{
  if(sql.includes('FROM ai_distill.workflows w')&&sql.includes('JOIN ai_distill.projects'))return{rows:[{material_backend:'library_v1'}],rowCount:1};
  if(sql.includes('FROM ai_distill.question_library_sources'))return{rows:[],rowCount:0};
  return undefined;
 });
 await expect(readQuestionMaterials(db,workflowId)).rejects.toThrow('来源快照');
 expect(statements.some(sql=>sql.includes('ordinal=9'))).toBe(false);
});

// 缓存用临时受管文件；数据库替身记录是否读取大字段，不访问业务数据库或模型。
async function snapshotCacheFixture(){
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'question-snapshot-'));
 await mkdir(join(root,workflowId));
 const metadata=[{id:'markdown-1',kind:'redacted_markdown',attempt_id:null,sha256:markdownSha,storage_path:`${workflowId}/markdown.md`,size_bytes:Buffer.byteLength(markdown)},
  {id:'index-1',kind:'redacted_index',attempt_id:null,sha256:indexSha,storage_path:`${workflowId}/index.json`,size_bytes:Buffer.byteLength(index)}];
 await writeFile(join(root,metadata[0].storage_path),markdown);await writeFile(join(root,metadata[1].storage_path),index);
 const contentReads:string[][]=[];
 const db={query:async(sql:string,values:any[])=>{
  if(sql.includes('FROM ai_distill.workflows w'))return{rows:[{material_backend:'library_v1'}]};
  if(sql.includes('FROM ai_distill.question_library_sources'))return{rows:[{snapshot_manifest:manifest,snapshot_digest:digest(canonicalJson(manifest)),package_id:'p1',revision_id:'r1',redaction_id:'d1',source_digest:'a'.repeat(64),markdown_artifact_id:'markdown-1',index_artifact_id:'index-1'}]};
  if(sql.startsWith('SELECT id,content FROM ai_distill.artifacts')){
   const ids=values[1] as string[];contentReads.push(ids);
   return{rows:ids.map(id=>({id,content:id==='markdown-1'?markdown:index}))};
  }
  if(sql.includes('FROM ai_distill.artifacts'))return{rows:metadata.map(x=>({...x}))};
  throw new Error('unexpected fixture query');
 }} as unknown as PoolClient;
 return{root,metadata,contentReads,db,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('verified local snapshots avoid all database content transfers',async()=>{
 const f=await snapshotCacheFixture();
 try{
  const result=await readQuestionMaterials(f.db,workflowId,f.root);
  expect(result.attachments).toEqual([{id:'markdown-1',sha256:markdownSha,content:markdown,source_names:[],attempt_id:null}]);
  expect(f.contentReads).toEqual([]);
 }finally{await f.cleanup();}
});

test('a missing local index fetches only that artifact from the database',async()=>{
 const f=await snapshotCacheFixture();const {unlink}=await import('node:fs/promises');const {join}=await import('node:path');
 try{
  await unlink(join(f.root,f.metadata[1].storage_path));
  expect((await readQuestionMaterials(f.db,workflowId,f.root)).attachments[0].content).toBe(markdown);
  expect(f.contentReads).toEqual([['index-1']]);
 }finally{await f.cleanup();}
});

test('same-size local corruption falls back without weakening SHA verification',async()=>{
 const f=await snapshotCacheFixture();const {writeFile}=await import('node:fs/promises');const {join}=await import('node:path');
 try{
  await writeFile(join(f.root,f.metadata[1].storage_path),index.replace('redacted-index-v2','redacted-index-v3'));
  expect((await readQuestionMaterials(f.db,workflowId,f.root)).attachments[0].content).toBe(markdown);
  expect(f.contentReads).toEqual([['index-1']]);
 }finally{await f.cleanup();}
});

test('a metadata SHA that disagrees with the frozen manifest cannot use a valid local copy',async()=>{
 const f=await snapshotCacheFixture();
 try{
  f.metadata[1].sha256='f'.repeat(64);
  await expect(readQuestionMaterials(f.db,workflowId,f.root)).rejects.toThrow('来源快照不匹配');
  expect(f.contentReads).toEqual([]);
 }finally{await f.cleanup();}
});

test('paths outside the workflow directory are never accepted as a snapshot cache',async()=>{
 const f=await snapshotCacheFixture();const {writeFile}=await import('node:fs/promises');const {join}=await import('node:path');
 try{
  await writeFile(join(f.root,'outside.json'),index);f.metadata[1].storage_path='outside.json';
  expect((await readQuestionMaterials(f.db,workflowId,f.root)).attachments[0].content).toBe(markdown);
  expect(f.contentReads).toEqual([['index-1']]);
 }finally{await f.cleanup();}
});

test('both missing snapshots retain database fallback and reject corrupt database text',async()=>{
 const f=await snapshotCacheFixture();const {rm}=await import('node:fs/promises');const {join}=await import('node:path');
 try{
  await rm(join(f.root,workflowId),{recursive:true});
  expect((await readQuestionMaterials(f.db,workflowId,f.root)).attachments[0].content).toBe(markdown);
  expect(f.contentReads).toEqual([['markdown-1','index-1']]);
  const query=f.db.query.bind(f.db);
  const broken={query:async(sql:string,values:any[])=>sql.startsWith('SELECT id,content FROM ai_distill.artifacts')?{rows:[{id:'markdown-1',content:'wrong'},{id:'index-1',content:index}]}:query(sql,values)} as unknown as PoolClient;
  await expect(readQuestionMaterials(broken,workflowId,f.root)).rejects.toThrow('来源快照不匹配');
 }finally{await f.cleanup();}
});

test('a snapshot symlink outside its workflow also falls back to database content',async()=>{
 const f=await snapshotCacheFixture();const {writeFile,unlink,symlink}=await import('node:fs/promises');const {join}=await import('node:path');
 try{
  const outside=join(f.root,'outside.json');await writeFile(outside,index);
  const path=join(f.root,f.metadata[1].storage_path);await unlink(path);await symlink(outside,path);
  expect((await readQuestionMaterials(f.db,workflowId,f.root)).attachments[0].content).toBe(markdown);
  expect(f.contentReads).toEqual([['index-1']]);
 }finally{await f.cleanup();}
});
