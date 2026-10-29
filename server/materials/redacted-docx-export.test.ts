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
import {exportCurrentMaterialDocx,exportRedactedDocx,isLibraryDocxPath,projectPreparedDocuments,preparationDocxProjection} from './redacted-docx-export';
import {compilePreparation,preparationBlocks,preparationUnits} from '../../shared/material-preparation-result';

const workflowId='11111111-1111-4111-8111-111111111111',attemptId='22222222-2222-4222-8222-222222222222',materialId='33333333-3333-4333-8333-333333333333';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

async function fixture(options:{incomplete?:boolean;active?:boolean;publicationInProgress?:boolean;stale?:boolean;sourceKey?:string;parentName?:string;phaseName?:string;failInsert?:boolean;reversedSources?:boolean;invalidIndex?:boolean;structured?:boolean;invalidStructure?:boolean}={}){
 const root=`${tmpdir()}/redacted-docx-${crypto.randomUUID()}`,materialRoot=join(root,'project','questions'),storageRoot=join(root,'managed'),projectExportsRoot=join(root,'assets','out'),calls:{sql:string;values?:unknown[]}[]=[];roots.push(root);
 const original=Buffer.from('original attachment');await mkdir(join(storageRoot,'sources'),{recursive:true});await writeFile(join(storageRoot,'sources','source.pdf'),original);
 const sources=[{material_id:materialId,source_sha256:hash(original),artifact_id:'44444444-4444-4444-8444-444444444444',artifact_sha256:'extraction-hash'}],markdown='【附件 1】\n\n【原附件第 1 页】\n脱敏文本';
 if(options.reversedSources)sources.push({...sources[0]!,material_id:'55555555-5555-4555-8555-555555555555',artifact_id:'66666666-6666-4666-8666-666666666666'});
 const inputMaterials=options.stale?[{...sources[0],source_sha256:'old-hash'}]:options.reversedSources?[...sources].reverse():sources;
 const manifestArtifacts:{id:string;attempt_id:string;sha256:string;storage_path:string;content:string}[]=[],input={materials:inputMaterials,digest:redactionInputDigest(inputMaterials)},docxArtifacts:{id:string;attempt_id:string;sha256:string;storage_path:string;material_id:string}[]=[];
 const indexMaterials=sources.map((source,i)=>{const materialMarkdown=`附件${i+1}的脱敏正文`,document={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'p1-b1',kind:'heading',level:1,text:materialMarkdown}]}]};return{material_id:source.material_id,markdown:materialMarkdown,...(options.structured?{document,structure_sha256:options.invalidStructure?'wrong':hash(JSON.stringify(document))}:{})};});
 const index=JSON.stringify({...(options.structured?{format:'redacted-index-v2'}:{}),redacted_sha256:options.invalidIndex?'wrong-hash':hash(markdown),materials:indexMaterials});
 const steps=STEP_REGISTRY.filter(stage=>stage.visible).map(stage=>({ordinal:stage.ordinal,status:options.publicationInProgress&&stage.ordinal===8?'running':options.incomplete&&stage.ordinal===8?'waiting':'succeeded'}));
 const client={release(){},async query(sql:string,values?:unknown[]){calls.push({sql,values});
  if(sql.startsWith('SELECT p.material_backend'))return{rows:[{material_backend:'legacy',has_library_snapshot:false}]};
  if(sql.startsWith('SELECT a.id,a.input FROM ai_distill.step_attempts'))return{rows:[{id:attemptId,input}]};
  if(sql.startsWith('SELECT id,kind,attempt_id,sha256,content'))return{rows:[{id:'77777777-7777-4777-8777-777777777777',kind:'redacted_markdown',attempt_id:attemptId,sha256:hash(markdown),content:markdown}]};
  if(sql.startsWith('SELECT input FROM ai_distill.step_attempts'))return{rows:[{input}]};
  if(sql.includes('FROM ai_distill.workflows w JOIN ai_distill.projects'))return{rows:[{workflow_id:workflowId,project_id:'project',project_name:'豆包高经',parent_name:options.parentName,phase_name:options.phaseName,title:'问题1',source_key:options.sourceKey??'题目1',material_root:materialRoot}],rowCount:1};
  if(sql.includes('FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN'))return{rows:steps,rowCount:steps.length};
  if(sql.includes("status IN ('waiting','running')")&&sql.includes('step_attempts')){const active=Boolean(options.active&&!(values?.[1]===true&&options.publicationInProgress));return{rows:active?[{id:'active-attempt'}]:[],rowCount:active?1:0};}
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
 return{root,materialRoot,storageRoot,projectExportsRoot,calls,docxArtifacts,manifestArtifacts,authoringInput:{redaction_attempt_id:attemptId,materials:[{id:'77777777-7777-4777-8777-777777777777',sha256:hash(markdown)}]},pool:pool as unknown as Pool};
}

test('manual export writes one DOCX artifact without touching workflow state or attempts',async()=>{
 const f=await fixture();await mkdir(f.materialRoot,{recursive:true});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot),file=join(f.projectExportsRoot,'附件库','豆包高经','问题1','成果','脱敏材料.docx'),sourceCopy=join(f.projectExportsRoot,'附件库','豆包高经','问题1','原件',`${materialId.slice(0,8)}_source.pdf`),bytes=await readFile(file),again=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result).toMatchObject({reused:false,sha256:hash(bytes)});expect(bytes.readUInt32LE(0)).toBe(0x04034b50);expect(again).toMatchObject({artifact_id:result.artifact_id,reused:true});
 expect(await readFile(sourceCopy)).toEqual(Buffer.from('original attachment'));
 expect(f.calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts')&&call.values?.[3]==='redacted_docx')).toHaveLength(1);
 expect(f.manifestArtifacts).toHaveLength(1);expect(JSON.parse(f.manifestArtifacts[0]!.content).renderer_version).toBe('redacted-structure-docx-v5');
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts)/.test(call.sql))).toBe(false);
});

