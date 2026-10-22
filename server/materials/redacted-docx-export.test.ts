/**
 * 职责：验证可选 DOCX 导出的完成门槛、当前脱敏绑定和工作流状态隔离。
 * 主要验证：导出只写独立 artifact 与附件库归档；未完成/过期输入不导出。
 * 使用场景：由 Bun test 定向运行，不连接真实数据库或模型服务。
 */
import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import type {Pool} from 'pg';
import {STEP_REGISTRY} from '@shared/step-registry';
import {redactionInputDigest} from './redaction-jobs';
import {exportRedactedDocx,isLibraryDocxPath} from './redacted-docx-export';

const workflowId='11111111-1111-4111-8111-111111111111',attemptId='22222222-2222-4222-8222-222222222222',materialId='33333333-3333-4333-8333-333333333333';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

async function fixture(options:{incomplete?:boolean;active?:boolean;stale?:boolean;sourceKey?:string;parentName?:string;phaseName?:string;failInsert?:boolean;reversedSources?:boolean;invalidIndex?:boolean;structured?:boolean;invalidStructure?:boolean}={}){
 const root=`${tmpdir()}/redacted-docx-${crypto.randomUUID()}`,materialRoot=join(root,'project','questions'),storageRoot=join(root,'managed'),projectExportsRoot=join(root,'assets','out'),calls:{sql:string;values?:unknown[]}[]=[];roots.push(root);
 const original=Buffer.from('original attachment');await mkdir(join(storageRoot,'sources'),{recursive:true});await writeFile(join(storageRoot,'sources','source.pdf'),original);
 const sources=[{material_id:materialId,source_sha256:hash(original),artifact_id:'44444444-4444-4444-8444-444444444444',artifact_sha256:'extraction-hash'}],markdown='【附件 1】\n\n【原附件第 1 页】\n脱敏文本';
 if(options.reversedSources)sources.push({...sources[0]!,material_id:'55555555-5555-4555-8555-555555555555',artifact_id:'66666666-6666-4666-8666-666666666666'});
 const inputMaterials=options.stale?[{...sources[0],source_sha256:'old-hash'}]:options.reversedSources?[...sources].reverse():sources;
 const manifestArtifacts:{id:string;attempt_id:string;sha256:string;storage_path:string;content:string}[]=[],input={materials:inputMaterials,digest:redactionInputDigest(inputMaterials)},docxArtifacts:{id:string;attempt_id:string;sha256:string;storage_path:string;material_id:string}[]=[];
 const indexMaterials=sources.map((source,i)=>{const materialMarkdown=`附件${i+1}的脱敏正文`,document={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'p1-b1',kind:'heading',level:1,text:materialMarkdown}]}]};return{material_id:source.material_id,markdown:materialMarkdown,...(options.structured?{document,structure_sha256:options.invalidStructure?'wrong':hash(JSON.stringify(document))}:{})};});
 const index=JSON.stringify({...(options.structured?{format:'redacted-index-v2'}:{}),redacted_sha256:options.invalidIndex?'wrong-hash':hash(markdown),materials:indexMaterials});
 const steps=STEP_REGISTRY.filter(stage=>stage.visible).map(stage=>({ordinal:stage.ordinal,status:options.incomplete&&stage.ordinal===8?'waiting':'succeeded'}));
 const client={release(){},async query(sql:string,values?:unknown[]){calls.push({sql,values});
  if(sql.includes('FROM ai_distill.workflows w JOIN ai_distill.projects'))return{rows:[{workflow_id:workflowId,project_id:'project',project_name:'豆包高经',parent_name:options.parentName,phase_name:options.phaseName,title:'问题1',source_key:options.sourceKey??'题目1',material_root:materialRoot}],rowCount:1};
  if(sql.includes('FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN'))return{rows:steps,rowCount:steps.length};
  if(sql.includes("status IN ('waiting','running') LIMIT 1"))return{rows:options.active?[{id:'active-attempt'}]:[],rowCount:options.active?1:0};
  if(sql.includes('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=9'))return{rows:[{status:'succeeded'}],rowCount:1};
  if(sql.includes("kind='redacted_index'"))return{rows:[{content:index,sha256:hash(index)}],rowCount:1};
  if(sql.includes("ar.kind='redacted_markdown'"))return{rows:[{id:attemptId,status:'succeeded',input,result:{redacted_sha256:hash(markdown)},content:markdown,sha256:hash(markdown)}],rowCount:1};
  if(sql.includes("ar.kind='private_extracted_pages'"))return{rows:sources,rowCount:1};
  if(sql.startsWith('SELECT count(*)::int'))return{rows:[{count:sources.length}],rowCount:1};
  if(sql.startsWith('SELECT id,original_name,storage_path,sha256,size_bytes FROM ai_distill.materials'))return{rows:sources.map(source=>({id:source.material_id,original_name:'source.pdf',storage_path:'sources/source.pdf',sha256:hash(original),size_bytes:original.byteLength})),rowCount:sources.length};
  if(sql.includes("kind='redacted_docx_manifest'"))return{rows:manifestArtifacts,rowCount:manifestArtifacts.length};
  if(sql.includes("kind='redacted_docx'")||(sql.includes('kind=$2')&&values?.[1]==='redacted_docx'))return{rows:docxArtifacts,rowCount:docxArtifacts.length};
  if(sql.startsWith('INSERT INTO ai_distill.artifacts')){if(options.failInsert)throw new Error('artifact write failed');if(sql.includes("'redacted_docx_manifest'"))manifestArtifacts.push({id:String(values?.[0]),attempt_id:String(values?.[2]),storage_path:String(values?.[3]),sha256:String(values?.[4]),content:String(values?.[6])});else docxArtifacts.push({id:String(values?.[0]),attempt_id:String(values?.[2]),storage_path:String(values?.[4]),sha256:String(values?.[5]),material_id:String(values?.[7])});return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.artifacts SET attempt_id')){if(sql.includes('content=$6')){const artifact=manifestArtifacts.find(row=>row.id===values?.[0]);if(artifact)Object.assign(artifact,{attempt_id:values?.[1],storage_path:values?.[2],sha256:values?.[3],content:values?.[5]});}else{const artifact=docxArtifacts.find(row=>row.id===values?.[0]);if(artifact)Object.assign(artifact,{attempt_id:values?.[1],storage_path:values?.[2],sha256:values?.[3]});}return{rows:[],rowCount:1};}
  return{rows:[],rowCount:1};
 }};
 const pool={connect:async()=>client,query:async(sql:string,values?:unknown[])=>sql.startsWith('SELECT material_mode FROM ai_distill.question_library_sources')?{rows:[],rowCount:0}:client.query(sql,values)};
 return{root,materialRoot,storageRoot,projectExportsRoot,calls,docxArtifacts,manifestArtifacts,pool:pool as unknown as Pool};
}

