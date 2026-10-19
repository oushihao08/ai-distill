/**
 * 职责：页级 PDF 工具：封装 Poppler 命令、文字与 OCR 提取、页级并发及指纹缓存。
 * 关键方法与用途：`command()` 安全调用 Poppler 工具；`extractPdf()` 按页执行文字／OCR 提取、并发控制和指纹缓存。
 * 使用场景：command供Poppler工具复用，documentBlocksToText供当前结构投影；extractPdf为旧Vision提取路径，不是当前MinerU队列入口。
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {currentTaskSignal} from '../task-signal';
import { join } from 'node:path';
import type { VisionClient } from './vision';
export interface DocumentCell { text: string; rowSpan?: number; columnSpan?: number }
export interface DocumentRow { cells: DocumentCell[] }
export const DOCUMENT_STRUCTURE_VERSION = 'document-structure-v1';
export type DocumentBlock =
 | { id: string; kind: 'heading' | 'paragraph' | 'footnote' | 'caption' | 'formula' | 'code'; text: string; level?: number }
 | { id: string; kind: 'list'; items: string[] }
 | { id: string; kind: 'table'; rows: DocumentRow[]; caption?: string; footnotes?: string[] };
export function documentBlocksToText(blocks: DocumentBlock[]) {
 return blocks.map(block => {
  if (block.kind === 'table') return [block.caption, block.rows.map(row => row.cells.map(cell => cell.text).join('\t')).join('\n'), ...(block.footnotes ?? [])].filter((part): part is string => part !== undefined).join('\n');
  if (block.kind === 'list') return block.items.join('\n');
  return block.text;
 }).join('\n');
}
export interface Page { page: number; text: string; structure?: DocumentBlock[]; method: 'text' | 'ocr'; usage?: unknown; model?: string; reused?: boolean; issues?: string[]; attempts?: { effort:string; elapsed_ms:number; issue?:string; usage?:unknown }[]; }
export interface PageCheckpoint { directory:string; source_sha256:string; config_fingerprint:string; }
const PAGE_CONCURRENCY=3,MAX_PAGE_RETRIES=2;
let activePages=0;const pageWaiters:(()=>void)[]=[];
async function withPageSlot<T>(work:()=>Promise<T>):Promise<T>{
 if(activePages>=PAGE_CONCURRENCY)await new Promise<void>(resolve=>pageWaiters.push(resolve));
 activePages++;
 try{return await work();}finally{activePages--;pageWaiters.shift()?.();}
}
async function readPageCheckpoint(checkpoint:PageCheckpoint,page:number):Promise<Page|undefined>{
 const path=join(checkpoint.directory,`page-${String(page).padStart(4,'0')}.json`);
 try{
  const value=JSON.parse(await readFile(path,'utf8'));
  if(value.source_sha256!==checkpoint.source_sha256||value.config_fingerprint!==checkpoint.config_fingerprint||value.page?.page!==page||typeof value.page.text!=='string'||!['text','ocr'].includes(value.page.method))throw new Error('invalid checkpoint');
  return {...value.page,reused:true};
 }catch(error){
  if(error instanceof Error&&(error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
  await rm(path,{force:true});return undefined;
 }
}
async function writePageCheckpoint(checkpoint:PageCheckpoint,page:Page){
 const path=join(checkpoint.directory,`page-${String(page.page).padStart(4,'0')}.json`),temporary=`${path}.${crypto.randomUUID()}.tmp`;
 const {reused:_,...savedPage}=page;
 try{await writeFile(temporary,JSON.stringify({source_sha256:checkpoint.source_sha256,config_fingerprint:checkpoint.config_fingerprint,page:savedPage}),{mode:0o600,flag:'wx'});await rename(temporary,path);}
 catch(error){await rm(temporary,{force:true});throw error;}
}
export async function command(args: string[]): Promise<string> {
 try {
  const signal=currentTaskSignal();if(signal?.aborted)throw new Error('PDF 工具执行已取消');
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
  try {
   const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
   if (code !== 0) throw new Error(`PDF 工具 ${args[0]} 执行失败，请检查文件损坏、加密或运行依赖`);
   return output;
  } finally { signal?.removeEventListener('abort',abort);clearTimeout(timer); }
 } catch (error) { if (error instanceof Error && error.message.startsWith('PDF 工具')) throw error; throw new Error('PDF 运行依赖缺失或不可用'); }
}
export async function extractPdf(path: string, vision: VisionClient, run = command, checkpoint?:PageCheckpoint): Promise<Page[]> {
 let temporary: string | undefined;
 try {
  const info = await run(['pdfinfo', path]);
  const count = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(count) || count < 1) throw new Error('PDF 页数无效');
  if(checkpoint)await mkdir(checkpoint.directory,{recursive:true,mode:0o700});
  temporary = await mkdtemp(join(tmpdir(), 'ai-distill-pages-'));const pageDirectory=temporary;
  const images = await run(['pdfimages', '-list', path]);
  const imagePages = new Set(images.split('\n').flatMap(line => {
   const match = line.match(/^\s*(\d+)\s+\d+\s/);
   return match ? [Number(match[1])] : [];
  }));
  const pages: Page[] = Array(count);
  let nextPage=1;
  const runPage=async()=>{while(true){const page=nextPage++;if(page>count)return;
   const cached=checkpoint?await readPageCheckpoint(checkpoint,page):undefined;
   if(cached){pages[page-1]=cached;continue;}
   try {
   const raw = (await run(['pdftotext', '-f', String(page), '-l', String(page), '-layout', '-enc', 'UTF-8', path, '-'])).replace(/\f/g, '').trim();
   // Sparse/broken text layers are not assumed to represent the complete page.
   if (!imagePages.has(page) && raw.replace(/\s/g, '').length >= 80 && !raw.includes('\uFFFD')) pages[page-1]={ page, text: raw, method: 'text' };
   else {
    const prefix = join(pageDirectory, `page-${page}`);
    // Avoid enlarging ordinary 144-DPI scans; oversized images slow vision requests without adding source detail.
    await run(['pdftoppm', '-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1600', '-png', path, prefix]);
    const image=await readFile(`${prefix}.png`),attempts:NonNullable<Page['attempts']>=[];let result:Awaited<ReturnType<VisionClient['recognize']>>|undefined,lastIssue='ocr_page_error',lastError:unknown;
    for(let retry=0;retry<=MAX_PAGE_RETRIES;retry++){
     const effort=retry===0?undefined:'high',started=performance.now();
     try{
      const candidate=await withPageSlot(()=>vision.recognize(image,effort));
     const issue=candidate.issues?.[0];attempts.push({effort:effort??'configured',elapsed_ms:Math.round(performance.now()-started),...(issue?{issue}:{}),usage:candidate.usage});
      result=candidate;if(!issue)break;lastIssue=issue;lastError=new Error(issue);
     }catch(error){
      const message=error instanceof Error?error.message:'';lastIssue=/HTTP (\d{3})/.test(message)?`http_${message.match(/HTTP (\d{3})/)![1]}`:message.startsWith('PDF ')?'pdf_page_error':'ocr_page_error';
      lastError=error;
      attempts.push({effort:effort??'configured',elapsed_ms:Math.round(performance.now()-started),issue:lastIssue});
     }
     if(retry<MAX_PAGE_RETRIES)await new Promise(resolve=>setTimeout(resolve,250*(retry+1)));
    }
    const unresolved=attempts.at(-1)?.issue?lastIssue:undefined;
    if(unresolved&& !vision.continueOnError)throw lastError;
    pages[page-1]={page,text:result?.text??'',method:'ocr',usage:result?.usage,model:result?.model,attempts,issues:unresolved?[unresolved]:[]};
   }
   } catch(error) {
    if(!vision.continueOnError)throw error;
    const message=error instanceof Error?error.message:'';
    const issue=/HTTP (\d{3})/.test(message)?`http_${message.match(/HTTP (\d{3})/)![1]}`:message.startsWith('PDF ')?'pdf_page_error':'ocr_page_error';
    pages[page-1]={page,text:'',method:'ocr',issues:[issue]};
   }
   if(checkpoint && !pages[page-1]!.issues?.length)await writePageCheckpoint(checkpoint,pages[page-1]!);
  }};
  await Promise.all(Array.from({length:Math.min(PAGE_CONCURRENCY,count)},()=>runPage()));
  return pages;
 } catch (error) { throw error; }
 finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
