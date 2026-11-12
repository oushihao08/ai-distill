/** 职责：显式预处理本机材料清单：DOC/WPS经隔离LibreOffice、OFD经OFDRW转PDF，PDF按页/大小拆分，图片原样进入上传清单。入口prepareLibraryFiles供CLI使用；不写数据库、不派发任务、不修改原件、不自动安装工具。 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile,access,rm} from 'node:fs/promises';
import {resolve,dirname,join,basename,extname,delimiter} from 'node:path';
import {pathToFileURL} from 'node:url';
import {storageDirectory} from '../paths';
import {splitLargePdf} from './pdf-split';
import {MAX_FILE,MAX_FOLDER_BATCH} from '../validation';
import {createLibreOfficeEnvironment} from './libreoffice';
const run=promisify(execFile),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function pdfPages(path:string){const {stdout}=await run('pdfinfo',[path],{timeout:30000});const n=Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1]);if(!Number.isSafeInteger(n)||n<1)throw new Error('PDF页数无效');return n;}
async function libreOfficeVersion(){try{return (await run('soffice',['--version'],{timeout:30000})).stdout.trim()||'unknown';}catch{throw new Error('缺少LibreOffice soffice，请先手动安装并确认命令可用');}}
async function convertOfficeToPdf(source:string,convertedDirectory:string,profileDirectory:string,signal?:AbortSignal){
 const version=await libreOfficeVersion();
 const output=join(convertedDirectory,basename(source,extname(source))+'.pdf');
 try{await access(output);throw new Error('转换文件名重复：'+basename(output));}catch(error:any){if(error.code!=='ENOENT')throw error;}
 const env=await createLibreOfficeEnvironment(profileDirectory);
 await run('soffice',[`-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,'--headless','--convert-to','pdf','--outdir',convertedDirectory,source],{timeout:600000,maxBuffer:4*1024*1024,signal,env});
 try{await access(output);}catch{throw new Error(`LibreOffice未生成PDF：${basename(source)}`);}
 const [{stdout:text},{stdout:fonts}]=await Promise.all([
  run('pdftotext',[output,'-'],{timeout:30000,maxBuffer:16*1024*1024,signal}),
  run('pdffonts',[output],{timeout:30000,maxBuffer:4*1024*1024,signal}),
 ]);
 if(/[\u3400-\u9fff\uf900-\ufaff]/u.test(text)&&/NotoSansLisu|LastResort/i.test(fonts))throw new Error(`LibreOffice中文字体替换无效，未发布转换件：${basename(source)}`);
 return{output,converter:'LibreOffice',converter_version:version};
}
/** 输出目录必须尚不存在，失败保留审计文件但不发布manifest.json；原件只读。 */
export async function prepareLibraryFiles(manifestPath:string,outputPath:string,signal?:AbortSignal,maxBatchBytes=MAX_FOLDER_BATCH){
 try{
  const sourcePath=resolve(manifestPath),output=resolve(outputPath),manifest=JSON.parse(await readFile(sourcePath,'utf8'));
  if(Object.hasOwn(manifest,'recovery'))throw new Error('临时恢复清单不能再次预处理或作为材料原件');
  if(Object.keys(manifest).some(key=>key!=='files'))throw new Error('材料清单只能包含 files');
  if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>100)throw new Error('材料清单须包含1至100份文件');
  const inputs=manifest.files.map((x:any)=>{
   if(!x||typeof x.path!=='string'||!x.path.trim()||!['model','declared_redacted'].includes(x.redaction_mode??'model'))throw new Error('材料清单路径或脱敏声明无效');
   if(Object.keys(x).some(key=>!['path','redaction_mode'].includes(key)))throw new Error('材料清单文件项含不支持的来源或恢复字段');
   const path=resolve(dirname(sourcePath),x.path),format=extname(path).toLowerCase();
   if(!['.ofd','.doc','.wps','.pdf','.docx','.txt','.md','.png','.jpg','.jpeg'].includes(format))throw new Error('材料预处理格式不支持：'+format);
   if((x.redaction_mode??'model')==='declared_redacted'&&format!=='.docx')throw new Error('只有DOCX可声明已人工脱敏');
   return{path,format,redaction_mode:x.redaction_mode??'model'};
  });
  if(inputs.some((x:any)=>x.path===output||x.path.startsWith(output+'/')))throw new Error('输出目录不能包含输入原件');
  await mkdir(dirname(output),{recursive:true,mode:0o700});await mkdir(output,{recursive:false,mode:0o700});await mkdir(join(output,'files'));await mkdir(join(output,'converted'));
  const files:any[]=[],audit:any[]=[];const names=new Set<string>();
  try{for(const input of inputs){
   signal?.throwIfAborted();
   const original=await readFile(input.path),sourceSha=hash(original);let current=input.path,sourcePages:number|undefined,converter:string|undefined,converterVersion:string|undefined;
   if(input.format==='.doc'||input.format==='.wps'){
    const profile=join(output,`.libreoffice-profile-${crypto.randomUUID()}`);await mkdir(profile,{recursive:false,mode:0o700});
    try{const converted=await convertOfficeToPdf(input.path,join(output,'converted'),profile,signal);current=converted.output;converter=converted.converter;converterVersion=converted.converter_version;sourcePages=await pdfPages(current);}
    finally{await rm(profile,{recursive:true,force:true});}
   }
   if(input.format==='.ofd'){
    const tools=join(storageDirectory(),'tools/ofd-2.4.0');try{await access(join(tools,'OfdToPdf.class'));}catch{throw new Error('缺少本地OFD转换器，请显式执行 bun scripts/runtime/ofd/install.ts');}
    const convertedName=basename(input.path,extname(input.path))+'-OFD转换.pdf';current=join(output,'converted',convertedName);
    try{await access(current);throw new Error('转换文件名重复：'+convertedName);}catch(error:any){if(error.code!=='ENOENT')throw error;}
    const {stdout}=await run('java',['-Djava.awt.headless=true','-Xmx2g','-cp',tools+delimiter+join(tools,'lib/*'),'OfdToPdf',input.path,current],{timeout:600000,maxBuffer:4*1024*1024,signal});
    sourcePages=Number(stdout.match(/DISTILL_OFD_PAGES=(\d+)/)?.[1]);if(!sourcePages||await pdfPages(current)!==sourcePages)throw new Error('OFD转PDF页数不一致');converter='OFDRW-IText';converterVersion='2.4.0';
   }
   let parts=[{name:basename(current),path:current}];
   if(['.pdf','.ofd','.doc','.wps'].includes(input.format)){
    sourcePages??=await pdfPages(current);parts=await splitLargePdf(current,await readFile(current));let total=0;
    for(const part of parts)total+=await pdfPages(part.path);
    if(total!==sourcePages)throw new Error('PDF分片总页数不一致');
    if(parts.length>1){const existingRange=basename(current).match(/-页(\d+)-(\d+)\.pdf$/);const offset=existingRange&&Number(existingRange[2])-Number(existingRange[1])+1===sourcePages?Number(existingRange[1])-1:0;let next=offset+1;for(const part of parts){const range=part.name.match(/-页(\d+)-(\d+)\.pdf$/);if(!range)throw new Error('分片页码范围缺失');const start=Number(range[1]),end=Number(range[2]);if(start!==next||end-start+1!==await pdfPages(part.path))throw new Error('分片页码不连续');next=end+1;}if(next!==offset+sourcePages+1)throw new Error('分片尾页不完整');}
   }
   const outputs:any[]=[];
   for(const part of parts){if(names.has(part.name))throw new Error('上传文件名重复：'+part.name);names.add(part.name);const target=join(output,'files',part.name);await copyFile(part.path,target);const bytes=await readFile(target),pageCount=['.png','.jpg','.jpeg'].includes(input.format)?1:['.pdf','.ofd','.doc','.wps'].includes(input.format)?await pdfPages(target):undefined;files.push({path:'files/'+part.name,redaction_mode:input.redaction_mode});outputs.push({path:'files/'+part.name,sha256:hash(bytes),size_bytes:bytes.length,page_count:pageCount});}
   if(hash(await readFile(input.path))!==sourceSha)throw new Error('处理期间原件发生变化');
   const converted=['.ofd','.doc','.wps'].includes(input.format);
   audit.push({source_path:input.path,source_sha256:sourceSha,source_size_bytes:original.length,source_pages:sourcePages,converter,converter_version:converterVersion,outputs,visual_review:converted?'required':'not_applicable',digital_signature_note:input.format==='.ofd'?'PDF转换件不继承原OFD数字签名验证效力':undefined});
   await writeFile(join(output,'provenance.json'),JSON.stringify({version:1,complete:false,files:audit},null,2)+'\n');
  }
  signal?.throwIfAborted();
  if(audit.some(x=>x.outputs.some((o:any)=>o.size_bytes>MAX_FILE))||audit.reduce((s,x)=>s+x.outputs.reduce((n:number,o:any)=>n+o.size_bytes,0),0)>maxBatchBytes)throw new Error('预处理产物超过上传单文件或整包大小限制，未发布清单');
  if(files.length>100)throw new Error('预处理结果超过100份文件，未发布清单');
  await writeFile(join(output,'provenance.json'),JSON.stringify({version:1,complete:true,files:audit},null,2)+'\n');
  await writeFile(join(output,'manifest.json'),JSON.stringify({files},null,2)+'\n');
  return{manifest_path:join(output,'manifest.json'),provenance_path:join(output,'provenance.json'),source_files:inputs.length,upload_files:files.length,requires_visual_review:inputs.some((x:any)=>['.ofd','.doc','.wps'].includes(x.format))};
  }catch(error){await writeFile(join(output,'failed.json'),JSON.stringify({complete:false,error:error instanceof Error?error.message:'预处理失败'})+'\n');throw error;}
 }catch(error){throw error;}
}
