/**
 * 职责：通过HTTP导入Codex已审阅的精确编辑/分册计划，生成新的不可变库级脱敏结果。
 * 入口：importPreparedLibraryMaterials()供routes调用；同请求键复用，全部写入同一事务，不重跑OCR或模型，不修改旧结果。
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {prepareStructuredMaterialData} from '../../shared/prepared-structure';
import {prepareMaterialData,validateMaterialPreparationPlan} from '../../shared/material-preparation';
import {canonicalJson} from '../../shared/workflow-config';
import {insertLibraryTextBlob} from './storage';
import {renderRedactedMaterials} from '../materials/redaction';
import {documentBlocksToText} from '../materials/pdf';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const conflict=(s:string)=>new HTTPException(409,{message:s});
export async function importPreparedLibraryMaterials(pool:Pool,revisionId:string,body:any,_storageRoot?:string){
 const plan=body?.plan,requestKey=body?.request_key;
 try{validateMaterialPreparationPlan(plan);}catch(error){throw new HTTPException(400,{message:error instanceof Error?error.message:'材料计划格式无效'});}
 if(typeof requestKey!=='string'||!idPattern.test(requestKey)||plan.revision_id!==revisionId)throw new HTTPException(400,{message:'材料计划或请求标识无效'});
 const digest=hash(canonicalJson(plan)),db=await pool.connect();
 try{
  await db.query('BEGIN');
  const identity=(await db.query('SELECT package_id FROM ai_distill.library_revisions WHERE id=$1',[revisionId])).rows[0];if(!identity)throw conflict('来源版本不存在');
  const pkg=(await db.query('SELECT id,deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[identity.package_id])).rows[0];if(!pkg||pkg.deleted_at)throw conflict('材料包不可用');
  const revision=(await db.query('SELECT state,file_count FROM ai_distill.library_revisions WHERE id=$1 FOR UPDATE',[revisionId])).rows[0];if(revision?.state!=='ready')throw conflict('来源版本尚未入库');
  const prior=(await db.query('SELECT j.id,j.input_digest,r.id AS redaction_id FROM ai_distill.library_jobs j LEFT JOIN ai_distill.library_redactions r ON r.redaction_job_id=j.id WHERE j.package_id=$1 AND j.request_key=$2',[pkg.id,requestKey])).rows[0];
  if(prior){if(prior.input_digest!==digest||!prior.redaction_id)throw conflict('请求标识与已有任务不匹配');await db.query('COMMIT');return{job_id:prior.id,redaction_id:prior.redaction_id,reused:true};}
  // 模板字段记录生成计划时的审计上下文；导入只依赖稳定来源、精确编辑、覆盖和结构校验。
  const template=plan.template_id?{id:plan.template_id,name:plan.template_id,digest:plan.template_digest,workflow:'codex_plan'}:undefined;
  if((await db.query("SELECT id FROM ai_distill.library_jobs WHERE revision_id=$1 AND kind<>'prepare' AND status IN ('queued','running')",[revisionId])).rowCount)throw conflict('来源版本有活动任务');
  const extraction=(await db.query("SELECT id FROM ai_distill.library_jobs WHERE id=$1 AND revision_id=$2 AND kind='extract' AND status='succeeded'",[plan.extraction_job_id,revisionId])).rows[0];if(!extraction)throw conflict('提取任务未成功或与来源版本不符');
  const rows=(await db.query(`SELECT d.file_id,d.source_sha256,d.text_sha256,b.text_content,b.sha256 FROM ai_distill.library_documents d
   JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id JOIN ai_distill.library_files f ON f.id=d.file_id AND f.revision_id=d.revision_id
   JOIN ai_distill.library_blobs source ON source.id=f.blob_id
   WHERE d.revision_id=$1 AND d.extraction_job_id=$2 AND source.sha256=d.source_sha256 ORDER BY f.position`,[revisionId,extraction.id])).rows;
  if(rows.length!==Number(revision.file_count)||rows.length!==plan.files.length||new Set(plan.files.map((f:any)=>f?.file_id)).size!==rows.length)throw conflict('处理计划未覆盖全部附件');
  const originals=new Map<string,any>();const sourcePages=[];
  for(const row of rows){
   const file=plan.files.find((f:any)=>f?.file_id===row.file_id);let doc:any;
   try{doc=JSON.parse(row.text_content);}catch{throw conflict('提取原文结构无效');}
   if(hash(row.text_content)!==row.sha256||doc.source_sha256!==row.source_sha256||!Array.isArray(doc.pages)||!doc.pages.length||doc.pages.some((p:any)=>!Number.isSafeInteger(p.page)||typeof p.text!=='string'||!Array.isArray(p.structure)||documentBlocksToText(p.structure)!==p.text)||hash(doc.pages.map((p:any)=>p.text).join('\n'))!==row.text_sha256||file?.text_sha256!==row.text_sha256)throw conflict('提取原文摘要或结构不匹配');
   originals.set(row.file_id,doc);sourcePages.push(...doc.pages.map((p:any)=>({file_id:row.file_id,page:p.page,text:p.text,structure:p.structure})));
  }
  let prepared:any;
  try{prepared=template?prepareStructuredMaterialData(plan,sourcePages):prepareMaterialData(plan,sourcePages);}catch{throw new HTTPException(400,{message:'编辑或分册计划未通过原文/覆盖校验'});}
  const materials=rows.map(row=>({material_id:row.file_id,pages:prepared.pages.filter((p:any)=>p.file_id===row.file_id).map((p:any)=>({page:p.page,text:p.text,structure:p.structure??[{id:`prepared-${p.page}`,kind:'paragraph' as const,text:p.text}],issues:originals.get(row.file_id).pages.find((v:any)=>v.page===p.page)?.issues??[]}))}));
  const rendered=renderRedactedMaterials(materials),index=JSON.parse(rendered.index);
  // 安全分册元数据随题目索引冻结；原名/编辑原文仍只在私有任务配置中。
  index.prepared_documents=prepared.documents.map((d:any,i:number)=>({id:d.id,title:d.title,text:d.text,segments:plan.documents[i].segments,...(d.document?{document:d.document}:{})}));
  rendered.markdown=prepared.documents.map((d:any)=>d.text).join('\n\n');
  index.redacted_sha256=hash(rendered.markdown);
  index.preparation_layout=template?'preserved-structure':'extracted-page-text';
  if(template)index.redaction_template={id:template.id,digest:template.digest,workflow:template.workflow};
  const indexText=JSON.stringify(index),outputDigest=hash(canonicalJson({source:digest,markdown:hash(rendered.markdown),index:hash(indexText)}));
  const jobId=randomUUID(),redactionId=randomUUID(),lease=randomUUID(),config={protocol:'codex-reviewed-plan-v1',plan,...(template?{redaction_template:template}:{})};
  await db.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,started_at,deadline_at,lease_token,lease_expires_at,heartbeat_at)
   VALUES($1,$2,$3,'redact','running',$4,$5,$6::jsonb,$7,$8::jsonb,'internal','local',now(),now()+interval '2 minutes',$9,now()+interval '2 minutes',now())`,[jobId,pkg.id,revisionId,requestKey,digest,JSON.stringify({protocol:'codex-reviewed-plan-v1',extraction_job_id:extraction.id,files:plan.files}),hash(canonicalJson(config)),JSON.stringify(config),lease]);
  const markdownBlob=(await insertLibraryTextBlob(db,rendered.markdown,'text/markdown; charset=utf-8')).id,indexBlob=(await insertLibraryTextBlob(db,indexText,'application/vnd.ai-distill.redacted-index+json')).id;
  const report={usable_for_question:true,protocol:'codex-reviewed-plan-v1',content_validation_scope:'exact_edits_and_source_coverage',model_invoked:false,file_count:rows.length,page_count:prepared.pages.length,document_count:prepared.documents.length,structure_mode:template?'preserved-structure':'extracted-page-text',...(template?{redaction_template_id:template.id,redaction_template_name:template.name,redaction_template_digest:template.digest}:{}),extraction_issues:rows.map(row=>({file_id:row.file_id,pages:originals.get(row.file_id).pages.filter((p:any)=>p.issues?.length).map((p:any)=>({page:p.page,issues:p.issues}))}))};
  await db.query(`INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[redactionId,pkg.id,revisionId,extraction.id,jobId,markdownBlob,indexBlob,digest,outputDigest,JSON.stringify(report)]);
  await db.query("UPDATE ai_distill.library_jobs SET status='succeeded',finished_at=now(),lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,result_summary=$2::jsonb WHERE id=$1",[jobId,JSON.stringify({redaction_id:redactionId,output_digest:outputDigest,...report})]);
  await db.query('COMMIT');return{job_id:jobId,redaction_id:redactionId,output_digest:outputDigest,reused:false,...report};
 }catch(error){try{await db.query('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'材料导入回滚状态未知');}throw error;}finally{db.release();}
}
