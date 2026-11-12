/**
 * 职责：材料脱敏（整包化名）的离线作业台执行器：仅在 settings.mode='offline' 时使用，与 `api-redaction.ts` 同形；把同源 source.json、review-hints.json、plan-schema.json作为上传文件导出，回复按原 `compileAgentTextMaterialPlan` 校验后交回发布。
 * 主要入口：`offlineMaterialExecutor()`、`expandSparsePlanTexts()`；调用方为 `material-library/redaction-runner.ts`（provider='web' 且 mode='offline'）。
 * 边界：不驱动浏览器（自动网页脱敏已撤除）；允许回复只列出发生修改/删除的 texts，由宿主按精确 id 补齐未改原文，未知/重复 id 原样交给编译器拦截；validation-source.json 等宿主私有文件不导出。
 */
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {AgentTask,AgentResult} from '../agent';
import type {WebAgentSettings} from '../../shared/web-agent';
import {compileAgentTextMaterialPlan} from '../../shared/agent-material-plan';
import {writePrivateJson} from '../material-library/agent-redaction-artifacts';
import {WEB_UPLOAD_MAX_FILES,bundleForUpload,renderUploadManifest} from './bundle';
import {runWebJsonChat} from './chat-loop';
import {roundRecorder,webAgentResult,webTransportFor} from './common';

/** 回复只含改动条目时按 source 顺序补齐；未出现的 id 取原文。不改动 documents/unresolved。 */
export function expandSparsePlanTexts(plan:any,source:{texts:{id:string;text:string}[]}){
  if(!plan||typeof plan!=='object'||!Array.isArray(plan.texts))return plan;
  const known=new Set(source.texts.map(item=>item.id));
  const returned=new Map<string,unknown>();const extras:unknown[]=[];
  for(const item of plan.texts){
    const id=item&&typeof item==='object'?(item as any).id:undefined;
    if(typeof id==='string'&&known.has(id)&&!returned.has(id))returned.set(id,item);else extras.push(item);
  }
  return{...plan,texts:[...source.texts.map(item=>returned.get(item.id)??{id:item.id,text:item.text}),...extras]};
}

export function offlineMaterialExecutor(settings:WebAgentSettings){
  if(settings.mode!=='offline')throw new Error('脱敏仅支持离线作业台模式');
  return async<T>(task:AgentTask<T>):Promise<AgentResult<T>>=>{
    const started=performance.now();
    const read=async(name:string)=>JSON.parse(await readFile(join(task.directory,name),'utf8'));
    const context=await read('validation-source.json'),source=await read('source.json') as {texts:{id:string;text:string}[]};
    const entries=[
      {path:'source.json',content:JSON.stringify(source)},
      {path:'review-hints.json',content:JSON.stringify(await read('review-hints.json'))},
      {path:'plan-schema.json',content:JSON.stringify(await read('plan-schema.json'))},
    ];
    // 不导出续作计划：离线交回按轮次回放，导出内容须在导出与交回两次执行间保持一致。
    const bundle=bundleForUpload(entries,WEB_UPLOAD_MAX_FILES[settings.provider]);
    const prompt=`${task.prompt}\n\n【网页对话交付方式】你没有本地文件系统、shell或校验脚本；上文提到的 source.json、review-hints.json、plan-schema.json均已作为上传文件完整提供，validate-plan.mjs 由宿主代为运行。不要保存文件或返回 plan_file，直接在回复中只输出一个\`\`\`json代码块，内容为符合 plan-schema.json 的计划，块外不写任何说明。为缩短输出（以本节为准，覆盖上文“输出texts完整列表”的要求）：texts 只需列出**发生修改或删除**的条目（id 与修改后的完整 text，删除为空字符串），未列出的 id 视为原样保留；documents 与 unresolved 必须完整给出。输出过长被截断时从中断处继续。\n\n${renderUploadManifest(bundle.manifest)}`;
    await mkdir(join(task.directory,'output'),{recursive:true,mode:0o700});
    let parsed:unknown;
    const chat=await runWebJsonChat({
      transport:webTransportFor(settings),settings,label:'material_redaction',timeout_ms:task.timeout_ms??1200000,signal:task.signal,onRound:roundRecorder(task.directory),first:{prompt,files:bundle.files},
      check:async value=>{
        const expanded=expandSparsePlanTexts(value,source);
        await writePrivateJson(join(task.directory,'output/material-plan.json'),expanded);
        compileAgentTextMaterialPlan(expanded,context.files,context.identity);
        parsed=expanded;return expanded;
      },
    });
    return webAgentResult(task,settings,started,chat,task.validate({plan_file:'output/material-plan.json',parsed_plan:parsed} as any));
  };
}
