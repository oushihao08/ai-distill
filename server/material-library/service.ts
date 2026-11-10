/**
 * 文件职责：实现全局材料包元数据、不可变文件集合和处理默认配置。
 * 关键入口：`createLibraryPackage()`、`readLibraryPackages()`、`readLibraryPackage()`、`updateLibraryPackage()`、`archiveLibraryPackage()` 与 `createLibraryRevision()` 供材料库 HTTP 路由调用。
 * 边界：所有写入只涉及 library_* 表；上传原件写入独立受管 blob 目录，不创建项目或题目工作流。
 */
import {redactionJobCurrentValidationSql} from './processing-policy';
import {LIBRARY_LOAD_ASSESSMENT_VERSION} from './load-eligibility';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {canonicalJson} from '../../shared/workflow-config';
import {readSystemStepPrompts} from '../system-step-prompts';
import {ModelApiError,readModelApiDefaults,resolveModelApiConfig} from '../llm-api';
import {MAX_FILE,MAX_FOLDER_BATCH,validateFile,uuid} from '../validation';
import {cleanupRolledBackLibraryBlobs,installLibraryBlob,lockLibraryBlobWrites,normalizeLibraryFilename,type InstalledLibraryBlob} from './storage';

const conflict=(message:string)=>new HTTPException(409,{message});
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export interface LibraryFileInput {original_name:string;bytes:Uint8Array;redaction_mode?:'model'|'declared_redacted'}
export function validateLibraryPackageInput(value:unknown){
 if(!object(value)||Object.keys(value).some(key=>!['name','description','tags','processing_settings'].includes(key)))throw new HTTPException(400,{message:'材料包参数无效'});
 if(typeof value.name!=='string'||!value.name.trim()||value.name.trim().length>180)throw new HTTPException(400,{message:'材料包名称须为1至180字'});
 const description=value.description??'';
 if(typeof description!=='string'||description.length>10000)throw new HTTPException(400,{message:'材料包说明最多10000字'});
 const tags=value.tags??[];
 if(!Array.isArray(tags)||tags.length>50||tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.trim().length>80)||new Set(tags.map((tag:string)=>tag.trim())).size!==tags.length)throw new HTTPException(400,{message:'材料包标签无效或重复'});
 return{name:value.name.trim(),description,tags:tags.map((tag:string)=>tag.trim())};
}

export function buildLibraryManifest(files:Array<{original_name:string;position:number;sha256:string;size_bytes:number;redaction_mode:'model'|'declared_redacted'}>){
 const manifest={version:1,files:files.map(file=>({original_name:file.original_name,position:file.position,sha256:file.sha256,size_bytes:file.size_bytes,redaction_mode:file.redaction_mode}))};
 return{manifest,sha256:hash(canonicalJson(manifest))};
}

