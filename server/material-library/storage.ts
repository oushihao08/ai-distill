/**
 * 文件职责：管理独立材料库的不可变文件/数据库文本对象及受控读取。
 * 关键入口：`installLibraryBlob()` 原子安装原件；`insertLibraryTextBlob()` 沿用调用方事务保存提取/脱敏正文；`readLibraryBlob()` 校验路径和摘要后读取；`normalizeLibraryFilename()` 校验上传名称。
 * 使用场景：材料库服务、处理worker、旧数据导入和Codex计划导入；文件只写受管blob目录，文本只写library_blobs，不接触项目输入目录。
 */
import {createHash,randomUUID} from 'node:crypto';
import {link,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import type {PoolClient} from 'pg';

export interface InstalledLibraryBlob {sha256:string;size_bytes:number;content_type:string;storage_target:'local'|'server';storage_path:string}
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
 const temporary=join(realDirectory,`.${sha256}.${randomUUID()}.tmp`);
 try{
  await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
  try{await link(temporary,destination);}
  catch(error){
   if(!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw error;
   const existing=await readFile(destination);
   if(digest(existing)!==sha256||!existing.equals(Buffer.from(bytes)))throw new HTTPException(409,{message:'同摘要材料对象内容校验失败'});
  }
 }finally{await rm(temporary,{force:true});}
 const actualPath=await realpath(destination);
 if(!inside(realRoot,actualPath))throw new HTTPException(409,{message:'材料对象路径越出受管存储范围'});
 const installed=await readFile(actualPath);
 if(digest(installed)!==sha256||!installed.equals(Buffer.from(bytes)))throw new HTTPException(409,{message:'材料对象摘要校验失败'});
 return{sha256,size_bytes:bytes.byteLength,content_type:contentType,storage_target:target,storage_path:relativePath};
}

/** 只能根据数据库返回的受管相对路径读取，拒绝符号链接越界并复核原始字节摘要。 */
export async function readLibraryBlob(storageRoot:string,storagePath:string,expectedSha256:string):Promise<Uint8Array>{
 const root=resolve(storageRoot),path=resolve(root,storagePath);
 if(!inside(root,path))throw new HTTPException(409,{message:'材料对象路径无效'});
 let realRoot:string,actualPath:string;
 try{[realRoot,actualPath]=await Promise.all([realpath(root),realpath(path)]);}catch{throw new HTTPException(404,{message:'材料对象不存在'});}
 if(!inside(realRoot,actualPath))throw new HTTPException(409,{message:'材料对象路径越出受管存储范围'});
 const bytes=await readFile(actualPath);
 if(digest(bytes)!==expectedSha256)throw new HTTPException(409,{message:'材料对象摘要校验失败'});
 return bytes;
}
