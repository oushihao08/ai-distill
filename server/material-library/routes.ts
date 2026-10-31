/**
 * 文件职责：装配独立材料库元数据、处理默认值、文件集合上传、受控预览和逻辑归档 HTTP 路由。
 * 关键入口：`registerMaterialLibraryRoutes()` 由本地 API app 注册；输入校验与事务由 service 层负责。
 * 使用场景：材料库页面调用 `/api/material-library`，该路由不创建项目工作流或旧材料记录。
 */
import type {Hono} from 'hono';
import {enqueueAtomicLibraryImport} from './atomic-import';
import {registerPreparationRoutes} from './preparation';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {uuid} from '../validation';
import {archiveLibraryPackage,buildDefaultProcessingSettings,readLibraryPackage,readLibraryPackageUsage,readLibraryPackages,readLibraryRevisions,restoreLibraryPackage,updateLibraryPackage} from './service';
import type {LibraryFileInput} from './service';
import {cancelLibraryJob,enqueueLibraryJob,readLibraryJob,projectLibraryJobExecutions} from './jobs';
import {readLibraryDocuments,readLibraryOriginal,readLibraryRedactionPreview} from './preview';
import {readLibraryProcessingSettings,saveLibraryProcessingSettings} from './settings';
import {readLibraryOriginalPreview} from './original-preview';
import {libraryRedactionTemplates} from '../../shared/redaction-templates';
import {resolveLibraryTemplate} from './templates';
import {importPreparedLibraryMaterials} from './prepared-import';
import {revalidateAgentLibraryRedaction} from './redaction-review';
import {importMineruExtraction} from './mineru-import';
import {readNameRevisionSource,previewNameRevision,applyNameRevision} from './name-revisions';
import {reviewNameMappings} from './name-mapping-review';
import type {AgentResult,AgentTask} from '../agent';

