/** 职责：执行已冻结的Agent化名脱敏，校验并事务发布材料库结果；由runner调度，不领取队列或选择期次模式。 */
import {cachedExternalCall} from '../execution-queue/runtime';
import type {Pool} from 'pg';
import type {Page} from '../materials/pdf';
import {join} from 'node:path';
import {renderRedactedMaterials} from '../materials/redaction';
import {type RedactionConfig} from '../materials/redaction-config';
import {isAgentProviderConfig,runAgent} from '../agent';
import {runExternalCall} from '../external-call';
import {assertLibraryExtractionUsable,finishLibraryJob} from './jobs';
import {insertLibraryTextBlob} from './storage';
import {prepareAgentLibraryMaterials} from './agent-redaction';
import {apiMaterialExecutor} from './api-redaction';
import {hash,jobDirectory,ensurePages} from './execution-shared';
import {AGENT_TEXT_REDACTION_PROTOCOL} from '../../shared/agent-material-plan';
import {fileIdentityMapping,remapResultIds,revisionFileIdentities,sameOriginalSetSql} from './result-reuse';
import {redactionJobCurrentValidationSql} from './processing-policy';
import {logEvent,classifyLogError} from '../logging';

/** 成功整包化名只在原件集合完全相同时复用；仍为当前包发布独立结果和来源绑定。 */
async function reuseRedaction(pool:Pool,job:RedactionJob){
 if(job.previous_job_id)return false;
 const candidates=(await pool.query(`SELECT r.id,r.revision_id,r.redaction_job_id,r.markdown_blob_id,r.index_blob_id,r.validation_report
  FROM ai_distill.library_redactions r
  JOIN ai_distill.library_jobs j ON j.id=r.redaction_job_id AND j.package_id=r.package_id AND j.status='succeeded'
  WHERE r.validation_report->>'usable_for_question'='true' AND ${redactionJobCurrentValidationSql('j')}
   AND r.validation_report->>'material_processing_mode'='aliases' AND ${sameOriginalSetSql('r.revision_id')}
  ORDER BY r.created_at DESC LIMIT 10`,[job.revision_id])).rows;
 if(!candidates.length)return false;
 const target=await revisionFileIdentities(pool,job.revision_id);
 for(const candidate of candidates){
  let index:any,report:any,markdownText='';
  try{
   const mapping=fileIdentityMapping(await revisionFileIdentities(pool,candidate.revision_id),target);
   if(!mapping)continue;
   const blobs=(await pool.query(`SELECT m.text_content AS markdown,m.sha256 AS markdown_sha256,
    i.text_content AS index_content,i.sha256 AS index_sha256
    FROM ai_distill.library_blobs m,ai_distill.library_blobs i
    WHERE m.id=$1 AND i.id=$2`,[candidate.markdown_blob_id,candidate.index_blob_id])).rows[0];
   if(!blobs||hash(blobs.markdown)!==blobs.markdown_sha256||hash(blobs.index_content)!==blobs.index_sha256)continue;
   markdownText=blobs.markdown;
   index=remapResultIds(JSON.parse(blobs.index_content),mapping);
   if(index.text_protocol!==AGENT_TEXT_REDACTION_PROTOCOL||index.format!=='redacted-index-v2'||!Array.isArray(index.materials)||index.materials.length!==target.length)continue;
   const ids=new Set(index.materials.map((item:any)=>item.material_id));
   if(target.some(file=>!ids.has(file.id)))continue;
   report=remapResultIds(candidate.validation_report,mapping);
  }catch(error){logEvent('library_result.reuse_unusable',{level:'warn',kind:'redact',...classifyLogError(error)});continue;}
  const indexText=JSON.stringify(index),outputDigest=hash({source:job.input_digest,markdown:hash(markdownText),index:hash(indexText)});
  await finishLibraryJob(pool,job.id,job.lease_token,{...report,output_digest:outputDigest,reused_from_job_id:candidate.redaction_job_id},async db=>{
   const markdown=await insertLibraryTextBlob(db,markdownText,'text/markdown; charset=utf-8'),indexBlob=await insertLibraryTextBlob(db,indexText,'application/vnd.ai-distill.redacted-index+json');
   await db.query(`INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[crypto.randomUUID(),job.package_id,job.revision_id,job.input_snapshot.extraction_job_id,job.id,markdown.id,indexBlob.id,job.input_digest,outputDigest,JSON.stringify(report)]);
  });
  return true;
 }
 return false;
}

/** 只描述本执行器实际读取的冻结字段；原始队列行的其他元数据不参与正文组装。 */
type RedactionJob={
 id:string;package_id:string;revision_id:string;lease_token:string;input_digest:string;deadline_at:string;previous_job_id?:string|null;
 input_snapshot:{extraction_job_id:string;material_processing_mode?:string;files:{file_id:string;document_sha256:string}[]};
 config_snapshot:{
  text_protocol?:string;
  settings:{redaction:RedactionConfig;execution:{task_timeout_ms:number;request_timeout_ms:number}};
  redaction_template?:Parameters<typeof prepareAgentLibraryMaterials>[0]['template']&{name:string;workflow:'codex_plan'};
 };
};
type ExtractedRow={
 file_id:string;document_blob_id:string;source_sha256:string;text_sha256:string;issues:Record<string,unknown>[];
 blob_sha256:string;text_content:string;original_name:string;position:number;redaction_mode:'model'|'declared_redacted';current_source_sha:string;
};

async function readExtractedDocuments(pool:Pool,job:RedactionJob){
 const rows=(await pool.query<ExtractedRow>(`SELECT d.file_id,d.document_blob_id,d.source_sha256,d.text_sha256,d.issues,b.sha256 AS blob_sha256,b.text_content,
  f.original_name,f.position,f.redaction_mode,lf.sha256 AS current_source_sha
  FROM ai_distill.library_documents d JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id JOIN ai_distill.library_files f ON f.id=d.file_id AND f.revision_id=d.revision_id
  JOIN ai_distill.library_blobs lf ON lf.id=f.blob_id WHERE d.extraction_job_id=$1 ORDER BY f.position`,[job.input_snapshot.extraction_job_id])).rows;
 const files=job.input_snapshot.files;
 if(rows.length!==files.length)throw new Error('提取文档集合不完整');
 return rows.map(row=>{
  if(!files.some(item=>item.file_id===row.file_id))throw new Error('提取文档ID不匹配');
  const parsed=JSON.parse(row.text_content) as {version?:number;source_sha256?:string;pages?:Page[]};
  if(parsed.version!==1||!Array.isArray(parsed.pages))throw new Error('提取文档格式无效');
  const pages=ensurePages(parsed.pages,row.source_sha256).pages;
  return{file_id:row.file_id,original_name:row.original_name,position:row.position,redaction_mode:row.redaction_mode,source_sha256:row.source_sha256,pages,issues:row.issues as Record<string,unknown>[]};
 });
}

/** 只允许正文坐标进入脱敏Agent，拒绝将提取页上的图片元数据或路径透传。 */
export function redactionPageInput(page:Page){
 if(!page.structure)throw new Error('Agent脱敏要求完整提取结构');
 return{page:page.page,text:page.text,structure:page.structure,method:page.method};
}

export async function executeRedaction(pool:Pool,root:string,job:RedactionJob,signal:AbortSignal,execute:typeof runAgent=runAgent){
 // 旧冻结队列也不能回退到已删除的字段映射引擎；不调用模型、不改写历史结果。
 if(job.config_snapshot.redaction_template?.workflow!=='codex_plan')throw new Error('字段映射脱敏已删除，请重新创建Agent化名任务');
 if(job.config_snapshot.text_protocol!==AGENT_TEXT_REDACTION_PROTOCOL)throw Object.assign(new Error('脱敏文本协议不兼容，请重新创建任务'),{reason_code:'agent_text_protocol_invalid'});
 const documents=await readExtractedDocuments(pool,job),settings=job.config_snapshot.settings;
 // 旧队列可能早于派发前检查；在任何收费调用之前按相同门槛再次核对。
 assertLibraryExtractionUsable(documents);
 if(await reuseRedaction(pool,job))return;
 const template=job.config_snapshot.redaction_template;
 if(template?.workflow==='codex_plan'){
  const agentConfig=settings.redaction;
  const isAgent=isAgentProviderConfig(agentConfig);
  const api=isAgent||agentConfig.provider!=='api'?undefined:agentConfig.api;
  // provider='web' 仅为离线作业台：导出zip待人工交回，交回后回放回复并走同一编译器。
  const web=!isAgent&&agentConfig.provider==='web'?agentConfig.web:undefined;
  const model=isAgent?agentConfig.model:agentConfig.provider==='api'?agentConfig.api.model:web?`web:${web.provider}`:'';
  const reasoning=isAgent?agentConfig.reasoning_effort:'none';
  const executeModel=api?apiMaterialExecutor(api):web?(await import('../web-executors/redaction')).offlineMaterialExecutor(web):execute;
  const output=await cachedExternalCall('library_preparation_complete',()=>prepareAgentLibraryMaterials({directory:join(jobDirectory(root,job.id),'private'),files:documents.map(d=>({file_id:d.file_id,text_sha256:hash(d.pages.map(p=>p.text).join('\n')),pages:d.pages.map(redactionPageInput)})),revision_id:job.revision_id,extraction_job_id:job.input_snapshot.extraction_job_id,
   template,model,reasoning_effort:reasoning,...(api?{api}:{}),signal,timeout_ms:new Date(job.deadline_at).getTime()-Date.now(),
   ...(job.previous_job_id?{previous_directory:join(jobDirectory(root,job.previous_job_id),'private')}:{}),
   execute:options=>runExternalCall({library_job_id:job.id,library_package_id:job.package_id,library_revision_id:job.revision_id,operation:api?'library_preparation_api':web?'library_preparation_offline':'library_preparation_agent'},call_id=>executeModel({...options,call_id})),
  }));
  // 不换调用缓存键重调旧/未知请求；旧缓存缺少新协议时拒绝发布，交由显式新任务处理。
  if(output.text_protocol!==AGENT_TEXT_REDACTION_PROTOCOL)throw Object.assign(new Error('脱敏调用缓存不符合当前文本协议，请重新创建任务'),{reason_code:'agent_text_protocol_invalid'});
  const materials=documents.map(d=>({material_id:d.file_id,pages:output.prepared.pages.filter((p:any)=>p.file_id===d.file_id).map((p:any)=>({page:p.page,text:p.text,structure:p.structure,issues:d.pages.find(original=>original.page===p.page)?.issues}))}));
  const rendered=renderRedactedMaterials(materials),index=JSON.parse(rendered.index);
  index.prepared_documents=output.prepared.documents.map((d:any,i:number)=>({id:d.id,title:d.title,text:d.text,duplicate_of:output.plan.documents[i]!.duplicate_of,segments:output.plan.documents[i]!.segments,document:d.document}));
  rendered.markdown=output.prepared.documents.map((d:any)=>d.text).join('\n\n');index.redacted_sha256=hash(rendered.markdown);index.preparation_layout='preserved-structure';
  index.redaction_template={id:template.id,digest:template.digest,workflow:'codex_plan'};
  index.text_protocol=output.text_protocol;
  const indexText=JSON.stringify(index),outputDigest=hash({source:job.input_digest,markdown:hash(rendered.markdown),index:hash(indexText)});
  const report={material_processing_mode:'aliases',redaction_template_workflow:'codex_plan',usable_for_question:true,protocol:'agent-material-plan-v1',text_protocol:output.text_protocol,structure_mode:'preserved-structure',content_validation_scope:'exact_edits_and_source_coverage',redaction_template_id:template.id,redaction_template_name:template.name,redaction_template_digest:template.digest,file_count:documents.length,page_count:output.prepared.pages.length,document_count:output.prepared.documents.length,entity_count:output.entity_count,unresolved_count:output.unresolved_count,extraction_issues:documents.filter(d=>d.issues.length).map(d=>({file_id:d.file_id,issues:d.issues}))};
  await finishLibraryJob(pool,job.id,job.lease_token,{...report,output_digest:outputDigest,model_provider:output.provider,model:output.model,requested_model:output.requested_model,returned_model:output.returned_model,usage:output.usage,duration_ms:output.duration_ms},async db=>{
   const markdown=await insertLibraryTextBlob(db,rendered.markdown,'text/markdown; charset=utf-8'),indexBlob=await insertLibraryTextBlob(db,indexText,'application/vnd.ai-distill.redacted-index+json');
   await db.query(`INSERT INTO ai_distill.library_redactions(id,package_id,revision_id,extraction_job_id,redaction_job_id,markdown_blob_id,index_blob_id,input_digest,output_digest,validation_report) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[crypto.randomUUID(),job.package_id,job.revision_id,job.input_snapshot.extraction_job_id,job.id,markdown.id,indexBlob.id,job.input_digest,outputDigest,JSON.stringify(report)]);
  });
  return;
 }
 throw new Error('字段映射脱敏已删除，请重新创建Agent化名任务');
}
