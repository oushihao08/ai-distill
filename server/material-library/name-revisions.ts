/** 职责：读取本期材料/题包同源快照，生成名称修订预览并原子应用；由材料库HTTP路由调用，不运行模型或覆盖历史。 */
import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {HTTPException} from 'hono/http-exception';
import {canonicalJson} from '../../shared/workflow-config';
import {nameRevisionHash as hash,previewMaterialNames,previewQuestionNames} from '../authoring/name-revision-preview';
import type {NameReplacement} from '../authoring/name-replacements';
import {replaceNameTextTree} from '../authoring/name-replacements';
import {insertLibraryTextBlob} from './storage';
import {readQuestionMaterials} from '../question-materials';
import {assertAuthoringMaterialBinding} from '../publishing/feishu-verification';
import {renderPublicQuestionPackage} from '../authoring/executor';
import {inputDigest} from '../authoring/jobs';
import {readReviewedNameRevision,type ReviewedNameRevisionPackage} from './name-mapping-review';

const conflict=(message:string)=>new HTTPException(409,{message});
function requireRow(result:{rowCount:number|null},message:string){if(result.rowCount!==1)throw conflict(message);}
const revisionQuestionFields=(question:any)=>structuredClone({
 task_name:question.task_name,task_type:question.task_type,question:question.question,rubric:question.rubric,
 answer_approach:question.answer_approach,reference_answer:question.reference_answer,
});
async function previousFeishuAttachmentNames(db:PoolClient,workflowId:string){
 const row=(await db.query("SELECT content,sha256 FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx_manifest' ORDER BY created_at DESC,id DESC LIMIT 1",[workflowId])).rows[0];
 if(!row)return null;
 if(typeof row.content!=='string'||hash(row.content)!==row.sha256)throw conflict('现有材料DOCX清单摘要不匹配');
 let manifest:any;try{manifest=JSON.parse(row.content);}catch{throw conflict('现有材料DOCX清单损坏');}
 if(!Array.isArray(manifest?.materials)||!manifest.materials.length||manifest.materials.some((item:any)=>typeof item?.docx_sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.docx_sha256)))throw conflict('现有材料DOCX清单缺少附件摘要');
 return manifest.materials.map((item:any)=>`材料-${item.docx_sha256.slice(0,16)}.docx`);
}
export interface NameRevisionContext {project_id:string;redaction:any;originals:any[];workflows:any[]}

