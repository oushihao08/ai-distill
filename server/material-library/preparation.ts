/**
 * 文件职责：可选材料整理任务的来源读取、入队/续作、Agent/API 执行、逐图判断与 HTTP 路由装配。
 * 关键入口：`enqueuePreparation()`、`resumePreparation()`、`executePreparation()`、`findMatchingPreparation()`、`registerPreparationRoutes()`；提示词与私有检查点由 `preparation-support.ts` 提供并在此重导出。
 * 边界：未执行或未采用整理不阻止加载与建题；worker 复用 `library_jobs` 租约与 Agent/API 槽位。
 */
import {documentPagesToModelText} from '../../shared/document-structure';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {runAgent,readAgentDefaults,validateAgentModelSettings} from '../agent';
import {createModelApiClient,resolveModelApiConfig,type ModelApiConfig} from '../llm-api';
import {localQueueEnabled,localExecutionQueue,registerLocalJob,forgetLocalRegistrations,releaseRolledBackRegistrations,cachedExternalCall} from '../execution-queue/runtime';
import {logEvent,classifyLogError} from '../logging';
import {runExternalCall} from '../external-call';
import {validateWebAgentSettings,type WebAgentSettings} from '../../shared/web-agent';
import {finishLibraryJob} from './jobs';
import {hash,jobDirectory} from './execution-shared';
import {readLibraryBlob} from './storage';
import {preparationUnits,preparationBlocks,compileFixedPreparation,materializePreparation,MATERIAL_PREPARATION_SINGLE_SCHEMA,type MaterialPreparationResult} from '../../shared/material-preparation-result';
import {PREPARATION_PROMPT,runPreparationCheckpoint,imageDecisionCheckpoint} from './preparation-support';
export {PREPARATION_PROMPT,runPreparationCheckpoint};

