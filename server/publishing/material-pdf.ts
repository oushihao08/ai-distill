/** 职责：将已核验材料DOCX转换为图像PDF；供飞书服务端与本地CLI共用，不访问HTTP API或数据库。 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
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

