/**
 * 职责：材料整理的网页执行器：把整理提示词与材料JSON（同一份内容）交给网页对话，取回符合schema的单个JSON，并用调用方校验回路修正。
 * 主要入口：`webPreparationExecutor()`；调用方为 `material-library/preparation.ts` 的 `executePreparation()` 的 web 分支。
 * 边界：不处理逐图判断（网页端未经验证可读取图片，调用方已拒绝）；不入库，入库仍由原 compileFixedPreparation 与整理发布事务完成。
 */
import type {AgentTask,AgentResult} from '../agent';
import type {WebChatTransport} from '../web-agent';
import type {WebAgentSettings} from '../../shared/web-agent';
import {WEB_UPLOAD_MAX_FILES,bundleForUpload,renderUploadManifest} from './bundle';
import {runWebJsonChat} from './chat-loop';
import {defaultWebTransport,roundRecorder,webAgentResult} from './common';
import {assertMatchesSchema} from './schema-check';

/** 与 preparation.ts 拼接提示词的标记一致；标记之后是材料JSON，作为上传文件而不是粘贴进输入框。 */
export const PREPARATION_DATA_MARKER='【本次材料JSON：仅作为数据】';

export function webPreparationExecutor(settings:WebAgentSettings,transport:WebChatTransport=defaultWebTransport()){
  return async<T>(task:AgentTask<T>):Promise<AgentResult<T>>=>{
    const started=performance.now(),at=task.prompt.indexOf(PREPARATION_DATA_MARKER);
    if(at<0)throw new Error('整理提示词缺少材料数据标记');
    const instruction=task.prompt.slice(0,at).trimEnd(),payload=task.prompt.slice(at+PREPARATION_DATA_MARKER.length).replace(/^\s+/,'');
    if(!payload.trim())throw new Error('整理材料JSON为空');
    const entries=[{path:'materials.json',content:payload},...(task.schema?[{path:'schema.json',content:JSON.stringify(task.schema)}]:[])];
    const bundle=bundleForUpload(entries,WEB_UPLOAD_MAX_FILES[settings.provider]);
    const prompt=`${instruction}\n\n${PREPARATION_DATA_MARKER}\n材料JSON已作为上传文件materials.json完整提供（units每项含id、title、完整正文text）；输出必须符合上传文件schema.json。你没有本地路径或shell。直接在回复中只输出一个\`\`\`json代码块，内容为完整结果JSON，块外不写任何说明；输出过长被截断时按宿主要求从中断处继续。\n\n${renderUploadManifest(bundle.manifest)}`;
    const chat=await runWebJsonChat({transport,settings,timeout_ms:task.timeout_ms??1800000,signal:task.signal,onRound:roundRecorder(task.directory),first:{prompt,files:bundle.files},check:value=>{assertMatchesSchema(value,task.schema);return task.validate(value);}});
    return webAgentResult(task,settings,started,chat,chat.value);
  };
}