test('new phase exports use project, phase, and question directory levels',async()=>{
 const f=await fixture({parentName:'豆包高经济价值',phaseName:'第五期',sourceKey:'题目3'});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result.archive_path).toBe('附件库/豆包高经济价值/第五期/题目3');
 expect(f.docxArtifacts[0]?.storage_path).toBe(`附件库/豆包高经济价值/第五期/题目3/成果/脱敏材料.docx`);
 expect(await Bun.file(join(f.projectExportsRoot,f.docxArtifacts[0]!.storage_path)).exists()).toBe(true);
});

test('attachment library path contract accepts legacy and project-phase-question paths only',()=>{
 expect(isLibraryDocxPath('附件库/project/question/成果/file.docx')).toBe(true);
 expect(isLibraryDocxPath('附件库/project/phase/question/成果/file.docx')).toBe(true);
 expect(isLibraryDocxPath('附件库/project/phase/question/other/file.docx')).toBe(false);
});

test('multiple verified attachments are merged into one DOCX without losing either body',async()=>{
 const f=await fixture({reversedSources:true});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result.artifacts).toHaveLength(1);
 const path=join(f.projectExportsRoot,result.archive_path,'成果',result.artifacts[0]!.filename);
 const out=spawnSync('python3',['-c',"import zipfile,sys,xml.etree.ElementTree as E; r=E.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml')); print(''.join(r.itertext()))",path],{encoding:'utf8'});
 expect(out.status).toBe(0);expect(out.stdout).toContain('附件1的脱敏正文');expect(out.stdout).toContain('附件2的脱敏正文');
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts)/.test(call.sql))).toBe(false);
});

test.each([{incomplete:true},{active:true},{active:true,publicationInProgress:true}])('valid redacted material exports independently of workflow progress (%j)',async options=>{
 const f=await fixture(options);await mkdir(f.materialRoot,{recursive:true});
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result.artifacts).toHaveLength(1);
 expect(f.calls.some(call=>call.sql.startsWith('UPDATE ai_distill.steps'))).toBe(false);
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
 expect(await Bun.file(join(f.projectExportsRoot,'附件库','豆包高经','问题1','成果','脱敏材料.docx')).exists()).toBe(true);
 expect(await Bun.file(join(f.projectExportsRoot,'outside','脱敏材料.docx')).exists()).toBe(false);
});

test('artifact-index failure removes the staged DOCX and leaves workflow state untouched',async()=>{
 const f=await fixture({failInsert:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('artifact write failed');
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts)/.test(call.sql))).toBe(false);
 expect(await Bun.file(join(f.projectExportsRoot,'附件库','豆包高经','问题1','成果','脱敏材料.docx')).exists()).toBe(false);
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
 expect(manifest.renderer_version).toBe('redacted-structure-docx-v5');
});

test('corrupt structured index fails closed before copying or exporting materials',async()=>{
 const f=await fixture({structured:true,invalidStructure:true});
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('脱敏结构与正文投影不一致');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
});