type Db=Pick<PoolClient,'query'>;
export type PreparationSource={material_mode:'original'|'redacted';package_id:string;revision_id:string;redaction_id:string|null;extraction_job_id:string;source_digest:string;index:any};
const conflict=(message:string)=>new HTTPException(409,{message});
/** 续作创建新job，继承明确来源与模型；不领取任务、不启动worker。 */
export async function resumePreparation(pool:Pool,root:string,previousJobId:string,body:any){
 const previous=(await pool.query("SELECT * FROM ai_distill.library_jobs WHERE id=$1 AND kind='prepare'",[previousJobId])).rows[0];
 if(!previous)throw new HTTPException(404,{message:'原整理任务不存在'});
 if(!['failed','cancelled'].includes(previous.status))throw conflict('仅可显式续作已失败或取消的整理任务');
 const input=previous.input_snapshot;
 return enqueuePreparation(pool,root,previous.revision_id,{request_key:body.request_key,previous_job_id:previousJobId,...(input.redaction_id?{redaction_id:input.redaction_id}:{extraction_job_id:input.extraction_job_id}),...(input.project_id?{project_id:input.project_id}:{}),...(previous.config_snapshot.api?{api_settings:previous.config_snapshot.api}:previous.config_snapshot.web?{web_settings:previous.config_snapshot.web}:{agent_settings:previous.config_snapshot.agent}),execution_timeout_ms:body.execution_timeout_ms===undefined?(previous.config_snapshot.settings?.execution?.task_timeout_ms??30*60*1000):body.execution_timeout_ms});
}
export async function preparationAvailable(db:Db){return (await db.query("SELECT to_regclass('ai_distill.library_preparations') IS NOT NULL AS available")).rows[0]?.available===true;}
/** 全部读取来自不可变库对象；原文明确绑定提取ID，不取另一次最新结果。 */
export async function readPreparationSource(db:Db,revisionId:string,request:{redaction_id?:string;extraction_job_id?:string}):Promise<PreparationSource>{
 if(request.redaction_id){
  const r=(await db.query(`SELECT r.package_id,r.revision_id,r.extraction_job_id,r.output_digest,b.text_content,b.sha256
   FROM ai_distill.library_redactions r JOIN ai_distill.library_blobs b ON b.id=r.index_blob_id
   JOIN ai_distill.library_jobs j ON j.id=r.redaction_job_id AND j.status='succeeded'
   WHERE r.id=$1 AND r.revision_id=$2`,[request.redaction_id,revisionId])).rows[0];
  if(!r||typeof r.text_content!=='string')throw conflict('所选脱敏结构不存在或损坏，可跳过整理继续原流程');
  if(request.extraction_job_id&&request.extraction_job_id!==r.extraction_job_id)throw conflict('提取任务与脱敏版本不一致');
  return{material_mode:'redacted',package_id:r.package_id,revision_id:r.revision_id,redaction_id:request.redaction_id,extraction_job_id:r.extraction_job_id,source_digest:r.output_digest,index:JSON.parse(r.text_content)};
 }
 if(!request.extraction_job_id)throw new HTTPException(400,{message:'原文整理需要明确提取任务ID'});
 const r=(await db.query("SELECT package_id FROM ai_distill.library_jobs WHERE id=$1 AND revision_id=$2 AND kind='extract' AND status='succeeded'",[request.extraction_job_id,revisionId])).rows[0];
 if(!r)throw conflict('所选提取任务未完成，可跳过整理继续原流程');
 const rows=(await db.query(`SELECT d.file_id AS id,f.original_name,d.source_sha256,d.text_sha256 AS document_sha256,
  b.sha256 AS document_blob_sha256,b.text_content FROM ai_distill.library_documents d
  JOIN ai_distill.library_files f ON f.id=d.file_id JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id
  WHERE d.revision_id=$1 AND d.extraction_job_id=$2 ORDER BY f.position`,[revisionId,request.extraction_job_id])).rows;
 if(!rows.length)throw conflict('提取任务缺少正文');
 const materials=rows.map(x=>{return{material_id:x.id,title:x.original_name,document:JSON.parse(x.text_content)};});
 const source_digest=hash({revision_id:revisionId,extraction_job_id:request.extraction_job_id,files:rows.map(x=>({id:x.id,source_sha256:x.source_sha256,document_sha256:x.document_sha256,document_blob_sha256:x.document_blob_sha256}))});
 return{material_mode:'original',package_id:r.package_id,revision_id:revisionId,redaction_id:null,extraction_job_id:request.extraction_job_id,source_digest,index:{format:'source-index-v1',materials}};
}
const sourceIdentity=(s:PreparationSource)=>({material_mode:s.material_mode,package_id:s.package_id,revision_id:s.revision_id,redaction_id:s.redaction_id,extraction_job_id:s.extraction_job_id,source_digest:s.source_digest});
export async function enqueuePreparation(pool:Pool,root:string,revisionId:string,body:any){
 if(!await preparationAvailable(pool))throw conflict('可选材料整理尚未启用，普通建题可继续');
 const source=await readPreparationSource(pool,revisionId,body);
 if(body.project_id&&!(await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[body.project_id])).rows.length)throw new HTTPException(404,{message:'项目不存在'});
 if([body.api_settings,body.agent_settings,body.web_settings].filter(value=>value!==undefined).length>1)throw new HTTPException(400,{message:'API、Agent与网页Agent设置不能同时指定'});
 let api:ModelApiConfig|undefined;
 if(body.api_settings!==undefined){try{api=resolveModelApiConfig(body.api_settings);}catch{throw new HTTPException(400,{message:'材料整理API模型配置无效'});}}
 let web:WebAgentSettings|undefined;
 if(body.web_settings!==undefined){try{web=validateWebAgentSettings(body.web_settings);}catch(error){throw new HTTPException(400,{message:error instanceof Error?error.message:'网页Agent设置无效'});}}
 const agent=api||web?undefined:body.agent_settings?validateAgentModelSettings(body.agent_settings):await readAgentDefaults(pool);
 if(web&&!localQueueEnabled())throw conflict('网页Agent通道需要启用本机独立队列（EXECUTION_QUEUE_MODE=local）');
  const timeout=body.execution_timeout_ms===undefined?30*60*1000:body.execution_timeout_ms;
 if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>24*60*60*1000)throw new HTTPException(400,{message:'整理执行预算须为1000至86400000毫秒'});
 const config={settings:{execution:{task_timeout_ms:timeout}},...(api?{api}:web?{web}:{agent})};
 const requestDigest=hash({revision_id:revisionId,...body,...(api?{api_settings:api}:{}),...(web?{web_settings:web}:{})});
 if(body.previous_job_id){
  const previous=(await pool.query("SELECT status,input_snapshot FROM ai_distill.library_jobs WHERE id=$1 AND package_id=$2 AND revision_id=$3 AND kind='prepare'",[body.previous_job_id,source.package_id,revisionId])).rows[0];
  if(!previous||!['failed','cancelled'].includes(previous.status))throw conflict('续作来源必须是同材料包、同revision且已失败或取消的整理任务');
  if(previous.input_snapshot?.extraction_job_id!==source.extraction_job_id||
   (previous.input_snapshot?.redaction_id??null)!==(source.redaction_id??null)||
   (previous.input_snapshot?.project_id??null)!==(body.project_id??null))throw conflict('整理续作必须使用同一提取、脱敏及项目来源');
 }
 const input={...(body.previous_job_id?{previous_job_id:body.previous_job_id}:{}),...sourceIdentity(source),project_id:body.project_id??null,request_digest:requestDigest,files:[]};
 const id=randomUUID(),executor=api?'api':web?'web':'agent',db=await pool.connect();
 try{
  await db.query('BEGIN');const pkg=await db.query('SELECT id FROM ai_distill.library_packages WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[source.package_id]);if(!pkg.rows.length)throw new HTTPException(404,{message:'材料包不存在或已归档'});
  const previous=(await db.query('SELECT id,input_snapshot FROM ai_distill.library_jobs WHERE package_id=$1 AND request_key=$2',[source.package_id,body.request_key])).rows[0];
  if(previous){if(previous.input_snapshot?.request_digest!==requestDigest)throw conflict('同一请求键对应不同整理请求');await db.query('COMMIT');forgetLocalRegistrations(db);return{id:previous.id,reused:true};}
  // 复用相同成功结果或本机仍在途的整理；不把他机共享queued当成本机任务或永久占用。
  const owner=localQueueEnabled()?localExecutionQueue().executorId:null;
  const active=(await db.query(`SELECT j.id FROM ai_distill.library_jobs j
   WHERE j.package_id=$1 AND j.revision_id=$2 AND j.kind='prepare' AND j.status IN ('queued','running','succeeded')
   AND j.input_snapshot->>'extraction_job_id'=$3 AND j.input_snapshot->>'redaction_id' IS NOT DISTINCT FROM $4::text
   AND j.input_snapshot->>'project_id' IS NOT DISTINCT FROM $5::text AND ($7::boolean=false OR j.status<>'succeeded')
   AND (j.status='succeeded' OR $6::uuid IS NULL OR EXISTS(SELECT 1 FROM ai_distill.execution_dispatches d WHERE d.job_id=j.id AND d.job_kind='library' AND d.executor_id=$6))
   ORDER BY j.created_at DESC LIMIT 1`,[source.package_id,source.revision_id,source.extraction_job_id,source.redaction_id,body.project_id??null,owner,body.force===true])).rows[0];
  if(active){await db.query('COMMIT');forgetLocalRegistrations(db);return{id:active.id,reused:true};}
  await db.query(`INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,previous_job_id)
   VALUES($1,$2,$3,'prepare','queued',$4,$5,$6::jsonb,$7,$8::jsonb,$9,'local',$10)`,[id,source.package_id,revisionId,body.request_key,hash(input),JSON.stringify(input),hash(config),JSON.stringify(config),executor,body.previous_job_id??null]);
  await registerLocalJob(db,id,'library',executor,'library:prepare');await db.query('COMMIT');forgetLocalRegistrations(db);return{id,reused:false};
 }catch(error){try{await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);}catch(rollback){throw new AggregateError([error,rollback],'材料整理入队状态未知');}throw error;}finally{db.release();}
}
export async function executePreparation(pool:Pool,root:string,job:any,signal:AbortSignal,execute=runAgent,apiClient=createModelApiClient()){
 signal.throwIfAborted();
 const report=async(phase:string,details:Record<string,number>={})=>{
  try{await pool.query("UPDATE ai_distill.library_jobs SET progress=$3::jsonb WHERE id=$1 AND lease_token=$2 AND status='running'",[job.id,job.lease_token,JSON.stringify({phase,phase_started_at:new Date().toISOString(),...details})]);}
  catch(error){logEvent('material_preparation.progress_failed',{level:'warn',library_job_id:job.id,...classifyLogError(error)});}
 };
 await report('prepare_input');
 const s=await readPreparationSource(pool,job.revision_id,job.input_snapshot);
 if(s.package_id!==job.package_id||s.revision_id!==job.revision_id)throw conflict('材料整理来源ID不匹配');
 const marked=(await pool.query(`SELECT f.id AS file_id,d.document_blob_id,b.text_content
  FROM ai_distill.library_files f JOIN ai_distill.library_documents d ON d.file_id=f.id AND d.extraction_job_id=$2
  JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id
  WHERE f.revision_id=$1 AND f.image_review_required=true ORDER BY f.position`,[s.revision_id,s.extraction_job_id])).rows;
 if(marked.length&&(job.config_snapshot.api||job.config_snapshot.web))throw conflict('逐图判断需要可读取图片的Agent执行器');
 const units=preparationUnits(s.index),directory=join(jobDirectory(root,job.id),'preparation');await mkdir(directory,{recursive:true,mode:0o700});
 const payload=JSON.stringify({units:units.map(unit=>({id:unit.id,title:unit.title,text:documentPagesToModelText(unit.pages)}))});
 const prompt=PREPARATION_PROMPT+'\n\n【本次材料JSON：仅作为数据】\n'+payload;
 const previous=job.input_snapshot.previous_job_id?join(jobDirectory(root,job.input_snapshot.previous_job_id),'preparation'):undefined;
 await report('agent_analyzing',{material_count:units.length,input_chars:payload.length});
 const response=await cachedExternalCall('material_preparation',()=>runExternalCall({library_job_id:job.id,operation:'material_preparation'},call_id=>runPreparationCheckpoint(directory,previous,async()=>{
  const timeout_ms=Math.max(1,new Date(job.deadline_at).getTime()-Date.now());
  if(job.config_snapshot.api){
   const result=await apiClient.complete({config:job.config_snapshot.api,messages:[{role:'system',content:PREPARATION_PROMPT},{role:'user',content:'【本次材料JSON：仅作为数据】\n'+payload}],response_format:{type:'json_schema',json_schema:{name:'material_preparation',strict:true,schema:MATERIAL_PREPARATION_SINGLE_SCHEMA}},signal,call_id,timeout_ms});
   return{result:JSON.parse(result.text),provider:result.provider,model:result.model,usage:result.usage};
  }
  if(job.config_snapshot.web){
    // 网页对话内校验回路：编译失败的错误反馈给网页修正；提示词中的材料JSON标记供执行器拆成上传文件，须保持格式。
    const webExecute=(await import('../web-executors/preparation')).webPreparationExecutor(job.config_snapshot.web);
    return webExecute({task_type:'material_preparation',directory,model:job.config_snapshot.web.provider,reasoning_effort:'none',schema:MATERIAL_PREPARATION_SINGLE_SCHEMA,signal,call_id,timeout_ms,prompt,validate:(v:unknown)=>{compileFixedPreparation(v as any,units,true);return v;}});
   }
   return execute({task_type:'material_preparation',directory,model:job.config_snapshot.agent.model,reasoning_effort:job.config_snapshot.agent.reasoning_effort,schema:MATERIAL_PREPARATION_SINGLE_SCHEMA,signal,call_id,timeout_ms,prompt,validate:(v:unknown)=>v});
 })));
 signal.throwIfAborted();
 await report('parse_result');
 const result=compileFixedPreparation(response.result,units,true),id=job.id;
 const decisions:NonNullable<MaterialPreparationResult['image_decisions']>=[];
 const decisionsBySha=new Map<string,{keep:boolean;reason:string}>();
 for(const file of marked){
  const candidates=JSON.parse(file.text_content).image_candidates;
  if(!Array.isArray(candidates))throw conflict('已标记材料缺少保留图片的提取结果');
  for(const candidate of candidates){
   signal.throwIfAborted();
   if(typeof candidate.id!=='string'||!/^p\d+-i\d+-[a-f0-9]{12}$/.test(candidate.id)||typeof candidate.sha256!=='string'||!/^[a-f0-9]{64}$/.test(candidate.sha256)||!Number.isSafeInteger(candidate.page)||candidate.page<1||typeof candidate.blob_id!=='string')throw conflict('图片候选来源无效');
   const blob=(await pool.query("SELECT sha256,storage_path,content_type FROM ai_distill.library_blobs WHERE id=$1 AND storage_kind='file'",[candidate.blob_id])).rows[0];
   if(!blob||blob.sha256!==candidate.sha256||!['image/png','image/jpeg'].includes(blob.content_type))throw conflict('图片候选对象无效');
   const bytes=await readLibraryBlob(root,blob.storage_path,blob.sha256);
   if(hash(bytes)!==blob.sha256)throw conflict('图片候选摘要不匹配');
   if(candidate.role==='page_scan'||candidate.role==='repeated_decoration'){
    decisions.push({file_id:file.file_id,image_id:candidate.id,page:candidate.page,sha256:candidate.sha256,keep:false,reason:candidate.role==='page_scan'?'PDF整页扫描底图，正文已由提取结构提供，不作为独立插图':'PDF跨页重复图面，不作为独立诊疗插图'});
    continue;
   }
   let decision=decisionsBySha.get(candidate.sha256);
   if(!decision){
    const imageDirectory=join(directory,'images',file.file_id,candidate.id);await mkdir(imageDirectory,{recursive:true,mode:0o700});
    const imageName=`source.${blob.content_type==='image/png'?'png':'jpg'}`;
    const imagePath=join(imageDirectory,imageName);
    await writeFile(imagePath,bytes,{mode:0o600});
    const previousImageDirectory=previous?join(previous,'images',file.file_id,candidate.id):undefined;
    decision=await imageDecisionCheckpoint(imageDirectory,previousImageDirectory,candidate.sha256,async()=>{
     const answer=await execute({task_type:'material_image_review',directory:imageDirectory,model:job.config_snapshot.agent.model,reasoning_effort:job.config_snapshot.agent.reasoning_effort,signal,timeout_ms:Math.max(1,new Date(job.deadline_at).getTime()-Date.now()),schema:{type:'object',additionalProperties:false,properties:{keep:{type:'boolean'},reason:{type:'string'}},required:['keep','reason']},prompt:`查看当前工作目录中的图片 ${imageName}。逐张检查：无可见文字且无身份信息的独立临床图像（影像、心电图、病理切片、临床照片或诊疗曲线）应保留；有文字但确认仅为非身份诊疗标注的临床图像也可保留。姓名、编号、二维码、印章、整页扫描、标识、页眉及装饰图均不保留；无法确认是否含身份信息或是否有临床判断价值时不保留。只返回 keep 和 reason。`,validate:(value:unknown)=>value as {keep:boolean;reason:string}});
     return answer.result;
    });
    decisionsBySha.set(candidate.sha256,decision);
   }
   decisions.push({file_id:file.file_id,image_id:candidate.id,page:candidate.page,sha256:candidate.sha256,keep:decision.keep,reason:decision.reason});
  }
 }
 if(marked.length)result.image_decisions=decisions;
 await report('publish_result',{material_count:result.documents.length,combination_count:result.combinations.length,warning_count:result.warnings.length});
 await finishLibraryJob(pool,job.id,job.lease_token,{preparation_id:id,document_count:result.document_count,unassigned_group_count:result.unassigned_group_count,unassigned_block_count:result.unassigned_block_count,combination_count:result.combinations.length,warning_count:result.warnings.length},async db=>{
  await db.query(`INSERT INTO ai_distill.library_preparations(id,job_id,package_id,revision_id,extraction_job_id,redaction_id,project_id,source_digest,result)
   VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(job_id) DO NOTHING`,[id,s.package_id,s.revision_id,s.extraction_job_id,s.redaction_id,job.input_snapshot.project_id,s.source_digest,JSON.stringify(result)]);
 });
}
export async function readPreparation(db:Db,id:string,includeContent=false){
 if(!await preparationAvailable(db))throw new HTTPException(404,{message:'材料整理结果不存在，普通流程可跳过'});
 const row=(await db.query('SELECT * FROM ai_distill.library_preparations WHERE id=$1',[id])).rows[0];if(!row)throw new HTTPException(404,{message:'材料整理结果不存在'});
 if(!includeContent)return row;
 const s=await readPreparationSource(db,row.revision_id,row);return{...row,documents:materializePreparation(row.result as MaterialPreparationResult,preparationUnits(s.index))};
}

