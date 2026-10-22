/** 职责：执行已冻结的遮挡或化名脱敏，校验并事务发布材料库结果；由runner调度，不领取队列或选择期次模式。 */
import type {Pool} from 'pg';
import type {Page} from '../materials/pdf';
import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import {redactExtractedMaterials,renderRedactedMaterials,type ExtractedMaterial,type RedactedMaterial} from '../materials/redaction';
import {validateRedactionConfig,type RedactionConfig} from '../materials/redaction-config';
import {resolveRedactionExecution} from '../materials/redaction-execution';
import {runAgent} from '../agent';
import {createModelApiClient} from '../llm-api';
import {runExternalCall} from '../external-call';
import {assertLibraryExtractionUsable,finishLibraryJob} from './jobs';
import {insertLibraryTextBlob} from './storage';
import {prepareAgentLibraryMaterials} from './agent-redaction';
import {AGENT_REDACTION_MAX_MS} from '../../shared/redaction-templates';
import {hash,jobDirectory,ensurePages} from './execution-shared';
async function readExtractedDocuments(pool:Pool,job:any){
 const rows=(await pool.query(`SELECT d.file_id,d.document_blob_id,d.source_sha256,d.text_sha256,d.issues,b.sha256 AS blob_sha256,b.text_content,
  f.original_name,f.position,f.redaction_mode,lf.sha256 AS current_source_sha
  FROM ai_distill.library_documents d JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id JOIN ai_distill.library_files f ON f.id=d.file_id AND f.revision_id=d.revision_id
  JOIN ai_distill.library_blobs lf ON lf.id=f.blob_id WHERE d.extraction_job_id=$1 ORDER BY f.position`,[job.input_snapshot.extraction_job_id])).rows;
 const files=job.input_snapshot.files as any[];
 if(rows.length!==files.length)throw new Error('提取文档集合不完整');
 return rows.map(row=>{
  if(row.current_source_sha!==row.source_sha256||hash(row.text_content)!==row.blob_sha256||row.blob_sha256!==files.find(item=>item.file_id===row.file_id)?.document_sha256)throw new Error('提取文档摘要校验失败');
  const parsed=JSON.parse(row.text_content);
  if(parsed.version!==1||parsed.source_sha256!==row.source_sha256||!Array.isArray(parsed.pages))throw new Error('提取文档格式无效');
  const pages=ensurePages(parsed.pages,row.source_sha256).pages;
  if(hash(pages.map((page:Page)=>page.text).join('\n'))!==row.text_sha256)throw new Error('提取正文摘要校验失败');
  return{file_id:row.file_id,original_name:row.original_name,position:row.position,redaction_mode:row.redaction_mode,source_sha256:row.source_sha256,pages,issues:row.issues as Record<string,unknown>[]};
 });
}

