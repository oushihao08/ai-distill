/**
 * 职责：Work 项目独有的归档准备：读取本题冻结材料，准备原件/结构和五件套标准成果。
 * 入口：readConfig() 冻结旧格式生成配置；prepare() 由公共归档器在释放读取事务后调用。
 * 边界：本文件的材料与成果要求仅约束 Work；公共评分达标条件不由项目脚本改写。
 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {canonicalJson} from '../../../shared/workflow-config';
import type {DeliveryInput,ProjectArchiveContext} from '../../../server/publishing/project-delivery';
import {readProjectAgentDefaults} from '../../../server/agent/config';
import {readCurrentRedactionForDocx,readOriginalFilesForDelivery} from '../../../server/materials/redacted-docx-export';
import {readQuestionMaterials} from '../../../server/question-materials';
import {getOrGenerateWorkSimulation} from './work-simulation';
import {getAgentConcurrencyGate,readConcurrencySettings} from '../../../server/concurrency';
import {cachedExternalCall} from '../../../server/execution-queue/runtime';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const conflict=(reason_code:string,message:string)=>Object.assign(new HTTPException(409,{message}),{reason_code});
interface Material {id:string;attempt_id:string|null;sha256:string;storage_path:string;content?:string|null}

export async function readConfig(pool:Pick<Pool,'query'>,projectId:string,workflowId:string){
 const row=(await pool.query("SELECT result->>'content_contract' AS content_contract FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=4",[workflowId])).rows[0];
 return row?.content_contract==='work_legal_v1'?null:await readProjectAgentDefaults(pool,projectId);
}

async function readMaterial(root:string,artifact:Material){
 let bytes:Uint8Array;
 if(typeof artifact.content==='string')bytes=Buffer.from(artifact.content,'utf8');
 else{
  if(!artifact||isAbsolute(artifact.storage_path)||artifact.storage_path.includes('\\'))throw conflict('publication_material_path_invalid','Work材料文件索引无效');
  try{const base=await realpath(resolve(root)),path=await realpath(join(base,artifact.storage_path));if(!path.startsWith(`${base}/`))throw new Error('unsafe material');bytes=await readFile(path);}
  catch{throw conflict('publication_material_file_invalid','Work材料正文无法读取');}
 }
 if(hash(bytes)!==artifact.sha256)throw conflict('publication_material_hash_mismatch','Work材料内容指纹变化');
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.trim())throw new Error('empty');return text;}
 catch{throw conflict('publication_material_text_invalid','Work材料不是有效的UTF-8文本');}
}

interface Dependencies {prepareWork?:typeof getOrGenerateWorkSimulation;readStructuredMaterials?:(...args:Parameters<typeof readCurrentRedactionForDocx>)=>Promise<Awaited<ReturnType<typeof readCurrentRedactionForDocx>>|undefined>}
export async function prepare(input:DeliveryInput,context:ProjectArchiveContext,dependencies:Dependencies={}){
 const {pool,workflowId,storageRoot:root,frozen}=context,q=input.question;
 const ids=q.attachment_ids;
 if(!Array.isArray(ids)||!ids.length||!Array.isArray(frozen?.materials))throw conflict('publication_attachment_snapshot_incomplete','Work出题附件快照不完整');
 if(q.delivery_identity&&(!/^LAW-\d{3,}$/.test(q.delivery_identity.task_id)||!/^[a-z0-9][a-z0-9-]{1,31}$/.test(q.delivery_identity.org)))throw new HTTPException(400,{message:'可选Harbor身份格式无效'});
 let materials:Material[];
 if(frozen.material_origin?.kind==='library_v1'){
  let source:Awaited<ReturnType<typeof readQuestionMaterials>>;
  try{source=await readQuestionMaterials(pool,workflowId);}catch{throw conflict('publication_library_source_invalid','Work材料库题目来源快照或正文校验失败');}
  if(canonicalJson(source.origin)!==canonicalJson(frozen.material_origin)||JSON.stringify(ids)!==JSON.stringify(source.attachments.map(item=>item.id)))throw conflict('publication_library_attachment_mismatch','Work材料库冻结附件与题目版本不一致');
  materials=source.attachments.map(item=>({id:item.id,attempt_id:null,storage_path:'',sha256:item.sha256,content:item.content}));
 }else{
  materials=(await pool.query("SELECT ar.id,ar.attempt_id,ar.kind,ar.storage_path,ar.sha256,ar.content FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id JOIN ai_distill.steps s ON s.workflow_id=ar.workflow_id AND s.ordinal=9 WHERE ar.workflow_id=$1 AND ar.id=ANY($2::uuid[]) AND ar.kind='redacted_markdown' AND a.ordinal=9 AND a.status='succeeded' AND s.status='succeeded'",[workflowId,ids])).rows;
 }
 let structured:Awaited<ReturnType<typeof readCurrentRedactionForDocx>>|undefined;
 try{structured=await (dependencies.readStructuredMaterials??readCurrentRedactionForDocx)(pool,workflowId);}catch{throw conflict('publication_material_structure_invalid','Work题目冻结的材料正文或结构校验失败');}
 input.attachments=await Promise.all(ids.map(async(id:string,index:number)=>{
  const matching=materials.filter(item=>item.id===id),material=matching[0];
  if(matching.length!==1||!material||!frozen.materials.some((item:any)=>item.id===id&&item.sha256===material.sha256)||(frozen.material_origin?.kind!=='library_v1'&&material.attempt_id!==frozen.redaction_attempt_id))throw conflict('publication_attachment_binding_mismatch','Work当前附件与出题快照不一致');
  // 046之前的共享库快照没有material_mode，既有语义为脱敏；显式原文仍由上方冻结来源校验。
  const materialMode=frozen.material_origin?.kind==='library_v1'?(frozen.material_origin.material_mode??'redacted'):'redacted';
  const documents=structured&&structured.redacted_sha256===material.sha256?[...structured.materialDocuments.values()].map(item=>item.document):undefined;
  const prepared_documents=structured&&'prepared_documents'in structured?structured.prepared_documents:undefined;
  let original_files:DeliveryInput['attachments'][number]['original_files'];
  if(materialMode==='original'&&!structured?.selected_materials){
   if(ids.length!==1)throw conflict('publication_original_attachment_mapping_unsupported','Work原文归档的多附件映射不明确');
   const manifest=(await pool.query('SELECT snapshot_manifest FROM ai_distill.question_library_sources WHERE workflow_id=$1',[workflowId])).rows[0]?.snapshot_manifest;
   const expected=Array.isArray(manifest?.files)?manifest.files.map((file:any)=>({material_id:String(file.material_id),original_name:String(file.original_name),sha256:String(file.source_sha256)})):[];
   try{const originals=await readOriginalFilesForDelivery(pool,workflowId,root,expected);original_files=originals.map(file=>({name:file.name,sha256:file.sha256,content_base64:Buffer.from(file.bytes).toString('base64')}));}
   catch{throw conflict('publication_original_source_invalid','Work原文材料与冻结文件清单不一致或无法读取');}
  }
  return{id,sha256:material.sha256,name:`材料-${String(index+1).padStart(3,'0')}.md`,text:await readMaterial(root,material),material_mode:materialMode,...(structured?.selected_materials?{selected_materials:true}:{}),...(documents?{documents}:{}),...(prepared_documents?{prepared_documents}:{}),...(original_files?{original_files}:{})};
 }));
 context.signal?.throwIfAborted();
 const generate=()=>cachedExternalCall(`publication_simulation:${input.source_digest}:${input.delivery_digest}`,()=>(dependencies.prepareWork??getOrGenerateWorkSimulation)(pool,{project_id:input.project_id,workflow_id:workflowId,title:input.title,question_version:input.question_version,rubric_version:input.rubric_version,question:q,attachments:input.attachments.map(({name,text,material_mode})=>({name,text,material_mode:material_mode??'redacted'}))},root,hash(`${input.source_digest}:${input.delivery_digest}`),context.expectedLegacyAgentConfig));
 if(q.content_contract==='work_legal_v1')input.simulation=await generate();
 else{
  const permit=await getAgentConcurrencyGate(root,readConcurrencySettings(process.env,root).agent).run(generate);
  if(!permit.acquired)throw new HTTPException(409,{message:'Work旧格式成果生成尚未取得Agent槽位'});
  input.simulation=permit.value;
 }
}
