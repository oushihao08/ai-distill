/**
 * 文件职责：注册项目加载全局材料包的读取、加载、选版、排序和软移除接口。
 * 关键入口：`registerProjectLibraryRoutes()` 在 app 创建时调用；引用写请求交由 projects.ts；建题、使用账和旧材料导入分别调用 questions.ts、uses.ts、legacy-import.ts。
 * 使用场景：项目材料页只管理引用关系，不复制材料包，也不触发入库、提取或脱敏。
 */
import type {Hono} from 'hono';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {uuid} from '../validation';
import {loadLibraryPackage,readLoadedLibraryPackages,removeLoadedLibraryPackage,restoreLoadedLibraryPackage,updateLoadedLibraryPackage} from './projects';
import {readLibraryPackages} from './service';
import {readLegacyMaterialInventory,importLegacyMaterial,activateLegacyImports} from './legacy-import';
import {createLibraryQuestion} from './questions';
import {readPhaseMaterialUseEvents,readPhaseMaterialUses,updateMaterialUse} from './uses';
import {readProjectMaterialProcessingMode} from './processing-policy';
import {materialProcessingSourceMode} from '../../shared/material-library';

async function jsonBody(c:any){try{return await c.req.json();}catch{throw new HTTPException(400,{message:'请求必须是有效JSON'});}}
function versionHeader(value:string|undefined){
 if(!value)throw new HTTPException(428,{message:'缺少 If-Match 加载关系版本'});
 const parsed=Number(value.replace(/^W\//,'').replace(/^"|"$/g,''));
 if(!Number.isSafeInteger(parsed)||parsed<1)throw new HTTPException(400,{message:'If-Match 加载关系版本无效'});
 return parsed;
}

export function registerProjectLibraryRoutes(app:Hono,pool:Pool,storageRoot:string){
 app.get('/api/projects/:id/material-processing',async c=>{const mode=await readProjectMaterialProcessingMode(pool,uuid(c.req.param('id')));return c.json({material_processing_mode:mode,material_source_mode:materialProcessingSourceMode(mode)});});
 app.get('/api/projects/:id/legacy-materials',async c=>c.json({items:await readLegacyMaterialInventory(pool,uuid(c.req.param('id')))}));
 app.post('/api/projects/:id/legacy-material-imports',async c=>c.json(await importLegacyMaterial(pool,storageRoot,uuid(c.req.param('id')),await jsonBody(c))));
 app.post('/api/projects/:id/legacy-material-imports/:importId/activate',async c=>c.json(await activateLegacyImports(pool,uuid(c.req.param('id')),uuid(c.req.param('importId')))));
 app.get('/api/workflows/:id/library-history',async c=>{
  const result=await pool.query(`SELECT i.id,i.package_id,i.revision_id,i.use_id,p.name AS package_name,i.source_digest,i.created_at
   FROM ai_distill.workflows w JOIN ai_distill.legacy_material_imports i ON i.source_phase_id=w.project_id
    AND i.source_workflow_id=COALESCE(w.source_workflow_id,w.id)
   JOIN ai_distill.library_packages p ON p.id=i.package_id WHERE w.id=$1 ORDER BY i.created_at,i.id`,[uuid(c.req.param('id'))]);
  return c.json({items:result.rows});
 });
 app.get('/api/projects/:id/material-candidates',async c=>{
  const phaseId=uuid(c.req.param('id'));
  const query=c.req.query('q')??'',page=Number(c.req.query('page')??1),pageSize=Number(c.req.query('page_size')??30);
  const sourceMode=c.req.query('source_mode')??'any';if(!['any','redacted','original'].includes(sourceMode))throw new HTTPException(400,{message:'材料来源模式无效'});
  const [phaseResult,catalog]=await Promise.all([
   pool.query('SELECT project_group_id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[phaseId]),
   readLibraryPackages(pool,{q:query,page,page_size:pageSize,usage_project_id:phaseId,source_mode:sourceMode as 'any'|'redacted'|'original'}),
  ]);
  const phase=phaseResult.rows[0];
  if(!phase)throw new HTTPException(404,{message:'期次不存在'});
  return c.json({...catalog,items:catalog.items.map(item=>{
   const {usage_status,used_phase_name,...candidate}=item as typeof item&{usage_status:string|null;used_phase_name:string|null};
   return{...candidate,used_in_project:!!usage_status,...(usage_status?{usage_status}:{}),...(used_phase_name?{used_phase_name}:{})};
  })});
 });
 app.get('/api/projects/:id/material-uses',async c=>c.json({items:await readPhaseMaterialUses(pool,uuid(c.req.param('id')))}));
 app.get('/api/projects/:id/material-uses/:useId/events',async c=>c.json({items:await readPhaseMaterialUseEvents(pool,uuid(c.req.param('id')),uuid(c.req.param('useId')))}));
 app.patch('/api/projects/:id/material-uses/:useId',async c=>c.json(await updateMaterialUse(pool,
  uuid(c.req.param('id')),uuid(c.req.param('useId')),versionHeader(c.req.header('If-Match')),await jsonBody(c))));
 app.get('/api/projects/:id/loaded-materials',async c=>c.json({items:await readLoadedLibraryPackages(pool,uuid(c.req.param('id')),{includeRemoved:c.req.query('include_removed')==='true'})}));
 app.post('/api/projects/:id/loaded-materials',async c=>{
  const projectId=uuid(c.req.param('id')),body=await jsonBody(c);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['package_id','redaction_id','revision_id'].includes(key))||typeof body.package_id!=='string'||('redaction_id'in body&&'revision_id'in body))throw new HTTPException(400,{message:'加载材料包参数无效'});
  if(body.redaction_id!==undefined&&typeof body.redaction_id!=='string')throw new HTTPException(400,{message:'脱敏结果标识无效'});
  if(body.revision_id!==undefined&&typeof body.revision_id!=='string')throw new HTTPException(400,{message:'提取版本标识无效'});
  const result=await loadLibraryPackage(pool,projectId,uuid(body.package_id),body.redaction_id===undefined?undefined:body.redaction_id,body.revision_id===undefined?undefined:uuid(body.revision_id));
  return c.json(result,result.reused?200:201);
 });
 app.patch('/api/projects/:id/loaded-materials/:linkId',async c=>c.json(await updateLoadedLibraryPackage(
  pool,uuid(c.req.param('id')),uuid(c.req.param('linkId')),versionHeader(c.req.header('If-Match')),await jsonBody(c))));
 app.delete('/api/projects/:id/loaded-materials/:linkId',async c=>c.json(await removeLoadedLibraryPackage(
  pool,uuid(c.req.param('id')),uuid(c.req.param('linkId')),versionHeader(c.req.header('If-Match')))));
 app.post('/api/projects/:id/loaded-materials/:linkId/restore',async c=>c.json(await restoreLoadedLibraryPackage(
  pool,uuid(c.req.param('id')),uuid(c.req.param('linkId')),versionHeader(c.req.header('If-Match')))));
 app.post('/api/projects/:id/loaded-materials/:linkId/questions',async c=>{
  const result=await createLibraryQuestion(pool,storageRoot,uuid(c.req.param('id')),uuid(c.req.param('linkId')),await jsonBody(c));
  return c.json(result,result.reused?200:201);
 });
}
