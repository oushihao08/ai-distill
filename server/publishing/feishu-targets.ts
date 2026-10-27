/**
 * 职责：豆包各期飞书交付目标配置、独立新表创建及HTTP入口。
 * 入口：readFeishuDeliveryConfig()供归档读取；registerFeishuTargetRoutes()装配配置/建表接口。
 * 配置复用project_step_configs.ordinal=8的feishu_delivery键，只合并该键，不迁移、不失效已有题目或归档。
 */
import type {Pool} from 'pg';
import type {Hono,Context} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {uuid} from '../validation';
import {feishuClient,createFeishuTable,ensureFeishuSchema,SyncError,FEISHU_FIELDS} from './feishu-api';

const DEFAULT_BASE='DuizblJJwavfGjsB4KJcPH0TnRg',GROUP='315407cd-43db-49d1-8eb3-c2dff77af859';
export interface FeishuTarget {base_token:string;table_id:string}
type DefaultTarget=FeishuTarget|{base_token:string;table_name:string};
const bad=(message:string)=>new HTTPException(400,{message});
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function token(value:unknown,kind:'base'|'table'){
 if(typeof value!=='string'||!(kind==='table'?/^tbl[A-Za-z0-9]{6,80}$/:/^[A-Za-z0-9]{10,100}$/).test(value))throw bad('飞书目标ID格式无效');
 return value;
}
export function validateFeishuTarget(value:unknown):FeishuTarget{
 if(!object(value)||Object.keys(value).some(k=>!['base_token','table_id'].includes(k)))throw bad('交付目标须包含base_token和table_id');
 return{base_token:token(value.base_token,'base'),table_id:token(value.table_id,'table')};
}
async function project(pool:Pick<Pool,'query'>,id:string){
 return(await pool.query(`SELECT p.project_group_id,p.phase_name,c.config->'feishu_delivery' AS settings
 FROM ai_distill.projects p LEFT JOIN ai_distill.project_step_configs c ON c.project_id=p.id AND c.ordinal=8
 WHERE p.id=$1 AND p.deleted_at IS NULL`,[id])).rows[0];
}
/** 未配置时保持现有按期次目标；显式配置只接受具体表ID，避免同名表产生含混路由。 */
export async function readFeishuDeliveryConfig(pool:Pick<Pool,'query'>,projectId:string):Promise<{default_target:DefaultTarget;source:'phase_default'|'configured'}|null>{
 const row=await project(pool,projectId);if(!row||String(row.project_group_id)!==GROUP)return null;
 if(row.settings)return{default_target:validateFeishuTarget(row.settings.default_target),source:'configured'};
 const phase=String(row.phase_name??'').trim();if(!phase)throw bad('期次名称缺失');
 return{default_target:phase==='第六期'?{base_token:DEFAULT_BASE,table_id:'tblbT3gCovrk5lf0'}:{base_token:DEFAULT_BASE,table_name:phase},source:'phase_default'};
}
async function requireProject(pool:Pool,id:string){if(!await readFeishuDeliveryConfig(pool,id))throw new HTTPException(404,{message:'本项目未启用豆包飞书交付'});}
async function payload(c:Context){try{const body=await c.req.json();if(!object(body))throw bad('须提交JSON对象');return body;}catch(error){if(error instanceof HTTPException)throw error;throw bad('须提交有效JSON');}}
function remoteError(error:unknown):never{if(error instanceof HTTPException)throw error;throw new HTTPException(502,{message:error instanceof SyncError?error.code:'飞书请求失败，请先核对远端结果再重试'});}

/** 一次性新表只返回目标，不改默认配置；重名明确拒绝，未知创建响应后必须先查询远端，不换名盲重试。 */
export function registerFeishuTargetRoutes(app:Hono,pool:Pool){
 app.get('/api/projects/:id/feishu-delivery',async c=>{
  const id=uuid(c.req.param('id'));await requireProject(pool,id);
  return c.json({...await readFeishuDeliveryConfig(pool,id),capabilities:{target_override:true,per_target_receipts:true},fields:FEISHU_FIELDS.map(([name,type])=>({name,type,hidden:name==='系统同步ID'}))});
 });
 app.put('/api/projects/:id/feishu-delivery',async c=>{
  const id=uuid(c.req.param('id'));await requireProject(pool,id);const body=await payload(c);
  if(Object.keys(body).some(k=>k!=='default_target'))throw bad('只允许修改default_target');
  const target=validateFeishuTarget(body.default_target);
  let api:Awaited<ReturnType<typeof feishuClient>>|undefined;
  try{api=await feishuClient();await ensureFeishuSchema(api,target.base_token,target.table_id);}catch(error){remoteError(error);}finally{await api?.close();}
  const saved=await pool.query(`INSERT INTO ai_distill.project_step_configs AS existing(project_id,ordinal,config)
   VALUES($1,8,jsonb_build_object('feishu_delivery',$2::jsonb)) ON CONFLICT(project_id,ordinal)
   DO UPDATE SET config=existing.config||EXCLUDED.config,updated_at=now() RETURNING project_id`,[id,JSON.stringify({default_target:target})]);
  if(!saved.rowCount)throw new HTTPException(409,{message:'保存交付目标失败'});
  return c.json(await readFeishuDeliveryConfig(pool,id));
 });
 app.post('/api/projects/:id/feishu-tables',async c=>{
  const id=uuid(c.req.param('id'));await requireProject(pool,id);const body=await payload(c);
  if(Object.keys(body).some(k=>!['base_token','table_name'].includes(k)))throw bad('仅接受base_token和table_name');
  const base=body.base_token===undefined?DEFAULT_BASE:token(body.base_token,'base');
  if(typeof body.table_name!=='string'||!body.table_name.trim()||body.table_name.trim().length>100||/[\x00-\x1f]/.test(body.table_name))throw bad('请填写1至100字的新表名称');
  const name=body.table_name.trim(),db=await pool.connect();let tx=false,api:Awaited<ReturnType<typeof feishuClient>>|undefined;
  try{
   await db.query('BEGIN');tx=true;
   const lock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-base-v2'),hashtext($1)) AS locked",[base])).rows[0]?.locked;
   if(!lock)throw new HTTPException(409,{message:'同一多维表格正在创建数据表，请稍后核对'});
   api=await feishuClient();const tables=await api.list(`/bitable/v1/apps/${base}/tables`);
   if(tables.some(t=>t.name===name))throw new HTTPException(409,{message:'已有同名数据表；追加请使用该表ID，不重复创建'});
   const target=await createFeishuTable(api,base,name);
   await db.query('COMMIT');tx=false;
   return c.json({target,table_name:name,default_changed:false,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${target.table_id}`},201);
  }catch(error){if(tx){await db.query('ROLLBACK');tx=false;}remoteError(error);}
  finally{try{await api?.close();}finally{db.release();}}
 });
}
