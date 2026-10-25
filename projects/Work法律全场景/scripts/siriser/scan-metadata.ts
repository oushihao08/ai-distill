/**
 * 职责：用现有Poppler工具核对实际交付PDF的扫描属性，不调用OCR/模型或修改原件。
 * 入口：inspectPdfScan供五件套使用；classifyPdfScan供离线测试。不能判定或工具不可用时明确unknown，不阻断归档。
 */
import {execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
const run=promisify(execFile);
export type ScanCheck={status:'scanned'|'not_scanned'|'unknown';reason:string};
/** 图像且无文字层的页可确认扫描；图文混排不能由图片存在推断扫描，保留未知。 */
export function classifyPdfScan(text:string,images:string):ScanCheck{
 const pages=text.split('\f'),imagePages=new Set(images.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+\d+\s/.exec(line);return match?[Number(match[1])]:[];}));
 if(!imagePages.size)return{status:'not_scanned',reason:'未发现栅格图像'};
 if([...imagePages].some(page=>page>=1&&page<=pages.length&&!pages[page-1]!.trim()))return{status:'scanned',reason:'存在含图像且无文字层的页'};
 return{status:'unknown',reason:'存在图像与文字层，不能据此区分扫描底图与普通插图'};
}
export async function inspectPdfScan(bytes:Uint8Array):Promise<ScanCheck>{
 let directory:string|undefined;
 try{
  directory=await mkdtemp(join(tmpdir(),'work-scan-'));const path=join(directory,'input.pdf');await writeFile(path,bytes,{mode:0o600});
  const [text,images]=await Promise.all([run('pdftotext',['-enc','UTF-8',path,'-'],{timeout:15000,maxBuffer:16*1024*1024}),run('pdfimages',['-list',path],{timeout:15000,maxBuffer:4*1024*1024})]);
  return classifyPdfScan(text.stdout,images.stdout);
 }catch{return{status:'unknown',reason:'PDF扫描属性检测不可用或原件不能可靠读取'};}
 finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
