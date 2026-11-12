/**
 * 职责：web agent 模块公共入口——优先经 BrowserSkill 后台 Agent Window 复用已登录浏览器，否则退回独立 Chrome 档案经 CDP 驱动 DeepSeek / Gemini 网页对话。
 * 公开入口：`createWebChatTransport`、`createOfflineChatTransport`（离线作业台：导出zip、回放交回的回复）、`webBrowserStatus`、`webDoctor`、`webLogin`、`webCloseBrowser`、`WebAgentError`、`extractJsonFromReply`、`isLikelyTruncatedJson` 及类型。
 * 不读取数据库/队列/.env，不借用用户日常标签页；详细边界、核验事实与排错见 `README.md`。
 */
import {bskBrowserStatus,closeOwnedBskSessions,probeBskBrowser} from './bsk-transport';
import {ensureBrowser,webBrowserStatus as cdpBrowserStatus,webCloseBrowser as cdpCloseBrowser,webLogin as cdpLogin} from './browser';
import {probeProviderHealth,resolveBackend} from './transport';
import type {WebAgentBackend,WebChatTransportOptions,WebProvider} from './types';

export {createWebChatTransport,createCdpChatTransport,resolveBackend} from './transport';
export {createBskChatTransport,probeBskBrowser} from './bsk-transport';
export {createOfflineChatTransport,readOfflineTask,importOfflineReply,offlineRoot,OFFLINE_TASK_KEY} from './offline-transport';
export type {OfflineTaskState,OfflineTaskStatus} from './offline-transport';
export {extractJsonFromReply,isLikelyTruncatedJson,JsonExtractError} from './json-extract';
export type {JsonExtractReason} from './json-extract';
export {classifyNotice,classifyPage} from './classify';
export {WebAgentError,isWebAgentError,WEB_AGENT_REASON_CODES} from './types';
export type {
 WebProvider,WebProviderId,WebAgentBackend,WebChatFile,WebChatTurn,WebChatReply,WebChatSession,WebChatTransport,
 WebChatTransportOptions,WebChatOpenOptions,WebAgentReasonCode,
} from './types';

const PROVIDERS:WebProvider[]=['deepseek','gemini'];

export async function webBrowserStatus(root?:string):Promise<{running:boolean;port?:number;profile:string;backend?:'bsk'|'cdp';instance_id?:string;browser_version?:string}>{
 const cdp=await cdpBrowserStatus(root);
 if(root)return {...cdp,backend:'cdp'};
 const backend=await resolveBackend(undefined,{});
 if(backend==='bsk'){
  const bsk=await bskBrowserStatus();
  if(bsk.available)return {running:true,profile:cdp.profile,backend:'bsk',instance_id:bsk.instance_id,browser_version:bsk.browser_version};
 }
 return {...cdp,backend:'cdp'};
}

export async function webCloseBrowser(root?:string):Promise<void>{
 if(!root)await closeOwnedBskSessions();
 await cdpCloseBrowser(root);
}

export async function webLogin(provider:WebProvider,root?:string,options:{chromePath?:string}={}):Promise<void>{
 if(!root&&!options.chromePath){
  const backend=await resolveBackend(provider,{});
  if(backend==='bsk'){
   const state=await probeProviderHealth(provider,{backend:'bsk'});
   if(state==='logged_in')return;
  }
 }
 await cdpLogin(provider,root,options);
}

/** 只读体检：按所选后端逐站点开后台会话/target 判断登录态后立即关闭；不发送消息。 */
export async function webDoctor(
 root?:string,
 options:WebChatTransportOptions={},
):Promise<{browser:'ok'|'unavailable';backend:'bsk'|'cdp';instance_id?:string;providers:Record<WebProvider,'logged_in'|'login_required'|'challenge'|'unknown'>}>{
 const providers={deepseek:'unknown',gemini:'unknown'} as Record<WebProvider,'logged_in'|'login_required'|'challenge'|'unknown'>;
 const opts:WebChatTransportOptions={...options,root};
 const backend=await resolveBackend(undefined,opts);
 if(backend==='bsk'){
  const found=await probeBskBrowser(opts).catch(()=>null);
  if(!found)return {browser:'unavailable',backend:'bsk',providers};
  const states=await Promise.all(PROVIDERS.map(provider=>probeProviderHealth(provider,{...opts,backend:'bsk'}).catch(()=>'unknown' as const)));
  PROVIDERS.forEach((provider,index)=>{providers[provider]=states[index];});
  return {browser:'ok',backend:'bsk',instance_id:found.browser.instance_id,providers};
 }
 try{await ensureBrowser({root,chromePath:options.chromePath,headless:options.headless});}catch{return {browser:'unavailable',backend:'cdp',providers};}
 for(const provider of PROVIDERS){
  try{providers[provider]=await probeProviderHealth(provider,{...opts,backend:'cdp'});}catch{providers[provider]='unknown';}
 }
 return {browser:'ok',backend:'cdp',providers};
}
