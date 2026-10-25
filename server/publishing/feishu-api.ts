/** 职责：飞书凭证隔离、带截止的HTTP调用、统一交付字段与隐藏系统关联字段；供飞书交付与目标配置复用，不读业务数据库。 */
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export const FEISHU_FIELDS=[['题目ID',1],['飞书账号',11],['xpert uid',1],['专家来源',3],['一级行业',3],['L1职业簇',3],['任务名称',1],['任务类型',1],['prompt',1],['输入附件',17],['考点rubric',1],['作答思路',1],['标准答案-文本',1],['标准答案-附件',17],['题目是否完成',3],['系统同步ID',1]] as const;
export class SyncError extends Error {constructor(public code:string){super(code);}}

/** 一次同步使用同一个90秒截止；不重试未知写请求，后续通过远端题目ID对账。 */
export async function feishuClient(){
 if(!process.env.FEISHU_APP_ID||!process.env.FEISHU_APP_SECRET)throw new SyncError('feishu_credentials_missing');
 const signal=AbortSignal.timeout(90_000),root='https://open.feishu.cn/open-apis';
 const auth=await fetch(root+'/auth/v3/tenant_access_token/internal',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:process.env.FEISHU_APP_ID,app_secret:process.env.FEISHU_APP_SECRET})}).then(r=>r.json()) as any;
 if(auth.code!==0||typeof auth.tenant_access_token!=='string')throw new SyncError('feishu_auth_failed');
 async function call(path:string,method='GET',body?:unknown){
  const multipart=body instanceof FormData;
  const response=await fetch(root+path,{method,signal,headers:{Authorization:`Bearer ${auth.tenant_access_token}`,...(!multipart?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:multipart?body:JSON.stringify(body)}:{})});
  const data=await response.json() as any;
  if(!response.ok||data.code!==0)throw new SyncError(`feishu_api_${Number(data.code)||response.status}`);
  return data.data;
 }
 async function list(path:string){const items:any[]=[];let next='';do{const page=await call(`${path}?page_size=100${next?`&page_token=${encodeURIComponent(next)}`:''}`);items.push(...(page.items??[]));if(page.has_more&&!page.page_token)throw new SyncError('feishu_pagination_invalid');next=page.has_more?page.page_token:'';}while(next);return items;}
 return{call,list};
}


/** 校验统一字段并隐藏内部关联；只补兼容版本缺失的系统同步ID，不改用户业务字段。 */
export async function ensureFeishuSchema(api:Awaited<ReturnType<typeof feishuClient>>,base:string,tableId:string){
 const path=`/bitable/v1/apps/${base}/tables/${tableId}`;
 let actual=await api.list(path+'/fields');
 if(FEISHU_FIELDS.filter(([name])=>name!=='系统同步ID').some(([name,type])=>!actual.some(f=>f.field_name===name&&f.type===type)))throw new SyncError('feishu_schema_mismatch');
 if(!actual.some(f=>f.field_name==='系统同步ID')){
  await api.call(path+'/fields','POST',{field_name:'系统同步ID',type:1});actual=await api.list(path+'/fields');
 }
 const internalId=actual.find(f=>f.field_name==='系统同步ID'&&f.type===1)?.field_id;
 if(typeof internalId!=='string')throw new SyncError('feishu_identity_field_missing');
 for(const view of await api.list(path+'/views')){
  if(view.view_type!=='grid')continue;
  const detail=await api.call(path+'/views/'+view.view_id),property=detail.view?.property??{};
  const hidden=Array.isArray(property.hidden_fields)?property.hidden_fields:[];
  if(!hidden.includes(internalId))await api.call(path+'/views/'+view.view_id,'PATCH',{property:{...property,hidden_fields:[...hidden,internalId]}});
 }
}

/** 新目标统一使用同一字段及选项；不复制旧表记录，也不生成空白占位行。 */
export async function createFeishuTable(api:Awaited<ReturnType<typeof feishuClient>>,base:string,name:string){
 const options:Record<string,string[]>={'专家来源':['九盈'],'一级行业':['法律服务'],'L1职业簇':['法律与合规'],'题目是否完成':['已完成','未完成']};
 const created=await api.call(`/bitable/v1/apps/${base}/tables`,'POST',{table:{name,default_view_name:name,fields:FEISHU_FIELDS.map(([field_name,type])=>({field_name,type,...(options[field_name]?{property:{options:options[field_name].map(name=>({name}))}}:{})}))}});
 if(typeof created.table_id!=='string')throw new SyncError('feishu_table_missing');
 await ensureFeishuSchema(api,base,created.table_id);
 return{base_token:base,table_id:created.table_id};
}

/** 仅清理无业务值的占位行；隐藏ID不算业务内容，自定义字段有值时一律保留。 */
export function isEmptyFeishuRow(fields:Record<string,unknown>){
 const empty=(value:unknown)=>value===undefined||value===null||value===''||(Array.isArray(value)&&value.length===0);
 return Object.entries(fields).every(([name,value])=>{
  if(name==='系统同步ID')return empty(value)||(typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
  if(name==='父记录'&&Array.isArray(value))return value.every(item=>item&&typeof item==='object'&&Object.keys(item).every(key=>['table_id','type','text_arr'].includes(key))&&Array.isArray(item.text_arr)&&item.text_arr.length===0);
  return empty(value);
 });
}

/** 创建前清理空壳，先本机备份、逐行重读复核；只删除明确空内容，不复用其他题目的record_id。 */
export async function removeEmptyFeishuRows(api:Awaited<ReturnType<typeof feishuClient>>,base:string,tableId:string,storageRoot:string,onlyRecordIds?:string[]){
 const path=`/bitable/v1/apps/${base}/tables/${tableId}`,rows=await api.list(path+'/records');
 const candidates=rows.filter(row=>(!onlyRecordIds||onlyRecordIds.includes(row.record_id))&&isEmptyFeishuRow(row.fields??{}));
 if(!candidates.length)return{deleted:[] as string[],backup_path:null};
 const folder=join(storageRoot,'feishu-row-cleanup');await mkdir(folder,{recursive:true,mode:0o700});
 const backupPath=join(folder,crypto.randomUUID()+'.json');
 await writeFile(backupPath,JSON.stringify({base_token:base,table_id:tableId,created_at:new Date().toISOString(),records:candidates},null,2),{flag:'wx',mode:0o600});
 const deleted:string[]=[];
 for(const candidate of candidates){
  const current=await api.call(path+'/records/'+candidate.record_id);
  if(!isEmptyFeishuRow(current.record?.fields??{}))throw new SyncError('feishu_empty_row_changed');
  await api.call(path+'/records/'+candidate.record_id,'DELETE');deleted.push(candidate.record_id);
 }
 return{deleted,backup_path:backupPath};
}