export function validateProcessingSettings(value:unknown){
 if(!object(value)||Object.keys(value).some(key=>!['version','extraction','redaction','execution','policy','redaction_templates'].includes(key))||value.version!==1||!object(value.extraction)||!object(value.redaction)||!object(value.execution)||!object(value.policy))throw new HTTPException(400,{message:'材料库处理设置格式无效'});
 const settings=value as Record<string,any>,extraction=settings.extraction,redaction=settings.redaction,execution=settings.execution,policy=settings.policy;
 if(Object.keys(extraction).some(key=>!['provider_config','protocol'].includes(key))||typeof extraction.protocol!=='string'||!extraction.protocol.trim()||!object(extraction.provider_config))throw new HTTPException(400,{message:'材料提取设置无效'});
 if(Object.keys(redaction).some(key=>!['provider','api','model','reasoning_effort','prompt'].includes(key))||!['api','codex'].includes(redaction.provider)||typeof redaction.prompt!=='string'||!redaction.prompt.trim()||redaction.prompt.length>12000)throw new HTTPException(400,{message:'材料脱敏设置无效'});
 if(redaction.provider==='api'&&(redaction.api!==null&&!object(redaction.api)||redaction.model!==undefined||redaction.reasoning_effort!==undefined))throw new HTTPException(400,{message:'材料库 API 模型设置无效'});
 if(redaction.provider==='api'&&object(redaction.api)){
  try{redaction.api=resolveModelApiConfig(redaction.api);}catch{throw new HTTPException(400,{message:'材料库 API 模型设置无效'});}
 }
 if(redaction.provider==='codex'&&(typeof redaction.model!=='string'||!redaction.model.trim()||typeof redaction.reasoning_effort!=='string'||redaction.api!==undefined))throw new HTTPException(400,{message:'材料库 Agent 模型设置无效'});
 if(Object.keys(execution).some(key=>!['task_timeout_ms','request_timeout_ms'].includes(key))||![execution.task_timeout_ms,execution.request_timeout_ms].every(item=>Number.isSafeInteger(item)&&item>0&&item<=1800000))throw new HTTPException(400,{message:'材料库执行预算无效'});
 if(Object.keys(policy).some(key=>!['preserve_amounts','preserve_dates'].includes(key))||policy.preserve_amounts!==true||policy.preserve_dates!==true)throw new HTTPException(400,{message:'材料库金额和日期策略必须保持原文'});
 if(settings.redaction_templates!==undefined){
  if(!Array.isArray(settings.redaction_templates)||settings.redaction_templates.length>20)throw new HTTPException(400,{message:'脱敏模板列表无效'});
  const ids=new Set<string>(['mask']);
  for(const template of settings.redaction_templates){
   if(!object(template)||Object.keys(template).some(k=>!['id','name','workflow','redaction'].includes(k))||typeof template.id!=='string'||! /^[a-z][a-z0-9_-]{0,47}$/.test(template.id)||ids.has(template.id)||typeof template.name!=='string'||!template.name.trim()||template.name.length>80||template.workflow!=='codex_plan')throw new HTTPException(400,{message:'脱敏模板身份或流程无效'});
   ids.add(template.id);
   const config=template.redaction;
   if(template.workflow==='codex_plan'&&(!object(config)||Object.keys(config).some(k=>!['provider','prompt'].includes(k))||config.provider!=='codex'))throw new HTTPException(400,{message:'整包计划模板仅配置Codex提示词，模型由执行会话固定'});
   const checked=validateProcessingSettings({...settings,redaction:template.workflow==='codex_plan'?{...(config as Record<string,unknown>),model:'session',reasoning_effort:'medium'}:config,redaction_templates:undefined}) as any;
   if(template.workflow==='codex_plan'&&checked.redaction.provider!=='codex')throw new HTTPException(400,{message:'整包代称计划模板必须使用Codex'});
  }
 }
 const encoded=JSON.stringify(value);
 if(encoded.length>300000||/(?:api[_-]?key|authorization|access[_-]?token|client[_-]?secret|credential[_-]?home)/i.test(encoded))throw new HTTPException(400,{message:'设置过大或包含凭据字段'});
 return JSON.parse(encoded) as Record<string,unknown>;
}

export async function buildDefaultProcessingSettings(pool:Pick<Pool,'query'>){
 const prompts=await readSystemStepPrompts(pool);
 let api:ReturnType<typeof readModelApiDefaults>|null=null;
 try{api=readModelApiDefaults();}catch(error){if(!(error instanceof ModelApiError))throw error;}
 // provider_config保留旧设置的读取契约；MinerU实际供应商在任务pdf_provider冻结，不再注入未执行的Vision配置。
 const settings={version:1,extraction:{provider_config:{},protocol:'material-extraction-v1'},redaction:{provider:'api',api,prompt:prompts[9]},execution:{task_timeout_ms:1200000,request_timeout_ms:180000},policy:{preserve_amounts:true,preserve_dates:true}};
 return validateProcessingSettings(settings);
}

export async function createLibraryPackage(pool:Pool,value:unknown){
 if(object(value)&&'processing_settings'in value)throw new HTTPException(400,{message:'请通过材料库共用处理设置配置模型和提示词'});
 const input=validateLibraryPackageInput(value),settings=await buildDefaultProcessingSettings(pool),id=randomUUID();
 await pool.query('INSERT INTO ai_distill.library_packages(id,name,description,tags,processing_settings) VALUES($1,$2,$3,$4,$5::jsonb)',[id,input.name,input.description,input.tags,JSON.stringify(settings)]);
 return{id,name:input.name,lock_version:1};
}

