/**
 * 职责：解析主项目的可选交付脚本，并在归档校验通过后以独立进程执行。
 * 关键入口：`resolveProjectDelivery()` 固定脚本版本；`runProjectDelivery()` 接收当前题目快照并等待脚本完成。
 * 使用场景：`publishWorkflow()` 在写入 ordinal 8 成功状态前调用；未配置脚本时执行内置空函数。
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HTTPException} from 'hono/http-exception';

const projectsRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../projects');
const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export interface ProjectDelivery {mode:'script'|'noop';digest:string;path?:string;projectRoot?:string}
export interface DeliveryInput {version:1;project_id:string;workflow_id:string;title:string;source_digest:string;question_version:string;rubric_version:string;question:{task_name:unknown;task_type:unknown;header:unknown;question:unknown;attachment_ids:unknown;rubric:unknown;answer_approach:unknown;reference_answer:unknown;scoring_policy?:unknown};acceptance:unknown;attachments:{id:string;sha256:string}[]}

/** 项目名只作一级目录名；脚本不能通过符号链接逃出项目目录。 */
export async function resolveProjectDelivery(parentName:unknown):Promise<ProjectDelivery>{
 const noop:ProjectDelivery={mode:'noop',digest:sha256('project-delivery-noop-v1')};
 if(typeof parentName!=='string'||!parentName||basename(parentName)!==parentName||parentName==='.'||parentName==='..')return noop;
 const root=join(projectsRoot,parentName),path=join(root,'delivery.ts');
 let info;try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return noop;throw error;}
 if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new HTTPException(409,{message:'项目交付脚本不是有效普通文件'});
 if(await realpath(root)!==root||await realpath(path)!==path)throw new HTTPException(409,{message:'项目交付脚本路径越界'});
 return{mode:'script',digest:sha256(await readFile(path)),path,projectRoot:root};
}

async function noopDelivery(_input:DeliveryInput){return;}

/** 子进程只接收当前题目数据，不继承数据库凭证；非零退出不允许本次归档成功。 */
export async function runProjectDelivery(delivery:ProjectDelivery,input:DeliveryInput,storageRoot:string):Promise<void>{
 if(delivery.mode==='noop'){await noopDelivery(input);return;}
 if(!delivery.path||!delivery.projectRoot)throw new HTTPException(409,{message:'项目交付脚本路径缺失'});
 if(sha256(await readFile(delivery.path))!==delivery.digest)throw new HTTPException(409,{message:'项目交付脚本已变化，请重新归档'});
 await new Promise<void>((resolveRun,rejectRun)=>{
  const outputParent=join(storageRoot,'deliveries',input.project_id,input.workflow_id);
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
