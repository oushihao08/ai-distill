/**
 * 职责：将超过单附件限制的 PDF 按页拆到其所在目录，不重新渲染页面。
 * 公开入口：splitLargePdf() 供题目目录同步调用；全部分片落盘并核对后删除超限原件。
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { storageDirectory } from '../paths';
import { MAX_FILE } from '../validation';

const run = promisify(execFile);
const splitRoot = () => join(storageDirectory(), 'pdf-splits');
const MAX_PDF_PAGES = 200;

async function pageCount(path: string): Promise<number> {
 const { stdout } = await run('pdfinfo', [path]);
 const pages = Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1]);
 if (!Number.isSafeInteger(pages) || pages < 1) throw new Error('无法读取 PDF 页数');
 return pages;
}

export async function splitLargePdf(path: string, sourceBytes: Uint8Array): Promise<{name:string;path:string}[]> {
 const pages=await pageCount(path);
 if (sourceBytes.length <= MAX_FILE && pages <= MAX_PDF_PAGES) return [{name:basename(path),path}];
 const sourceBase=basename(path,'.pdf');
 const sourceRange=sourceBase.match(/^(.*)-页(\d{4,})-(\d{4,})$/i);
 const rangeStart=sourceRange?Number(sourceRange[2]):1;
 const rangeEnd=sourceRange?Number(sourceRange[3]):pages;
 const hasSourceRange=Boolean(sourceRange&&rangeEnd-rangeStart+1===pages);
 const prefix=hasSourceRange?sourceRange![1]:sourceBase;
 const pageOffset=hasSourceRange?rangeStart-1:0;
 const digest=createHash('sha256').update(String(MAX_FILE)).update(String(MAX_PDF_PAGES)).update(basename(path)).update(sourceBytes).digest('hex');
 const directory=join(splitRoot(),digest);
 const existing=await readdir(directory).catch(()=>[]);
 if(existing.length&&existing.every(name=>name.endsWith('.pdf'))){
  const files=existing.sort().map(name=>({name,path:join(directory,name)}));
  if((await Promise.all(files.map(file=>stat(file.path)))).every(info=>info.size>0&&info.size<=MAX_FILE))return installBesideSource(path,digest,files);
 }
 await mkdir(splitRoot(),{recursive:true,mode:0o700});
 const temporary=await mkdtemp(join(splitRoot(),'.building-'));
 try {
  const pagePattern=join(temporary,'page-%d.pdf');
  await run('pdfseparate',['-f','1','-l',String(pages),path,pagePattern]);
  const result:{name:string;path:string}[]=[];
  async function writeRange(first:number,last:number):Promise<void>{
   const name=`${prefix}-页${String(pageOffset+first).padStart(4,'0')}-${String(pageOffset+last).padStart(4,'0')}.pdf`;
   const target=join(temporary,name);
   await run('pdfunite',[...Array.from({length:last-first+1},(_,index)=>join(temporary,`page-${first+index}.pdf`)),target]);
   if((await stat(target)).size<=MAX_FILE){result.push({name,path:target});return;}
   await rm(target);
   if(first===last)throw new HTTPException(400,{message:`PDF 第 ${first} 页单独保存后仍超过单文件限制`});
   const middle=Math.floor((first+last)/2);
   await writeRange(first,middle);await writeRange(middle+1,last);
  }
  for(let first=1;first<=pages;first+=MAX_PDF_PAGES)await writeRange(first,Math.min(first+MAX_PDF_PAGES-1,pages));
  if(result.length>100)throw new HTTPException(400,{message:'PDF 分片超过100份限制'});
  for(let page=1;page<=pages;page++)await rm(join(temporary,`page-${page}.pdf`));
 if(createHash('sha256').update(String(MAX_FILE)).update(String(MAX_PDF_PAGES)).update(basename(path)).update(await readFile(path)).digest('hex')!==digest)throw new HTTPException(409,{message:'PDF 在拆分过程中发生变化，请重试同步'});
  try { await rename(temporary,directory); }
  catch(error){if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  return await installBesideSource(path,digest,result.map(file=>({name:file.name,path:join(directory,file.name)})));
 } catch(error) {
  if(error instanceof HTTPException)throw error;
  throw new HTTPException(400,{message:'PDF 拆分失败，请检查 pdfinfo、pdfseparate、pdfunite 是否可用及来源文件是否有效'});
 } finally { await rm(temporary,{recursive:true,force:true}); }
}

async function installBesideSource(source:string,digest:string,parts:{name:string;path:string}[]):Promise<{name:string;path:string}[]> {
 const installed:{name:string;path:string}[]=[];
 for(const part of parts){
  const target=join(dirname(source),part.name);
  const expected=createHash('sha256').update(await readFile(part.path)).digest('hex');
  const current=await readFile(target).catch(error=>{
   if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
   throw error;
  });
  if(current){
   if(createHash('sha256').update(current).digest('hex')!==expected)throw new HTTPException(409,{message:`PDF 分片目标已存在且内容不同：${part.name}`});
  }else{
   const temporary=join(dirname(source),`.pdf-split-${randomUUID()}.tmp`);
   try{
    await copyFile(part.path,temporary);
    try{await link(temporary,target);}
    catch(error){
     if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
     if(createHash('sha256').update(await readFile(target)).digest('hex')!==expected)throw new HTTPException(409,{message:`PDF 分片目标已存在且内容不同：${part.name}`});
    }
   }finally{await rm(temporary,{force:true});}
  }
  installed.push({name:part.name,path:target});
 }
 if(createHash('sha256').update(String(MAX_FILE)).update(String(MAX_PDF_PAGES)).update(basename(source)).update(await readFile(source)).digest('hex')!==digest)throw new HTTPException(409,{message:'PDF 在拆分过程中发生变化，请重试同步'});
 await unlink(source);
 return installed;
}
