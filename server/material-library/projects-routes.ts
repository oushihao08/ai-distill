/**
 * 文件职责：注册项目加载全局材料包的读取、加载、选版、排序和软移除接口。
 * 关键入口：`registerProjectLibraryRoutes()` 在 app 创建时调用；所有写请求交由 projects.ts 的事务服务。
 * 使用场景：项目材料页只管理引用关系，不复制材料包，也不触发入库、提取或脱敏。
 */
import type {Hono} from 'hono';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {uuid} from '../validation';
import {loadLibraryPackage,readLoadedLibraryPackages,removeLoadedLibraryPackage,updateLoadedLibraryPackage} from './projects';
import {createLibraryQuestion} from './questions';

async function jsonBody(c:any){try{return await c.req.json();}catch{throw new HTTPException(400,{message:'请求必须是有效JSON'});}}
function versionHeader(value:string|undefined){
 if(!value)throw new HTTPException(428,{message:'缺少 If-Match 加载关系版本'});
 const parsed=Number(value.replace(/^W\//,'').replace(/^"|"$/g,''));
 if(!Number.isSafeInteger(parsed)||parsed<1)throw new HTTPException(400,{message:'If-Match 加载关系版本无效'});
 return parsed;
}

export function registerProjectLibraryRoutes(app:Hono,pool:Pool,storageRoot:string){
 app.get('/api/projects/:id/loaded-materials',async c=>c.json({items:await readLoadedLibraryPackages(pool,uuid(c.req.param('id')))}));
 app.post('/api/projects/:id/loaded-materials',async c=>{
  const projectId=uuid(c.req.param('id')),body=await jsonBody(c);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['package_id','redaction_id'].includes(key))||typeof body.package_id!=='string')throw new HTTPException(400,{message:'加载材料包参数无效'});
  const result=await loadLibraryPackage(pool,projectId,uuid(body.package_id),body.redaction_id===undefined?undefined:body.redaction_id);
  return c.json(result,result.reused?200:201);
 });
 app.patch('/api/projects/:id/loaded-materials/:linkId',async c=>c.json(await updateLoadedLibraryPackage(
  pool,uuid(c.req.param('id')),uuid(c.req.param('linkId')),versionHeader(c.req.header('If-Match')),await jsonBody(c))));
 app.delete('/api/projects/:id/loaded-materials/:linkId',async c=>c.json(await removeLoadedLibraryPackage(
  pool,uuid(c.req.param('id')),uuid(c.req.param('linkId')),versionHeader(c.req.header('If-Match')))));
 app.post('/api/projects/:id/loaded-materials/:linkId/questions',async c=>{
  const result=await createLibraryQuestion(pool,storageRoot,uuid(c.req.param('id')),uuid(c.req.param('linkId')),await jsonBody(c));
  return c.json(result,result.reused?200:201);
 });
}