export async function readLibraryPackages(pool:Pool,options:{q?:string;page?:number;page_size?:number;ready_only?:boolean;project_ids?:string[];redaction_state?:string;preparation_state?:string;archived_only?:boolean;usage_project_id?:string;source_mode?:'any'|'redacted'|'original'}={}){
 const page=options.page??1,pageSize=options.page_size??30;
 if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new HTTPException(400,{message:'材料包分页参数无效'});
 const q=options.q?.trim()??'';
 if(q.length>180)throw new HTTPException(400,{message:'搜索词最多180字'});
 const projectIds=[...new Set(options.project_ids??[])];
 if(projectIds.length>100)throw new HTTPException(400,{message:'最多选择100个项目'});
 projectIds.forEach(id=>uuid(id));
 const usageProjectId=options.usage_project_id?uuid(options.usage_project_id):undefined;
 const state=options.redaction_state??'all';
 if(!['all','ready','not_ready'].includes(state))throw new HTTPException(400,{message:'脱敏状态无效'});
 const preparationState=options.preparation_state??'all';
 if(!['all','ready','not_ready'].includes(preparationState))throw new HTTPException(400,{message:'整理状态无效'});
 let preparationFilter='';
 if(preparationState!=='all'){
  const available=(await pool.query("SELECT to_regclass('ai_distill.library_preparations') IS NOT NULL AS available")).rows[0]?.available===true;
  preparationFilter=available?`AND ${preparationState==='not_ready'?'NOT ':''}EXISTS(
   SELECT 1 FROM ai_distill.library_preparations preparation
   JOIN ai_distill.library_jobs preparation_job ON preparation_job.id=preparation.job_id AND preparation_job.status='succeeded'
   WHERE preparation.package_id=p.id AND preparation.revision_id=r.id AND preparation.result->>'format'='material-preparation-v2'
  )`:preparationState==='ready'?'AND false':'';
 }

 const sourceMode=options.source_mode??'any';if(!['any','redacted','original'].includes(sourceMode))throw new HTTPException(400,{message:'材料来源模式无效'});
 const usageJoin=usageProjectId?`LEFT JOIN ai_distill.projects requested_phase ON requested_phase.id=$8::uuid AND requested_phase.deleted_at IS NULL
  LEFT JOIN ai_distill.project_material_uses material_use ON material_use.project_group_id=requested_phase.project_group_id AND material_use.package_id=p.id
  LEFT JOIN ai_distill.projects owner_phase ON owner_phase.id=material_use.owner_phase_id`:'';
 const usageProjection=usageProjectId?'material_use.status AS usage_status,owner_phase.phase_name AS used_phase_name,':'NULL::text AS usage_status,NULL::text AS used_phase_name,';
 const sourceModeParam=usageProjectId?'$9::text':'$8::text';
 const params:unknown[]=[q,pageSize,(page-1)*pageSize,options.ready_only===true,state,projectIds,options.archived_only===true];
 if(usageProjectId)params.push(usageProjectId);
 params.push(sourceMode,LIBRARY_LOAD_ASSESSMENT_VERSION);
 const result=await pool.query(`SELECT p.id,p.name,p.description,p.tags,p.current_revision_id,p.lock_version,p.deleted_at,p.created_at,p.updated_at,
  COALESCE(r.file_count,0)::int AS file_count,r.state AS revision_state,
  COALESCE((SELECT j.status FROM ai_distill.library_jobs j WHERE j.revision_id=r.id AND j.kind='intake' ORDER BY j.created_at DESC,j.id DESC LIMIT 1),CASE WHEN r.state='ready' THEN 'succeeded' ELSE 'not_started' END) AS intake_status,
  COALESCE((SELECT j.status FROM ai_distill.library_jobs j WHERE j.revision_id=r.id AND j.kind='extract' ORDER BY j.created_at DESC,j.id DESC LIMIT 1),'not_started') AS extraction_status,
  COALESCE((SELECT j.status FROM ai_distill.library_jobs j WHERE j.revision_id=r.id AND j.kind='redact' ORDER BY j.created_at DESC,j.id DESC LIMIT 1),'not_started') AS redaction_status,
  available.count AS available_redaction_count,
  extracted.count AS available_extraction_count,
  load_check.estimated_page_count AS load_estimated_docx_pages,load_check.load_eligible,
  ${usageProjection}
  (SELECT count(*)::int FROM ai_distill.project_library_packages l JOIN ai_distill.projects project ON project.id=l.project_id AND project.deleted_at IS NULL WHERE l.package_id=p.id AND l.removed_at IS NULL) AS loaded_project_count,
  count(*) OVER()::int AS total_count
  FROM ai_distill.library_packages p LEFT JOIN ai_distill.library_revisions r ON r.package_id=p.id AND r.id=p.current_revision_id
  CROSS JOIN LATERAL (SELECT count(*)::int FROM ai_distill.library_redactions x
   JOIN ai_distill.library_revisions v ON v.id=x.revision_id AND v.package_id=x.package_id AND v.state='ready'
   JOIN ai_distill.library_jobs e ON e.id=x.extraction_job_id AND e.revision_id=x.revision_id AND e.kind='extract' AND e.status='succeeded'
   JOIN ai_distill.library_jobs j ON j.id=x.redaction_job_id AND j.revision_id=x.revision_id AND j.kind='redact' AND j.status='succeeded'
   WHERE x.package_id=p.id AND x.validation_report->>'usable_for_question'='true' AND ${redactionJobCurrentValidationSql('j')}) available
  CROSS JOIN LATERAL (SELECT count(DISTINCT v.id)::int FROM ai_distill.library_revisions v
   JOIN ai_distill.library_jobs e ON e.revision_id=v.id AND e.kind='extract' AND e.status='succeeded'
   WHERE v.package_id=p.id AND v.state='ready'
    AND (SELECT count(*) FROM ai_distill.library_documents d WHERE d.revision_id=v.id AND d.extraction_job_id=e.id) = v.file_count) extracted
  LEFT JOIN LATERAL (SELECT eligibility.estimated_page_count,eligibility.load_eligible FROM ai_distill.library_jobs extraction_job
   LEFT JOIN ai_distill.library_load_eligibility eligibility ON eligibility.extraction_job_id=extraction_job.id
    AND eligibility.revision_id=r.id AND eligibility.assessment_version=$${params.length}
   WHERE extraction_job.revision_id=r.id AND extraction_job.kind='extract' AND extraction_job.status='succeeded'
    AND (SELECT count(*) FROM ai_distill.library_documents d WHERE d.revision_id=r.id AND d.extraction_job_id=extraction_job.id)=r.file_count
   ORDER BY extraction_job.finished_at DESC,extraction_job.id DESC LIMIT 1) load_check ON true
  ${usageJoin}
  WHERE (($7::boolean=false AND p.deleted_at IS NULL) OR ($7::boolean=true AND p.deleted_at IS NOT NULL))
  ${preparationFilter}
  AND ($4::boolean=false OR available.count>0)
  AND ($5::text='all' OR ($5::text='ready' AND available.count>0) OR ($5::text='not_ready' AND available.count=0))
  AND (${sourceModeParam}='any' OR (${sourceModeParam}='redacted' AND available.count>0) OR (${sourceModeParam}='original' AND extracted.count>0))
  AND (cardinality($6::uuid[])=0 OR EXISTS(SELECT 1 FROM ai_distill.project_library_packages l JOIN ai_distill.projects project ON project.id=l.project_id AND project.deleted_at IS NULL WHERE l.package_id=p.id AND l.removed_at IS NULL AND l.project_id=ANY($6::uuid[])))
  AND ($1::text='' OR p.name ILIKE '%'||$1::text||'%' OR p.description ILIKE '%'||$1::text||'%' OR $1::text=ANY(p.tags))
  ORDER BY p.updated_at DESC,p.id LIMIT $2 OFFSET $3`,params);
 const total=result.rows[0]?.total_count??0;
 const rows=result.rows.map(({total_count:_total_count,...row})=>row);
 const packageIds=rows.map(row=>row.id);
 const usesByPackage=new Map<string,unknown[]>();
 if(packageIds.length){
  // Only fetch use summaries for this page; the full event timeline remains in the detail endpoint.
  const uses=await pool.query(`SELECT u.package_id,jsonb_agg(jsonb_build_object(
    'id',u.id,'project_group_id',u.project_group_id,'project_name',g.name,'owner_phase_id',u.owner_phase_id,
    'phase_name',phase.phase_name,'phase_no',phase.phase_no,'status',u.status,'first_used_at',u.first_used_at
   ) ORDER BY g.name,phase.phase_no NULLS LAST,phase.phase_name,u.first_used_at) AS material_uses
   FROM ai_distill.project_material_uses u
   JOIN ai_distill.project_groups g ON g.id=u.project_group_id
   JOIN ai_distill.projects phase ON phase.id=u.owner_phase_id
   WHERE u.package_id=ANY($1::uuid[]) GROUP BY u.package_id`,[packageIds]);
  for(const row of uses.rows)usesByPackage.set(row.package_id,row.material_uses);
 }
 const items=rows.map(row=>({...row,material_uses:usesByPackage.get(row.id)??[]}));
 return{items,page,page_size:pageSize,total_count:total};
}

