import type {Pool} from 'pg';
import {constants} from 'node:fs';
import {access,realpath,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,dirname,isAbsolute,resolve} from 'node:path';

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
 const credentialHome=await normalizeCredentialHome(value);
 await pool.query(`INSERT INTO ai_distill.system_codex_config(id,credential_home) VALUES(1,$1)
  ON CONFLICT(id) DO UPDATE SET credential_home=EXCLUDED.credential_home,updated_at=now()`,[credentialHome]);
 return credentialHome;
}