test.each([false,true])('library material validation does not depend on workflow completion (incomplete=%s)',async incomplete=>{
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
 await expect(exportRedactedDocx(pool,workflowId,'unused','unused')).rejects.toThrow('已进入材料读取边界');
 expect(calls.at(-1)).toBe('ROLLBACK');
});

test('legacy project library-package question validates frozen materials without a completion gate',async()=>{
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
 expect(calls.some(sql=>sql.includes('FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN'))).toBe(false);
});


test('冻结分册仅省略纯空白，非空正文及结构矛盾仍严格拒绝',()=>{
 const empty={id:'blank',title:'空白分册',text:'\n',document:{format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'a',kind:'paragraph',text:''},{id:'b',kind:'paragraph',text:''}]}]}};
 const actual={id:'actual',title:'申请书',text:'保留全部真实正文'};
 const frozen=[empty,actual],before=JSON.stringify(frozen);
 expect(projectPreparedDocuments(frozen)).toEqual([actual]);expect(JSON.stringify(frozen)).toBe(before);
 expect(projectPreparedDocuments(undefined)).toBeUndefined();
 expect(()=>projectPreparedDocuments({})).toThrow('清单无效');
 expect(()=>projectPreparedDocuments([{...actual,text:null}])).toThrow('正文无效');
 expect(()=>projectPreparedDocuments([actual,actual])).toThrow('正文无效');
 expect(()=>projectPreparedDocuments([{...empty,text:'',document:{...empty.document,pages:[{page:1,blocks:[{id:'x',kind:'paragraph',text:'真实正文不能被丢弃'}]}]}}])).toThrow('结构无效');
});

test('已验证脱敏正文可在本机原PDF缺失时导出，不改写原件或冻结数据',async()=>{
 const f=await fixture({structured:true});await rm(join(f.storageRoot,'sources','source.pdf'));
 const result=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(result.artifacts).toHaveLength(1);
 expect(await Bun.file(join(f.projectExportsRoot,result.archive_path,'成果',result.artifacts[0]!.filename)).exists()).toBe(true);
 expect(await Bun.file(join(f.storageRoot,'sources','source.pdf')).exists()).toBe(false);
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(materials|steps|step_attempts)/.test(call.sql))).toBe(false);
});

test('脱敏导出不把存在但指纹损坏的原件误当成缺失',async()=>{
 const f=await fixture({structured:true});await writeFile(join(f.storageRoot,'sources','source.pdf'),'wrong bytes');
 await expect(exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot)).rejects.toThrow('指纹校验失败');
});

test('飞书严格导出通过有效出题材料绑定后只生成一份DOCX',async()=>{const f=await fixture();const result=await exportCurrentMaterialDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot,undefined,{expectedAuthoringInput:f.authoringInput});expect(result.artifacts).toHaveLength(1);});
test('严格导出不接受不同出题材料，且不写DOCX',async()=>{const f=await fixture();await expect(exportCurrentMaterialDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot,undefined,{expectedAuthoringInput:{...f.authoringInput,materials:[]}})).rejects.toThrow('feishu_authoring_materials_missing');expect(f.docxArtifacts).toHaveLength(0);});
test('脱敏交付按冻结材料身份核验，原PDF副本跨机器缺失不阻断',async()=>{const f=await fixture();await rm(join(f.storageRoot,'sources','source.pdf'));const result=await exportCurrentMaterialDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot,undefined,{expectedAuthoringInput:f.authoringInput});expect(result.artifacts).toHaveLength(1);});
test('脱敏交付仍拒绝存在但大小或SHA错误的原件副本',async()=>{const f=await fixture();await writeFile(join(f.storageRoot,'sources','source.pdf'),'wrong bytes');await expect(exportCurrentMaterialDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot,undefined,{expectedAuthoringInput:f.authoringInput})).rejects.toThrow('当前附件原件指纹校验失败');expect(f.docxArtifacts).toHaveLength(0);});

