/**
 * 职责：两个网页执行器共用的小工具：默认传输单例、与Agent同形的结果封装、每轮回复的私有记录。
 * 主要入口：`defaultWebTransport()`、`webAgentResult()`、`roundRecorder()`；调用方为 preparation.ts、authoring.ts。
 * 边界：模型身份只记录“网页提供方”，网页不返回可核实的实际模型，因此 returned_model 恒为 null。
 */
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createWebChatTransport,type WebChatTransport} from '../web-agent';
import type {AgentResult,AgentTask} from '../agent';
import type {WebAgentSettings} from '../../shared/web-agent';
import type {WebChatRoundLog,WebJsonChatResult} from './chat-loop';

let shared:WebChatTransport|undefined;
/** 同一进程共用一个传输（其内部复用同一个专用浏览器实例）；测试可传入替身。 */
export function defaultWebTransport():WebChatTransport{return shared??=createWebChatTransport();}
export function setWebTransportForTests(transport:WebChatTransport|undefined){shared=transport;}

export function webAgentResult<T>(task:AgentTask<T>,settings:WebAgentSettings,started:number,chat:WebJsonChatResult<unknown>,value:T):AgentResult<T>{
  const model=`web:${settings.provider}`;
  return{result:value,session_id:chat.conversation_url,usage:{web_rounds:chat.rounds.map(({round,kind,chars,elapsed_ms})=>({round,kind,chars,elapsed_ms}))},diagnostic_path:task.directory,duration_ms:Math.round(performance.now()-started),provider:'web',model,requested_model:model,returned_model:null};
}

/** 每轮回复只写长度/耗时/会话地址到私有目录，不保存提示词或回复正文。 */
export function roundRecorder(directory:string){
  return async(log:WebChatRoundLog)=>{await writeFile(join(directory,`web-call-${log.round}.private.json`),JSON.stringify(log),{mode:0o600});};
}
