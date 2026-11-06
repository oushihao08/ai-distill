/**
 * 职责：将DOCX原件转为只读PDF预览副本，PDF/TXT原件直接查看；不修改来源。
 * 入口：readLibraryOriginalPreview() 供材料库单文件预览路由调用。复用原件身份/摘要校验，
 * LibreOffice隔离用户目录、60秒时限，按源摘要缓存；单进程串行转换避免重复预览占满资源。
 */
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {readLibraryOriginal} from './preview';
import {createLibreOfficeEnvironment} from '../materials/libreoffice';
const pending=new Map<string,Promise<Uint8Array>>();
let tail:Promise<unknown>=Promise.resolve();
function validPdf(bytes:Uint8Array){return bytes.byteLength<=32*1024*1024&&Buffer.from(bytes.subarray(0,5)).toString()==='%PDF-';}
async function convert(root:string,key:string,bytes:Uint8Array){
 const directory=join(root,'material-library','previews');await mkdir(directory,{recursive:true,mode:0o700});
 const destination=join(directory,`${key}.pdf`);
 try{const cached=await readFile(destination);if(validPdf(cached))return cached;throw new HTTPException(409,{message:'原文件预览缓存损坏，请下载原文件查看'});}
 catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
 const temporary=await mkdtemp(join(directory,'.docx-'));
 try{
  await writeFile(join(temporary,'source.docx'),bytes,{mode:0o600});
  let child:ReturnType<typeof Bun.spawn>;
  const env=await createLibreOfficeEnvironment(temporary);
  try{child=Bun.spawn([process.env.LIBREOFFICE_PATH||'soffice',`-env:UserInstallation=${pathToFileURL(join(temporary,'profile')).href}`,'--headless','--convert-to','pdf','--outdir',temporary,join(temporary,'source.docx')],{env,stdout:'ignore',stderr:'ignore'});}
  catch{throw new HTTPException(503,{message:'DOCX预览转换器未安装，请先下载原文件查看'});}
  const timer=setTimeout(()=>child.kill(),60000);
  try{if(await child.exited!==0)throw new HTTPException(503,{message:'DOCX预览生成失败，请下载原文件查看'});}finally{clearTimeout(timer);}
  let result:Buffer;
  try{result=await readFile(join(temporary,'source.pdf'));}catch{throw new HTTPException(503,{message:'DOCX预览未生成，请下载原文件查看'});}
  if(!validPdf(result))throw new HTTPException(413,{message:'DOCX预览无效或过大，请下载原文件查看'});
  await rename(join(temporary,'source.pdf'),destination);return result;
 }finally{await rm(temporary,{recursive:true,force:true});}
}
export async function readLibraryOriginalPreview(pool:Pool,root:string,fileId:string){
 const file=await readLibraryOriginal(pool,root,fileId);
 if(!file.name.toLowerCase().endsWith('.docx'))return file;
 const key=createHash('sha256').update('original-docx-pdf-v2\0').update(file.bytes).digest('hex'),identity=join(root,key);
 let promise=pending.get(identity);
 if(!promise){promise=tail.then(()=>convert(root,key,file.bytes));pending.set(identity,promise);tail=promise.then(()=>undefined,()=>undefined);}
 try{return{bytes:await promise,name:file.name.replace(/\.docx$/i,'.pdf'),content_type:'application/pdf'};}
 finally{if(pending.get(identity)===promise)pending.delete(identity);}
}
