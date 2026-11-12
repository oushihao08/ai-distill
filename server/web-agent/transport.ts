/**
 * 职责：把站点适配器、浏览器后端（默认优先已连接的 BrowserSkill 后台 Agent Window，否则退回独立 Chrome CDP 档案）组装成 `WebChatTransport`。
 * 公开入口：`createWebChatTransport()`、`probeProviderHealth()`、`resolveBackend()`；由 `index.ts` 再导出，供 worker 的 web agent 执行器与 `webDoctor` 使用。
 * 数据流：`bsk` 后端通过 BrowserSkill 打开独立后台 Agent Window 会话（复用已有登录态、不动用户标签页）；`cdp` 后端通过独立档案调试端口创建后台 target。
 */
import {join} from 'node:path';
import {createBskChatTransport,probeBskBrowser,probeBskProviderHealth} from './bsk-transport';
import {CdpClient} from './cdp';
import {ensureBrowser,webAgentPaths,type LaunchOptions} from './browser';
import {classifyPage,providerHealth} from './classify';
import {CdpChatSession,applySessionOptions,waitForPageReady,type SessionContext} from './session';
import {deepseekAdapter} from './sites/deepseek';
import {fakeAdapter} from './sites/fake';
import {geminiAdapter} from './sites/gemini';
import type {PageStateInfo,WebSiteAdapter} from './sites/types';
import {WebAgentError,type WebAgentBackend,type WebChatOpenOptions,type WebChatSession,type WebChatTransport,type WebChatTransportOptions,type WebProvider,type WebProviderId} from './types';

export function adapterFor(provider:WebProviderId,options:WebChatTransportOptions):WebSiteAdapter{
 if(provider==='deepseek')return deepseekAdapter;
 if(provider==='gemini')return geminiAdapter;
 if(provider==='fake'){
  if(!options.fake_url)throw new WebAgentError('web_ui_changed','fake 站点需要 fake_url');
  return fakeAdapter(options.fake_url);
 }
 throw new WebAgentError('web_ui_changed','未知站点');
}

export async function resolveBackend(provider:WebProviderId|undefined,options:WebChatTransportOptions={}):Promise<'bsk'|'cdp'>{
 const configured=(options.backend??(process.env.WEB_AGENT_BACKEND as WebAgentBackend|undefined)??'auto');
 if(configured==='cdp')return 'cdp';
 if(configured==='bsk')return 'bsk';
 if(provider==='fake'||options.fake_url||options.root||options.chromePath||options.headless!==undefined)return 'cdp';
 const bsk=await probeBskBrowser(options);
 return bsk?'bsk':'cdp';
}

interface OpenedTarget{ctx:SessionContext;page?:PageStateInfo}

async function openTarget(client:CdpClient,adapter:WebSiteAdapter,tmpRoot:string,signal?:AbortSignal):Promise<OpenedTarget>{
 const created=await client.send<{targetId:string}>('Target.createTarget',{url:adapter.startUrl,newWindow:true,background:true,width:1280,height:900},{signal,timeout_ms:20000});
 const targetId=created.targetId;
 try{
  const attached=await client.send<{sessionId:string}>('Target.attachToTarget',{targetId,flatten:true},{signal,timeout_ms:15000});
  const sessionId=attached.sessionId;
  await client.send('Page.enable',{},{sessionId,signal});
  await client.send('Emulation.setFocusEmulationEnabled',{enabled:true},{sessionId,signal}).catch(()=>undefined);
  return {ctx:{client,adapter,targetId,sessionId,tmpRoot}};
 }catch(error){
  await client.send('Target.closeTarget',{targetId}).catch(()=>undefined);
  throw error;
 }
}

export function createCdpChatTransport(options:WebChatTransportOptions={}):WebChatTransport&{dispose():void}{
 const launch:LaunchOptions={root:options.root,chromePath:options.chromePath,headless:options.headless};
 const tmpRoot=join(webAgentPaths(options.root).dir,'tmp');
 let current:CdpClient|null=null;
 let connecting:Promise<CdpClient>|null=null;
 async function client():Promise<CdpClient>{
  if(current&&!current.closed)return current;
  connecting??=(async()=>{
   const {wsUrl}=await ensureBrowser(launch);
   const connected=await CdpClient.connect(wsUrl);
   current=connected;
   return connected;
  })().finally(()=>{connecting=null;});
  return connecting;
 }
 return {
  async open(provider:WebProviderId,opts:WebChatOpenOptions={}):Promise<WebChatSession>{
   if(opts.signal?.aborted)throw new WebAgentError('web_cancelled');
   const adapter=adapterFor(provider,options);
   const cdp=await client();
   const {ctx}=await openTarget(cdp,adapter,tmpRoot,opts.signal);
   try{
    const page=await waitForPageReady(ctx,{timeout_ms:60_000,signal:opts.signal});
    await applySessionOptions(ctx,opts,opts.signal);
    const session=new CdpChatSession(ctx,page.url);
    session.diagnostics.visibility_initial=String(page.visibility??'');
    return session;
   }catch(error){
    await cdp.send('Target.closeTarget',{targetId:ctx.targetId}).catch(()=>undefined);
    throw error;
   }
  },
  dispose(){current?.close();current=null;},
 };
}

export function createWebChatTransport(options:WebChatTransportOptions={}):WebChatTransport&{dispose():void}{
 const cdp=createCdpChatTransport(options);
 const bsk=createBskChatTransport(adapterFor,options);
 return {
  async open(provider:WebProviderId,opts:WebChatOpenOptions={}):Promise<WebChatSession>{
   const backend=await resolveBackend(provider,options);
   return backend==='bsk'?bsk.open(provider,opts):cdp.open(provider,opts);
  },
  dispose(){bsk.dispose();cdp.dispose();},
 };
}

/** 只读探测登录态：按所选后端开后台会话/target 判断后立即关闭；不发送消息。 */
export async function probeProviderHealth(provider:WebProvider,options:WebChatTransportOptions={}):Promise<'logged_in'|'login_required'|'challenge'|'unknown'>{
 const backend=await resolveBackend(provider,options);
 if(backend==='bsk')return probeBskProviderHealth(provider,adapterFor,options);
 const adapter=adapterFor(provider,options);
 const {wsUrl}=await ensureBrowser({root:options.root,chromePath:options.chromePath,headless:options.headless});
 const cdp=await CdpClient.connect(wsUrl);
 try{
  const {ctx}=await openTarget(cdp,adapter,join(webAgentPaths(options.root).dir,'tmp'));
  try{
   await waitForPageReady(ctx,{timeout_ms:45_000});
   return providerHealth('ready');
  }catch(error){
   if(error instanceof WebAgentError){
    if(error.reason_code==='web_login_required')return providerHealth('login');
    if(error.reason_code==='web_challenge_required')return providerHealth('challenge');
   }
   return 'unknown';
  }finally{
   await cdp.send('Target.closeTarget',{targetId:ctx.targetId}).catch(()=>undefined);
  }
 }finally{cdp.close();}
}

export {classifyPage};
