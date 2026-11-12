/**
 * 职责：出题（步骤4）的网页执行器：与 `runAgent` 同形，供 `runAuthoring` 的 execute 注入；把Agent读取的同一 input/ 目录文件上传给网页对话，取回完整题包JSON。
 * 主要入口：`webAuthoringExecutor()`；调用方为 `authoring/jobs.ts` 中 provider='web' 的出题任务。
 * 边界：网页没有文件系统、shell与项目工作目录，不假装具备；Skill及其引用、附件、设计输入以上传文件提供，result.json以回复中的单个JSON交付，宿主按原 validateDraft 接收。不写库。
 */
import type {AgentTask,AgentResult} from '../agent';
import type {WebChatTransport} from '../web-agent';
import type {WebAgentSettings} from '../../shared/web-agent';
import {WEB_UPLOAD_MAX_FILES,bundleForUpload,collectDirectoryFiles,renderUploadManifest} from './bundle';
import {runWebJsonChat} from './chat-loop';
import {defaultWebTransport,roundRecorder,webAgentResult} from './common';
import {assertMatchesSchema} from './schema-check';

/** 只上传 input/ 下与Agent读取相同的文件；render-package.cjs 是只在本机运行的脚本，上传无意义。 */

export function webAuthoringExecutor(settings:WebAgentSettings,transport:WebChatTransport=defaultWebTransport()){
  return async<T>(task:AgentTask<T>):Promise<AgentResult<T>>=>{
    const started=performance.now();
    const entries=(await collectDirectoryFiles(task.directory,path=>path==='output/')).filter(entry=>entry.path.startsWith('input/')&&entry.path!=='input/render-package.cjs');
    if(!entries.length)throw new Error('出题输入目录为空');
    const bundle=bundleForUpload(entries,WEB_UPLOAD_MAX_FILES[settings.provider]);
    const prompt=`${task.prompt}\n\n【网页对话交付方式】你没有本地文件系统、shell、render命令或项目工作目录。上文中凡要求读取 input/ 下路径的文件，均已作为上传文件完整提供，请按下面的对照表阅读（合并文件内以 <<<<< FILE: 路径 >>>>> 为边界）；凡要求运行命令或保存文件之处，改为：完成全部阅读、核对与自检后，在回复中只输出一个\`\`\`json代码块，内容就是完整的 result.json（字段严格符合 delivery.json 中的 schema），块外不写任何说明，也不要输出其他JSON；输出过长被截断时按宿主要求从中断处继续。法源与计算按你实际能做到的方式核验，没有核验的不要写成已核验。\n\n${renderUploadManifest(bundle.manifest)}`;
    const chat=await runWebJsonChat({
      transport,settings,timeout_ms:task.timeout_ms??1800000,signal:task.signal,onRound:roundRecorder(task.directory),first:{prompt,files:bundle.files},
      check:value=>{assertMatchesSchema(value,task.schema);return task.validate(value);},
    });
    return webAgentResult(task,settings,started,chat,chat.value);
  };
}