/** 按建题实际来源查找同项目优先的成功整理；整理缺失时返回undefined，不影响完整材料建题。 */
export async function findMatchingPreparation(db:Db,source:Pick<PreparationSource,'package_id'|'revision_id'|'redaction_id'|'extraction_job_id'>,projectId:string){
 if(!await preparationAvailable(db))return undefined;
 const row=(await db.query(`SELECT p.id,p.result FROM ai_distill.library_preparations p
  JOIN ai_distill.library_jobs j ON j.id=p.job_id AND j.status='succeeded'
  WHERE p.package_id=$1 AND p.revision_id=$2 AND p.redaction_id IS NOT DISTINCT FROM $3::uuid
   AND p.extraction_job_id=$4 AND (p.project_id=$5 OR p.project_id IS NULL)
  ORDER BY (p.project_id=$5) DESC NULLS LAST,p.created_at DESC,p.id DESC LIMIT 1`,[source.package_id,source.revision_id,source.redaction_id,source.extraction_job_id,projectId])).rows[0];
 if(!row||row.result?.format!=='material-preparation-v2')return undefined;
 return{id:String(row.id),result:{...row.result,summary_scope:'visible'} as MaterialPreparationResult};
}

/** HTTP只提供可选入口；能力未启用时列表为空，不影响原材料接口。 */
export function registerPreparationRoutes(app:import('hono').Hono,pool:Pool,root:string){
 app.post('/api/material-library/revisions/:id/prepare',async c=>{
  const {uuid}=await import('../validation');const revision=uuid(c.req.param('id'));let body:any;
  try{body=await c.req.json();}catch{throw new HTTPException(400,{message:'整理请求需要有效JSON'});}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['request_key','redaction_id','extraction_job_id','project_id','agent_settings','api_settings','web_settings','execution_timeout_ms','previous_job_id','force'].includes(k)))throw new HTTPException(400,{message:'材料整理请求字段无效'});
  if(body.force!==undefined&&typeof body.force!=='boolean')throw new HTTPException(400,{message:'force须为布尔值'});
  uuid(body.request_key);for(const key of ['redaction_id','extraction_job_id','project_id','previous_job_id'])if(body[key]!==undefined)uuid(body[key]);
  const result=await enqueuePreparation(pool,root,revision,body);return c.json(result,result.reused?200:202);
 });
 app.post('/api/material-library/jobs/:id/prepare-resume',async c=>{
  const {uuid}=await import('../validation');let body:any;
  try{body=await c.req.json();}catch{throw new HTTPException(400,{message:'续作请求需要有效JSON'});}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['request_key','execution_timeout_ms'].includes(key)))throw new HTTPException(400,{message:'续作请求字段无效'});
  uuid(body.request_key);const result=await resumePreparation(pool,root,uuid(c.req.param('id')),body);return c.json(result,result.reused?200:202);
 });
 app.get('/api/material-library/packages/:id/preparations',async c=>{
  const {uuid}=await import('../validation');const id=uuid(c.req.param('id'));const available=await preparationAvailable(pool);if(!available)return c.json({available:false,items:[]});
  const revision=c.req.query('revision_id'),redaction=c.req.query('redaction_id'),project=c.req.query('project_id');
  if(revision)uuid(revision);if(redaction)uuid(redaction);if(project)uuid(project);
  const rows=(await pool.query(`SELECT id,job_id,revision_id,redaction_id,project_id,created_at,result FROM ai_distill.library_preparations
   WHERE package_id=$1 AND ($2::uuid IS NULL OR revision_id=$2)
   AND ($3::boolean=false OR redaction_id IS NOT DISTINCT FROM $4::uuid)
   AND ($5::uuid IS NULL OR project_id=$5 OR project_id IS NULL)
   ORDER BY (project_id=$5) DESC NULLS LAST,created_at DESC,id DESC LIMIT 20`,[id,revision??null,redaction!==undefined,redaction||null,project||null])).rows;
  return c.json({available:true,items:rows});
 });
 app.get('/api/material-library/preparations/:id',async c=>{
  const {uuid}=await import('../validation');return c.json(await readPreparation(pool,uuid(c.req.param('id')),c.req.query('include_content')==='true'));
 });
}