export async function readLibraryPackage(pool:Pool,id:string){
 const result=await pool.query(`SELECT p.id,p.name,p.description,p.tags,p.current_revision_id,p.lock_version,p.created_at,p.updated_at,
  (SELECT count(*)::int FROM ai_distill.project_library_packages l JOIN ai_distill.projects project ON project.id=l.project_id AND project.deleted_at IS NULL WHERE l.package_id=p.id AND l.removed_at IS NULL) AS loaded_project_count
  FROM ai_distill.library_packages p WHERE p.id=$1 AND p.deleted_at IS NULL`,[id]);
 if(!result.rowCount)throw new HTTPException(404,{message:'材料包不存在'});
 const revisions=await pool.query(`SELECT r.id,r.package_id,r.parent_revision_id,r.state,r.manifest_sha256,r.file_count,r.created_at,r.sealed_at,
  load_check.estimated_page_count AS load_estimated_docx_pages,load_check.load_eligible,
  COALESCE(jsonb_agg(jsonb_build_object('id',f.id,'revision_id',f.revision_id,'original_name',f.original_name,'position',f.position,'sha256',b.sha256,'size_bytes',b.size_bytes,'content_type',b.content_type,'redaction_mode',f.redaction_mode,'created_at',f.created_at) ORDER BY f.position) FILTER(WHERE f.id IS NOT NULL),'[]'::jsonb) AS files
  FROM ai_distill.library_revisions r LEFT JOIN ai_distill.library_files f ON f.revision_id=r.id LEFT JOIN ai_distill.library_blobs b ON b.id=f.blob_id
  LEFT JOIN LATERAL (SELECT eligibility.estimated_page_count,eligibility.load_eligible FROM ai_distill.library_jobs extraction_job
   LEFT JOIN ai_distill.library_load_eligibility eligibility ON eligibility.extraction_job_id=extraction_job.id
    AND eligibility.revision_id=r.id AND eligibility.assessment_version=$2
   WHERE extraction_job.revision_id=r.id AND extraction_job.kind='extract' AND extraction_job.status='succeeded'
    AND (SELECT count(*) FROM ai_distill.library_documents d WHERE d.revision_id=r.id AND d.extraction_job_id=extraction_job.id)=r.file_count
   ORDER BY extraction_job.finished_at DESC,extraction_job.id DESC LIMIT 1) load_check ON true
  WHERE r.package_id=$1 GROUP BY r.id,load_check.estimated_page_count,load_check.load_eligible ORDER BY r.created_at DESC,r.id`,[id,LIBRARY_LOAD_ASSESSMENT_VERSION]);
 return{...result.rows[0],revisions:revisions.rows};
}

