/**
 * 职责：项目模型集合：校验注册模型、读取启用配置并生成包含评分门槛的稳定指纹。
 * 关键方法与用途：`validateModelSet()` 校验选择；`readProjectModelSet()`／`listAnswerModels()` 读取目录；`registerAnswerModel()`、`setAnswerModelEnabled()`、`saveProjectModelSet()` 更新配置；`answerModelSetDigest()` 固定集合指纹。
 * 使用场景：由 `app.ts` 的项目模型设置接口和作答队列调用。
 */
import {HTTPException} from 'hono/http-exception';
import {resolveAnswerConfig} from './dispatch';
import {readConfiguredAgentModelCatalog} from '../agent/config';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

export interface RegisteredAnswerModel {
 model_id:string;
 name:string;
 // 保留历史字段名，当前语义为0—100的百分制分数上限。
 minimum_score:number|null;
 config:ReturnType<typeof resolveAnswerConfig>;
}

export function answerModelSetDigest(models:readonly RegisteredAnswerModel[]):string{
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const snapshot=models.map(({model_id,name,minimum_score,config})=>({model_id,name,minimum_score,config}));
 return createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
}

export function validateModelSet(raw:unknown):RegisteredAnswerModel[]{
 if(!Array.isArray(raw)||raw.length<1||raw.length>8)throw new HTTPException(400,{message:'项目须选择1至8个模型'});
 const ids=new Set<string>();const identities=new Set<string>();
 return raw.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw new HTTPException(400,{message:'模型设置无效'});
  const value=item as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['model_id','name','minimum_score','config'].includes(key))||typeof value.model_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.model_id)||ids.has(value.model_id)||typeof value.name!=='string'||!value.name.trim()||value.name.length>80||(value.minimum_score!==null&&(typeof value.minimum_score!=='number'||!Number.isFinite(value.minimum_score)||value.minimum_score<0||value.minimum_score>100)))throw new HTTPException(400,{message:'模型设置无效或重复'});
  let config:ReturnType<typeof resolveAnswerConfig>;
  try{config=resolveAnswerConfig(value.config,{});}catch{throw new HTTPException(400,{message:'模型端点或模型标识无效'});}
  const identity=JSON.stringify([config.provider,'base_url'in config?config.base_url:null,config.model,'reasoning_effort'in config?config.reasoning_effort:null]);
  if(identities.has(identity))throw new HTTPException(400,{message:'同一模型不能重复加入项目'});
  ids.add(value.model_id);identities.add(identity);
  return {model_id:value.model_id,name:value.name.trim(),minimum_score:value.minimum_score,config};
 });
}

export async function readProjectModelSet(db:Pool|PoolClient,projectId:string,requireEnabled=true):Promise<RegisteredAnswerModel[]>{
 const rows=await db.query(`SELECT s.model_id,m.name,m.config,m.enabled,s.minimum_score
  FROM ai_distill.project_answer_models s JOIN ai_distill.system_answer_models m ON m.id=s.model_id
  WHERE s.project_id=$1 ORDER BY s.position`,[projectId]);
 if(!rows.rowCount)return [];
 if(requireEnabled&&rows.rows.some(row=>!row.enabled))throw new HTTPException(409,{message:'项目所选模型已停用，请更新项目模型集合'});
 return validateModelSet(rows.rows.map(row=>({model_id:row.model_id,name:row.name,minimum_score:row.minimum_score===null?null:Number(row.minimum_score),config:row.config})));
}

export async function listAnswerModels(db:Pool,enabledOnly=false){
 const rows=await db.query(`SELECT id,name,provider,base_url,model,config,enabled,created_at FROM ai_distill.system_answer_models ${enabledOnly?'WHERE enabled=true':''} ORDER BY name,id`);
 return rows.rows;
}

