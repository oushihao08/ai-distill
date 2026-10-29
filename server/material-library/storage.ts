/**
 * 文件职责：管理独立材料库的不可变文件/数据库文本对象及受控读取。
 * 关键入口：`installLibraryBlob()` 原子安装原件；`insertLibraryTextBlob()` 沿用调用方事务保存提取/脱敏正文；`readLibraryBlob()` 校验路径和摘要后读取；`normalizeLibraryFilename()` 校验上传名称。
 * 使用场景：材料库服务、处理worker、旧数据导入和Codex计划导入；文件只写受管blob目录，文本只写library_blobs，不接触项目输入目录。
 */
import {createHash,randomUUID} from 'node:crypto';
import {link,lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import type {PoolClient} from 'pg';
import {logEvent} from '../logging';

export interface InstalledLibraryBlob {sha256:string;size_bytes:number;content_type:string;storage_target:'local'|'server';storage_path:string;installed_new:boolean}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** 三条材料处理入口共用不可变文本对象写入；沿用调用方事务，同摘要/MIME复用前复核正文及UTF8字节数。 */
export async function insertLibraryTextBlob(db:Pick<PoolClient,'query'>,content:string,contentType:string){
 const sha256=createHash('sha256').update(content).digest('hex'),size=Buffer.byteLength(content);
 const inserted=await db.query(`INSERT INTO ai_distill.library_blobs(id,sha256,size_bytes,content_type,storage_kind,text_content)
  VALUES($1,$2,$3,$4,'database_text',$5) ON CONFLICT(sha256,content_type) WHERE storage_kind='database_text' DO NOTHING RETURNING id`,[randomUUID(),sha256,size,contentType,content]);
 if(inserted.rows[0]?.id)return{id:inserted.rows[0].id as string,sha256,size_bytes:size};
 const existing=(await db.query("SELECT id,text_content,size_bytes FROM ai_distill.library_blobs WHERE sha256=$1 AND content_type=$2 AND storage_kind='database_text'",[sha256,contentType])).rows[0];
 if(!existing||existing.text_content!==content||Number(existing.size_bytes)!==size)throw new HTTPException(409,{message:'材料文本对象摘要或大小冲突'});
 return{id:existing.id as string,sha256,size_bytes:size};
}
function inside(root:string,path:string){const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!rel.startsWith(sep);}

/** 保留层级但拒绝绝对路径、空段、路径回退和控制字符。 */
export function normalizeLibraryFilename(value:string):string{
 if(typeof value!=='string'||!value.trim()||value.length>500||/[\x00-\x1f\x7f]/.test(value))throw new HTTPException(400,{message:'材料文件名无效'});
 const normalized=value.replaceAll('\\','/');
 if(normalized.startsWith('/')||/^[a-z]:/i.test(normalized)||normalized.split('/').some(part=>!part||part==='.'||part==='..'))throw new HTTPException(400,{message:'材料文件名必须是安全的相对路径'});
 return normalized;
}

/** 同 SHA 和存储目标只安装一个文件；硬链接提供原子 no-replace 发布，重放时重新核对既有内容。 */
export async function installLibraryBlob(storageRoot:string,bytes:Uint8Array,contentType:string,target:'local'|'server'):Promise<InstalledLibraryBlob>{
 if(!contentType.trim())throw new HTTPException(400,{message:'材料内容类型无效'});
 const root=resolve(storageRoot),sha256=digest(bytes),relativePath=join('material-library','blobs',sha256.slice(0,2),sha256),destination=resolve(root,relativePath);
 if(!inside(root,destination))throw new HTTPException(400,{message:'材料对象路径无效'});
 await mkdir(dirname(destination),{recursive:true,mode:0o700});
 const realRoot=await realpath(root),realDirectory=await realpath(dirname(destination));
 if(!inside(realRoot,realDirectory))throw new HTTPException(409,{message:'材料对象目录越出受管存储范围'});
 const temporary=join(realDirectory,`.${sha256}.${randomUUID()}.tmp`);let installedNew=false;
 try{
  await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
  try{await link(temporary,destination);installedNew=true;}
  catch(error){
   if(!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw error;
   const existing=await readFile(destination);
   if(digest(existing)!==sha256||!existing.equals(Buffer.from(bytes)))throw new HTTPException(409,{message:'同摘要材料对象内容校验失败'});
  }
 }finally{
  // 临时硬链接清理是辅助工作：失败不能覆盖安装异常，也不能阻止下方正式文件校验及回执返回。
  // installed_new回执必须交给上传/导入方，后续数据库回滚才知道哪些原件可进入安全回收核查。
  try{await rm(temporary,{force:true});}
  catch{logEvent('library_blob.install_cleanup_failed',{level:'warn',reason_code:'temporary_blob_cleanup_failed'});}
 }
 const actualPath=await realpath(destination);
 if(!inside(realRoot,actualPath))throw new HTTPException(409,{message:'材料对象路径越出受管存储范围'});
 const installed=await readFile(actualPath);
 if(digest(installed)!==sha256||!installed.equals(Buffer.from(bytes)))throw new HTTPException(409,{message:'材料对象摘要校验失败'});
 return{sha256,size_bytes:bytes.byteLength,content_type:contentType,storage_target:target,storage_path:relativePath,installed_new:installedNew};
}

/** 所有原件登记入口在安装前按同一顺序取得事务锁，覆盖安装到数据库提交；回收也用同一锁，防止查无登记后误删并发上传。 */
export async function lockLibraryBlobWrites(db:Pick<PoolClient,'query'>,sha256s:readonly string[]){
 for(const sha256 of [...new Set(sha256s)].sort()){
  if(!/^[a-f0-9]{64}$/i.test(sha256))throw new Error('材料对象锁摘要无效');
  // 内容寻址路径没有target段，同摘要跨target也共用锁；数据库核查同样保守覆盖全部目标。
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`library-blob:${sha256}`]);
 }
}

