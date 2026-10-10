/**
 * 职责：Codex 设置服务：管理系统与项目默认值、步骤覆盖合并，以及经路径校验的凭证目录。
 * 关键方法与用途：`readCodexSettings()` 合并步骤、项目、系统设置；`saveCodexSettings()` 与项目保存／清除方法写入覆盖；凭证目录方法单独校验路径。
 * 使用场景：API 保存设置，`worker.ts` 创建任务时读取冻结后的有效配置。
 */
import type {Pool} from 'pg';
import {constants} from 'node:fs';
import {access,realpath,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,dirname,isAbsolute,resolve} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import {readCodexModelCatalog,validateCodexModelSettings,type AdvertisedModel} from './models';

export const DEFAULT_CODEX_SETTINGS={model:'gpt-6.1-sol',reasoning_effort:'medium'};
export interface CodexModelSettings {model:string;reasoning_effort:string}
export type CodexSettingsSource='step'|'project'|'system';
type CodexSettingsQuery=Pick<Pool,'query'>;

function supportedModelSettings(model:string,reasoning_effort:string):CodexModelSettings{
 return model==='gpt-6-astra'?{model:'gpt-6-luna',reasoning_effort:reasoning_effort==='ultra'?'max':reasoning_effort}:{model,reasoning_effort};
}

export function mergeCodexDefaults(raw:unknown,defaults:CodexModelSettings):Record<string,unknown>&CodexModelSettings{
 const overrides=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 const merged={...defaults,...overrides} as Record<string,unknown>&CodexModelSettings;
 return{...merged,...supportedModelSettings(merged.model,merged.reasoning_effort)};
}

export async function readCodexSettings(pool:CodexSettingsQuery):Promise<{credential_home:string|null}&CodexModelSettings>{
 const result=await pool.query('SELECT credential_home,model,reasoning_effort FROM ai_distill.system_codex_config WHERE id=1');
 const row=result.rows[0];
 const settings=supportedModelSettings(
  typeof row?.model==='string'?row.model:DEFAULT_CODEX_SETTINGS.model,
  typeof row?.reasoning_effort==='string'?row.reasoning_effort:DEFAULT_CODEX_SETTINGS.reasoning_effort,
 );
 return{
  credential_home:typeof row?.credential_home==='string'?row.credential_home:null,
  ...settings,
 };
}

export async function readCodexDefaults(pool:CodexSettingsQuery):Promise<CodexModelSettings>{
 const {model,reasoning_effort}=await readCodexSettings(pool);
 return{model,reasoning_effort};
}