test('manual export writes one DOCX artifact without touching workflow state or attempts',async()=>{
 const f=await fixture();await mkdir(f.materialRoot,{recursive:true});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot),file=join(f.projectExportsRoot,'附件库','豆包高经','问题1','成果',`source-脱敏-${materialId.slice(0,8)}.docx`),sourceCopy=join(f.projectExportsRoot,'附件库','豆包高经','问题1','原件',`${materialId.slice(0,8)}_source.pdf`),bytes=await readFile(file),again=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result).toMatchObject({reused:false,sha256:hash(bytes)});expect(bytes.readUInt32LE(0)).toBe(0x04034b50);expect(again).toMatchObject({artifact_id:result.artifact_id,reused:true});
 expect(await readFile(sourceCopy)).toEqual(Buffer.from('original attachment'));
 expect(f.calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts')&&call.values?.[3]==='redacted_docx')).toHaveLength(1);
 expect(f.manifestArtifacts).toHaveLength(1);expect(JSON.parse(f.manifestArtifacts[0]!.content).renderer_version).toBe('redacted-structure-docx-v3');
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts)/.test(call.sql))).toBe(false);
});

test('new phase exports use project, phase, and question directory levels',async()=>{
 const f=await fixture({parentName:'豆包高经济价值',phaseName:'第五期',sourceKey:'题目3'});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result.archive_path).toBe('附件库/豆包高经济价值/第五期/题目3');
 expect(f.docxArtifacts[0]?.storage_path).toBe(`附件库/豆包高经济价值/第五期/题目3/成果/source-脱敏-${materialId.slice(0,8)}.docx`);
 expect(await Bun.file(join(f.projectExportsRoot,f.docxArtifacts[0]!.storage_path)).exists()).toBe(true);
});

test('attachment library path contract accepts legacy and project-phase-question paths only',()=>{
 expect(isLibraryDocxPath('附件库/project/question/成果/file.docx')).toBe(true);
 expect(isLibraryDocxPath('附件库/project/phase/question/成果/file.docx')).toBe(true);
 expect(isLibraryDocxPath('附件库/project/phase/question/other/file.docx')).toBe(false);
});

test('export accepts identical attachment fingerprints returned in a different database order',async()=>{
 const f=await fixture({reversedSources:true});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result.reused).toBe(false);
 expect(result.artifacts).toHaveLength(2);
 expect(f.calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts')&&call.values?.[3]==='redacted_docx')).toHaveLength(2);
 const contents=await Promise.all(result.artifacts.map(artifact=>readFile(join(f.projectExportsRoot,result.archive_path,'成果',artifact.filename))));
 expect(hash(contents[0]!)).not.toBe(hash(contents[1]!));
 for(const artifact of result.artifacts){
  const index=artifact.material_id===materialId?0:1;
  const path=join(f.projectExportsRoot,result.archive_path,'成果',artifact.filename);
  const out=spawnSync('python3',['-c',"import zipfile,sys,xml.etree.ElementTree as E; r=E.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml')); print(''.join(r.itertext()))",path],{encoding:'utf8'});
  expect(out.status).toBe(0);expect(out.stdout).toContain(`附件${index+1}的脱敏正文`);expect(out.stdout).not.toContain(`附件${2-index}的脱敏正文`);
 }
});