/**
 * 仅在调用方确认ROLLBACK成功后执行；沿用已归还事务但尚未release的连接，不另取池连接。
 * 只回收本次新安装、当前仍无任何file blob登记的原件，不扫描历史目录、不删复用文件或数据库记录。
 * COMMIT回执未知但实际已提交时，登记查询会保留文件；查询/锁/路径/摘要检查失败时保留并记录安全原因。
 * 普通上传和历史导入必须先使用lockLibraryBlobWrites；部署须让同一存储的原件写入口一起加载新代码。
 * installed_new是内存中的本次安装回执，不属于持久化blob身份；进程崩溃或无法确认回滚时不据此自动清理。
 */
export async function cleanupRolledBackLibraryBlobs(db:Pick<PoolClient,'query'>,root:string,installed:readonly InstalledLibraryBlob[]){
 const candidates=[...new Map(installed.filter(blob=>blob.installed_new).map(blob=>[`${blob.storage_target}:${blob.sha256}`,blob])).values()];
 let removed=0,retained=0;
 if(!candidates.length)return{removed,retained,deferred:0};
 try{
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='2s'");
  await db.query("SET LOCAL statement_timeout='10s'");
  await lockLibraryBlobWrites(db,candidates.map(blob=>blob.sha256));
  for(const blob of candidates){
   const registered=await db.query("SELECT id FROM ai_distill.library_blobs WHERE sha256=$1 AND storage_kind='file' LIMIT 1",[blob.sha256]);
   if(registered.rows.length){retained++;continue;}
   const canonical=join('material-library','blobs',blob.sha256.slice(0,2),blob.sha256);
   if(blob.storage_path!==canonical)throw new Error('材料回收路径无效');
   const path=resolve(root,canonical),info=await lstat(path);
   if(!info.isFile()||info.isSymbolicLink())throw new Error('材料回收对象无效');
   const bytes=await readLibraryBlob(root,canonical,blob.sha256);
   if(bytes.byteLength!==blob.size_bytes)throw new Error('材料回收对象大小不匹配');
   await rm(path);removed++;
  }
  await db.query('COMMIT');
  return{removed,retained,deferred:0};
 }catch{
  try{await db.query('ROLLBACK');}catch{logEvent('library_blob.cleanup_rollback_failed',{level:'error',reason_code:'cleanup_rollback_unconfirmed'});}
  logEvent('library_blob.cleanup_deferred',{level:'error',reason_code:'cleanup_not_verified'});
  return{removed,retained,deferred:candidates.length-removed-retained};
 }
}

/** 只能根据数据库返回的受管相对路径读取，拒绝符号链接越界并复核原始字节摘要。 */
export async function readLibraryBlob(storageRoot:string,storagePath:string,expectedSha256:string):Promise<Uint8Array>{
 const root=resolve(storageRoot),path=resolve(root,storagePath);
 if(!inside(root,path))throw new HTTPException(409,{message:'材料对象路径无效'});
 let realRoot:string,actualPath:string;
 try{[realRoot,actualPath]=await Promise.all([realpath(root),realpath(path)]);}catch{throw new HTTPException(404,{message:'材料对象不存在'});}
 if(!inside(realRoot,actualPath))throw new HTTPException(409,{message:'材料对象路径越出受管存储范围'});
 const bytes=await readFile(actualPath);
 return bytes;
}
