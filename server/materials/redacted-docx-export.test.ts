/**
 * 职责：验证可选 DOCX 导出的完成门槛、当前脱敏绑定和工作流状态隔离。
 * 主要验证：导出只写独立 artifact 与 outputs 文件；未完成/过期输入不导出。
 * 使用场景：由 Bun test 定向运行，不连接真实数据库或模型服务。
 */
import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {STEP_REGISTRY} from '@shared/step-registry';
import {redactionInputDigest} from './redaction-jobs';
import {exportRedactedDocx} from './redacted-docx-export';

const workflowId='11111111-1111-4111-8111-111111111111',attemptId='22222222-2222-4222-8222-222222222222',materialId='33333333-3333-4333-8333-333333333333';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

function fixture(options:{incomplete?:boolean;active?:boolean;stale?:boolean;sourceKey?:string;failInsert?:boolean}={}){
 const root=`${tmpdir()}/redacted-docx-${crypto.randomUUID()}`,materialRoot=join(root,'project','questions'),calls:{sql:string;values?:unknown[]}[]=[];roots.push(root);
 const sources=[{material_id:materialId,source_sha256:'source-hash',artifact_id:'44444444-4444-4444-8444-444444444444',artifact_sha256:'extraction-hash'}],markdown='【附件 1】\n\n【原附件第 1 页】\n脱敏文本';
 const inputMaterials=options.stale?[{...sources[0],source_sha256:'old-hash'}]:sources;
 const input={materials:inputMaterials,digest:redactionInputDigest(inputMaterials)},docxArtifacts:{id:string;attempt_id:string;sha256:string;storage_path:string}[]=[];
 const steps=STEP_REGISTRY.filter(stage=>stage.visible).map(stage=>({ordinal:stage.ordinal,status:options.incomplete&&stage.ordinal===8?'waiting':'succeeded'}));
 const client={release(){},async query(sql:string,values?:unknown[]){calls.push({sql,values});
  if(sql.includes('FROM ai_distill.workflows w JOIN ai_distill.projects'))return{rows:[{workflow_id:workflowId,project_id:'project',title:'问题1',source_key:options.sourceKey??'题目1',material_root:materialRoot}],rowCount:1};
  if(sql.includes('FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal NOT IN'))return{rows:steps,rowCount:steps.length};
  if(sql.includes("status IN ('waiting','running') LIMIT 1"))return{rows:options.active?[{id:'active-attempt'}]:[],rowCount:options.active?1:0};
  if(sql.includes('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=9'))return{rows:[{status:'succeeded'}],rowCount:1};
  if(sql.includes("ar.kind='redacted_markdown'"))return{rows:[{id:attemptId,status:'succeeded',input,result:{redacted_sha256:hash(markdown)},content:markdown,sha256:hash(markdown)}],rowCount:1};
  if(sql.includes("ar.kind='private_extracted_pages'"))return{rows:sources,rowCount:1};
  if(sql.startsWith('SELECT count(*)::int'))return{rows:[{count:1}],rowCount:1};
  if(sql.includes("kind='redacted_docx'"))return{rows:docxArtifacts,rowCount:docxArtifacts.length};
  if(sql.startsWith('INSERT INTO ai_distill.artifacts')){if(options.failInsert)throw new Error('artifact write failed');docxArtifacts.push({id:String(values?.[0]),attempt_id:String(values?.[2]),storage_path:String(values?.[3]),sha256:String(values?.[4])});return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.artifacts SET attempt_id')){const artifact=docxArtifacts.find(row=>row.id===values?.[0]);if(artifact)Object.assign(artifact,{attempt_id:values?.[1],storage_path:values?.[2],sha256:values?.[3]});return{rows:[],rowCount:1};}
  return{rows:[],rowCount:1};
 }};
 return{root,materialRoot,calls,pool:{connect:async()=>client} as unknown as Pool};
}

test('manual export writes one DOCX artifact without touching workflow state or attempts',async()=>{
 const f=fixture();await mkdir(f.materialRoot,{recursive:true});
 const result=await exportRedactedDocx(f.pool,workflowId),file=join(f.root,'project','outputs','题目1','脱敏材料.docx'),bytes=await readFile(file),again=await exportRedactedDocx(f.pool,workflowId);
 expect(result).toMatchObject({reused:false,sha256:hash(bytes)});expect(bytes.readUInt32LE(0)).toBe(0x04034b50);expect(again).toMatchObject({artifact_id:result.artifact_id,reused:true});
 expect(f.calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toHaveLength(1);
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts|revision_chains)/.test(call.sql))).toBe(false);
});

test('incomplete workflow rejects export before writing any file or artifact',async()=>{
 const f=fixture({incomplete:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId)).rejects.toThrow('请先完成当前工作流');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
 expect(await Bun.file(join(f.root,'project','outputs')).exists()).toBe(false);
});

test('active workflow attempt rejects export before writing any file or artifact',async()=>{
 const f=fixture({active:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId)).rejects.toThrow('当前仍有工作流任务');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
 expect(await Bun.file(join(f.root,'project','outputs')).exists()).toBe(false);
});

test('stale material digest rejects export without changing workflow state',async()=>{
 const f=fixture({stale:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId)).rejects.toThrow('当前脱敏结果与附件版本不一致');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
});

test('unsafe question directory key is rejected before filesystem writes',async()=>{
 const f=fixture({sourceKey:'../outside'});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId)).rejects.toThrow('题目目录标识');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
 expect(await Bun.file(join(f.root,'project','outputs')).exists()).toBe(false);
});

test('artifact-index failure removes the staged DOCX and leaves workflow state untouched',async()=>{
 const f=fixture({failInsert:true});await mkdir(f.materialRoot,{recursive:true});
 await expect(exportRedactedDocx(f.pool,workflowId)).rejects.toThrow('artifact write failed');
 expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE).*ai_distill\.(steps|step_attempts|revision_chains)/.test(call.sql))).toBe(false);
 expect(await Bun.file(join(f.root,'project','outputs','题目1','脱敏材料.docx')).exists()).toBe(false);
});