/** 读取同一事务中的库级结果与本期冻结结果；正文只返回本地私有接口，不写普通日志。 */
async function readContext(db:PoolClient,projectId:string,redactionId:string):Promise<NameRevisionContext>{
 const redaction=(await db.query(`SELECT r.id,r.package_id,r.revision_id,r.extraction_job_id,r.redaction_job_id,r.input_digest,r.output_digest,r.validation_report,
  m.text_content AS markdown,m.sha256 AS markdown_sha256,i.text_content AS index_content,i.sha256 AS index_sha256,
  p.name AS package_name,l.id AS link_id,l.lock_version AS link_version,l.selected_redaction_id
  FROM ai_distill.library_redactions r JOIN ai_distill.library_packages p ON p.id=r.package_id AND p.deleted_at IS NULL
  JOIN ai_distill.library_blobs m ON m.id=r.markdown_blob_id JOIN ai_distill.library_blobs i ON i.id=r.index_blob_id
  JOIN ai_distill.project_library_packages l ON l.package_id=r.package_id AND l.project_id=$1 AND l.removed_at IS NULL
  JOIN ai_distill.projects project ON project.id=l.project_id AND project.deleted_at IS NULL AND project.parent_name='豆包高经济价值'
  WHERE r.id=$2`,[projectId,redactionId])).rows[0];
 if(!redaction)throw new HTTPException(404,{message:'本期未加载指定脱敏材料'});
 if(redaction.selected_redaction_id!==redactionId)throw conflict('本期选用的脱敏结果已变化');
 if(typeof redaction.markdown!=='string'||typeof redaction.index_content!=='string'||hash(redaction.markdown)!==redaction.markdown_sha256||hash(redaction.index_content)!==redaction.index_sha256)throw conflict('库级脱敏正文或索引摘要不匹配');
 const originals=(await db.query(`SELECT f.id AS file_id,f.original_name,b.text_content AS document,b.sha256
  FROM ai_distill.library_files f JOIN ai_distill.library_documents d ON d.file_id=f.id AND d.revision_id=f.revision_id AND d.extraction_job_id=$2
  JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id WHERE f.revision_id=$1 ORDER BY f.position`,[redaction.revision_id,redaction.extraction_job_id])).rows;
 const index=JSON.parse(redaction.index_content);
 if(!originals.length||originals.length!==index.materials?.length)throw conflict('原件提取与脱敏文件集合不完整');
 for(const file of originals)if(typeof file.document!=='string'||hash(file.document)!==file.sha256)throw conflict('原件提取结构摘要不匹配');
 const workflows=(await db.query(`SELECT w.id,w.title,w.project_id,s.redaction_id,s.snapshot_manifest,s.snapshot_digest,s.markdown_artifact_id,s.index_artifact_id,
  s.project_material_id,s.package_id AS source_package_id,s.revision_id AS source_revision_id,s.request_key AS source_request_key,
  s.request_digest AS source_request_digest,s.material_mode,s.created_at AS source_created_at,
  m.content AS markdown,m.sha256 AS markdown_sha256,i.content AS index_content,i.sha256 AS index_sha256,
  q.result AS question,a.id AS source_attempt_id,a.input AS source_input,a.config AS source_config,
  EXISTS(SELECT 1 FROM ai_distill.step_attempts running WHERE running.workflow_id=w.id AND running.ordinal BETWEEN 4 AND 8 AND running.status IN ('waiting','running')) AS active,
  EXISTS(SELECT 1 FROM ai_distill.steps published WHERE published.workflow_id=w.id AND published.ordinal=8 AND published.status='succeeded') AS archived
  FROM ai_distill.question_library_sources s JOIN ai_distill.workflows w ON w.id=s.workflow_id AND w.deleted_at IS NULL
  JOIN ai_distill.artifacts m ON m.id=s.markdown_artifact_id AND m.workflow_id=w.id
  JOIN ai_distill.artifacts i ON i.id=s.index_artifact_id AND i.workflow_id=w.id
  LEFT JOIN ai_distill.steps q ON q.workflow_id=w.id AND q.ordinal=4 AND q.status='succeeded'
  LEFT JOIN LATERAL (SELECT id,input,config FROM ai_distill.step_attempts a WHERE a.workflow_id=w.id AND a.ordinal=4 AND a.status='succeeded'
   AND a.result->>'question_version'=q.result->>'question_version' AND a.result->>'rubric_version'=q.result->>'rubric_version' ORDER BY a.attempt DESC LIMIT 1) a ON true
  WHERE s.project_id=$1 AND s.package_id=$2 ORDER BY w.id`,[projectId,redaction.package_id])).rows;
 for(const w of workflows){
  if(w.redaction_id!==redactionId)throw conflict('题目冻结来源与当前库级结果不同，须逐题核对后修订');
  if(w.active||w.archived)throw conflict('题目有活动任务或已归档，不能生成可应用预览');
  if(!w.question||!w.source_attempt_id)throw conflict('缺少当前成功题包及冻结出题来源');
  if(typeof w.markdown!=='string'||typeof w.index_content!=='string'||hash(w.markdown)!==w.markdown_sha256||hash(w.index_content)!==w.index_sha256||hash(canonicalJson(w.snapshot_manifest))!==w.snapshot_digest)throw conflict('题目冻结材料摘要不匹配');
 }
 return{project_id:projectId,redaction,originals,workflows};
}

