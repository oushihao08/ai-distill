/**
 * 职责：脱敏（整包化名）的网页执行器：与 `api-redaction.ts` 同形，把同一目录输入交给网页对话，用同一编译器校验回复并反馈修正。
 * 主要入口：`webMaterialExecutor()`；调用方为 `redaction-runner.ts`（经 `prepareAgentLibraryMaterials` 的 execute 注入）。
 * 边界：只写任务私有目录的 output/material-plan.json；不入队、不发布、不写库；validation-source.json 等宿主私有文件不上传。
 */
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {AgentTask,AgentResult} from '../agent';
import {compileAgentTextMaterialPlan} from '../../shared/agent-material-plan';
import {writePrivateJson} from '../material-library/agent-redaction-artifacts';
import type {WebChatTransport} from '../web-agent';
import {WEB_UPLOAD_MAX_FILES,bundleForUpload,renderUploadManifest,type BundleEntry} from './bundle';
import {runWebJsonChat} from './chat-loop';
import {defaultWebTransport,roundRecorder,webAgentResult} from './common';
import type {WebAgentSettings} from '../../shared/web-agent';

async function optional(path:string){try{return await readFile(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}

/** 与Agent读取同一份文件：source.json、review-hints.json、plan-schema.json及续作计划；宿主私有的validation-source.json不上传。 */
export async function readRedactionUploads(directory:string):Promise<BundleEntry[]>{
  const entries:BundleEntry[]=[];
  for(const name of ['source.json','review-hints.json','plan-schema.json']){
    const bytes=await optional(join(directory,name));
    if(!bytes)throw new Error(`脱敏输入缺少${name}`);
    entries.push({path:name,content:new Uint8Array(bytes)});
  }
  const resume=await optional(join(directory,'resume','material-plan.json'));
  if(resume)entries.push({path:'resume-material-plan.json',content:new Uint8Array(resume)});
  return entries;
}

export function webMaterialExecutor(settings:WebAgentSettings,transport:WebChatTransport=defaultWebTransport()){
  return async<T>(task:AgentTask<T>):Promise<AgentResult<T>>=>{
    const started=performance.now();
    const context=JSON.parse(await readFile(join(task.directory,'validation-source.json'),'utf8'));
    const bundle=bundleForUpload(await readRedactionUploads(task.directory),WEB_UPLOAD_MAX_FILES[settings.provider]);
    await mkdir(join(task.directory,'output'),{recursive:true,mode:0o700});
    const chat=await runWebJsonChat({
      transport,settings,timeout_ms:task.timeout_ms??1200000,signal:task.signal,onRound:roundRecorder(task.directory),
      first:{prompt:`${task.prompt}\n\n${renderUploadManifest(bundle.manifest)}`,files:bundle.files},
      check:async(plan)=>{
        await writePrivateJson(join(task.directory,'output/material-plan.json'),plan);
        compileAgentTextMaterialPlan(plan,context.files,context.identity);
        return plan;
      },
    });
    return webAgentResult(task,settings,started,chat,task.validate({plan_file:'output/material-plan.json',parsed_plan:chat.value}));
  };
}
