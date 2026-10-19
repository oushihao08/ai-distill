/**
 * 职责：解析主项目的可选交付脚本，并在归档校验通过后以独立进程执行。
 * 关键入口：`resolveProjectDelivery()` 固定脚本版本；`runProjectDelivery()` 接收当前题目快照并等待脚本完成。
 * 使用场景：`publishWorkflow()` 在写入 ordinal 8 成功状态前调用；未配置脚本时执行内置空函数。
 */
import type {RedactedDocumentStructure} from '../materials/redacted-docx';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HTTPException} from 'hono/http-exception';

const projectsRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../projects');
const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export interface ProjectDelivery {mode:'script'|'noop';digest:string;path?:string;projectRoot?:string}
export interface DeliveryInput {version:1;project_id:string;workflow_id:string;title:string;source_digest:string;delivery_digest:string;question_version:string;rubric_version:string;question:{content_contract?:string;task_metadata?:unknown;input_files?:unknown;deliverables?:unknown;reference_outputs?:unknown;research_records?:unknown;task_requirements?:unknown;content_status?:unknown;delivery_identity?:{task_id:string;org:string};task_name:unknown;task_type:unknown;header:unknown;question:unknown;attachment_ids:unknown;rubric:unknown;answer_approach:unknown;reference_answer:unknown;scoring_policy?:unknown};acceptance:unknown;attachments:{id:string;sha256:string;name:string;text:string;material_mode?:'redacted'|'original';documents?:RedactedDocumentStructure[]}[];simulation?:{deliverable_type:'F1'|'F2'|'F3'|'F4'|'F5';deliverable_title:string;deliverable_markdown:string;harbor_files:{path:string;markdown:string;sheets:{name:string;columns:string[];rows:(string|number|boolean)[][]}[]}[];research_entries:{id:string;query:string;title:string;url:string;finding:string;version_or_date:string;used_in:string}[];unresolved:string[];generated_at:string;model:string;reasoning_effort:string;actual_search_queries:string[];actually_opened_urls:string[]}}

async function deliveryFiles(projectRoot:string,entry:string){
 const files:{path:string;sha256:string}[]=[];
 const add=async(path:string,label:string)=>{
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>10*1024*1024)throw new HTTPException(409,{message:'项目交付依赖文件无效'});
  files.push({path:label,sha256:sha256(await readFile(path))});
 };
 const scripts=join(projectRoot,'scripts');
 try{
  const info=await lstat(scripts);
  if(!info.isDirectory()||info.isSymbolicLink())throw new HTTPException(409,{message:'项目脚本目录无效'});
  const walk=async(folder:string):Promise<void>=>{
   for(const item of await readdir(folder,{withFileTypes:true})){
    const path=join(folder,item.name),info=await lstat(path);
    if(info.isSymbolicLink())throw new HTTPException(409,{message:'项目脚本目录不能包含符号链接'});
    if(info.isDirectory())await walk(path);
    else if(info.isFile())await add(path,relative(projectRoot,path).split('/').join('/'));
    else throw new HTTPException(409,{message:'项目脚本目录包含不支持的文件'});
   }
  };
  await walk(scripts);
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await add(entry,relative(projectRoot,entry));}
 const entryRelative=relative(projectRoot,entry);
 if(!files.some(item=>item.path===entryRelative))await add(entry,entryRelative);
 if(basename(projectRoot)==='Work法律全场景')for(const path of ['materials/交付规范.md','skill c/assets/模拟专家交付物与检索轨迹模板.md']){
  const absolute=join(projectRoot,path);
  try{await lstat(absolute);await add(absolute,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}

/** 项目名只作一级目录名；脚本不能通过符号链接逃出项目目录。 */
export async function resolveProjectDelivery(parentName:unknown):Promise<ProjectDelivery>{
 const noop:ProjectDelivery={mode:'noop',digest:sha256('project-delivery-noop-v1')};
 if(typeof parentName!=='string'||!parentName||basename(parentName)!==parentName||parentName==='.'||parentName==='..')return noop;
 const root=join(projectsRoot,parentName);
 let path:string|undefined,info:Awaited<ReturnType<typeof lstat>>|undefined;
 for(const candidate of [join(root,'scripts','delivery.ts'),join(root,'delivery.ts')]){
  try{info=await lstat(candidate);path=candidate;break;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 if(!path||!info)return noop;
 if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new HTTPException(409,{message:'项目交付脚本不是有效普通文件'});
 if(await realpath(root)!==root||await realpath(path)!==path||(path===join(root,'scripts','delivery.ts')&&await realpath(join(root,'scripts'))!==join(root,'scripts')))throw new HTTPException(409,{message:'项目交付脚本路径越界'});
 const files=await deliveryFiles(root,path);
 return{mode:'script',digest:sha256(JSON.stringify(files)),path,projectRoot:root};
}

async function noopDelivery(_input:DeliveryInput){return;}

/** 子进程只接收当前题目数据，不继承数据库凭证；非零退出不允许本次归档成功。outputDir 为该题成果目录。 */
export async function runProjectDelivery(delivery:ProjectDelivery,input:DeliveryInput,outputDir:string):Promise<void>{
 if(delivery.mode==='noop'){await noopDelivery(input);return;}
 if(!delivery.path||!delivery.projectRoot)throw new HTTPException(409,{message:'项目交付脚本路径缺失'});
 if(!outputDir||!isAbsolute(outputDir))throw new HTTPException(409,{message:'项目交付目录无效'});
 const currentFiles=await deliveryFiles(delivery.projectRoot,delivery.path);
 if(sha256(JSON.stringify(currentFiles))!==delivery.digest)throw new HTTPException(409,{message:'项目交付脚本或其规则依赖已变化，请重新归档'});
 await new Promise<void>((resolveRun,rejectRun)=>{
  const outputParent=outputDir;
  const child=spawn(process.execPath,[delivery.path!],{cwd:delivery.projectRoot,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'/tmp',TMPDIR:process.env.TMPDIR??'/tmp',AI_DISTILL_DELIVERY_PARENT_DIR:outputParent},stdio:['pipe','ignore','ignore']});
  let settled=false;
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)rejectRun(error);else resolveRun();};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new HTTPException(409,{message:'项目交付脚本超时，归档未完成'}));},60_000);
  child.once('error',()=>finish(new HTTPException(409,{message:'项目交付脚本无法启动，归档未完成'})));
  child.once('close',code=>finish(code===0?undefined:new HTTPException(409,{message:'项目交付脚本执行失败，归档未完成'})));
  child.stdin.on('error',()=>finish(new HTTPException(409,{message:'项目交付脚本无法接收题目数据'})));
  child.stdin.end(JSON.stringify(input));
 });
}