export async function readProjectCodexSettings(pool:CodexSettingsQuery,id:string):Promise<CodexModelSettings&{source:'project'|'system'}>{
 const [project,system]=await Promise.all([
  pool.query('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id]),
  readCodexDefaults(pool),
 ]);
 const row=project.rows[0];
 if(!row)throw new HTTPException(404,{message:'项目不存在'});
 if(typeof row.codex_model==='string'&&typeof row.codex_reasoning_effort==='string')return{...supportedModelSettings(row.codex_model,row.codex_reasoning_effort),source:'project'};
 return{...system,source:'system'};
}

export async function readProjectCodexDefaults(pool:CodexSettingsQuery,id:string):Promise<CodexModelSettings>{
 const {model,reasoning_effort}=await readProjectCodexSettings(pool,id);
 return{model,reasoning_effort};
}

export async function saveProjectCodexSettings(pool:CodexSettingsQuery,id:string,value:unknown,catalog?:AdvertisedModel[]):Promise<CodexModelSettings&{source:'project'}>{
 const system=await readCodexSettings(pool);
 const settings=validateCodexModelSettings(value,catalog??readCodexModelCatalog(system.credential_home??undefined));
 const saved=await pool.query(`UPDATE ai_distill.projects SET codex_model=$2,codex_reasoning_effort=$3
  WHERE id=$1 AND deleted_at IS NULL RETURNING codex_model,codex_reasoning_effort`,[id,settings.model,settings.reasoning_effort]);
 if(!saved.rowCount)throw new HTTPException(404,{message:'项目不存在'});
 return{model:saved.rows[0]!.codex_model,reasoning_effort:saved.rows[0]!.codex_reasoning_effort,source:'project'};
}

export async function clearProjectCodexSettings(pool:CodexSettingsQuery,id:string):Promise<CodexModelSettings&{source:'system'}>{
 const saved=await pool.query(`UPDATE ai_distill.projects SET codex_model=NULL,codex_reasoning_effort=NULL
  WHERE id=$1 AND deleted_at IS NULL RETURNING id`,[id]);
 if(!saved.rowCount)throw new HTTPException(404,{message:'项目不存在'});
 const settings=await readCodexDefaults(pool);
 return{...settings,source:'system'};
}

export async function readCodexCredentialHome(pool:Pool):Promise<string|undefined>{
 const result=await pool.query('SELECT credential_home FROM ai_distill.system_codex_config WHERE id=1');
 return typeof result.rows[0]?.credential_home==='string'?result.rows[0].credential_home:undefined;
}

async function normalizeCredentialHome(value:unknown):Promise<string|null>{
 if(value===null||value===undefined||value==='')return null;
 if(typeof value!=='string'||value.length>2048||/[\x00-\x1f]/.test(value))throw new Error('凭证路径格式无效');
 const expanded=value.trim().replace(/^~(?=\/|$)/,homedir());
 if(!expanded||!isAbsolute(expanded))throw new Error('请输入绝对路径');
 let canonical:string;
 try{
  const resolved=resolve(expanded),info=await stat(resolved);
  if(info.isFile()){
   if(basename(resolved)!=='auth.json')throw new Error('请选择 Codex 凭证目录或 auth.json');
   canonical=await realpath(dirname(resolved));
  }else if(info.isDirectory())canonical=await realpath(resolved);
  else throw new Error('凭证路径须为目录或 auth.json');
  await access(canonical,constants.R_OK|constants.X_OK);
 }catch(error){
  if(error instanceof Error&&['请选择 Codex 凭证目录或 auth.json','凭证路径须为目录或 auth.json'].includes(error.message))throw error;
  throw new Error('凭证目录不存在或当前用户不可读取');
 }
 return canonical;
}

export async function saveCodexCredentialHome(pool:Pool,value:unknown):Promise<string|null>{
 return(await saveCodexSettings(pool,{credential_home:value})).credential_home;
}

export async function saveCodexSettings(pool:Pool,value:unknown,catalog?:AdvertisedModel[]):Promise<{credential_home:string|null}&CodexModelSettings>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请提交有效JSON');
 const body=value as Record<string,unknown>;
 const current=await readCodexSettings(pool);
 const credentialHome=Object.hasOwn(body,'credential_home')?await normalizeCredentialHome(body.credential_home):current.credential_home;
 const hasModelSettings=Object.hasOwn(body,'model')||Object.hasOwn(body,'reasoning_effort');
 const modelSettings=hasModelSettings
  ?validateCodexModelSettings({model:body.model??current.model,reasoning_effort:body.reasoning_effort??current.reasoning_effort},catalog??readCodexModelCatalog(credentialHome??undefined))
  :{model:current.model,reasoning_effort:current.reasoning_effort};
 const saved=await pool.query(`INSERT INTO ai_distill.system_codex_config(id,credential_home,model,reasoning_effort) VALUES(1,$1,$2,$3)
  ON CONFLICT(id) DO UPDATE SET credential_home=EXCLUDED.credential_home,model=EXCLUDED.model,reasoning_effort=EXCLUDED.reasoning_effort,updated_at=now()
  RETURNING credential_home,model,reasoning_effort`,[credentialHome,modelSettings.model,modelSettings.reasoning_effort]);
 const row=saved.rows[0];
 return{
  credential_home:typeof row?.credential_home==='string'?row.credential_home:null,
  model:typeof row?.model==='string'?row.model:modelSettings.model,
  reasoning_effort:typeof row?.reasoning_effort==='string'?row.reasoning_effort:modelSettings.reasoning_effort,
 };
}