test('Feishu old library manifests verify frozen IDs and real bytes without requiring new artifacts',async()=>{
 const {verifyLibraryOriginalManifest}=await import('./redacted-docx-export');const root=await mkdtemp(join(tmpdir(),'legacy-manifest-'));
 const bytes=Buffer.from('synthetic original'),material={id:'material-a',sha256:hash(bytes),size_bytes:bytes.length,storage_path:'source.pdf',original_name:'source.pdf'};
 const frozen={id:material.id,sha256:material.sha256,artifact_declared:false,source_artifact_id:null,artifact_id:null,size_bytes:null};
 let rows:any[]=[frozen];const pool={query:async()=>({rows})} as any;
 try{
  await writeFile(join(root,'source.pdf'),bytes);expect((await verifyLibraryOriginalManifest(pool,'workflow',[material],root)).get(material.id)).toEqual(bytes);
  rows=[{...frozen,artifact_declared:true}];expect((await verifyLibraryOriginalManifest(pool,'workflow',[material],root)).get(material.id)).toEqual(bytes);
  rows=[{...frozen,artifact_declared:true,source_artifact_id:'missing'}];await expect(verifyLibraryOriginalManifest(pool,'workflow',[material],root)).rejects.toThrow('产物关联');
  rows=[{...frozen,artifact_declared:true,source_artifact_id:'artifact',artifact_id:'artifact',artifact_kind:'source_document',artifact_sha256:material.sha256,size_bytes:bytes.length}];expect((await verifyLibraryOriginalManifest(pool,'workflow',[material],root)).size).toBe(0);
  rows=[{...rows[0],artifact_sha256:'wrong'}];await expect(verifyLibraryOriginalManifest(pool,'workflow',[material],root)).rejects.toThrow('产物关联');
  rows=[{...frozen,sha256:hash('different')}];await expect(verifyLibraryOriginalManifest(pool,'workflow',[material],root)).rejects.toThrow();
  rows=[frozen,frozen];await expect(verifyLibraryOriginalManifest(pool,'workflow',[material],root)).rejects.toThrow();
  rows=[frozen];await writeFile(join(root,'source.pdf'),'tampered');await expect(verifyLibraryOriginalManifest(pool,'workflow',[material],root)).rejects.toThrow('指纹');
  await rm(join(root,'source.pdf'));await expect(verifyLibraryOriginalManifest(pool,'workflow',[material],root)).rejects.toThrow('缺失');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('DOCX projection exports only visible prepared documents and remains fail-closed when all are hidden',async()=>{
 const index={format:'redacted-index-v2',materials:[{material_id:'material-1',markdown:'判决依据正文\n现成证据目录及逐项证明目的正文',document:{format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'b1',kind:'paragraph',text:'判决依据正文'},{id:'b2',kind:'paragraph',text:'现成证据目录及逐项证明目的正文'}]}]}}]};
 const units=preparationUnits(index),blocks=preparationBlocks(units);
 const result=compilePreparation({package_summary:'材料包',documents:[
  {id:'evidence',title:'民事判决书',block_ids:[blocks[0]!.id],summary:'交易证据',document_type:'判决',tags:[],notes:'',visibility:'visible',visibility_reason:''},
  {id:'judgment',title:'证据目录及逐项证明目的说明',block_ids:[blocks[1]!.id],summary:'既成裁判结果',document_type:'证明目的说明',tags:[],notes:'',visibility:'hidden',visibility_reason:'已完成出题目标要求生成的证据目录和证明目的'},
 ],combinations:[],warnings:[]},units);
 const visible=preparationDocxProjection({material_scope:{result}},index);
 expect(visible.applied).toBe(true);expect(visible.prepared_documents?.map(document=>document.title)).toEqual(['民事判决书']);
 expect(visible.prepared_documents?.[0]?.text).toContain('判决依据正文');expect(visible.prepared_documents?.[0]?.text).not.toContain('现成证据目录及逐项证明目的正文');
 const {buildDocx}=await import('../document-generation/docx');
 const {combineMaterialSections}=await import('./redacted-docx-export');
 const bytes=await buildDocx(combineMaterialSections(visible.prepared_documents!.map(document=>{expect(document.document).toBeDefined();return{...document,document:document.document!};})));
 const out=spawnSync('python3',['-c',"import zipfile,io,sys,xml.etree.ElementTree as E; r=E.fromstring(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read('word/document.xml')); print(''.join(r.itertext()))"],{input:Buffer.from(bytes),encoding:'utf8'});
 expect(out.status).toBe(0);expect(out.stdout).toContain('判决依据正文');expect(out.stdout).not.toContain('现成证据目录及逐项证明目的正文');
 const allHidden={...result,documents:result.documents.map(document=>({...document,visibility:'hidden' as const}))};
 const hidden=preparationDocxProjection({material_scope:{result:allHidden}},index);
 expect(hidden.applied).toBe(true);expect(hidden.prepared_documents).toEqual([]);
});