test('incomplete workflow rejects export before writing any file or artifact',async()=>{
 const f=await fixture({incomplete:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('请先完成当前工作流');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
 expect(await Bun.file(join(f.root,'project','outputs')).exists()).toBe(false);
});

test('active workflow attempt rejects export before writing any file or artifact',async()=>{
 const f=await fixture({active:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('当前仍有工作流任务');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
 expect(await Bun.file(join(f.root,'project','outputs')).exists()).toBe(false);
});

test('stale material digest rejects export without changing workflow state',async()=>{
 const f=await fixture({stale:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('当前脱敏结果与附件版本不一致');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
});

test('unsafe source key cannot escape the id-based attachment library folder',async()=>{
 const f=await fixture({sourceKey:'../outside'});await mkdir(f.materialRoot,{recursive:true});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result.reused).toBe(false);
 expect(await Bun.file(join(f.projectExportsRoot,'附件库','豆包高经','问题1','成果',`source-脱敏-${materialId.slice(0,8)}.docx`)).exists()).toBe(true);
 expect(await Bun.file(join(f.projectExportsRoot,'outside','脱敏材料.docx')).exists()).toBe(false);
});

test('artifact-index failure removes the staged DOCX and leaves workflow state untouched',async()=>{
 const f=await fixture({failInsert:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('artifact write failed');
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts)/.test(call.sql))).toBe(false);
 expect(await Bun.file(join(f.projectExportsRoot,'附件库','豆包高经','问题1','成果',`source-脱敏-${materialId.slice(0,8)}.docx`)).exists()).toBe(false);
 expect(await Bun.file(join(f.projectExportsRoot,'附件库','豆包高经','问题1','原件',`${materialId.slice(0,8)}_source.pdf`)).exists()).toBe(false);
});

test('mismatched per-material redaction index rejects the entire export',async()=>{
 const f=await fixture({invalidIndex:true});
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('脱敏附件索引与当前附件不一致');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
});

test('structured index drives DOCX rendering and manifest binds source structure and file digest',async()=>{
 const f=await fixture({structured:true});await mkdir(f.materialRoot,{recursive:true});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot),artifact=result.artifacts[0]!,path=join(f.projectExportsRoot,result.archive_path,'成果',artifact.filename);
 const xml=spawnSync('python3',['-c',"import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode())",path],{encoding:'utf8'});
 expect(xml.status).toBe(0);expect(xml.stdout).toContain('w:val="Heading1"');expect(xml.stdout).toContain('附件1的脱敏正文');
 const manifest=JSON.parse(f.manifestArtifacts[0]!.content);expect(manifest.materials[0]).toMatchObject({material_id:materialId,source_sha256:hash(Buffer.from('original attachment')),docx_artifact_id:artifact.artifact_id,docx_sha256:artifact.sha256});
 expect(manifest.renderer_version).toBe('redacted-structure-docx-v3');
});

test('corrupt structured index fails closed before copying or exporting materials',async()=>{
 const f=await fixture({structured:true,invalidStructure:true});
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('脱敏结构与正文投影不一致');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
});

test.each([false,true])('library completion gate uses only applicable stages before material validation (incomplete=%s)',async incomplete=>{
 const calls:string[]=[];
 const client={release(){},async query(sql:string){
  calls.push(sql);
  if(sql.startsWith('SELECT w.id AS workflow_id'))return{rows:[{workflow_id:workflowId,project_id:workflowId,material_backend:'library_v1',workflow_kind:'question',project_name:'合成项目',title:'合成题目'}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return{rows:[4,5,6,7,8].map(ordinal=>({ordinal,status:incomplete&&ordinal===6?'waiting':'succeeded'})),rowCount:5};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT'))throw new Error('已进入材料读取边界');
  return{rows:[],rowCount:0};
 }};
 const pool={connect:async()=>client} as unknown as Pool;
 await expect(exportRedactedDocx(pool,workflowId,'unused','unused')).rejects.toThrow(incomplete?'请先完成当前工作流并归档达标题目':'已进入材料读取边界');
 expect(calls.at(-1)).toBe('ROLLBACK');
});

test('legacy project library-package question uses the library completion gate',async()=>{
 const calls:string[]=[];
 const client={release(){},async query(sql:string){
  calls.push(sql);
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT w.id AS workflow_id'))return{rows:[{workflow_id:workflowId,project_id:workflowId,material_backend:'legacy',has_library_snapshot:true,project_name:'旧项目',title:'材料库题目'}],rowCount:1};
  if(sql.includes('FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN'))return{rows:[4,5,6,7,8].map(ordinal=>({ordinal,status:'succeeded'})),rowCount:5};
  if(sql.startsWith("SELECT id FROM ai_distill.step_attempts"))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT p.material_backend'))return{rows:[{material_backend:'legacy',has_library_snapshot:true}],rowCount:1};
  throw new Error('library snapshot material read reached');
 }};
 const pool={connect:async()=>client} as unknown as Pool;
 await expect(exportRedactedDocx(pool,workflowId,'unused','unused')).rejects.toThrow('library snapshot material read reached');
 expect(calls.some(sql=>sql.includes('FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN'))).toBe(true);
});
