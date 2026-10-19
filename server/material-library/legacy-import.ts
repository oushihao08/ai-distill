/**
 * 文件职责：通过受控API将旧材料包的原件及已成功提取结果导入全局库，不导入脱敏或改写旧题。
 * 公开入口：readLegacyMaterialInventory()只返回来源摘要；importLegacyMaterial()提供dry-run/幂等apply；activateLegacyImports()绑定原期次。
 * 边界：原件摘要/结构/来源必须一致；导入任务明确origin=legacy_import，不冒充新OCR或模型执行。
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {canonicalJson} from '../../shared/workflow-config';
import {documentBlocksToText} from '../materials/pdf';
import {readLibraryBlob,installLibraryBlob,normalizeLibraryFilename} from './storage';
import {buildDefaultProcessingSettings,buildLibraryManifest} from './service';
import {claimMaterialUse,materialSetSignature} from './uses';
import {uuid,validateFile} from '../validation';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const conflict=(message:string)=>new HTTPException(409,{message});
type RawFile={id:string;original_name:string;storage_path:string;sha256:string;size_bytes:string|number;content_type:string;redaction_mode:'model'|'declared_redacted';artifact_id?:string;artifact_sha256?:string;artifact_content?:string;extraction_attempt_id?:string};

export function parseImportedDocument(file:RawFile){
 if(!file.artifact_id)return null;
 if(typeof file.artifact_content!=='string'||hash(file.artifact_content)!==file.artifact_sha256)throw conflict('旧提取产物摘要不匹配');
 let value:any;try{value=JSON.parse(file.artifact_content);}catch{throw conflict('旧提取产物不是有效JSON');}
 if(value.source_sha256!==file.sha256||!Array.isArray(value.pages)||!value.pages.length)throw conflict('旧提取产物与原件不匹配');
 const pages=value.pages.map((page:any,index:number)=>{
  if(!page||page.page!==index+1||typeof page.text!=='string'||!['text','ocr'].includes(page.method))throw conflict('旧提取页序或正文无效');
  const structure=page.structure??[{id:`legacy-page-${index+1}`,kind:'paragraph',text:page.text}];
  if(!Array.isArray(structure)||documentBlocksToText(structure)!==page.text)throw conflict('旧提取结构与正文不一致');
  return{...page,structure};
 });
 return{...value,version:1,source_sha256:file.sha256,pages};
}

async function readLegacySource(db:Pool|PoolClient,phaseId:string,workflowId:string,lock=false){
 const workflow=(await db.query(`SELECT w.id,w.title,w.project_id,w.source_manifest,w.workflow_kind,p.project_group_id,p.phase_name,p.phase_no,
  s.status AS intake_status FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id
  LEFT JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=1
  WHERE w.id=$1 AND w.project_id=$2 AND w.deleted_at IS NULL AND p.deleted_at IS NULL${lock?' FOR UPDATE OF w,p':''}`,[workflowId,phaseId])).rows[0];
 if(!workflow||workflow.workflow_kind!=='material_package')throw new HTTPException(404,{message:'本期旧材料包不存在'});
 if(workflow.intake_status!=='succeeded')throw conflict('该材料包未完成入库，不属于本次历史同步范围');
 const files=(await db.query(`SELECT m.id,m.original_name,m.storage_path,m.sha256,m.size_bytes,m.content_type,m.redaction_mode,
  extracted.id AS artifact_id,extracted.sha256 AS artifact_sha256,extracted.content AS artifact_content,extracted.attempt_id AS extraction_attempt_id
  FROM ai_distill.materials m LEFT JOIN LATERAL(SELECT a.id,a.sha256,a.content,a.attempt_id FROM ai_distill.artifacts a
   JOIN ai_distill.step_attempts t ON t.id=a.attempt_id AND t.status='succeeded'
   WHERE a.workflow_id=m.workflow_id AND a.material_id=m.id AND a.kind='private_extracted_pages'
   ORDER BY t.finished_at DESC NULLS LAST,a.created_at DESC,a.id DESC LIMIT 1) extracted ON true
  WHERE m.workflow_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at,m.id`,[workflowId])).rows as RawFile[];
 if(!files.length)throw conflict('该材料包没有已入库原件');
 const sourceDigest=hash(canonicalJson({workflow_id:workflowId,files:files.map(f=>({id:f.id,name:f.original_name,sha256:f.sha256,size:Number(f.size_bytes),extraction:f.artifact_id??null,extracted_sha:f.artifact_sha256??null}))}));
 return{workflow,files,source_digest:sourceDigest,signature:materialSetSignature(files)};
}

export async function readLegacyMaterialInventory(pool:Pool,phaseId:string){
 const packages=await pool.query(`SELECT w.id,w.title,s.status AS intake_status,
  (SELECT count(*)::int FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.deleted_at IS NULL) AS file_count,
  (SELECT jsonb_build_object('id',i.id,'package_id',i.package_id,'revision_id',i.revision_id,'use_id',i.use_id)
   FROM ai_distill.legacy_material_imports i WHERE i.source_phase_id=w.project_id AND i.source_workflow_id=w.id ORDER BY i.created_at DESC LIMIT 1) AS imported
  FROM ai_distill.workflows w LEFT JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=1
  WHERE w.project_id=$1 AND w.workflow_kind='material_package' AND w.deleted_at IS NULL ORDER BY w.created_at,w.id`,[phaseId]);
 return packages.rows;
}

async function textBlob(db:PoolClient,content:string){
 const sha=hash(content),type='application/vnd.ai-distill.extracted-document+json';
 const inserted=(await db.query(`INSERT INTO ai_distill.library_blobs(id,sha256,size_bytes,content_type,storage_kind,text_content)
  VALUES($1,$2,$3,$4,'database_text',$5) ON CONFLICT(sha256,content_type) WHERE storage_kind='database_text' DO NOTHING RETURNING id`,[randomUUID(),sha,Buffer.byteLength(content),type,content])).rows[0];
 if(inserted)return inserted.id;
 const existing=(await db.query("SELECT id,text_content FROM ai_distill.library_blobs WHERE sha256=$1 AND content_type=$2 AND storage_kind='database_text'",[sha,type])).rows[0];
 if(existing?.text_content!==content)throw conflict('旧提取内容与已有文本对象冲突');
 return existing.id;
}

async function importedJob(db:PoolClient,packageId:string,revisionId:string,kind:'intake'|'extract',snapshot:Record<string,unknown>,summary:Record<string,unknown>){
 const id=randomUUID(),config={origin:'legacy_import',protocol:'legacy-intake-import-v1'};
 await db.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,result_summary,finished_at,origin)
  VALUES($1,$2,$3,$4,'succeeded',$5,$6,$7::jsonb,$8,$9::jsonb,'internal','local',$10::jsonb,now(),'legacy_import')`,
  [id,packageId,revisionId,kind,randomUUID(),hash(canonicalJson(snapshot)),JSON.stringify(snapshot),hash(canonicalJson(config)),JSON.stringify(config),JSON.stringify(summary)]);
 return id;
}

export async function importLegacyMaterial(pool:Pool,root:string,phaseId:string,value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HTTPException(400,{message:'历史导入参数无效'});
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(key=>!['source_workflow_id','expected_source_digest','request_key','dry_run'].includes(key)))throw new HTTPException(400,{message:'历史导入包含未知参数'});
 const workflowId=uuid(String(input.source_workflow_id)),requestKey=uuid(String(input.request_key));
 if(input.dry_run!==undefined&&typeof input.dry_run!=='boolean')throw new HTTPException(400,{message:'dry_run必须为布尔值'});
 const source=await readLegacySource(pool,phaseId,workflowId);
 const prepared=await Promise.all(source.files.map(async file=>{
  const bytes=await readLibraryBlob(root,file.storage_path,file.sha256);
  if(bytes.byteLength!==Number(file.size_bytes))throw conflict('旧入库原件大小不匹配');
  const name=normalizeLibraryFilename(file.original_name),document=parseImportedDocument(file);
  validateFile(new File([new Uint8Array(bytes).buffer],name),bytes);
  return{file,bytes,name,document};
 }));
 if(new Set(prepared.map(f=>f.name)).size!==prepared.length)throw conflict('旧材料包存在重名文件，请先核对来源映射');
 const preview={source_workflow_id:workflowId,source_digest:source.source_digest,material_signature:source.signature,file_count:prepared.length,extracted_file_count:prepared.filter(f=>f.document).length,redaction_imported:false};
 if(input.dry_run!==false)return{...preview,dry_run:true};
 if(input.expected_source_digest!==source.source_digest)throw conflict('旧材料在预览后已变化，请重新dry-run');
 const settings=await buildDefaultProcessingSettings(pool),db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtext('legacy-material-import'),hashtext($1))",[source.signature]);
  const prior=(await db.query(`SELECT * FROM ai_distill.legacy_material_imports WHERE source_phase_id=$1 AND source_workflow_id=$2
   ORDER BY created_at DESC,id LIMIT 1`,[phaseId,workflowId])).rows[0];
  const equivalent=(await db.query("SELECT * FROM ai_distill.legacy_material_imports WHERE manifest->>'material_signature'=$1 ORDER BY created_at,id LIMIT 1",[source.signature])).rows[0];
  // 复用包时先锁包，再锁主项目/期次；避免与普通加载的包→主项目→期次顺序反转。
  const existingIds=[...new Set([prior?.package_id,equivalent?.package_id].filter(Boolean))].sort();
  if(existingIds.length)await db.query('SELECT id FROM ai_distill.library_packages WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[existingIds]);
  await db.query('SELECT g.id FROM ai_distill.project_groups g JOIN ai_distill.projects p ON p.project_group_id=g.id WHERE p.id=$1 FOR UPDATE OF g',[phaseId]);
  const locked=await readLegacySource(db,phaseId,workflowId,true);
  if(locked.source_digest!==source.source_digest)throw conflict('旧材料输入已变化');
  if(prior?.source_digest===source.source_digest){await db.query('COMMIT');return{...preview,...prior,reused:true};}
  const sameExtraction=equivalent&&source.files.every(file=>(equivalent.manifest.files??[]).some((old:any)=>old.source_sha256===file.sha256&&(old.source_artifact_sha256??null)===(file.artifact_sha256??null)));
  if(equivalent&&sameExtraction){
   const same=(await db.query('SELECT deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[equivalent.package_id])).rows[0];
   if(!same||same.deleted_at)throw conflict('相同原件已导入到归档材料包，请先恢复该包');
   const targetFiles=(await db.query('SELECT f.id,b.sha256 FROM ai_distill.library_files f JOIN ai_distill.library_blobs b ON b.id=f.blob_id WHERE f.revision_id=$1',[equivalent.revision_id])).rows;
   const files=source.files.map(file=>{
    const target=targetFiles.find(row=>row.sha256===file.sha256);if(!target)throw conflict('同源包的文件映射不完整');
    const original=(equivalent.manifest.files??[]).find((f:any)=>f.source_sha256===file.sha256);
    return{...original,legacy_material_id:file.id,file_id:target.id,source_sha256:file.sha256,original_name:file.original_name,source_attempt_id:file.extraction_attempt_id??null,source_artifact_sha256:file.artifact_sha256??null};
   });
   const id=randomUUID(),manifest={...equivalent.manifest,origin:'legacy_import',source_phase_id:phaseId,source_workflow_id:workflowId,source_digest:source.source_digest,files,request_key:requestKey};
   await db.query(`INSERT INTO ai_distill.legacy_material_imports(id,source_phase_id,source_workflow_id,source_digest,package_id,revision_id,manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[id,phaseId,workflowId,source.source_digest,equivalent.package_id,equivalent.revision_id,JSON.stringify(manifest)]);
   await db.query('COMMIT');return{...preview,id,package_id:equivalent.package_id,revision_id:equivalent.revision_id,reused:true};
  }
  const packageId=prior?.package_id??equivalent?.package_id??randomUUID(),revisionId=randomUUID();
  if(!prior&&!equivalent)await db.query('INSERT INTO ai_distill.library_packages(id,name,description,tags,processing_settings) VALUES($1,$2,$3,$4,$5::jsonb)',[packageId,source.workflow.title.slice(0,180),'旧材料入库结果导入',[],JSON.stringify(settings)]);
  const pkg=(await db.query('SELECT * FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[packageId])).rows[0];
  if(!pkg||pkg.deleted_at)throw conflict('目标材料包已归档');
  const entries=prepared.map(({file,name},index)=>({original_name:name,position:index+1,sha256:file.sha256,size_bytes:Number(file.size_bytes),redaction_mode:file.redaction_mode??'model'}));
  const manifest=buildLibraryManifest(entries);
  await db.query(`INSERT INTO ai_distill.library_revisions(id,package_id,parent_revision_id,state,manifest_sha256,file_count,source_info,request_key,request_digest)
   VALUES($1,$2,$3,'pending',$4,$5,$6::jsonb,$7,$8)`,[revisionId,packageId,pkg.current_revision_id,manifest.sha256,prepared.length,JSON.stringify({kind:'legacy_import',source_phase_id:phaseId,source_workflow_id:workflowId,source_digest:source.source_digest}),requestKey,source.source_digest]);
  const mappings=[];
  for(const [index,item] of prepared.entries()){
   const blob=await installLibraryBlob(root,item.bytes,item.file.content_type,'local');
   const inserted=(await db.query(`INSERT INTO ai_distill.library_blobs(id,sha256,size_bytes,content_type,storage_kind,storage_target,storage_path)
    VALUES($1,$2,$3,$4,'file','local',$5) ON CONFLICT(sha256,storage_target) WHERE storage_kind='file' DO NOTHING RETURNING id`,[randomUUID(),blob.sha256,blob.size_bytes,blob.content_type,blob.storage_path])).rows[0];
   const blobId=inserted?.id??(await db.query("SELECT id FROM ai_distill.library_blobs WHERE sha256=$1 AND storage_target='local' AND storage_kind='file'",[blob.sha256])).rows[0]?.id;
   if(!blobId)throw conflict('原件对象登记失败');
   const fileId=randomUUID();
   await db.query('INSERT INTO ai_distill.library_files(id,revision_id,blob_id,original_name,position,redaction_mode) VALUES($1,$2,$3,$4,$5,$6)',[fileId,revisionId,blobId,item.name,index+1,item.file.redaction_mode??'model']);
   const documentBlob=item.document?await textBlob(db,JSON.stringify(item.document)):null;
   mappings.push({legacy_material_id:item.file.id,file_id:fileId,source_sha256:item.file.sha256,original_name:item.name,source_attempt_id:item.file.extraction_attempt_id??null,source_artifact_sha256:item.file.artifact_sha256??null,document_blob_id:documentBlob});
  }
  const snapshot={origin:'legacy_import',source_phase_id:phaseId,source_workflow_id:workflowId,source_digest:source.source_digest,manifest_sha256:manifest.sha256,files:mappings};
  await importedJob(db,packageId,revisionId,'intake',snapshot,{file_count:prepared.length,origin:'legacy_import'});
  await db.query("UPDATE ai_distill.library_revisions SET state='ready',sealed_at=now() WHERE id=$1",[revisionId]);
  if(prepared.every(item=>item.document)){
   const extractionId=await importedJob(db,packageId,revisionId,'extract',snapshot,{file_count:prepared.length,page_count:prepared.reduce((n,f)=>n+f.document!.pages.length,0),origin:'legacy_import'});
   for(const [index,item] of prepared.entries()){
    const document=item.document!,blobId=mappings[index]!.document_blob_id;
    const issues=document.pages.flatMap((p:any)=>[...(p.issues??[]).map((kind:string)=>({page:p.page,kind})),...(!p.text.trim()?[{page:p.page,kind:'empty_page'}]:[]),...(/无法辨认|�/.test(p.text)?[{page:p.page,kind:'unreadable'}]:[])]);
    await db.query('INSERT INTO ai_distill.library_documents(id,revision_id,file_id,extraction_job_id,document_blob_id,source_sha256,text_sha256,page_count,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',[randomUUID(),revisionId,mappings[index]!.file_id,extractionId,blobId,item.file.sha256,hash(document.pages.map((p:any)=>p.text).join('\n')),document.pages.length,JSON.stringify(issues)]);
   }
  }
  await db.query('UPDATE ai_distill.library_packages SET current_revision_id=$2,lock_version=lock_version+1,updated_at=now() WHERE id=$1',[packageId,revisionId]);
  const id=randomUUID(),origin={...snapshot,material_signature:source.signature};
  await db.query('INSERT INTO ai_distill.legacy_material_imports(id,source_phase_id,source_workflow_id,source_digest,package_id,revision_id,manifest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[id,phaseId,workflowId,source.source_digest,packageId,revisionId,JSON.stringify(origin)]);
  await db.query('COMMIT');return{...preview,id,package_id:packageId,revision_id:revisionId,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

/** 每包原子激活历史引用；不要求新脱敏已完成，也不向旧题插入新库执行快照。 */
export async function activateLegacyImports(pool:Pool,phaseId:string,importId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const imported=(await db.query('SELECT * FROM ai_distill.legacy_material_imports WHERE id=$1 AND source_phase_id=$2',[importId,phaseId])).rows[0];
  if(!imported)throw new HTTPException(404,{message:'本期历史导入记录不存在'});
  // 同源原件可能在迁移前已由另一库包加载。历史导入保留自身版本，使用账及有效加载沿用规范包。
  const priorUse=(await db.query(`SELECT u.* FROM ai_distill.project_material_uses u JOIN ai_distill.projects p ON p.project_group_id=u.project_group_id
   WHERE p.id=$1 AND u.material_signature=$2`,[phaseId,imported.manifest.material_signature])).rows[0];
  const packageIds=[...new Set([imported.package_id,priorUse?.package_id].filter(Boolean))].sort();
  const lockedPackages=await db.query('SELECT id FROM ai_distill.library_packages WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE',[packageIds]);
  if(lockedPackages.rowCount!==packageIds.length)throw conflict('历史材料或规范材料包已归档，请先恢复');
  await db.query('SELECT g.id FROM ai_distill.project_groups g JOIN ai_distill.projects p ON p.project_group_id=g.id WHERE p.id=$1 FOR UPDATE OF g',[phaseId]);
  const phase=(await db.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[phaseId])).rows[0];
  if(!phase)throw new HTTPException(404,{message:'期次不存在'});
  const use=await claimMaterialUse(db,phase,priorUse?.package_id??imported.package_id,imported.manifest.material_signature,{historical:true,reason:'旧材料包原期次使用记录衔接'});
  const link=(await db.query('SELECT * FROM ai_distill.project_library_packages WHERE project_id=$1 AND package_id=$2 ORDER BY created_at,id LIMIT 1 FOR UPDATE',[phaseId,use.package_id])).rows[0];
  if(link)await db.query('UPDATE ai_distill.project_library_packages SET material_use_id=$2 WHERE id=$1',[link.id,use.id]);
  else await db.query('INSERT INTO ai_distill.project_library_packages(id,project_id,package_id,material_use_id,position) VALUES($1,$2,$3,$4,(SELECT COALESCE(max(position),0)+1 FROM ai_distill.project_library_packages WHERE project_id=$2))',[randomUUID(),phaseId,use.package_id,use.id]);
  const activated=await db.query('UPDATE ai_distill.legacy_material_imports SET use_id=$2 WHERE id=$1 AND use_id IS NULL RETURNING id',[importId,use.id]);
  if(imported.use_id&&imported.use_id!==use.id)throw conflict('历史材料已关联其他使用记录，请核对来源');
  if(activated.rowCount&&use.package_id!==imported.package_id)await db.query(`INSERT INTO ai_distill.project_material_use_events(id,use_id,event_type,status,reason,evidence)
   VALUES($1,$2,'legacy_import',$3,'相同原件的历史导入沿用已有规范材料使用记录',$4::jsonb)`,[randomUUID(),use.id,use.status,JSON.stringify({import_id:importId,source_workflow_id:imported.source_workflow_id,imported_package_id:imported.package_id,imported_revision_id:imported.revision_id,canonical_package_id:use.package_id,material_signature:imported.manifest.material_signature})]);
  await db.query('COMMIT');return{use_id:use.id,package_id:imported.package_id,use_package_id:use.package_id,owner_phase_id:phaseId,status:use.status};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