function versionHeader(value:string|undefined){
 if(!value)throw new HTTPException(428,{message:'缺少 If-Match 材料包版本'});
 const parsed=Number(value.replace(/^W\//,'').replace(/^"|"$/g,''));
 if(!Number.isSafeInteger(parsed)||parsed<1)throw new HTTPException(400,{message:'If-Match 材料包版本无效'});
 return parsed;
}
async function jsonBody(c:any){try{return await c.req.json();}catch{throw new HTTPException(400,{message:'请求必须是有效JSON'});}}

export function registerMaterialLibraryRoutes(app:Hono,pool:Pool,storageRoot:string,executeAgent?:<T>(task:AgentTask<T>)=>Promise<AgentResult<T>>){
 registerPreparationRoutes(app,pool,storageRoot);
 const prefix='/api/material-library';
 app.get(`${prefix}/redactions/:id/name-revision-source`,async c=>{
  c.header('Cache-Control','no-store');
  return c.json(await readNameRevisionSource(pool,uuid(c.req.query('project_id')??''),uuid(c.req.param('id'))));
 });
 app.post(`${prefix}/redactions/:id/name-revisions/preview`,async c=>{
  c.header('Cache-Control','no-store');const body=await jsonBody(c);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['project_id','review_call_id'].includes(key))||typeof body.review_call_id!=='string')throw new HTTPException(400,{message:'名称修订预览参数无效'});
  return c.json(await previewNameRevision(pool,storageRoot,uuid(body.project_id),uuid(c.req.param('id')),body.review_call_id));
 });
 app.post(`${prefix}/redactions/:id/name-revisions/apply`,async c=>{
  c.header('Cache-Control','no-store');const body=await jsonBody(c);
  return c.json(await applyNameRevision(pool,storageRoot,uuid(body?.project_id??''),uuid(c.req.param('id')),body));
 });
 app.post(`${prefix}/name-revisions/review-mappings`,async c=>{
  c.header('Cache-Control','no-store');if(!executeAgent)throw new HTTPException(503,{message:'主体映射复核执行器未配置'});
  return c.json(await reviewNameMappings(storageRoot,await jsonBody(c),executeAgent));
 });
 app.get(`${prefix}/redaction-templates`,async c=>{const {processing_settings}=await readLibraryProcessingSettings(pool,storageRoot);return c.json({items:libraryRedactionTemplates(processing_settings).map(t=>resolveLibraryTemplate(processing_settings,t.id))});});
 app.get(`${prefix}/processing-defaults`,async c=>c.json(await buildDefaultProcessingSettings(pool)));
 app.get(`${prefix}/processing-settings`,async c=>c.json(await readLibraryProcessingSettings(pool,storageRoot)));
 app.put(`${prefix}/processing-settings`,async c=>{
  const raw=c.req.header('If-Match');
  if(raw===undefined)throw new HTTPException(428,{message:'缺少共用设置版本'});
  return c.json(saveLibraryProcessingSettings(storageRoot,Number(raw),await jsonBody(c)));
 });
 app.get(`${prefix}/files/:id/content`,async c=>{
  const file=await readLibraryOriginal(pool,storageRoot,uuid(c.req.param('id')));
  return new Response(new Uint8Array(file.bytes).buffer,{headers:{'Content-Type':file.content_type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'no-store'}});
 });
 app.get(`${prefix}/files/:id/preview`,async c=>{
  const file=await readLibraryOriginalPreview(pool,storageRoot,uuid(c.req.param('id')));
  return new Response(new Uint8Array(file.bytes).buffer,{headers:{'Content-Type':file.content_type,'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 });
 app.get(`${prefix}/revisions/:id/documents`,async c=>{
  c.header('Cache-Control','no-store');
  const job=c.req.query('extraction_job_id'),file=c.req.query('file_id');
  if(!job)throw new HTTPException(400,{message:'请选择成功的提取任务'});
  return c.json(await readLibraryDocuments(pool,uuid(c.req.param('id')),uuid(job),file?uuid(file):undefined));
 });
 app.get(`${prefix}/redactions/:id/preview`,async c=>{c.header('Cache-Control','no-store');const file=c.req.query('file_id');return c.json(await readLibraryRedactionPreview(pool,uuid(c.req.param('id')),file?uuid(file):undefined,c.req.query('metadata_only')==='true'));});
 app.post(`${prefix}/redactions/:id/revalidate`,async c=>c.json(await revalidateAgentLibraryRedaction(pool,storageRoot,uuid(c.req.param('id')))));
 app.get(`${prefix}/project-options`,async c=>c.json({items:(await pool.query('SELECT id,name FROM ai_distill.projects WHERE deleted_at IS NULL ORDER BY name,id')).rows}));
 app.get(`${prefix}/packages`,async c=>{
  const page=Number(c.req.query('page')??1),page_size=Number(c.req.query('page_size')??30);
  return c.json(await readLibraryPackages(pool,{q:c.req.query('q'),page,page_size,ready_only:c.req.query('ready_only')==='true',project_ids:c.req.queries('project_id'),redaction_state:c.req.query('redaction_state'),preparation_state:c.req.query('preparation_state'),archived_only:c.req.query('archived_only')==='true'}));
 });
 app.post(`${prefix}/packages`,async()=>{throw new HTTPException(410,{message:'不再先建立空材料包，请使用 /api/material-library/imports 上传并提取，成功后自动入库'});});
 app.get(`${prefix}/imports`,async c=>{
  const jobs=(await pool.query(`SELECT id,status,package_id,revision_id,progress,error_code,error_message,created_at,finished_at,
   input_snapshot#>>'{atomic_import,package_input,name}' AS name FROM ai_distill.library_jobs
   WHERE input_snapshot ? 'atomic_import' ORDER BY created_at DESC,id DESC LIMIT 50`)).rows;
  return c.json({items:await projectLibraryJobExecutions(pool,jobs)});
 });
 app.post(`${prefix}/imports`,async c=>{
  let form:FormData;try{form=await c.req.formData();}catch{throw new HTTPException(400,{message:'导入须为multipart/form-data'});}
  const key=form.get('request_key'),name=form.get('name');if(typeof key!=='string'||typeof name!=='string')throw new HTTPException(400,{message:'缺少导入名称或request_key'});
  const uploads=form.getAll('files').filter((file):file is File=>file instanceof File);
  if(!uploads.length||uploads.length>100)throw new HTTPException(400,{message:'请选择1至100份材料'});
  let modes:unknown=[];const modeField=form.get('redaction_modes');
  if(typeof modeField==='string'){try{modes=JSON.parse(modeField);}catch{throw new HTTPException(400,{message:'脱敏声明无效'});}}
  if(!Array.isArray(modes)||(modes.length&&modes.length!==uploads.length)||modes.some(mode=>!['model','declared_redacted'].includes(mode)))throw new HTTPException(400,{message:'脱敏声明无效'});
  const files=await Promise.all(uploads.map(async (file,index)=>({original_name:file.name,bytes:new Uint8Array(await file.arrayBuffer()),redaction_mode:(modes[index]??'model') as 'model'|'declared_redacted'})));
  const result=await enqueueAtomicLibraryImport(pool,storageRoot,key,{name,tags:[]},files);return c.json(result,result.reused?200:202);
 });
 app.get(`${prefix}/packages/:id`,async c=>c.json(await readLibraryPackage(pool,uuid(c.req.param('id')))));
 app.get(`${prefix}/packages/:id/usage`,async c=>c.json(await readLibraryPackageUsage(pool,uuid(c.req.param('id')))));
 app.patch(`${prefix}/packages/:id`,async c=>c.json(await updateLibraryPackage(pool,uuid(c.req.param('id')),versionHeader(c.req.header('If-Match')),await jsonBody(c))));
 app.delete(`${prefix}/packages/:id`,async c=>c.json(await archiveLibraryPackage(pool,uuid(c.req.param('id')),versionHeader(c.req.header('If-Match')))));
 app.post(`${prefix}/packages/:id/restore`,async c=>c.json(await restoreLibraryPackage(pool,uuid(c.req.param('id')),versionHeader(c.req.header('If-Match')))));
 app.get(`${prefix}/packages/:id/revisions`,async c=>{
  const items=await readLibraryRevisions(pool,uuid(c.req.param('id'))),jobs=items.flatMap(item=>item.jobs??[]);
  const projected=await projectLibraryJobExecutions(pool,jobs),byId=new Map(projected.map(job=>[job.id,job]));
  return c.json({items:items.map(item=>({...item,jobs:(item.jobs??[]).map((job:any)=>byId.get(job.id)??job)}))});
 });
 app.post(`${prefix}/revisions/:id/jobs`,async c=>{
  const revisionId=uuid(c.req.param('id')),body=await jsonBody(c);
  const packageId=(await pool.query('SELECT package_id FROM ai_distill.library_revisions WHERE id=$1',[revisionId])).rows[0]?.package_id;
  if(!packageId)throw new HTTPException(404,{message:'材料文件集合不存在'});
  const result=await enqueueLibraryJob(pool,packageId,revisionId,body,storageRoot);
  return c.json(result,result.reused?200:202);
 });
 app.get(`${prefix}/jobs/:id`,async c=>c.json(await readLibraryJob(pool,uuid(c.req.param('id')))));
 app.post(`${prefix}/revisions/:id/prepared-redactions`,async c=>c.json(await importPreparedLibraryMaterials(pool,uuid(c.req.param('id')),await jsonBody(c),storageRoot),201));
 app.post(`${prefix}/revisions/:id/mineru-extractions`,async c=>{const result=await importMineruExtraction(pool,storageRoot,uuid(c.req.param('id')),await jsonBody(c));return c.json(result,result.reused?200:201);});
 app.post(`${prefix}/jobs/:id/cancel`,async c=>c.json(await cancelLibraryJob(pool,uuid(c.req.param('id')))));
 app.post(`${prefix}/packages/:id/revisions`,async c=>{
  const packageId=uuid(c.req.param('id')),ifMatch=versionHeader(c.req.header('If-Match'));
  let form:FormData;try{form=await c.req.formData();}catch{throw new HTTPException(400,{message:'文件集合必须使用 multipart/form-data'});}
  const requestKey=form.get('request_key');
  if(typeof requestKey!=='string')throw new HTTPException(400,{message:'缺少文件集合幂等 request_key'});
  uuid(requestKey);
  const modeField=form.get('redaction_modes');let modes:unknown=[];
  if(typeof modeField==='string'){try{modes=JSON.parse(modeField);}catch{throw new HTTPException(400,{message:'脱敏声明须为有效JSON数组'});}}
  if(!Array.isArray(modes)||modes.some(mode=>mode!=='model'&&mode!=='declared_redacted'))throw new HTTPException(400,{message:'脱敏声明无效'});
  const uploads=form.getAll('files').filter((value):value is File=>value instanceof File);
  if(!uploads.length||uploads.length>100)throw new HTTPException(400,{message:'请选择1至100份材料'});
  if(modes.length&&modes.length!==uploads.length)throw new HTTPException(400,{message:'脱敏声明数量须与文件数一致'});
  const files:LibraryFileInput[]=await Promise.all(uploads.map(async(file,index)=>({original_name:file.name,bytes:new Uint8Array(await file.arrayBuffer()),redaction_mode:(modes[index]??'model') as LibraryFileInput['redaction_mode']})));
  const pkg=await readLibraryPackage(pool,packageId);
  const result=await enqueueAtomicLibraryImport(pool,storageRoot,requestKey,{name:pkg.name,description:pkg.description,tags:pkg.tags},files,{package_id:packageId,lock_version:ifMatch});
  return c.json(result,result.reused?200:202);
 });
}
