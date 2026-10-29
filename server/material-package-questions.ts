/**
 * 职责：从旧项目内材料包工作流一次成功脱敏尝试建立独立题目，复制本题受管理输入并保留来源版本。
 * 公开入口：listMaterialPackageVersions() 供建题前选择版本；createQuestionFromMaterialPackage() 供项目 API 建题。
 * 题目中的入库／脱敏记录明确标为继承快照，不代表再次运行提取或模型脱敏。
 */
import {createHash} from 'node:crypto';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join,relative,resolve,sep,isAbsolute} from 'node:path';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {STEP_REGISTRY} from '../shared/step-registry';
import {redactionInputDigest} from './materials/redaction-jobs';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const sourcePath=(root:string,path:string)=>{
 const base=resolve(root),full=resolve(base,path),rel=relative(base,full);
 if(!path||isAbsolute(path)||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new HTTPException(409,{message:'材料包管理文件路径无效'});
 return full;
};
type SourceRef={material_id:string;source_sha256:string;artifact_id:string;artifact_sha256:string;redaction_mode?:'model'|'declared_redacted'};
const sourceRefs=(input:any):SourceRef[]=>{
 const rows=input?.materials;
 if(!Array.isArray(rows)||!rows.length||rows.some(row=>!row||typeof row.material_id!=='string'||typeof row.source_sha256!=='string'||typeof row.artifact_id!=='string'||typeof row.artifact_sha256!=='string'))throw new HTTPException(409,{message:'脱敏版本缺少冻结的原文清单'});
 if(new Set(rows.map(row=>row.material_id)).size!==rows.length||new Set(rows.map(row=>row.artifact_id)).size!==rows.length)throw new HTTPException(409,{message:'脱敏版本的附件清单有重复引用'});
 return rows;
};

export async function listMaterialPackageVersions(pool:Pool,packageId:string){
 const workflow=(await pool.query("SELECT id FROM ai_distill.workflows WHERE id=$1 AND workflow_kind='material_package' AND deleted_at IS NULL",[packageId])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'材料包不存在'});
 const result=await pool.query("SELECT a.id,a.attempt,a.finished_at,a.result->>'redacted_sha256' AS redacted_sha256 FROM ai_distill.step_attempts a WHERE a.workflow_id=$1 AND a.ordinal=9 AND a.status='succeeded' AND EXISTS(SELECT 1 FROM ai_distill.artifacts ar WHERE ar.workflow_id=a.workflow_id AND ar.attempt_id=a.id AND ar.kind='redacted_markdown' AND ar.sha256=a.result->>'redacted_sha256') AND EXISTS(SELECT 1 FROM ai_distill.artifacts ar WHERE ar.workflow_id=a.workflow_id AND ar.attempt_id=a.id AND ar.kind='redacted_index') ORDER BY a.attempt DESC",[packageId]);
 return result.rows;
}