export async function readLibraryRevisions(pool:Pool,id:string){
 const visible=await pool.query('SELECT id FROM ai_distill.library_packages WHERE id=$1 AND deleted_at IS NULL',[id]);
 if(!visible.rowCount)throw new HTTPException(404,{message:'材料包不存在'});
 return(await pool.query(`SELECT r.id,r.package_id,r.parent_revision_id,r.state,r.manifest_sha256,r.file_count,r.created_at,r.sealed_at,
  load_check.estimated_page_count AS load_estimated_docx_pages,load_check.load_eligible,
  COALESCE(jsonb_agg(jsonb_build_object('id',f.id,'original_name',f.original_name,'position',f.position,'sha256',b.sha256,'size_bytes',b.size_bytes,'content_type',b.content_type,'redaction_mode',f.redaction_mode,'image_review_required',f.image_review_required) ORDER BY f.position) FILTER(WHERE f.id IS NOT NULL),'[]'::jsonb) AS files,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',red.id,'extraction_job_id',red.extraction_job_id,'redaction_job_id',red.redaction_job_id,'output_digest',red.output_digest,'redaction_template_id',red.validation_report->>'redaction_template_id','redaction_template_workflow',COALESCE(red.validation_report->>'redaction_template_workflow',(SELECT j.config_snapshot->'redaction_template'->>'workflow' FROM ai_distill.library_jobs j WHERE j.id=red.redaction_job_id)),'redaction_template_name',red.validation_report->>'redaction_template_name','load_estimated_docx_pages',red_check.estimated_page_count,'load_eligible',red_check.load_eligible,'usable_for_question',(red.validation_report->>'usable_for_question'='true' AND r.state='ready'
     AND EXISTS(SELECT 1 FROM ai_distill.library_jobs e WHERE e.id=red.extraction_job_id AND e.revision_id=r.id AND e.kind='extract' AND e.status='succeeded')
     AND EXISTS(SELECT 1 FROM ai_distill.library_jobs j WHERE j.id=red.redaction_job_id AND j.revision_id=r.id AND j.kind='redact' AND j.status='succeeded' AND ${redactionJobCurrentValidationSql('j')})),'created_at',red.created_at) ORDER BY red.created_at DESC,red.id)
    FROM ai_distill.library_redactions red LEFT JOIN ai_distill.library_load_eligibility red_check
     ON red_check.revision_id=red.revision_id AND red_check.extraction_job_id=red.extraction_job_id AND red_check.assessment_version=$2
    WHERE red.revision_id=r.id),'[]'::jsonb) AS redactions,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',j.id,'kind',j.kind,'status',j.status,'origin',j.origin,'created_at',j.created_at,'finished_at',j.finished_at) ORDER BY j.created_at DESC) FROM ai_distill.library_jobs j WHERE j.revision_id=r.id),'[]'::jsonb) AS jobs
  FROM ai_distill.library_revisions r LEFT JOIN ai_distill.library_files f ON f.revision_id=r.id LEFT JOIN ai_distill.library_blobs b ON b.id=f.blob_id
  LEFT JOIN LATERAL (SELECT eligibility.estimated_page_count,eligibility.load_eligible FROM ai_distill.library_jobs extraction_job
   LEFT JOIN ai_distill.library_load_eligibility eligibility ON eligibility.extraction_job_id=extraction_job.id
    AND eligibility.revision_id=r.id AND eligibility.assessment_version=$2
   WHERE extraction_job.revision_id=r.id AND extraction_job.kind='extract' AND extraction_job.status='succeeded'
    AND (SELECT count(*) FROM ai_distill.library_documents d WHERE d.revision_id=r.id AND d.extraction_job_id=extraction_job.id)=r.file_count
   ORDER BY extraction_job.finished_at DESC,extraction_job.id DESC LIMIT 1) load_check ON true
  WHERE r.package_id=$1 GROUP BY r.id,load_check.estimated_page_count,load_check.load_eligible ORDER BY r.created_at DESC,r.id`,[id,LIBRARY_LOAD_ASSESSMENT_VERSION])).rows;
}

