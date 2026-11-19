/** 职责：将已核验材料DOCX转换为图像PDF；供飞书服务端与本地CLI共用，不访问HTTP API或数据库。 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {materialDeliveryStems} from '../../shared/material-filenames';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {splitLargePdf} from '../materials/pdf-split';
import {FeishuError as SyncError} from '../../toolSkills/feishu-operations/scripts/client';
const execFileAsync=promisify(execFile);
const DOCX_TO_IMAGE_PDF_SCRIPT=fileURLToPath(new URL('../../scripts/runtime/docx-to-image-pdf.py',import.meta.url));

async function resolveSofficePath():Promise<string|undefined>{
 if(process.env.LIBREOFFICE_PATH?.trim())return process.env.LIBREOFFICE_PATH.trim();
 // 桌面API未必继承Codex终端的PATH；直接查找同用户已有运行时，不安装或修改环境。
 for(const candidate of [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/Applications/LibreOfficeDev.app/Contents/MacOS/soffice',
  join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice'),
 ]){
  try{await access(candidate,constants.X_OK);return candidate;}
  catch(error){if(!(error&&typeof error==='object'&&'code'in error&&['ENOENT','ENOTDIR','EACCES'].includes(String(error.code))))throw error;}
 }
 return undefined;
}

export async function convertMaterialDocxToImagePdf(files:Array<{bytes:Uint8Array}>,workflowId:string,storageRoot:string):Promise<Buffer[]>{
 const workDir=join(resolve(storageRoot),'feishu-material-pdfs',workflowId),sourcesDir=join(workDir,'sources');
 await mkdir(sourcesDir,{recursive:true,mode:0o700});
 const sourcePaths:string[]=[];
 for(const [index,file] of files.entries()){
  const digest=createHash('sha256').update(file.bytes).digest('hex').slice(0,16);
  const sourcePath=join(sourcesDir,`${index}-${digest}.docx`);
  await writeFile(sourcePath,file.bytes,{mode:0o600});
  sourcePaths.push(sourcePath);
 }
 const soffice=await resolveSofficePath();
 const args=[DOCX_TO_IMAGE_PDF_SCRIPT,'--output',workDir,...(soffice?['--soffice',soffice]:[]),...sourcePaths];
 let stdout='';
 try{
  ({stdout}=await execFileAsync(process.env.PYTHON3_PATH||'python3',args,{timeout:600000,maxBuffer:16*1024*1024}));
 }catch(error:any){
  const stderr=typeof error?.stderr==='string'?error.stderr:'',errStdout=typeof error?.stdout==='string'?error.stdout:'';
  if(stderr.includes('soffice is required')||error?.code==='ENOENT')throw new SyncError('feishu_pdf_soffice_missing');
  if(errStdout.includes('CJK font')||errStdout.includes('Chinese font'))throw new SyncError('feishu_pdf_cjk_font_failed');
  throw new SyncError('feishu_pdf_conversion_failed');
 }
 let parsed:unknown;
 try{parsed=JSON.parse(stdout);}catch{throw new SyncError('feishu_pdf_conversion_failed');}
 if(!Array.isArray(parsed)||parsed.length!==sourcePaths.length)throw new SyncError('feishu_pdf_conversion_failed');
 const outputs:Buffer[]=[];
 for(const item of parsed){
  if(!item||typeof item!=='object'||!['ok','reused'].includes(String((item as any).status))||typeof (item as any).output!=='string')throw new SyncError('feishu_pdf_conversion_failed');
  let pdf:Buffer;
  try{pdf=await readFile((item as any).output);}catch{throw new SyncError('feishu_pdf_conversion_failed');}
  if(pdf.byteLength<5||pdf.subarray(0,5).toString('utf8')!=='%PDF-')throw new SyncError('feishu_pdf_conversion_failed');
  outputs.push(pdf);
 }
 return outputs;
}


/** 飞书平台上限为18MB，本系统按十进制15MB留余量；交付文件名保留脱敏文书标题（去除001-序号前缀），不含哈希、页码范围等程序痕迹，超限按连续页无损分为“第一册、第二册”。 */
export const MATERIAL_PDF_MAX_BYTES=15_000_000;
/** 合册交付的固定业务文件名；不含“脱敏”“合并”等加工用语。 */
export const COMBINED_MATERIAL_PDF_STEM='案卷材料';
const CHINESE_DIGITS=['零','一','二','三','四','五','六','七','八','九'];
/** 1–99 转中文册序（十一、二十三），用于分册文件名。 */
export function chineseVolumeNumber(value:number):string{
 if(!Number.isSafeInteger(value)||value<1||value>99)throw new Error('分册序号超出范围');
 if(value<10)return CHINESE_DIGITS[value]!;
 const tens=Math.floor(value/10),ones=value%10;
 return `${tens===1?'':CHINESE_DIGITS[tens]}十${ones?CHINESE_DIGITS[ones]:''}`;
}
/** 分册文件名：<文书名>（第一册）.pdf；单册保持<文书名>.pdf。 */
export function materialVolumeName(stem:string,index:number,total:number):string{
 return total<=1?`${stem}.pdf`:`${stem}（第${chineseVolumeNumber(index+1)}册）.pdf`;
}
export function materialPdfBaseNames(files:ReadonlyArray<{filename?:string;name?:string}>):string[]{
 return materialDeliveryStems(files);
}
export function materialCleanPdfBaseNames(files:ReadonlyArray<{filename?:string;name?:string}>):string[]{
 return materialDeliveryStems(files.map(file=>({filename:(file.filename?.trim()||file.name?.trim()||'').replace(/^\d{3}-(?=.+)/,'')})));
}
/** 仅用于识别远端历史哈希命名附件，以便同文本快照复传时原地替换为真实分件文书名。 */
export function isLegacyHashAttachmentList(value:unknown):boolean{
 return Array.isArray(value)&&value.length>0&&value.every((file:any)=>typeof file?.name==='string'&&/^材料-[0-9a-f]{16}(?:-页\d{4,}-\d{4,})?\.(?:docx|pdf)$/.test(file.name));
}
export async function materialPdfAttachments(files:Array<{bytes:Uint8Array;filename?:string;name?:string}>,workflowId:string,storageRoot:string):Promise<Array<{name:string;bytes:Buffer}>>{
 const pdfs=await convertMaterialDocxToImagePdf(files,workflowId,storageRoot),stems=materialCleanPdfBaseNames(files),result:Array<{name:string;bytes:Buffer}>=[];
 for(const [index,bytes] of pdfs.entries()){
  const name=`${stems[index]!}.pdf`;
  if(bytes.length<=MATERIAL_PDF_MAX_BYTES){result.push({name,bytes});continue;}
  const directory=join(resolve(storageRoot),'feishu-material-pdfs',workflowId,'delivery-sources');
  await mkdir(directory,{recursive:true,mode:0o700});const source=join(directory,name);await writeFile(source,bytes,{mode:0o600});
  const parts=await splitLargePdf(source,bytes,{balanced:true,maxBytes:MATERIAL_PDF_MAX_BYTES,maxPages:Number.MAX_SAFE_INTEGER,cacheRoot:join(resolve(storageRoot),'feishu-pdf-parts')});
  // 分片缓存仍按页码命名以便校验；交付名改为册序，不暴露补零页码范围。
  for(const [partIndex,part] of parts.entries())result.push({name:materialVolumeName(stems[index]!,partIndex,parts.length),bytes:await readFile(part.path)});
 }
 return result;
}