export interface CreateMaterialQuestionInput{title:string;redaction_attempt_id:string;scenario?:string|null;role_perspective?:string|null;target_level?:'L2'|'L3'|'L4'|'L5'|null;question_tags?:string[];authoring_direction?:string|null}
export async function createQuestionFromMaterialPackage(pool:Pool,storageRoot:string,packageId:string,input:CreateMaterialQuestionInput){
 const db=await pool.connect(),questionId=crypto.randomUUID(),directory=join(resolve(storageRoot),questionId),materialMap=new Map<string,string>();
 let commitAttempted=false;
 try{
  await db.query('BEGIN');
  const source=(await db.query("SELECT w.id,w.project_id,w.source_manifest,p.material_mode,p.question_tags FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.workflow_kind='material_package' AND w.deleted_at IS NULL FOR UPDATE OF w,p",[packageId])).rows[0];
  if(!source||source.material_mode!=='material_packages')throw new HTTPException(404,{message:'材料包不存在或项目未启用材料包模式'});
  const selectedTags=input.question_tags??[];
  if(!Array.isArray(selectedTags)||selectedTags.some(tag=>typeof tag!=='string'||!source.question_tags.includes(tag)))throw new HTTPException(400,{message:'题目标签须属于当前项目'});
  const attempt=(await db.query("SELECT id,input,result,finished_at FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2 AND ordinal=9 AND status='succeeded' FOR SHARE",[input.redaction_attempt_id,packageId])).rows[0];
  if(!attempt)throw new HTTPException(409,{message:'所选脱敏版本未成功完成'});
  const refs=sourceRefs(attempt.input);
  const output=(await db.query("SELECT kind,content,sha256 FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind IN ('redacted_markdown','redacted_index')",[packageId,attempt.id])).rows;
  const markdown=output.filter(row=>row.kind==='redacted_markdown'),indexRows=output.filter(row=>row.kind==='redacted_index');
  if(markdown.length!==1||indexRows.length!==1||typeof markdown[0].content!=='string'||typeof indexRows[0].content!=='string')throw new HTTPException(409,{message:'所选脱敏版本产物缺失或指纹不一致'});
  let index:any;try{index=JSON.parse(indexRows[0].content);}catch{throw new HTTPException(409,{message:'脱敏索引格式无效'});}
  if(!Array.isArray(index.materials)||index.materials.length!==refs.length)throw new HTTPException(409,{message:'脱敏索引与来源清单不一致'});
  const sourceMaterials=(await db.query("SELECT id,original_name,storage_path,sha256,size_bytes,content_type,redaction_mode FROM ai_distill.materials WHERE workflow_id=$1 AND id=ANY($2::uuid[]) FOR SHARE",[packageId,refs.map(row=>row.material_id)])).rows;
  const byMaterial=new Map(sourceMaterials.map(row=>[row.id,row]));
  const sourceArtifacts=(await db.query("SELECT id,material_id,content,sha256 FROM ai_distill.artifacts WHERE workflow_id=$1 AND id=ANY($2::uuid[]) AND kind='private_extracted_pages'",[packageId,refs.map(row=>row.artifact_id)])).rows;
  const byArtifact=new Map(sourceArtifacts.map(row=>[row.id,row]));
  if(sourceMaterials.length!==refs.length||sourceArtifacts.length!==refs.length)throw new HTTPException(409,{message:'脱敏版本的原始材料已缺失'});
  await mkdir(directory,{recursive:true,mode:0o700});
  const intakeId=crypto.randomUUID(),redactionId=crypto.randomUUID(),clonedRefs:SourceRef[]=[];
  await db.query("INSERT INTO ai_distill.workflows(id,project_id,request_id,title,source_manifest,workflow_kind,source_workflow_id,source_redaction_attempt_id,source_redaction_sha256,scenario,role_perspective,target_level,question_tags,authoring_direction) VALUES($1,$2,$3,$4,$5,'question',$6,$7,$8,$9,$10,$11,$12,$13)",[questionId,source.project_id,crypto.randomUUID(),input.title,JSON.stringify(source.source_manifest),packageId,attempt.id,markdown[0].sha256,input.scenario??null,input.role_perspective??null,input.target_level??null,selectedTags,input.authoring_direction??null]);
  for(const stage of STEP_REGISTRY){
   const inherited=[1,9].includes(stage.ordinal),pdf=stage.ordinal===2&&sourceMaterials.some(row=>/\.(pdf|docx)$/i.test(String(row.original_name)));
   const status=inherited||pdf?'succeeded':stage.ordinal===2?'skipped':'waiting';
   const result=inherited?JSON.stringify({origin:'inherited_material_snapshot',source_workflow_id:packageId,source_attempt_id:attempt.id}):null;
   await db.query('INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,result,step_key,display_position,enabled,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $4 IN (\'succeeded\',\'skipped\') THEN now() END,CASE WHEN $4 IN (\'succeeded\',\'skipped\') THEN now() END)',[questionId,stage.ordinal,stage.name,status,stage.defaultEnabled,result,stage.key,stage.position,stage.defaultEnabled]);
  }
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,finished_at) VALUES($1,$2,1,1,'succeeded',$3,$4,now())",[intakeId,questionId,JSON.stringify({origin:'inherited_material_snapshot',source_workflow_id:packageId,source_attempt_id:attempt.id}),JSON.stringify({origin:'inherited_material_snapshot',material_count:refs.length})]);
  for(const ref of refs){
   const material=byMaterial.get(ref.material_id),artifact=byArtifact.get(ref.artifact_id);
   if(!material||!artifact||artifact.material_id!==ref.material_id||typeof artifact.content!=='string')throw new HTTPException(409,{message:'脱敏版本的原文指纹不一致'});
   const bytes=await readFile(sourcePath(storageRoot,material.storage_path));
   const newMaterialId=crypto.randomUUID(),newArtifactId=crypto.randomUUID(),filePath=`${questionId}/${newMaterialId}.source`,extractedPath=`${questionId}/${newMaterialId}.extracted.json`;
   await writeFile(join(resolve(storageRoot),filePath),bytes,{mode:0o600,flag:'wx'});
   await writeFile(join(resolve(storageRoot),extractedPath),artifact.content,{mode:0o600,flag:'wx'});
   await db.query("INSERT INTO ai_distill.materials(id,workflow_id,original_name,storage_path,sha256,size_bytes,content_type,processing_status,redaction_mode) VALUES($1,$2,$3,$4,$5,$6,$7,'redacted',$8)",[newMaterialId,questionId,material.original_name,filePath,material.sha256,material.size_bytes,material.content_type,ref.redaction_mode==='declared_redacted'?'declared_redacted':'model']);
   await db.query("INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,'private_extracted_pages',$5,$6,$7,$8)",[newArtifactId,questionId,newMaterialId,intakeId,extractedPath,artifact.sha256,Buffer.byteLength(artifact.content),artifact.content]);
   await db.query("INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,'source_document',$5,$6,$7)",[crypto.randomUUID(),questionId,newMaterialId,intakeId,filePath,material.sha256,material.size_bytes]);
   materialMap.set(ref.material_id,newMaterialId);
   clonedRefs.push({material_id:newMaterialId,source_sha256:material.sha256,artifact_id:newArtifactId,artifact_sha256:artifact.sha256,...(ref.redaction_mode==='declared_redacted'?{redaction_mode:'declared_redacted' as const}:{})});
  }
  if(index.materials.some((row:any)=>!materialMap.has(row?.material_id))||(Array.isArray(index.pages)&&index.pages.some((row:any)=>!materialMap.has(row?.material_id))))throw new HTTPException(409,{message:'脱敏索引引用了未知附件'});
  index.materials=index.materials.map((row:any)=>({...row,material_id:materialMap.get(row.material_id)}));
  if(Array.isArray(index.pages))index.pages=index.pages.map((row:any)=>({...row,material_id:materialMap.get(row.material_id)}));
  const indexText=JSON.stringify(index),indexSha=sha(indexText),redactionResult={origin:'inherited_material_snapshot',source_workflow_id:packageId,source_attempt_id:attempt.id,redacted_sha256:markdown[0].sha256,index_sha256:indexSha,material_count:refs.length};
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,finished_at) VALUES($1,$2,9,1,'succeeded',$3,$4,now())",[redactionId,questionId,JSON.stringify({origin:'inherited_material_snapshot',source_workflow_id:packageId,source_attempt_id:attempt.id,materials:clonedRefs,digest:redactionInputDigest(clonedRefs)}),JSON.stringify(redactionResult)]);
  await db.query('UPDATE ai_distill.steps SET result=$2 WHERE workflow_id=$1 AND ordinal=9',[questionId,JSON.stringify(redactionResult)]);
  for(const item of [{kind:'redacted_markdown',content:markdown[0].content,sha256:markdown[0].sha256},{kind:'redacted_index',content:indexText,sha256:indexSha}]){
   const path=`${questionId}/${item.kind}-${redactionId}.${item.kind==='redacted_index'?'json':'md'}`;
   await writeFile(join(resolve(storageRoot),path),item.content,{mode:0o600,flag:'wx'});
   await db.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[crypto.randomUUID(),questionId,redactionId,item.kind,path,item.sha256,Buffer.byteLength(item.content),item.content]);
  }
  // 作者只需原附件名称；路径指向题目自己的脱敏正文，不能继续指向材料包的未脱敏来源目录。
  const redactedPath=join(resolve(storageRoot),questionId,`redacted_markdown-${redactionId}.md`);
  const manifest=refs.map(ref=>({name:byMaterial.get(ref.material_id)!.original_name,path:redactedPath,size:Buffer.byteLength(markdown[0].content),sha256:markdown[0].sha256}));
  await db.query('UPDATE ai_distill.workflows SET source_manifest=$2::jsonb WHERE id=$1',[questionId,JSON.stringify(manifest)]);
  commitAttempted=true;await db.query('COMMIT');
  return{id:questionId,source_workflow_id:packageId,source_redaction_attempt_id:attempt.id,source_redaction_sha256:markdown[0].sha256};
 }catch(error){await db.query('ROLLBACK');if(!commitAttempted)await rm(directory,{recursive:true,force:true});throw error;}finally{db.release();}
}