/** 先提供同版原件与旧结果，供逐包映射；不返回作者配置或历史答案/评分。 */
export async function readNameRevisionSource(pool:Pool,projectId:string,redactionId:string){
 return readSnapshot(pool,async db=>{
  const c=await readContext(db,projectId,redactionId);
  return{project_id:projectId,package_id:c.redaction.package_id,revision_id:c.redaction.revision_id,redaction_id:redactionId,source_digest:c.redaction.output_digest,
   originals:c.originals.map(f=>({file_id:f.file_id,original_name:f.original_name,document:JSON.parse(f.document)})),
   index:JSON.parse(c.redaction.index_content),workflows:c.workflows.map(w=>({workflow_id:w.id,title:w.title,snapshot_digest:w.snapshot_digest,question_version:w.question.question_version,rubric_version:w.question.rubric_version}))};
 });
}

function countText(text:string,term:string){let count=0,offset=0;while((offset=text.indexOf(term,offset))>=0){count++;offset+=term.length;}return count;}
function countTextTree(value:unknown,term:string):number{
 if(typeof value==='string')return countText(value,term);
 if(Array.isArray(value))return value.reduce((sum,item)=>sum+countTextTree(item,term),0);
 if(value&&typeof value==='object')return Object.values(value as Record<string,unknown>).reduce<number>((sum,item)=>sum+countTextTree(item,term),0);
 return 0;
}
function pointerValue(root:unknown,path:string){
 let value:any=root;
 for(const segment of path.split('/').slice(1)){const key=segment.replace(/~1/g,'/').replace(/~0/g,'~');if(value===null||typeof value!=='object'||!(key in value))return;value=value[key];}
 return value;
}
function assertReviewedEvidence(context:NameRevisionContext,review:ReviewedNameRevisionPackage,library:any,workflows:any[]){
 if(review.package_id!==context.redaction.package_id||review.redaction_id!==context.redaction.id)throw conflict('主体映射复核回执不属于当前材料包');
 if(context.workflows.length!==1||context.workflows[0].id!==review.workflow_id)throw conflict('主体映射复核回执与当前题目身份不一致');
 const originalFiles=new Map(context.originals.map(file=>[file.file_id,{...file,document:JSON.parse(file.document)}] as const));
 const redactedIndex=JSON.parse(context.redaction.index_content),redactedFiles=new Map((redactedIndex.materials??[]).map((material:any)=>[material.material_id,material] as const));
 for(const evidence of review.evidence){
  const unique=new Map(evidence.samples.map(sample=>[canonicalJson([sample.file_id,sample.page,sample.path]),sample] as const));
  let originalCount=0,beforeCount=0;
  for(const sample of unique.values()){
   const original:any=originalFiles.get(sample.file_id),redacted:any=redactedFiles.get(sample.file_id);
   if(!original||original.original_name!==sample.original_name||!redacted)throw conflict('主体映射坐标未绑定当前原件与脱敏文件');
   const originalPage=original.document.pages?.find((page:any)=>page.page===sample.page),redactedPage=redacted.document?.pages?.find((page:any)=>page.page===sample.page);
   const originalNode=pointerValue(originalPage?.structure??originalPage?.blocks,sample.path),redactedNode=pointerValue(redactedPage?.structure??redactedPage?.blocks,sample.path);
   if(typeof originalNode!=='string'||typeof redactedNode!=='string')throw conflict('主体映射坐标在当前结构中不存在');
   originalCount+=countText(originalNode,evidence.original);beforeCount+=countText(redactedNode,evidence.before);
  }
  if(originalCount!==evidence.count||beforeCount!==evidence.count)throw conflict('主体映射没有覆盖全部精确坐标，不能执行全局替换');
  if((library.counts[evidence.before]??0)!==evidence.count)throw conflict('库级正文旧名称命中数与复核坐标不一致');
  const questionHits=workflows.reduce((sum,workflow)=>sum+workflow.question_changes.reduce((inner:number,change:any)=>inner+(change.counts[evidence.before]??0),0),0);
  // 差异候选可能来自长文本字段内的局部主体片段，生成期的 question_hits 只统计长字段旧值，不能作为片段命中依据。
  // 以当前冻结题包的全部字符串为准，并要求所有出现位置均落入允许替换的业务字段；遗漏到身份/历史字段时继续阻断。
  const frozenQuestionHits=context.workflows.reduce((sum,workflow)=>sum+countTextTree(workflow.question,evidence.before),0);
  if(questionHits!==frozenQuestionHits)throw conflict('题包旧名称存在未覆盖的公开字段，不能应用名称修订');
 }
}

