/**
 * 职责：将超过单附件限制的 PDF 按页拆到管理存储，不修改来源目录或原件。
 * 公开入口：splitLargePdf() 供题目目录同步调用；分片缓存于 .storage/pdf-splits 并按指纹复用。
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { storageDirectory } from '../paths';
import { MAX_FILE } from '../validation';
import { classifyLogError, logEvent } from '../logging';

const run = promisify(execFile);
const splitRoot = () => join(storageDirectory(), 'pdf-splits');
const MAX_PDF_PAGES = 200;

/** qpdf 状态3表示已生成结果但源文件存在警告；产物仍须经过后续页数、大小和来源摘要校验。 */
async function runQpdf(args:string[]){
 try{await run('qpdf',args,{timeout:180000,maxBuffer:1024*1024});}
 catch(error){if(Number((error as NodeJS.ErrnoException).code)!==3)throw error;}
}

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
 let compactSplit=false;try{await run('qpdf',['--version'],{timeout:5000});compactSplit=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('qpdf不可用，请检查安装');}
 const splitVersion=compactSplit?'qpdf-resource-pruned-v1':'poppler-v1';
 const digest=createHash('sha256').update(splitVersion).update(String(MAX_FILE)).update(String(MAX_PDF_PAGES)).update(basename(path)).update(sourceBytes).digest('hex');
 const directory=join(splitRoot(),digest);
 const existing=await readdir(directory).catch(()=>[]);
 if(existing.length&&existing.every(name=>name.endsWith('.pdf'))){
  const files=existing.sort().map(name=>({name,path:join(directory,name)}));
  if((await Promise.all(files.map(file=>stat(file.path)))).every(info=>info.size>0&&info.size<=MAX_FILE))return files;
 }
 await mkdir(splitRoot(),{recursive:true,mode:0o700});
 const temporary=await mkdtemp(join(splitRoot(),'.building-'));
 let phase='pdfseparate';
 try {
  const pagePattern=join(temporary,'page-%d.pdf');
  if(!compactSplit)await run('pdfseparate',['-f','1','-l',String(pages),path,pagePattern]);
  const result:{name:string;path:string}[]=[];
  async function writeRange(first:number,last:number):Promise<void>{
   const name=`${prefix}-页${String(pageOffset+first).padStart(4,'0')}-${String(pageOffset+last).padStart(4,'0')}.pdf`;
   const target=join(temporary,name);
   phase='pdfunite';
   if(compactSplit)await runQpdf(['--empty','--pages',path,`${first}-${last}`,'--','--remove-unreferenced-resources=yes',target]);
   else await run('pdfunite',[...Array.from({length:last-first+1},(_,index)=>join(temporary,`page-${first+index}.pdf`)),target]);
   if(await pageCount(target)!==last-first+1)throw new Error('PDF分片页数不一致');
   phase='verify_parts';
   if((await stat(target)).size<=MAX_FILE){result.push({name,path:target});return;}
   await rm(target);
   if(first===last)throw new HTTPException(400,{message:`PDF 第 ${first} 页单独保存后仍超过单文件限制`});
   const middle=Math.floor((first+last)/2);
   await writeRange(first,middle);await writeRange(middle+1,last);
  }
  for(let first=1;first<=pages;first+=MAX_PDF_PAGES)await writeRange(first,Math.min(first+MAX_PDF_PAGES-1,pages));
  if(result.length>100)throw new HTTPException(400,{message:'PDF 分片超过100份限制'});
  phase='cleanup_pages';
  if(!compactSplit)for(let page=1;page<=pages;page++)await rm(join(temporary,`page-${page}.pdf`));
  phase='verify_source';
 if(createHash('sha256').update(splitVersion).update(String(MAX_FILE)).update(String(MAX_PDF_PAGES)).update(basename(path)).update(await readFile(path)).digest('hex')!==digest)throw new HTTPException(409,{message:'PDF 在拆分过程中发生变化，请重试同步'});
  phase='cache_commit';
  try { await rename(temporary,directory); }
  catch(error){if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  return result.map(file=>({name:file.name,path:join(directory,file.name)}));
 } catch(error) {
  if(error instanceof HTTPException)throw error;
  logEvent('pdf_split.failed',{level:'error',component:'materials',operation:'pdf_split',reason_code:`${phase}_failed`,...classifyLogError(error)});
  throw new HTTPException(400,{message:'PDF 拆分失败，请检查 pdfinfo、pdfseparate、pdfunite 是否可用及来源文件是否有效'});
 } finally { await rm(temporary,{recursive:true,force:true}); }
}