test('combined DOCX reuses the first real title, distinguishes same-name copies and preserves every body',async()=>{
 const {combineMaterialSections}=await import('./redacted-docx-export');
 const {buildDocx}=await import('../document-generation/docx');
 const sections=[{title:'民事判决书',document:{format:'redacted-structure-v1' as const,pages:[{page:1,blocks:[]},{page:2,blocks:[{id:'h',kind:'heading' as const,text:'民 事 判 决 书',level:1},{id:'p',kind:'paragraph' as const,text:'本金10000元；2026-10-27'}]}]}},{title:'民事判决书',duplicate_of:'first',document:{format:'redacted-structure-v1' as const,pages:[{page:1,blocks:[{id:'h',kind:'paragraph' as const,text:'民事判决书'},{id:'p',kind:'paragraph' as const,text:'本金10000元；2026-10-27'}]}]}}];
 const original=JSON.stringify(sections),combined=combineMaterialSections(sections);
 expect(JSON.stringify(sections)).toBe(original);
 const bytes=await buildDocx(combined),out=spawnSync('python3',['-c',"import zipfile,io,sys,xml.etree.ElementTree as E; r=E.fromstring(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read('word/document.xml')); print('\\n'.join(n.text or '' for n in r.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')))"] ,{input:Buffer.from(bytes),encoding:'utf8'});
 expect(out.status).toBe(0);
 expect(out.stdout.trim().split('\n')).toEqual(['民事判决书（第1份）','本金10000元；2026-10-27','民事判决书（重复件，第2份）','本金10000元；2026-10-27']);
});

test('section labels never remove meaningful first paragraphs or repeated source headings',async()=>{
 const {combineMaterialSections}=await import('./redacted-docx-export');
 const document={format:'redacted-structure-v1' as const,pages:[{page:1,blocks:[{id:'p',kind:'paragraph' as const,text:'本案涉及10000元借款。'},{id:'h',kind:'heading' as const,text:'申请书',level:1},{id:'h2',kind:'heading' as const,text:'申请书',level:1}]}]};
 const out=combineMaterialSections([{title:'申请书',document},{title:'说明',document}]);
 expect(out.pages[0]!.blocks.map((block:any)=>block.text)).toEqual(['申请书','本案涉及10000元借款。','申请书','申请书']);
 expect(combineMaterialSections([{title:'申请书',document}])).toEqual(document);
 expect(projectPreparedDocuments([{id:'d1',title:'申请书',text:'甲'},{id:'d2',title:'申请书',text:'甲',duplicate_of:'d1'}])?.[1]?.duplicate_of).toBe('d1');
});


test('layout policy defaults to separate documents and combines only registered projects',async()=>{
 const {materialDocxLayout}=await import('../lifecycle/material-docx');
 const {planMaterialDocxExports}=await import('./redacted-docx-export');
 const document:any={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'title',kind:'heading',text:'民事起诉状'},{id:'body',kind:'paragraph',text:'本金10000元'}]}]};
 const sections=[{id:'a',title:'民事起诉状',document},{id:'b',title:'民事起诉状',document:structuredClone(document)}],before=JSON.stringify(sections);
 expect(materialDocxLayout({parent_name:'Work法律全场景'})).toBe('separate');
 expect(materialDocxLayout({parent_name:'其他项目'})).toBe('separate');
 expect(materialDocxLayout({parent_name:'豆包高经济价值'})).toBe('combined');
 const separate=planMaterialDocxExports(sections,'separate','redacted');
 expect(separate.map(d=>d.filename)).toEqual(['001-民事起诉状.docx','002-民事起诉状.docx']);
 expect(separate[0]!.document.pages[0]!.blocks).toHaveLength(2);
 const combined=planMaterialDocxExports(sections,'combined','redacted');
 expect(combined).toHaveLength(1);expect(combined[0]!.filename).toBe('脱敏材料.docx');
 expect(combined[0]!.document.pages.flatMap(p=>p.blocks).filter(b=>b.kind==='heading')).toHaveLength(2);
 expect(JSON.stringify(sections)).toBe(before);
});

test('Work export uses separate DOCX artifacts and reuses each current artifact without changing workflow state',async()=>{
 const f=await fixture({parentName:'Work法律全场景',reversedSources:true,structured:true});
 const first=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(first.artifacts).toHaveLength(2);
 expect(first.artifacts.every(item=>/^\d{3}-.+\.docx$/.test(item.filename))).toBe(true);
 const second=await exportRedactedDocx(f.pool,workflowId,f.storageRoot,f.projectExportsRoot);
 expect(second.reused).toBe(true);expect(second.artifacts.map(item=>item.artifact_id)).toEqual(first.artifacts.map(item=>item.artifact_id));
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts)/.test(call.sql))).toBe(false);
});