export async function executeRedaction(pool:Pool,root:string,job:any,signal:AbortSignal){
 const documents=await readExtractedDocuments(pool,job),settings=job.config_snapshot.settings;
 // 旧队列可能早于派发前检查；在任何收费调用之前按相同门槛再次核对。
 assertLibraryExtractionUsable(documents);
 if(job.config_snapshot.redaction_template?.workflow==='codex_plan'){
  const output=await prepareAgentLibraryMaterials({directory:join(jobDirectory(root,job.id),'private'),files:documents.map(d=>({file_id:d.file_id,text_sha256:hash(d.pages.map(p=>p.text).join('\n')),pages:d.pages.map(p=>{if(!p.structure)throw new Error('Agent脱敏要求完整提取结构');return{...p,structure:p.structure};})})),revision_id:job.revision_id,extraction_job_id:job.input_snapshot.extraction_job_id,
   template:job.config_snapshot.redaction_template,model:settings.redaction.model,reasoning_effort:settings.redaction.reasoning_effort,signal,timeout_ms:Math.min(AGENT_REDACTION_MAX_MS,new Date(job.deadline_at).getTime()-Date.now()),
   ...(job.previous_job_id?{previous_directory:join(jobDirectory(root,job.previous_job_id),'private')}:{}),
   execute:options=>runExternalCall({library_job_id:job.id,library_package_id:job.package_id,library_revision_id:job.revision_id,operation:'library_preparation_agent'},call_id=>runAgent({...options,call_id})),
  });
  const materials=documents.map(d=>({material_id:d.file_id,pages:output.prepared.pages.filter(p=>p.file_id===d.file_id).map(p=>({page:p.page,text:p.text,structure:p.structure,issues:d.pages.find(original=>original.page===p.page)?.issues}))}));
  const rendered=renderRedactedMaterials(materials),index=JSON.parse(rendered.index);
  index.prepared_documents=output.prepared.documents.map((d,i)=>({id:d.id,title:d.title,text:d.text,duplicate_of:output.plan.documents[i]!.duplicate_of,segments:output.plan.documents[i]!.segments,document:d.document}));
  rendered.markdown=output.prepared.documents.map(d=>d.text).join('\n\n');index.redacted_sha256=hash(rendered.markdown);index.preparation_layout='preserved-structure';
  index.redaction_template={id:job.config_snapshot.redaction_template.id,digest:job.config_snapshot.redaction_template.digest,workflow:'codex_plan'};
  const indexText=JSON.stringify(index),outputDigest=hash({source:job.input_digest,markdown:hash(rendered.markdown),index:hash(indexText)});
  const report={material_processing_mode:'aliases',redaction_template_workflow:'codex_plan',usable_for_question:true,protocol:'agent-material-plan-v1',structure_mode:'preserved-structure',content_validation_scope:'exact_edits_and_source_coverage',redaction_template_id:job.config_snapshot.redaction_template.id,redaction_template_name:job.config_snapshot.redaction_template.name,redaction_template_digest:job.config_snapshot.redaction_template.digest,file_count:documents.length,page_count:output.prepared.pages.length,document_count:output.prepared.documents.length,entity_count:output.entity_count,unresolved_count:output.unresolved_count,extraction_issues:documents.filter(d=>d.issues.length).map(d=>({file_id:d.file_id,issues:d.issues}))};
  await finishLibraryJob(pool,job.id,job.lease_token,{...report,output_digest:outputDigest,model_provider:output.provider,model:output.model,usage:output.usage,duration_ms:output.duration_ms},async db=>{
   const markdown=await insertLibraryTextBlob(db,rendered.markdown,'text/markdown; charset=utf-8'),indexBlob=await insertLibraryTextBlob(db,indexText,'application/vnd.ai-distill.redacted-index+json');
   await db.query(`INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[crypto.randomUUID(),job.package_id,job.revision_id,job.input_snapshot.extraction_job_id,job.id,markdown.id,indexBlob.id,job.input_digest,outputDigest,JSON.stringify(report)]);
  });
  return;
 }
 const forceApiMask=job.input_snapshot.material_processing_mode==='mask';
 const pending=documents.filter(document=>forceApiMask||document.redaction_mode!=='declared_redacted'),declared=documents.filter(document=>!forceApiMask&&document.redaction_mode==='declared_redacted');
 const modelMaterials:ExtractedMaterial[]=pending.map(document=>({material_id:document.file_id,source_sha256:document.source_sha256,pages:document.pages}));
 let config:RedactionConfig|null=null,modelOutput:any=null;
 if(pending.length){
  config=validateRedactionConfig(settings.redaction);
  const dir=join(jobDirectory(root,job.id),'private');
  modelOutput=await redactExtractedMaterials({directory:dir,checkpointDirectory:dir,materials:modelMaterials,config,signal,execution:resolveRedactionExecution({task_timeout_ms:settings.execution.task_timeout_ms,request_timeout_ms:settings.execution.request_timeout_ms}),
   execute:options=>runExternalCall({library_job_id:job.id,library_package_id:job.package_id,library_revision_id:job.revision_id,operation:'library_redaction_agent'},call_id=>runAgent({...options,call_id})),
   executeApi:(request,operation)=>runExternalCall({library_job_id:job.id,library_package_id:job.package_id,library_revision_id:job.revision_id,operation},async call_id=>{
    try{return{...await createModelApiClient().complete({...request,call_id}),call_id};}catch(error){if(error instanceof Error)Object.assign(error,{call_id});throw error;}
   }),
  });
 }
 const redactedByFile=new Map<string,RedactedMaterial>((modelOutput?.materials??[]).map((item:RedactedMaterial)=>[item.material_id,item]));
 const composed:RedactedMaterial[]=documents.map(document=>{
  if(document.redaction_mode==='declared_redacted')return{material_id:document.file_id,pages:document.pages.map(page=>({page:page.page,text:page.text,structure:page.structure,issues:page.issues}))};
  const material=redactedByFile.get(document.file_id);if(!material)throw new Error('脱敏结果缺少材料附件');return material;
 });
 const rendered=renderRedactedMaterials(composed),markdownSha=hash(rendered.markdown),indexSha=hash(rendered.index),sourceDigest=job.input_digest;
 const validationReport={material_processing_mode:'mask',redaction_template_workflow:'field_mapping',...(job.config_snapshot.redaction_template?{redaction_template_id:job.config_snapshot.redaction_template.id,redaction_template_name:job.config_snapshot.redaction_template.name}:{}),usable_for_question:true,file_count:documents.length,page_count:documents.reduce((sum,document)=>sum+document.pages.length,0),extraction_issue_count:documents.reduce((sum,document)=>sum+document.issues.length,0),extraction_issues:documents.filter(document=>document.issues.length).map(document=>({file_id:document.file_id,issues:document.issues})),content_validation_scope:'extracted_source_to_redacted_body',declared_redacted_count:declared.length,protocol:'attachment-field-redaction-v32',field_mapping_validation:'passed',markdown_sha256:markdownSha,index_sha256:indexSha};
 const outputDigest=hash({protocol:'library-redaction-output-v1',package_id:job.package_id,revision_id:job.revision_id,extraction_job_id:job.input_snapshot.extraction_job_id,markdown_sha256:markdownSha,index_sha256:indexSha});
 const summary=await finishLibraryJob(pool,job.id,job.lease_token,{file_count:documents.length,page_count:validationReport.page_count,usable_for_question:validationReport.usable_for_question,output_digest:outputDigest,model_provider:config?.provider??'declared',model:config?.provider==='api'?config.api.model:config?.model??'none',usage:modelOutput?.usage??null,duration_ms:modelOutput?.duration_ms??0},async db=>{
  const markdown=await insertLibraryTextBlob(db,rendered.markdown,'text/markdown; charset=utf-8'),index=await insertLibraryTextBlob(db,rendered.index,'application/vnd.ai-distill.redacted-index+json');
  await db.query(`INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[crypto.randomUUID(),job.package_id,job.revision_id,job.input_snapshot.extraction_job_id,job.id,markdown.id,index.id,sourceDigest,outputDigest,JSON.stringify(validationReport)]);
 });
 if(summary)await rm(jobDirectory(root,job.id),{recursive:true,force:true});
}