function workflowEvidence(review:ReviewedNameRevisionPackage,manifest:any){
 const ids=new Map((manifest?.files??[]).map((file:any)=>[file.library_file_id,file.material_id] as const));
 return review.evidence.map(evidence=>({...evidence,samples:evidence.samples.map(sample=>{
  const fileId=ids.get(sample.file_id);if(typeof fileId!=='string')throw conflict('题目快照缺少复核证据对应的附件身份');
  return{...sample,file_id:fileId};
 })}));
}

export function buildNameRevisionPreview(context:NameRevisionContext,mappings:NameReplacement[],review?:ReviewedNameRevisionPackage){
 const originalText=context.originals.map(file=>JSON.parse(file.document).pages.map((page:any)=>page.text).join('\n')).join('\n');
 const absent=mappings.filter(mapping=>!originalText.includes(mapping.original));
 if(absent.length)throw conflict('映射中的原主体未在本次原件提取正文中找到，须核对OCR和主体边界');
 const library=previewMaterialNames(context.redaction.markdown,context.redaction.index_content,mappings,review?.evidence);
 const missing=mappings.filter(mapping=>!library.counts[mapping.before]);
 if(missing.length)throw conflict('部分旧名称在库级正文中不存在，须核对旧化名与原件映射');
 const workflows=context.workflows.map(w=>{
  const material=previewMaterialNames(w.markdown,w.index_content,mappings,review?workflowEvidence(review,w.snapshot_manifest):undefined);
  const projectedDigest=hash(canonicalJson({previous:w.snapshot_digest,mappings,markdown:hash(material.markdown),index:hash(material.index)}));
  const q=previewQuestionNames(w.question,mappings,projectedDigest);
  return{workflow_id:w.id,question_version_before:w.question.question_version,rubric_version_before:w.question.rubric_version,snapshot_digest_before:w.snapshot_digest,
   material,question:q.question,question_changes:q.changes};
 });
 if(review)assertReviewedEvidence(context,review,library,workflows);
 const previewDigest=hash(canonicalJson({project_id:context.project_id,redaction_id:context.redaction.id,source_digest:context.redaction.output_digest,link_version:context.redaction.link_version,
  review:review?{call_id:review.review_call_id,request_digest:review.request_digest}:null,mappings,workflows:context.workflows.map(w=>({id:w.id,snapshot_digest:w.snapshot_digest,source_attempt_id:w.source_attempt_id,question:w.question,source_input:w.source_input}))}));
 return{preview_digest:previewDigest,review_call_id:review?.review_call_id??null,review_request_digest:review?.request_digest??null,project_id:context.project_id,package_id:context.redaction.package_id,redaction_id:context.redaction.id,mappings,library,workflows};
}
export async function previewNameRevision(pool:Pool,storageRoot:string,projectId:string,redactionId:string,reviewCallId:string){
 const review=await readReviewedNameRevision(storageRoot,reviewCallId,redactionId);
 return readSnapshot(pool,async db=>buildNameRevisionPreview(await readContext(db,projectId,redactionId),review.mappings,review));
}