export async function updateLibraryPackage(pool:Pool,id:string,expectedVersion:number,value:unknown){
 if(object(value)&&'processing_settings'in value)throw new HTTPException(400,{message:'请通过材料库共用处理设置配置模型和提示词'});
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!object(value)||Object.keys(value).some(key=>!['name','description','tags','processing_settings'].includes(key)))throw new HTTPException(400,{message:'材料包更新参数无效'});
 const current=(await pool.query('SELECT lock_version,name,description,tags FROM ai_distill.library_packages WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
 if(!current)throw new HTTPException(404,{message:'材料包不存在'});
 if(Number(current.lock_version)!==expectedVersion)throw conflict('材料包已被其他操作更新，请刷新后重试');
 const input=validateLibraryPackageInput({name:value.name??current.name,description:value.description??current.description,tags:value.tags??current.tags});
 const saved=await pool.query(`UPDATE ai_distill.library_packages SET name=$3,description=$4,tags=$5,lock_version=lock_version+1,updated_at=now()
  WHERE id=$1 AND deleted_at IS NULL AND lock_version=$2 RETURNING id,name,description,tags,lock_version,updated_at`,[id,expectedVersion,input.name,input.description,input.tags]);
 if(!saved.rowCount)throw conflict('材料包已被其他操作更新，请刷新后重试');
 return saved.rows[0];
}

export async function archiveLibraryPackage(pool:Pool,id:string,expectedVersion:number){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const row=(await db.query('SELECT lock_version FROM ai_distill.library_packages WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
  if(!row)throw new HTTPException(404,{message:'材料包不存在'});
  if(Number(row.lock_version)!==expectedVersion)throw conflict('材料包已被其他操作更新，请刷新后重试');
  if((await db.query("SELECT id FROM ai_distill.library_jobs WHERE package_id=$1 AND status IN ('queued','running') LIMIT 1",[id])).rowCount)throw conflict('材料包仍有活动处理任务，结束后才能归档');
  const saved=await db.query('UPDATE ai_distill.library_packages SET deleted_at=now(),lock_version=lock_version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,deleted_at,lock_version',[id]);
  await db.query('COMMIT');return saved.rows[0];
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function restoreLibraryPackage(pool:Pool,id:string,expectedVersion:number){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const row=(await db.query('SELECT lock_version FROM ai_distill.library_packages WHERE id=$1 AND deleted_at IS NOT NULL FOR UPDATE',[id])).rows[0];
  if(!row)throw new HTTPException(404,{message:'已归档材料包不存在'});
  if(Number(row.lock_version)!==expectedVersion)throw conflict('材料包已被其他操作更新，请刷新后重试');
  const saved=await db.query('UPDATE ai_distill.library_packages SET deleted_at=NULL,lock_version=lock_version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id,deleted_at,lock_version',[id]);
  if(!saved.rowCount)throw conflict('材料包已被其他操作更新，请刷新后重试');
  await db.query('COMMIT');return saved.rows[0];
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

/** 返回材料包曾被加载和归档的项目/题目，包括已移除的项目加载关系与已撤回归档。 */
export async function readLibraryPackageUsage(pool:Pool,id:string){
 const exists=await pool.query('SELECT id FROM ai_distill.library_packages WHERE id=$1',[id]);
 if(!exists.rowCount)throw new HTTPException(404,{message:'材料包不存在'});
 const [loads,archives,uses]=await Promise.all([
  pool.query(`SELECT l.project_id,p.name AS project_name,l.selected_revision_id,l.selected_redaction_id,l.created_at,l.removed_at
   FROM ai_distill.project_library_packages l JOIN ai_distill.projects p ON p.id=l.project_id WHERE l.package_id=$1 ORDER BY l.created_at,l.id`,[id]),
  pool.query(`SELECT e.id,e.project_id,p.name AS project_name,e.workflow_id,w.title AS workflow_title,(w.id IS NOT NULL) AS workflow_exists,e.attempt_id,e.event_type,e.provenance,e.created_at,
    CASE WHEN w.id IS NULL THEN 'workflow_deleted'
      WHEN latest.provenance->'material_origin'->>'kind'='library_v1'
      AND latest.provenance->'material_origin'->>'package_id'=$1
      AND latest.provenance->'material_origin'->>'revision_id'=e.provenance->'material_origin'->>'revision_id'
      AND latest.provenance->'material_origin'->>'redaction_id'=e.provenance->'material_origin'->>'redaction_id'
      THEN latest.event_type ELSE 'superseded' END AS current_publication_event
   FROM ai_distill.workflow_publication_events e JOIN ai_distill.projects p ON p.id=e.project_id LEFT JOIN ai_distill.workflows w ON w.id=e.workflow_id
   LEFT JOIN LATERAL (SELECT event_type,provenance FROM ai_distill.workflow_publication_events WHERE workflow_id=e.workflow_id ORDER BY created_at DESC,id DESC LIMIT 1) latest ON true
   WHERE e.provenance->'material_origin'->>'kind'='library_v1' AND e.provenance->'material_origin'->>'package_id'=$1
   ORDER BY e.created_at,e.id`,[id]),
  pool.query(`SELECT u.id,u.project_group_id,g.name AS project_name,u.owner_phase_id,p.phase_name,p.phase_no,u.status,u.first_used_at,u.updated_at
   FROM ai_distill.project_material_uses u JOIN ai_distill.project_groups g ON g.id=u.project_group_id
   JOIN ai_distill.projects p ON p.id=u.owner_phase_id WHERE u.package_id=$1 ORDER BY u.first_used_at,u.id`,[id]),
 ]);
 const useEvents=uses.rows.length?await pool.query('SELECT e.id,e.use_id,e.event_type,e.previous_status,e.status,e.reason,e.evidence,e.created_at FROM ai_distill.project_material_use_events e WHERE e.use_id=ANY($1::uuid[]) ORDER BY e.created_at,e.id',[uses.rows.map(row=>row.id)]):{rows:[]};
 return{loaded_projects:loads.rows,publication_events:archives.rows,material_uses:uses.rows.map(use=>({...use,events:useEvents.rows.filter(event=>event.use_id===use.id)}))};
}

export async function createLibraryRevision(pool:Pool,storageRoot:string,id:string,expectedVersion:number,requestKey:string,files:LibraryFileInput[]){
 if(!Array.isArray(files)||files.length<1||files.length>100)throw new HTTPException(400,{message:'请选择1至100份材料'});
 let total=0;
 const prepared=files.map((file,index)=>{
  const original_name=normalizeLibraryFilename(file.original_name),redaction_mode=file.redaction_mode??'model';
  if(!['model','declared_redacted'].includes(redaction_mode))throw new HTTPException(400,{message:'材料脱敏声明无效'});
  const extension=original_name.split('.').at(-1)?.toLowerCase();
  if(!['pdf','docx','txt','md','png','jpg','jpeg'].includes(extension??''))throw new HTTPException(400,{message:'只支持PDF、DOCX、TXT、MD、PNG、JPG和JPEG材料'});
  total+=file.bytes.byteLength;
  if(file.bytes.byteLength>MAX_FILE||total>MAX_FOLDER_BATCH)throw new HTTPException(413,{message:'材料包大小超过限制'});
  const bytes=new Uint8Array(file.bytes),fileBuffer=new ArrayBuffer(bytes.byteLength);new Uint8Array(fileBuffer).set(bytes);
  const sourceFile=new File([fileBuffer],original_name);validateFile(sourceFile,bytes);
  const content_type=extension==='pdf'?'application/pdf':extension==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':extension==='png'?'image/png':extension==='jpg'||extension==='jpeg'?'image/jpeg':extension==='md'?'text/markdown':'text/plain';
  return{original_name,bytes,position:index+1,redaction_mode,content_type,sha256:hash(bytes),size_bytes:bytes.byteLength};
 });
 if(new Set(prepared.map(file=>file.original_name)).size!==prepared.length)throw new HTTPException(400,{message:'同一材料集合中的文件名不能重复'});
 if(prepared.some(file=>file.redaction_mode==='declared_redacted'&&!file.original_name.toLowerCase().endsWith('.docx')))throw new HTTPException(400,{message:'只有DOCX支持人工已脱敏声明'});
 const {manifest,sha256:manifestSha}=buildLibraryManifest(prepared),requestDigest=hash(canonicalJson({version:1,package_id:id,manifest_sha256:manifestSha,files:prepared.map(({original_name,position,sha256,size_bytes,redaction_mode})=>({original_name,position,sha256,size_bytes,redaction_mode}))}));
 const db=await pool.connect(),installed:InstalledLibraryBlob[]=[];
 try{
  await db.query('BEGIN');
  const pkg=(await db.query('SELECT current_revision_id,lock_version,deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!pkg||pkg.deleted_at)throw new HTTPException(404,{message:'材料包不存在'});
  const existing=(await db.query('SELECT id,request_digest FROM ai_distill.library_revisions WHERE package_id=$1 AND request_key=$2',[id,requestKey])).rows[0];
  if(existing){if(existing.request_digest!==requestDigest)throw conflict('同一请求标识对应了不同材料内容');await db.query('COMMIT');return{id:existing.id,reused:true};}
  if(Number(pkg.lock_version)!==expectedVersion)throw conflict('材料包已被其他操作更新，请刷新后重试');
  const revisionId=randomUUID(),parentRevisionId=pkg.current_revision_id??null;
  await db.query(`INSERT INTO ai_distill.library_revisions(id,package_id,parent_revision_id,state,manifest_sha256,file_count,source_info,request_key,request_digest)
   VALUES($1,$2,$3,'pending',$4,$5,$6::jsonb,$7,$8)`,[revisionId,id,parentRevisionId,manifestSha,prepared.length,JSON.stringify({kind:'upload',manifest_version:1}),requestKey,requestDigest]);
  await lockLibraryBlobWrites(db,prepared.map(file=>file.sha256));
  for(const file of prepared){
   const blob=await installLibraryBlob(storageRoot,file.bytes,file.content_type,'local');
   installed.push(blob);
   const inserted=await db.query(`INSERT INTO ai_distill.library_blobs(id,sha256,size_bytes,content_type,storage_kind,storage_target,storage_path)
    VALUES($1,$2,$3,$4,'file',$5,$6) ON CONFLICT(sha256,storage_target) WHERE storage_kind='file' DO NOTHING RETURNING id`,[randomUUID(),blob.sha256,blob.size_bytes,blob.content_type,blob.storage_target,blob.storage_path]);
   let blobId=inserted.rows[0]?.id;
   if(!blobId){
    const existingBlob=(await db.query("SELECT id,size_bytes,content_type,storage_path FROM ai_distill.library_blobs WHERE sha256=$1 AND storage_target=$2 AND storage_kind='file' FOR UPDATE",[blob.sha256,blob.storage_target])).rows[0];
    if(!existingBlob||Number(existingBlob.size_bytes)!==blob.size_bytes)throw conflict('已有材料对象与新文件的类型或摘要信息不一致');
    if(existingBlob.storage_path!==blob.storage_path){
     // installLibraryBlob has verified the exact bytes at this canonical path. Repair only the
     // locator while retaining the immutable SHA/size identity; older deployments may have
     // stored this relative path using a different platform layout.
     const repaired=await db.query(`UPDATE ai_distill.library_blobs SET storage_path=$2
      WHERE id=$1 AND sha256=$3 AND size_bytes=$4 AND storage_target=$5 AND storage_kind='file' RETURNING id`,[existingBlob.id,blob.storage_path,blob.sha256,blob.size_bytes,blob.storage_target]);
     if(!repaired.rowCount)throw conflict('材料对象路径修复未命中当前对象');
    }
    if(existingBlob.content_type!==blob.content_type){
     // 同一UTF8原件可按TXT/MD命名；复用已核验的字节，不改既有对象的MIME。
     // 历史PDF的scanned/text识别类别继续兼容，二进制格式仍不能混用。
     const compatibleText=['text/plain','text/markdown'].includes(blob.content_type)&&['text/plain','text/markdown'].includes(existingBlob.content_type);
     const legacyPdf=blob.content_type==='application/pdf'&&['scanned','text'].includes(existingBlob.content_type);
     if(!compatibleText&&!legacyPdf)throw conflict('已有材料对象与新文件的类型或摘要信息不一致');
    }
    blobId=existingBlob.id;
   }
   await db.query('INSERT INTO ai_distill.library_files(id,revision_id,blob_id,original_name,position,redaction_mode) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),revisionId,blobId,file.original_name,file.position,file.redaction_mode]);
  }
  const updated=await db.query('UPDATE ai_distill.library_packages SET current_revision_id=$2,lock_version=lock_version+1,updated_at=now() WHERE id=$1 AND lock_version=$3 AND deleted_at IS NULL RETURNING lock_version',[id,revisionId,expectedVersion]);
  if(!updated.rowCount)throw conflict('材料包已被其他操作更新，请刷新后重试');
  await db.query('COMMIT');return{id:revisionId,reused:false,lock_version:updated.rows[0].lock_version,manifest_sha256:manifestSha,manifest};
 }catch(error){
  try{await db.query('ROLLBACK');}
  catch(rollbackError){throw new AggregateError([error,rollbackError],'材料集合事务失败且回滚状态不确定；保留原件等待核对');}
  await cleanupRolledBackLibraryBlobs(db,storageRoot,installed);
  throw error;
 }finally{db.release();}
}

export type LibraryDbClient=PoolClient;
