/** 职责：显式预处理本机材料清单：OFD通过本地OFDRW-IText转PDF、PDF按页/大小拆分，输出可上传清单和来源审计。入口prepareLibraryFiles供CLI使用；不写数据库、不派发任务、不修改原件、不自动安装工具。 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile,access} from 'node:fs/promises';
import {resolve,dirname,join,basename,extname,delimiter} from 'node:path';
import {storageDirectory} from '../paths';
import {splitLargePdf} from './pdf-split';
import {MAX_FILE,MAX_FOLDER_BATCH} from '../validation';
const run=promisify(execFile),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function pdfPages(path:string){const {stdout}=await run('pdfinfo',[path],{timeout:30000});const n=Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1]);if(!Number.isSafeInteger(n)||n<1)throw new Error('PDF页数无效');return n;}
/** 输出目录必须尚不存在，失败保留审计文件但不发布manifest.json；原件只读。 */
export async function prepareLibraryFiles(manifestPath:string,outputPath:string,signal?:AbortSignal){
 try{
  const sourcePath=resolve(manifestPath),output=resolve(outputPath),manifest=JSON.parse(await readFile(sourcePath,'utf8'));
  if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>100)throw new Error('材料清单须包含1至100份文件');
  const inputs=manifest.files.map((x:any)=>{
   if(!x||typeof x.path!=='string'||!x.path.trim()||!['model','declared_redacted'].includes(x.redaction_mode??'model'))throw new Error('材料清单路径或脱敏声明无效');
   const path=resolve(dirname(sourcePath),x.path),format=extname(path).toLowerCase();
   if(!['.ofd','.pdf','.docx','.txt','.md'].includes(format))throw new Error('材料预处理格式不支持：'+format);
   return{path,format,redaction_mode:x.redaction_mode??'model'};
  });
  if(inputs.some((x:any)=>x.path===output||x.path.startsWith(output+'/')))throw new Error('输出目录不能包含输入原件');
  await mkdir(dirname(output),{recursive:true,mode:0o700});await mkdir(output,{recursive:false,mode:0o700});await mkdir(join(output,'files'));await mkdir(join(output,'converted'));
  const files:any[]=[],audit:any[]=[];const names=new Set<string>();
  try{for(const input of inputs){
   signal?.throwIfAborted();
   const original=await readFile(input.path),sourceSha=hash(original);let current=input.path,sourcePages:number|undefined,converter:string|undefined;
   if(input.format==='.ofd'){
    const tools=join(storageDirectory(),'tools/ofd-2.4.0');try{await access(join(tools,'OfdToPdf.class'));}catch{throw new Error('缺少本地OFD转换器，请显式执行 bun scripts/runtime/ofd/install.ts');}
    const convertedName=basename(input.path,extname(input.path))+'-OFD转换.pdf';current=join(output,'converted',convertedName);
    try{await access(current);throw new Error('转换文件名重复：'+convertedName);}catch(error:any){if(error.code!=='ENOENT')throw error;}
    const {stdout}=await run('java',['-Djava.awt.headless=true','-Xmx2g','-cp',tools+delimiter+join(tools,'lib/*'),'OfdToPdf',input.path,current],{timeout:600000,maxBuffer:4*1024*1024,signal});
    sourcePages=Number(stdout.match(/DISTILL_OFD_PAGES=(\d+)/)?.[1]);if(!sourcePages||await pdfPages(current)!==sourcePages)throw new Error('OFD转PDF页数不一致');converter='OFDRW-2.4.0-IText';
   }
   let parts=[{name:basename(current),path:current}];
   if(input.format==='.pdf'||input.format==='.ofd'){
    sourcePages??=await pdfPages(current);parts=await splitLargePdf(current,await readFile(current));let total=0;
    for(const part of parts)total+=await pdfPages(part.path);
    if(total!==sourcePages)throw new Error('PDF分片总页数不一致');
    if(parts.length>1){const existingRange=basename(current).match(/-页(\d+)-(\d+)\.pdf$/);const offset=existingRange&&Number(existingRange[2])-Number(existingRange[1])+1===sourcePages?Number(existingRange[1])-1:0;let next=offset+1;for(const part of parts){const range=part.name.match(/-页(\d+)-(\d+)\.pdf$/);if(!range)throw new Error('分片页码范围缺失');const start=Number(range[1]),end=Number(range[2]);if(start!==next||end-start+1!==await pdfPages(part.path))throw new Error('分片页码不连续');next=end+1;}if(next!==offset+sourcePages+1)throw new Error('分片尾页不完整');}
   }
   const outputs:any[]=[];
   for(const part of parts){if(names.has(part.name))throw new Error('上传文件名重复：'+part.name);names.add(part.name);const target=join(output,'files',part.name);await copyFile(part.path,target);const bytes=await readFile(target);files.push({path:'files/'+part.name,redaction_mode:input.redaction_mode});outputs.push({path:'files/'+part.name,sha256:hash(bytes),size_bytes:bytes.length});}
   if(hash(await readFile(input.path))!==sourceSha)throw new Error('处理期间原件发生变化');
   audit.push({source_path:input.path,source_sha256:sourceSha,source_size_bytes:original.length,source_pages:sourcePages,converter,outputs,visual_review:input.format==='.ofd'?'required':'not_applicable',digital_signature_note:input.format==='.ofd'?'PDF转换件不继承原OFD数字签名验证效力':undefined});
   await writeFile(join(output,'provenance.json'),JSON.stringify({version:1,complete:false,files:audit},null,2)+'\n');
  }
  signal?.throwIfAborted();
  if(audit.some(x=>x.outputs.some((o:any)=>o.size_bytes>MAX_FILE))||audit.reduce((s,x)=>s+x.outputs.reduce((n:number,o:any)=>n+o.size_bytes,0),0)>MAX_FOLDER_BATCH)throw new Error('预处理产物超过上传单文件或整包大小限制，未发布清单');
  if(files.length>100)throw new Error('预处理结果超过100份文件，未发布清单');
  await writeFile(join(output,'provenance.json'),JSON.stringify({version:1,complete:true,files:audit},null,2)+'\n');
  await writeFile(join(output,'manifest.json'),JSON.stringify({files},null,2)+'\n');
  return{manifest_path:join(output,'manifest.json'),provenance_path:join(output,'provenance.json'),source_files:inputs.length,upload_files:files.length,requires_visual_review:inputs.some((x:any)=>x.format==='.ofd')};
  }catch(error){await writeFile(join(output,'failed.json'),JSON.stringify({complete:false,error:error instanceof Error?error.message:'预处理失败'})+'\n');throw error;}
 }catch(error){throw error;}
}