/** 应用同一预览绑定的修订；新库级结果、题目快照、作者尝试与下游失效均在同一事务提交。 */
export async function applyNameRevision(pool:Pool,storageRoot:string,projectId:string,redactionId:string,raw:any,readMaterials=readQuestionMaterials,readReview=readReviewedNameRevision){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['project_id','request_key','preview_digest','review_call_id','reason'].includes(key))||
  typeof raw.request_key!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw.request_key)||
  typeof raw.review_call_id!=='string'||typeof raw.preview_digest!=='string'||!/^[a-f0-9]{64}$/.test(raw.preview_digest)||typeof raw.reason!=='string'||!raw.reason.trim()||raw.reason.length>500)throw new HTTPException(400,{message:'名称修订应用参数无效'});
 const review=await readReview(storageRoot,raw.review_call_id,redactionId),mappings=review.mappings;
 const requestDigest=hash(canonicalJson({project_id:projectId,redaction_id:redactionId,review_call_id:review.review_call_id,review_request_digest:review.request_digest,mappings,preview_digest:raw.preview_digest,reason:raw.reason}));
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='2s'");
  const pkg=(await db.query(`SELECT p.id FROM ai_distill.library_packages p JOIN ai_distill.library_redactions r ON r.package_id=p.id WHERE r.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF p`,[redactionId])).rows[0];
  if(!pkg)throw new HTTPException(404,{message:'脱敏材料不存在'});
  const prior=(await db.query('SELECT input_digest,result_summary FROM ai_distill.library_jobs WHERE package_id=$1 AND request_key=$2',[pkg.id,raw.request_key])).rows[0];
  if(prior){if(prior.input_digest!==requestDigest)throw conflict('请求标识已用于不同名称修订');if(!prior.result_summary?.name_revision_receipt)throw conflict('名称修订回执不完整，不能按请求标识复用');await db.query('COMMIT');return{...prior.result_summary.name_revision_receipt,reused:true};}
  await db.query('SELECT g.id FROM ai_distill.project_groups g JOIN ai_distill.projects p ON p.project_group_id=g.id WHERE p.id=$1 FOR UPDATE OF g',[projectId]);
  await db.query('SELECT id FROM ai_distill.projects WHERE id=$1 FOR UPDATE',[projectId]);
  await db.query('SELECT id FROM ai_distill.project_library_packages WHERE project_id=$1 AND package_id=$2 AND removed_at IS NULL FOR UPDATE',[projectId,pkg.id]);
  const targets=(await db.query(`SELECT w.id FROM ai_distill.workflows w JOIN ai_distill.question_library_sources s ON s.workflow_id=w.id
   WHERE s.project_id=$1 AND s.package_id=$2 AND w.deleted_at IS NULL ORDER BY w.id FOR UPDATE OF w`,[projectId,pkg.id])).rows;
  for(const w of targets)if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-workflow-v2'),hashtext($1)) AS locked",[w.id])).rows[0]?.locked)throw conflict('题目正在飞书同步');
  const context=await readContext(db,projectId,redactionId),preview=buildNameRevisionPreview(context,mappings,review);
  if(preview.preview_digest!==raw.preview_digest)throw conflict('预览后材料、题包或加载版本已变化，请重新预览');
  const jobId=randomUUID(),newRedactionId=randomUUID();
  const markdownBlob=await insertLibraryTextBlob(db,preview.library.markdown,'text/markdown; charset=utf-8');
  const indexBlob=await insertLibraryTextBlob(db,preview.library.index,'application/vnd.ai-distill.redacted-index+json');
  const outputDigest=hash(canonicalJson({source:context.redaction.output_digest,request_digest:requestDigest,markdown:hash(preview.library.markdown),index:hash(preview.library.index)}));
  const report={...context.redaction.validation_report,protocol:'name-revision-v1',source_redaction_id:redactionId,review_call_id:review.review_call_id,review_request_digest:review.request_digest,model_invoked:false,content_validation_scope:'reviewed_name_replacements_and_exact_coordinates',usable_for_question:true};
  requireRow(await db.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,previous_job_id,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,started_at,finished_at,result_summary)
   SELECT $1,package_id,revision_id,'redact','succeeded',$2,id,$3,$4::jsonb,$5,config_snapshot||$6::jsonb,'internal','local',now(),now(),$7::jsonb FROM ai_distill.library_jobs WHERE id=$8`,
   [jobId,raw.request_key,requestDigest,JSON.stringify({source_redaction_id:redactionId,extraction_job_id:context.redaction.extraction_job_id,review_call_id:review.review_call_id,review_request_digest:review.request_digest,mappings}),hash(canonicalJson({protocol:'name-revision-v1',review_request_digest:review.request_digest,mappings})),JSON.stringify({name_revision:{source_redaction_id:redactionId,review_call_id:review.review_call_id,review_request_digest:review.request_digest,reason:raw.reason}}),JSON.stringify({redaction_id:newRedactionId,output_digest:outputDigest,...report}),context.redaction.redaction_job_id]),'源脱敏任务已变化');
  await db.query(`INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[newRedactionId,pkg.id,context.redaction.revision_id,context.redaction.extraction_job_id,jobId,markdownBlob.id,indexBlob.id,requestDigest,outputDigest,JSON.stringify(report)]);
  requireRow(await db.query('UPDATE ai_distill.project_library_packages SET selected_redaction_id=$2,lock_version=lock_version+1,updated_at=now() WHERE id=$1',[context.redaction.link_id,newRedactionId]),'期次材料加载关系已变化');
  const receipts=[];
  for(const plan of preview.workflows){
   const old=context.workflows.find(w=>w.id===plan.workflow_id),attemptId=randomUUID(),markdownId=randomUUID(),indexId=randomUUID();
   const previousAttachmentNames=await previousFeishuAttachmentNames(db,old.id);
   const manifest=structuredClone(old.snapshot_manifest);
   manifest.origin={...manifest.origin,redaction_id:newRedactionId,source_digest:outputDigest};
   manifest.material_markdown={artifact_id:markdownId,sha256:hash(plan.material.markdown),kind:'redacted_markdown'};
   manifest.material_index={artifact_id:indexId,sha256:hash(plan.material.index),kind:'redacted_index'};
   if(manifest.material_scope)manifest.material_scope=replaceNameTextTree(manifest.material_scope,mappings,new Set(['title','summary','notes','package_summary','party','direction','scene','core_work','deliverables','visibility_reason'])).value;
   manifest.name_revision={source_snapshot_digest:old.snapshot_digest,source_redaction_id:redactionId,request_key:raw.request_key,review_call_id:review.review_call_id,review_request_digest:review.request_digest};
   const snapshotDigest=hash(canonicalJson(manifest));
   for(const artifact of [{id:markdownId,kind:'redacted_markdown',content:plan.material.markdown,suffix:'md'},{id:indexId,kind:'redacted_index',content:plan.material.index,suffix:'json'}]){
    await db.query(`INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,NULL,NULL,$3,$4,$5,$6,$7)`,
     [artifact.id,old.id,artifact.kind,`${old.id}/name-revisions/${raw.request_key}/${artifact.id}.${artifact.suffix}`,hash(artifact.content),Buffer.byteLength(artifact.content),artifact.content]);
   }
   requireRow(await db.query('DELETE FROM ai_distill.question_library_sources WHERE workflow_id=$1',[old.id]),'题目来源快照已变化');
   await db.query(`INSERT INTO ai_distill.question_library_sources(workflow_id,project_id,project_material_id,package_id,revision_id,redaction_id,source_digest,snapshot_manifest,snapshot_digest,markdown_artifact_id,index_artifact_id,request_key,request_digest,material_mode,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,[old.id,old.project_id,old.project_material_id,old.source_package_id,old.source_revision_id,newRedactionId,outputDigest,JSON.stringify(manifest),snapshotDigest,markdownId,indexId,old.source_request_key,old.source_request_digest,old.material_mode,old.source_created_at]);
   const materials=await readMaterials(db,old.id,storageRoot);
   const input={...old.source_input,material_origin:materials.origin,materials:materials.attachments.map(attachment=>({id:attachment.id,sha256:attachment.sha256})),
    ...(materials.model_attachments?{model_materials:materials.model_attachments.map(attachment=>({id:attachment.id,sha256:attachment.sha256}))}:{}),
    ...(old.source_input.material_scope?{material_scope:replaceNameTextTree(old.source_input.material_scope,mappings,new Set(['title','summary','notes','package_summary','party','direction','scene','core_work','deliverables','visibility_reason'])).value}:{})};
   if(!materials.model_attachments)delete input.model_materials;
   input.digest=inputDigest(input);
   assertAuthoringMaterialBinding(input,materials);
   const projected=previewQuestionNames(old.question,mappings,snapshotDigest,materials.attachments.map(attachment=>attachment.id)).question;
   const result={...projected,manual_revision:{attempt_id:attemptId,source_attempt_id:old.source_attempt_id,source_snapshot_digest:old.snapshot_digest,previous_question_version:old.question.question_version,previous_rubric_version:old.question.rubric_version,request_key:raw.request_key,reason:raw.reason,kind:'subject_names',
    before:{question:revisionQuestionFields(old.question),material_binding:{snapshot_digest:old.snapshot_digest,materials:structuredClone(old.source_input.materials??[])},attachment_names:previousAttachmentNames,completion_status:old.archived?'已完成':'未完成'},
    after:{question:revisionQuestionFields(projected),material_binding:{snapshot_digest:snapshotDigest,materials:structuredClone(input.materials)}},created_at:new Date().toISOString()}};
   await db.query(`INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,result,finished_at)
    SELECT $1,$2,4,COALESCE(MAX(attempt),0)+1,'succeeded',$3::jsonb,$4::jsonb,$5::jsonb,now() FROM ai_distill.step_attempts WHERE workflow_id=$2 AND ordinal=4`,[attemptId,old.id,JSON.stringify(input),JSON.stringify({...old.source_config,execution_kind:'manual_name_revision'}),JSON.stringify(result)]);
   const content=renderPublicQuestionPackage({question:old.title,project_name:'豆包高经济价值',source_files:input.source_files??[]},result);
   await db.query(`INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,'authored_question',$4,$5,$6,$7)`,[randomUUID(),old.id,attemptId,`${old.id}/${attemptId}/authored_question.md`,hash(content),Buffer.byteLength(content),content]);
   requireRow(await db.query("UPDATE ai_distill.steps SET result=$2::jsonb,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=4",[old.id,JSON.stringify(result)]),'题目步骤4不存在');
   await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal BETWEEN 5 AND 8",[old.id]);
   requireRow(await db.query("UPDATE ai_distill.workflows SET status='waiting',source_manifest=$2::jsonb WHERE id=$1",[old.id,JSON.stringify(manifest.files.map((f:any)=>({name:f.original_name,path:`${old.id}/name-revisions/${raw.request_key}/${markdownId}.md`,size:Buffer.byteLength(plan.material.markdown),sha256:hash(plan.material.markdown)})))]),'题目工作流已变化');
   await db.query("UPDATE ai_distill.project_exports SET status='stale',error='主体名称已显式修订',finished_at=now() WHERE project_id=$1 AND status IN ('running','succeeded') AND $2::uuid=ANY(workflow_ids)",[projectId,old.id]);
   receipts.push({workflow_id:old.id,attempt_id:attemptId,question_version:result.question_version,rubric_version:result.rubric_version,snapshot_digest:snapshotDigest,invalidated_ordinals:[5,6,7,8]});
  }
  const receipt={job_id:jobId,package_id:pkg.id,redaction_id:newRedactionId,source_redaction_id:redactionId,review_call_id:review.review_call_id,review_request_digest:review.request_digest,output_digest:outputDigest,workflows:receipts};
  requireRow(await db.query("UPDATE ai_distill.library_jobs SET result_summary=result_summary||jsonb_build_object('name_revision_receipt',$2::jsonb) WHERE id=$1",[jobId,JSON.stringify(receipt)]),'名称修订任务回执写入失败');
  await db.query('COMMIT');return{...receipt,reused:false};
 }catch(error){try{await db.query('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'名称修订应用失败且事务回滚状态未知');}throw error;}finally{db.release();}
}
async function readSnapshot<T>(pool:Pool,action:(db:PoolClient)=>Promise<T>){
 const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await action(db);await db.query('COMMIT');return result;}
 catch(error){try{await db.query('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'名称修订预览事务回滚失败');}throw error;}finally{db.release();}
}