export async function registerAnswerModel(db:Pool,raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HTTPException(400,{message:'模型登记须为JSON对象'});
 const value=raw as Record<string,unknown>;
 if(value.provider==='codex'){
  if(Object.keys(value).some(key=>!['provider','model','reasoning_effort'].includes(key))||typeof value.model!=='string'||typeof value.reasoning_effort!=='string')throw new HTTPException(400,{message:'Codex模型登记信息无效'});
  const catalog=await readConfiguredAgentModelCatalog(db);
  if(!catalog.some(item=>item.slug===value.model&&item.supported_reasoning_levels.some(level=>level.effort===value.reasoning_effort)))throw new HTTPException(400,{message:'所选Codex模型或推理强度不在本机可用目录中'});
  const config=validateModelSet([{model_id:crypto.randomUUID(),name:`Codex ${value.model} · ${value.reasoning_effort}`,minimum_score:0,config:{provider:'codex',model:value.model,reasoning_effort:value.reasoning_effort}}])[0]!;
  const id=config.model_id,baseUrl=`codex://local/${encodeURIComponent(value.reasoning_effort)}`;
  const saved=await db.query(`INSERT INTO ai_distill.system_answer_models(id,name,provider,base_url,model,config)
   VALUES($1,$2,'codex',$3,$4,$5::jsonb) RETURNING id,name,provider,base_url,model,config,enabled,created_at`,[id,config.name,baseUrl,config.config.model,JSON.stringify(config.config)]);
  return saved.rows[0];
 }
 if(value.provider==='siliconflow'){
  if(Object.keys(value).some(key=>!['provider','model'].includes(key))||typeof value.model!=='string'||!value.model.trim())throw new HTTPException(400,{message:'SiliconFlow模型登记信息无效'});
  const modelId=value.model.trim();
  const id=crypto.randomUUID();
  const model=validateModelSet([{model_id:id,name:`SiliconFlow · ${modelId}`,minimum_score:0,config:{provider:'siliconflow',model:modelId}}])[0]!;
  if(model.config.provider==='codex')throw new HTTPException(400,{message:'SiliconFlow模型配置无效'});
  const saved=await db.query(`INSERT INTO ai_distill.system_answer_models(id,name,provider,base_url,model,config)
   VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,name,provider,base_url,model,config,enabled,created_at`,[id,model.name,model.config.provider,model.config.base_url,model.config.model,JSON.stringify(model.config)]);
  return saved.rows[0];
 }
 if(Object.keys(value).some(key=>key!=='model_id')||typeof value.model_id!=='string'||!value.model_id.trim())throw new HTTPException(400,{message:'请填写OpenRouter模型ID'});
 const modelId=value.model_id.trim();
 const id=crypto.randomUUID();
 const model=validateModelSet([{model_id:id,name:modelId,minimum_score:0,config:{provider:'openrouter',model:modelId}}])[0]!;
 if(model.config.provider==='codex')throw new HTTPException(400,{message:'OpenRouter模型配置无效'});
 const saved=await db.query(`INSERT INTO ai_distill.system_answer_models(id,name,provider,base_url,model,config)
  VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,name,provider,base_url,model,config,enabled,created_at`,[id,model.name,model.config.provider,model.config.base_url,model.config.model,JSON.stringify(model.config)]);
 return saved.rows[0];
}

export async function setAnswerModelEnabled(db:Pool,modelId:string,enabled:unknown){
 if(typeof enabled!=='boolean')throw new HTTPException(400,{message:'enabled须为布尔值'});
 const saved=await db.query('UPDATE ai_distill.system_answer_models SET enabled=$2 WHERE id=$1 RETURNING id,name,provider,base_url,model,config,enabled,created_at',[modelId,enabled]);
 if(!saved.rowCount)throw new HTTPException(404,{message:'模型不存在'});
 return saved.rows[0];
}

export async function saveProjectModelSet(pool:Pool,projectId:string,raw:unknown){
 if(!Array.isArray(raw)||raw.length<1||raw.length>8)throw new HTTPException(400,{message:'项目须选择1至8个模型'});
 const ids:string[]=[];const thresholds=new Map<string,number|null>();
 for(const item of raw){
  if(!item||typeof item!=='object'||Array.isArray(item))throw new HTTPException(400,{message:'项目模型设置无效'});
  const value=item as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['model_id','minimum_score'].includes(key))||typeof value.model_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.model_id)||thresholds.has(value.model_id)||(value.minimum_score!==null&&(typeof value.minimum_score!=='number'||!Number.isFinite(value.minimum_score)||value.minimum_score<0||value.minimum_score>100)))throw new HTTPException(400,{message:'项目模型设置无效或重复'});
  ids.push(value.model_id);thresholds.set(value.model_id,value.minimum_score);
 }
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  if(!(await db.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[projectId])).rowCount)throw new HTTPException(404,{message:'项目不存在'});
  const catalog=await db.query('SELECT id AS model_id,name,config,enabled FROM ai_distill.system_answer_models WHERE id=ANY($1::uuid[]) ORDER BY id',[ids]);
  if(catalog.rowCount!==ids.length||catalog.rows.some(row=>!row.enabled))throw new HTTPException(409,{message:'所选模型不存在或已停用'});
  const byId=new Map(catalog.rows.map(row=>[row.model_id,row]));
  const normalized=validateModelSet(ids.map(modelId=>{const row=byId.get(modelId)!;return {model_id:row.model_id,name:row.name,minimum_score:thresholds.get(row.model_id),config:row.config};}));
  const previous=await readProjectModelSet(db,projectId,false);
  const changed=answerModelSetDigest(previous)!==answerModelSetDigest(normalized);
  await db.query('DELETE FROM ai_distill.project_answer_models WHERE project_id=$1',[projectId]);
  for(const [position,item] of normalized.entries())await db.query('INSERT INTO ai_distill.project_answer_models(project_id,model_id,minimum_score,position) VALUES($1,$2,$3,$4)',[projectId,item.model_id,item.minimum_score,position]);
  if(changed){
   await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE ordinal BETWEEN 5 AND 8 AND workflow_id IN (SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL)",[projectId]);
   await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='项目模型集合或评分上限已变化，当前结果失效',finished_at=now() WHERE ordinal BETWEEN 5 AND 8 AND status IN ('waiting','running') AND workflow_id IN (SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL)",[projectId]);
   await db.query("UPDATE ai_distill.project_exports SET status='stale',error='项目模型集合或评分上限已变化',finished_at=now() WHERE project_id=$1 AND status IN ('running','succeeded')",[projectId]);
   await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE project_id=$1 AND deleted_at IS NULL AND status='succeeded'",[projectId]);
  }
  await db.query('COMMIT');return normalized;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
