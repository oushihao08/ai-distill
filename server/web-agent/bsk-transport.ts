/**
 * 职责：经 BrowserSkill（`bsk` CLI + Chrome 扩展）在独立后台 Agent Window 中驱动已登录网页会话，实现 `WebChatTransport`。
 * 公开入口：`probeBskBrowser()`、`createBskChatTransport()`、`probeBskProviderHealth()`、`bskBrowserStatus()`、`closeOwnedBskSessions()`。
 * 调用方：`transport.ts`（`backend:'auto'|'bsk'` 时选用）与 `index.ts`（`web status / doctor / login / close`）。
 * 边界：只开后台 Agent Window（从不传 `--focus`、从不 `tab borrow` 用户标签页），不读取 cookie/凭证；会话结束必调 `bsk session stop`。
 */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {basename,extname,join} from 'node:path';
import {NOTICE_BUSY,NOTICE_CHALLENGE,NOTICE_RATE_LIMITED,classifyNotice,classifyPage,classifyShortReply,providerHealth} from './classify';
import {jsArg,type AttachmentInfo,type ChatStateInfo,type OptionStateInfo,type PageStateInfo,type WebSiteAdapter} from './sites/types';
import {WebAgentError,type WebChatFile,type WebChatOpenOptions,type WebChatReply,type WebChatSession,type WebChatTransport,type WebChatTransportOptions,type WebProvider,type WebProviderId} from './types';

export interface BskBrowserInstance{
 instance_id:string;
 browser_name:string;
 browser_version?:string;
 extension_version?:string;
 label?:string;
 session_count?:number;
 unresponsive?:boolean;
}

interface BskRunResult{code:number;json:any;stderr:string}

const CHUNK_CHARS=160_000;
const UPLOAD_REJECT=/(not supported|unsupported|file format|too large|file size|exceed|不支持|过大|超过|大小限制|无法上传|上传失败)/i;
const ERROR_NOTICE_JS=`function __waErrNotice(s,incUp){if(!s)return false;return ${NOTICE_CHALLENGE.toString()}.test(s)||${NOTICE_RATE_LIMITED.toString()}.test(s)||${NOTICE_BUSY.toString()}.test(s)||(!!incUp&&${UPLOAD_REJECT.toString()}.test(s));}`;
const FORCE_VISIBLE=String.raw`(()=>{try{Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible';}});Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false;}});document.dispatchEvent(new Event('visibilitychange'));return true;}catch(e){return false;}})()`;
const ownedBskSessions=new Set<string>();

export function resolveBskBin(custom?:string):string|null{
 const explicit=custom??process.env.BSK_BIN;
 if(explicit)return existsSync(explicit)?explicit:null;
 const local=join(homedir(),'.local','bin','bsk');
 if(existsSync(local))return local;
 return typeof Bun!=='undefined'?Bun.which('bsk'):null;
}

function sleep(ms:number,signal?:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new WebAgentError('web_cancelled'));return;}
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
  const onAbort=()=>{clearTimeout(timer);reject(new WebAgentError('web_cancelled'));};
  signal?.addEventListener('abort',onAbort,{once:true});
 });
}

async function runBsk(bin:string,args:string[],options:{timeout_ms?:number;signal?:AbortSignal}={}):Promise<BskRunResult>{
 if(options.signal?.aborted)throw new WebAgentError('web_cancelled');
 const proc=Bun.spawn([bin,...args,'--json'],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 let killedByAbort=false,killedByTimeout=false;
 const onAbort=()=>{killedByAbort=true;try{proc.kill();}catch{}};
 options.signal?.addEventListener('abort',onAbort,{once:true});
 const timer=options.timeout_ms?setTimeout(()=>{killedByTimeout=true;try{proc.kill();}catch{};},options.timeout_ms):null;
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  if(killedByAbort||options.signal?.aborted)throw new WebAgentError('web_cancelled');
  if(killedByTimeout)throw new WebAgentError('web_timeout','bsk 命令执行超时');
  let parsed:any=null;
  const trimmed=stdout.trim();
  if(trimmed){try{parsed=JSON.parse(trimmed);}catch{parsed={raw:trimmed.slice(0,500)};}}
  return {code,json:parsed,stderr:stderr.trim().slice(0,400)};
 }finally{
  if(timer)clearTimeout(timer);
  options.signal?.removeEventListener('abort',onAbort);
 }
}

/** 查询可用的 BrowserSkill 连接实例；无连接返回 null，多实例未指定时报错。 */
export async function probeBskBrowser(options:Pick<WebChatTransportOptions,'bskBin'|'bskBrowser'>={}):Promise<{bin:string;browser:BskBrowserInstance}|null>{
 const bin=resolveBskBin(options.bskBin);
 if(!bin)return null;
 let res:BskRunResult;
 try{res=await runBsk(bin,['browsers'],{timeout_ms:4000});}catch{return null;}
 if(res.code!==0||!Array.isArray(res.json))return null;
 const ready=(res.json as BskBrowserInstance[]).filter(item=>item&&item.instance_id&&!item.unresponsive);
 if(!ready.length)return null;
 const want=(options.bskBrowser??process.env.WEB_AGENT_BSK_BROWSER??'').trim();
 if(want){
  const matched=ready.find(item=>item.instance_id===want||item.label===want);
  if(!matched)throw new WebAgentError('web_browser_unavailable',`未找到已连接的 bsk 浏览器实例 ${want}`);
  return {bin,browser:matched};
 }
 if(ready.length>1)throw new WebAgentError('web_browser_unavailable','存在多个已连接的 bsk 浏览器实例，请通过 WEB_AGENT_BSK_BROWSER 指定');
 return {bin,browser:ready[0]};
}

export async function bskBrowserStatus(options:Pick<WebChatTransportOptions,'bskBin'|'bskBrowser'>={}):Promise<{available:boolean;instance_id?:string;browser_version?:string;owned_sessions:number}>{
 const found=await probeBskBrowser(options).catch(()=>null);
 if(!found)return {available:false,owned_sessions:ownedBskSessions.size};
 return {available:true,instance_id:found.browser.instance_id,browser_version:found.browser.browser_version,owned_sessions:ownedBskSessions.size};
}

export async function closeOwnedBskSessions(options:Pick<WebChatTransportOptions,'bskBin'>={}):Promise<void>{
 const bin=resolveBskBin(options.bskBin);
 const ids=[...ownedBskSessions];
 ownedBskSessions.clear();
 if(!bin||!ids.length)return;
 for(const id of ids)await runBsk(bin,['session','stop',id],{timeout_ms:8000}).catch(()=>undefined);
}

async function stopBskSession(bin:string,sessionId:string):Promise<void>{
 ownedBskSessions.delete(sessionId);
 await runBsk(bin,['session','stop',sessionId],{timeout_ms:8000}).catch(()=>undefined);
}

/** 后台 Agent Window 未触发合成器首帧时 DeepSeek 虚拟列表不挂载节点；通过带重试的后台截图唤醒渲染且不抢焦点。 */
async function wakeBskCompositor(bin:string,sessionId:string,signal?:AbortSignal):Promise<void>{
 const outPath=join(tmpdir(),`wa-bsk-wake-${randomUUID()}.png`);
 try{
  for(let attempt=0;attempt<6;attempt++){
   const syncArgs=attempt<3
    ?['cooperate','sync','--settle','--session',sessionId,'--max-tokens','32']
    :['cooperate','sync','--session',sessionId,'--max-tokens','32'];
   const sync=await runBsk(bin,syncArgs,{timeout_ms:15_000,signal});
   if(sync.code===0&&sync.json?.context_id&&sync.json?.observation_id){
    const sc=await runBsk(
     bin,
     ['screenshot','--session',sessionId,'--context',String(sync.json.context_id),'--observation',String(sync.json.observation_id),'--out',outPath],
     {timeout_ms:15_000,signal},
    );
    if(sc.code===0)return;
   }
   await sleep(250,signal);
  }
 }catch(error){
  if(error instanceof WebAgentError&&error.reason_code==='web_cancelled')throw error;
 }finally{
  await rm(outPath,{force:true}).catch(()=>undefined);
 }
}

async function evalInBsk<T>(bin:string,sessionId:string,expression:string,options:{timeout_ms?:number;signal?:AbortSignal}={}):Promise<T>{
 const timeoutMs=Math.max(5000,options.timeout_ms??30_000);
 for(let attempt=0;attempt<12;attempt++){
  const syncArgs=attempt<4
   ?['cooperate','sync','--settle','--session',sessionId,'--max-tokens','32']
   :['cooperate','sync','--session',sessionId,'--max-tokens','32'];
  const sync=await runBsk(bin,syncArgs,{timeout_ms:25_000,signal:options.signal});
  if(sync.code!==0||!sync.json?.context_id||!sync.json?.observation_id){
   if(attempt<11){await sleep(300,options.signal);continue;}
   throw new WebAgentError('web_browser_unavailable','bsk 页面同步失败');
  }
  const ev=await runBsk(
   bin,
   ['evaluate','--session',sessionId,'--context',String(sync.json.context_id),'--observation',String(sync.json.observation_id),'--timeout',`${timeoutMs}ms`,expression],
   {timeout_ms:timeoutMs+15_000,signal:options.signal},
  );
  if(ev.code===0&&ev.json?.ok===true)return ev.json.value as T;
  const effect=ev.json?.data?.effect_state;
  const reason=ev.json?.data?.reason;
  if(effect==='none'&&(reason==='document_changed'||reason==='observation_changed'||reason==='cooperation_sync_required')&&attempt<11){
   await sleep(150,options.signal);
   continue;
  }
  if(ev.json?.ok===false||ev.json?.exception)throw new WebAgentError('web_ui_changed','页面表达式执行失败');
  throw new WebAgentError('web_browser_unavailable',ev.json?.message?String(ev.json.message).slice(0,160):'bsk 执行失败');
 }
 throw new WebAgentError('web_browser_unavailable','bsk 页面同步重试耗尽');
}

async function waitBskPageReady(bin:string,sessionId:string,adapter:WebSiteAdapter,timeout_ms:number,signal?:AbortSignal):Promise<PageStateInfo>{
 const deadline=Date.now()+timeout_ms;
 while(Date.now()<deadline){
  const state=await evalInBsk<PageStateInfo>(bin,sessionId,adapter.pageState,{timeout_ms:15_000,signal}).catch(error=>{
   if(error instanceof WebAgentError&&error.reason_code==='web_ui_changed')return null;
   throw error;
  });
  if(state){
   const kind=classifyPage(state);
   if(kind==='login')throw new WebAgentError('web_login_required');
   if(kind==='challenge')throw new WebAgentError('web_challenge_required');
   if(kind==='ready')return state;
  }
  await sleep(500,signal);
 }
 throw new WebAgentError('web_timeout','页面未出现聊天输入框');
}

async function applyBskOptions(bin:string,sessionId:string,adapter:WebSiteAdapter,opts:WebChatOpenOptions,signal?:AbortSignal):Promise<void>{
 const read=()=>evalInBsk<OptionStateInfo>(bin,sessionId,adapter.options,{signal});
 const want:Array<['thinking'|'search',boolean]>=[];
 if(adapter.supports.search_toggle)want.push(['search',false]);
 if(adapter.supports.thinking&&typeof opts.thinking==='boolean')want.push(['thinking',opts.thinking]);
 for(const [kind,on] of want){
  const state=await read();
  if(state[kind]===null)throw new WebAgentError('web_ui_changed',`未找到 ${kind} 开关`);
  if(state[kind]===on)continue;
  await evalInBsk(bin,sessionId,adapter.setOption(kind,on),{signal});
  await sleep(400,signal);
  if((await read())[kind]!==on)throw new WebAgentError('web_ui_changed',`无法切换 ${kind} 开关`);
 }
 if(opts.model_label&&adapter.supports.model&&adapter.modelOpen&&adapter.modelChoose&&adapter.modelClose){
  await evalInBsk(bin,sessionId,adapter.modelOpen,{signal});
  await sleep(700,signal);
  const chosen=await evalInBsk<{ok:boolean;labels:string[]}>(bin,sessionId,adapter.modelChoose(opts.model_label),{signal});
  await sleep(500,signal);
  await evalInBsk(bin,sessionId,adapter.modelClose,{signal}).catch(()=>undefined);
  if(!chosen.ok)throw new WebAgentError('web_ui_changed',`未找到模型选项；可选：${chosen.labels.join('；').slice(0,300)}`);
 }
}

function safeFileName(name:string,index:number):string{
 const base=basename(name.replace(/\\/g,'/')).replace(/[\u0000-\u001f]/g,'').trim();
 return base&&base!=='.'&&base!=='..'?base:`file-${index+1}.txt`;
}
function toBytes(content:Uint8Array|string):Uint8Array{return typeof content==='string'?new TextEncoder().encode(content):content;}
function mimeFor(name:string):string{
 const ext=extname(name).toLowerCase();
 if(ext==='.json')return 'application/json';
 if(ext==='.md')return 'text/markdown';
 return 'text/plain';
}

async function stageString(bin:string,sessionId:string,globalKey:string,value:string,signal?:AbortSignal):Promise<void>{
 await evalInBsk(bin,sessionId,`(()=>{window[${jsArg(globalKey)}]='';return true;})()`,{signal});
 for(let offset=0;offset<value.length;offset+=CHUNK_CHARS){
  const slice=value.slice(offset,offset+CHUNK_CHARS);
  await evalInBsk(bin,sessionId,`((s)=>{window[${jsArg(globalKey)}]+=s;return window[${jsArg(globalKey)}].length;})(${jsArg(slice)})`,{signal});
 }
}

export class BskChatSession implements WebChatSession{
 private closedFlag=false;
 private closeStarted=false;
 private chain:Promise<unknown>=Promise.resolve();
 private currentUrl:string;
 private activeAbort:AbortController|null=null;
 readonly diagnostics={visibility_overridden:false,visibility_initial:'' as string};

 constructor(
  private readonly bin:string,
  private readonly sessionId:string,
  private readonly adapter:WebSiteAdapter,
  initialUrl:string,
  private readonly timing:{poll_ms?:number;stable_ms?:number}={},
 ){this.currentUrl=initialUrl;}

 url():string{return this.currentUrl;}

 ask(turn:WebChatTurn,opts:{timeout_ms:number;signal?:AbortSignal}):Promise<WebChatReply>{
  const run=this.chain.then(()=>this.doAsk(turn,opts),()=>this.doAsk(turn,opts));
  this.chain=run.catch(()=>undefined);
  return run;
 }

 async close():Promise<void>{
  if(this.closeStarted)return;
  this.closeStarted=true;
  this.closedFlag=true;
  this.activeAbort?.abort();
  await stopBskSession(this.bin,this.sessionId);
 }

 private remaining(deadline:number){
  const left=deadline-Date.now();
  if(left<=0)throw new WebAgentError('web_timeout');
  return left;
 }

 private async bestEffortStop(){
  try{await evalInBsk<boolean>(this.bin,this.sessionId,this.adapter.stop,{timeout_ms:6000});}catch{}
 }

 private async doAsk(turn:WebChatTurn,opts:{timeout_ms:number;signal?:AbortSignal}):Promise<WebChatReply>{
  if(this.closedFlag)throw new WebAgentError('web_browser_unavailable','会话已关闭');
  if(opts.signal?.aborted)throw new WebAgentError('web_cancelled');
  const started=Date.now(),deadline=started+opts.timeout_ms;
  const local=new AbortController();
  this.activeAbort=local;
  const onAbort=()=>local.abort();
  opts.signal?.addEventListener('abort',onAbort,{once:true});
  const signal=local.signal;
  try{
   return await this.runTurn(turn,deadline,signal,started);
  }catch(error){
   if(opts.signal?.aborted||(error instanceof WebAgentError&&error.reason_code==='web_cancelled')){
    await this.close();
    throw error instanceof WebAgentError?error:new WebAgentError('web_cancelled');
   }
   if(error instanceof WebAgentError&&error.reason_code==='web_timeout')await this.bestEffortStop();
   throw error;
  }finally{
   opts.signal?.removeEventListener('abort',onAbort);
   if(this.activeAbort===local)this.activeAbort=null;
  }
 }

 private async runTurn(turn:WebChatTurn,deadline:number,signal:AbortSignal,started:number):Promise<WebChatReply>{
  const {adapter,bin,sessionId}=this;
  const files=turn.files??[];
  if(!turn.prompt.trim())throw new WebAgentError('web_ui_changed','提示词为空');
  if(files.length>adapter.max_files)throw new WebAgentError('web_upload_rejected',`文件数 ${files.length} 超过站点上限 ${adapter.max_files}`);
  const prepared=files.map((file,index)=>({name:safeFileName(file.name,index),bytes:toBytes(file.content),mime:mimeFor(file.name)}));
  for(const file of prepared){
   if(file.bytes.byteLength===0)throw new WebAgentError('web_upload_rejected','文件为空');
   if(file.bytes.byteLength>adapter.max_file_bytes)throw new WebAgentError('web_upload_rejected','文件超过站点单文件大小上限');
  }
  const page=await waitBskPageReady(bin,sessionId,adapter,Math.min(60_000,this.remaining(deadline)),signal);
  this.diagnostics.visibility_initial=this.diagnostics.visibility_initial||String(page.visibility??'');
  if(page.visibility==='hidden'){
   await evalInBsk(bin,sessionId,FORCE_VISIBLE,{signal});
   this.diagnostics.visibility_overridden=true;
  }
  const before=await evalInBsk<ChatStateInfo>(bin,sessionId,adapter.chatState,{signal});
  const baseChips=(await evalInBsk<AttachmentInfo[]>(bin,sessionId,adapter.attachments,{signal})).length;
  if(prepared.length)await this.uploadFiles(prepared,baseChips,deadline,signal);
  return this.sendAndAwaitReply(turn.prompt,before,deadline,started,signal);
 }

 private async uploadFiles(files:Array<{name:string;bytes:Uint8Array;mime:string}>,baseChips:number,deadline:number,signal:AbortSignal):Promise<void>{
  const {adapter,bin,sessionId}=this;
  await evalInBsk(bin,sessionId,'(()=>{window.__waFiles=[];return true;})()',{signal});
  try{
   for(const file of files){
    const b64=Buffer.from(file.bytes).toString('base64');
    await stageString(bin,sessionId,'__waFileB64',b64,signal);
    await evalInBsk(bin,sessionId,`((meta)=>{window.__waFiles.push({name:meta.name,mime:meta.mime,b64:window.__waFileB64});delete window.__waFileB64;return window.__waFiles.length;})(${jsArg({name:file.name,mime:file.mime})})`,{signal});
   }
   const waitMs=Math.min(90_000,this.remaining(deadline));
   const selector=adapter.upload.mode==='input'?adapter.upload.selector:null;
   const expr=String.raw`((async()=>{
    ${ERROR_NOTICE_JS}
    try{
     var raw=window.__waFiles||[];delete window.__waFiles;
     var dt=new DataTransfer();
     raw.forEach(function(f){
      var binStr=atob(f.b64),arr=new Uint8Array(binStr.length);
      for(var i=0;i<binStr.length;i++)arr[i]=binStr.charCodeAt(i);
      dt.items.add(new File([arr],f.name,{type:f.mime||'text/plain'}));
     });
     var sel=${jsArg(selector)};
     if(sel){
      var inp=document.querySelector(sel);
      if(!inp)return {ok:false,code:'web_ui_changed',detail:'未找到文件上传控件'};
      var setF=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files');
      if(setF&&setF.set)setF.set.call(inp,dt.files);else inp.files=dt.files;
      inp.dispatchEvent(new Event('change',{bubbles:true}));
     }else{
      ${adapter.composerFocus};
      var ed=document.activeElement||document.body;
      ed.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
      await new Promise(function(r){setTimeout(r,1800);});
      var initList=${adapter.attachments};
      if(initList.length<=${jsArg(baseChips)}){
       var dz=document.querySelector('xapscottyuploaderdropzone,rich-textarea,input-area-v2')||ed;
       dz.dispatchEvent(new DragEvent('dragenter',{dataTransfer:dt,bubbles:true,cancelable:true}));
       dz.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true}));
       dz.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
      }
     }
     var expected=${jsArg(baseChips+files.length)},base=${jsArg(baseChips)},begun=Date.now(),limit=${jsArg(waitMs)};
     while(Date.now()-begun<limit){
      var list=${adapter.attachments};
      if(list.some(function(i){return i.state==='failed';}))return {ok:false,code:'web_upload_rejected',detail:'站点标记文件上传/解析失败'};
      if(list.length>=expected&&list.every(function(i){return i.state==='ready';}))return {ok:true,count:list.length};
      var notice=${adapter.notice};
      if(__waErrNotice(notice,true))return {ok:false,code:'notice',notice:notice,count:list.length};
      if(list.length<=base&&Date.now()-begun>30000)return {ok:false,code:'web_upload_rejected',detail:'站点未接收上传文件'};
      await new Promise(function(r){setTimeout(r,400);});
     }
     return {ok:false,code:'web_timeout',detail:'等待附件就绪超时'};
    }finally{delete window.__waFiles;delete window.__waFileB64;}
   })())`;
   const out=await evalInBsk<{ok:boolean;code?:string;detail?:string;notice?:string}>(bin,sessionId,expr,{timeout_ms:waitMs+10_000,signal});
   if(out.ok)return;
   if(out.code==='notice'&&out.notice){
    const reason=classifyNotice(out.notice);
    if(reason)throw new WebAgentError(reason);
    if(UPLOAD_REJECT.test(out.notice))throw new WebAgentError('web_upload_rejected','站点提示文件不被接受');
    throw new WebAgentError('web_upload_rejected',out.notice.slice(0,120));
   }
   throw new WebAgentError((out.code as any)||'web_upload_rejected',out.detail);
  }finally{
   await evalInBsk(bin,sessionId,'(()=>{delete window.__waFiles;delete window.__waFileB64;return true;})()',{timeout_ms:6000}).catch(()=>undefined);
  }
 }

 private async sendAndAwaitReply(prompt:string,before:ChatStateInfo,deadline:number,started:number,signal:AbortSignal):Promise<WebChatReply>{
  const {adapter,bin,sessionId}=this;
  const want=prompt.replace(/\s+/g,'').length;
  const stable=this.timing.stable_ms??2000;
  const poll=this.timing.poll_ms??400;
  await stageString(bin,sessionId,'__waPrompt',prompt,signal);
  const writeExpr=adapter.composerFromExpr?adapter.composerFromExpr('window.__waPrompt'):`(()=>-1)()`;
  const waitMs=Math.max(5000,this.remaining(deadline));
  // 发送前页面处于静止态，在单次 evaluate Promise 内完成“写入→发送→等待流式稳定→读取回复”，避免流式 DOM 高频变动触发 bsk observation_changed。
  const expr=String.raw`((async()=>{
   ${ERROR_NOTICE_JS}
   try{
    if(!(${adapter.composerFocus}))return {ok:false,code:'web_ui_changed',detail:'未找到输入框'};
    var len=${writeExpr};
    delete window.__waPrompt;
    if(len!==${jsArg(want)})return {ok:false,code:'web_ui_changed',detail:'提示词未能完整写入输入框'};
    var totalLimit=${jsArg(waitMs)},begun=Date.now();
    var readyEnd=begun+Math.min(60000,totalLimit);
    while(!(${adapter.sendReady})){
     if(Date.now()>readyEnd)return {ok:false,code:'web_ui_changed',detail:'发送按钮未就绪'};
     await new Promise(function(r){setTimeout(r,300);});
    }
    var startHref=location.href;
    if(!(${adapter.send}))return {ok:false,code:'web_ui_changed',detail:'点击发送按钮失败'};
    var subEnd=Date.now()+Math.min(45000,Math.max(5000,totalLimit-(Date.now()-begun))),beforeUsers=${jsArg(before.users)},beforeKey=${jsArg(before.last_user_key)};
    for(;;){
     var st0=${adapter.chatState};
     if(st0.users>beforeUsers||(st0.last_user_key&&st0.last_user_key!==beforeKey))break;
     var curLen=${adapter.composerLength};
     if(curLen===0&&(st0.generating||location.href!==startHref))break;
     var notice0=${adapter.notice};
     if(__waErrNotice(notice0,false))return {ok:false,code:'notice',notice:notice0};
     if(Date.now()>subEnd)return {ok:false,code:'web_ui_changed',detail:'点击发送后消息未提交'};
     await new Promise(function(r){setTimeout(r,350);});
    }
    var sendDoneAt=Date.now(),stable=${jsArg(stable)},poll=${jsArg(poll)};
    var beforeAsst=${jsArg(before.assistants)},beforeAsstKey=${jsArg(before.last_assistant_key)};
    var sig='',changedAt=sendDoneAt,polls=0,visOverridden=false,seenGen=false;
    while(Date.now()-begun<totalLimit){
     var st=${adapter.chatState};
     if(st.generating)seenGen=true;
     if(polls++%3===0){
      var notice=${adapter.notice};
      if(__waErrNotice(notice,false))return {ok:false,code:'notice',notice:notice};
      if(st.visibility==='hidden'){${FORCE_VISIBLE};visOverridden=true;}
     }
     var hasStarted=st.assistants>beforeAsst||(!!st.last_assistant_key&&st.last_assistant_key!==beforeAsstKey);
     if(!hasStarted){
      if(!st.generating&&(seenGen||Date.now()-sendDoneAt>8000))return {ok:false,code:'need_paint',visOverridden:visOverridden};
      await new Promise(function(r){setTimeout(r,poll);});
      continue;
     }
     if(st.reply_sig!==sig){sig=st.reply_sig;changedAt=Date.now();}
     var quiet=Date.now()-changedAt;
     if(!st.generating){
      if(st.continue_available)return {ok:false,code:'need_continue',visOverridden:visOverridden};
      if(st.reply_len>0&&quiet>=(st.complete?stable:stable*3)){
       var text=${adapter.lastReply};
       return {ok:true,text:text,href:location.href,visOverridden:visOverridden};
      }
      if(st.reply_len===0&&quiet>=stable*2)return {ok:false,code:'need_paint',visOverridden:visOverridden};
     }
     await new Promise(function(r){setTimeout(r,poll);});
    }
    return {ok:false,code:'web_timeout'};
   }finally{delete window.__waPrompt;}
  })())`;
  const out=await evalInBsk<{ok:boolean;code?:string;detail?:string;notice?:string;text?:string;href?:string;visOverridden?:boolean}>(
   bin,sessionId,expr,{timeout_ms:waitMs+15_000,signal},
  ).finally(()=>{
   void evalInBsk(bin,sessionId,'(()=>{delete window.__waPrompt;return true;})()',{timeout_ms:5000}).catch(()=>undefined);
  });
  if(out.visOverridden)this.diagnostics.visibility_overridden=true;
  if(out.ok)return this.finalizeReplyText(String(out.text??''),String(out.href||this.currentUrl),started);
  if(out.code==='need_paint'||out.code==='need_continue'){
   return this.finishAfterPaintOrContinue(before,deadline,started,signal);
  }
  if(out.code==='notice'&&out.notice){
   const reason=classifyNotice(out.notice);
   if(reason){await this.bestEffortStop();throw new WebAgentError(reason);}
  }
  if(out.code==='web_timeout'){await this.bestEffortStop();throw new WebAgentError('web_timeout');}
  throw new WebAgentError((out.code as any)||'web_ui_changed',out.detail);
 }

 private finalizeReplyText(text:string,href:string,started:number):WebChatReply{
  const shortReason=classifyShortReply(text);
  if(shortReason)throw new WebAgentError(shortReason);
  if(!text.trim())throw new WebAgentError('web_reply_incomplete','回复为空');
  this.currentUrl=href||this.currentUrl;
  return {text,conversation_url:this.currentUrl,elapsed_ms:Date.now()-started};
 }

 private async waitInPageIdle(deadline:number,signal:AbortSignal):Promise<void>{
  const {adapter,bin,sessionId}=this;
  const poll=this.timing.poll_ms??400;
  const limit=Math.max(5000,this.remaining(deadline));
  const expr=String.raw`((async()=>{
   ${ERROR_NOTICE_JS}
   var begun=Date.now(),limit=${jsArg(limit)},poll=${jsArg(poll)},seenGen=false;
   while(Date.now()-begun<limit){
    var st=${adapter.chatState};
    if(st.generating)seenGen=true;
    var notice=${adapter.notice};
    if(__waErrNotice(notice,false))return {ok:false,code:'notice',notice:notice};
    if(!st.generating&&(seenGen||Date.now()-begun>5000))return {ok:true};
    await new Promise(function(r){setTimeout(r,poll);});
   }
   return {ok:false,code:'web_timeout'};
  })())`;
  const res=await evalInBsk<{ok:boolean;code?:string;notice?:string}>(bin,sessionId,expr,{timeout_ms:limit+12_000,signal});
  if(res.ok)return;
  if(res.code==='notice'&&res.notice){
   const reason=classifyNotice(res.notice);
   if(reason){await this.bestEffortStop();throw new WebAgentError(reason);}
  }
  if(res.code==='web_timeout'){await this.bestEffortStop();throw new WebAgentError('web_timeout');}
  throw new WebAgentError('web_ui_changed','等待流式输出结束失败');
 }

 private async finishAfterPaintOrContinue(before:ChatStateInfo,deadline:number,started:number,signal:AbortSignal):Promise<WebChatReply>{
  const {adapter,bin,sessionId}=this;
  const stable=this.timing.stable_ms??2000;
  let continues=0;
  for(let cycle=0;cycle<10;cycle++){
   this.remaining(deadline);
   await wakeBskCompositor(bin,sessionId,signal);
   await sleep(700,signal);
   const st=await evalInBsk<ChatStateInfo>(bin,sessionId,adapter.chatState,{signal});
   if(st.generating){
    await this.waitInPageIdle(deadline,signal);
    continue;
   }
   if(st.continue_available&&adapter.continueGen&&continues<6){
    const clicked=await evalInBsk<boolean>(bin,sessionId,adapter.continueGen,{signal});
    if(clicked){
     continues++;
     await this.waitInPageIdle(deadline,signal);
     continue;
    }
   }
   const hasStarted=st.assistants>before.assistants||(!!st.last_assistant_key&&st.last_assistant_key!==before.last_assistant_key);
   if(!hasStarted){
    if(cycle<3){await sleep(1200,signal);continue;}
    throw new WebAgentError('web_ui_changed','发送后未出现助手回复');
   }
   await sleep(stable,signal);
   const res=await evalInBsk<{text:string;href:string}>(bin,sessionId,`(()=>({text:(${adapter.lastReply}),href:location.href}))()`,{signal});
   return this.finalizeReplyText(String(res.text??''),String(res.href||this.currentUrl),started);
  }
  throw new WebAgentError('web_reply_incomplete','站点连续分段继续生成次数超限');
 }
}

export function createBskChatTransport(
 adapterResolver:(provider:WebProviderId,options:WebChatTransportOptions)=>WebSiteAdapter,
 options:WebChatTransportOptions={},
):WebChatTransport&{dispose():void}{
 return {
  async open(provider:WebProviderId,opts:WebChatOpenOptions={}):Promise<WebChatSession>{
   if(opts.signal?.aborted)throw new WebAgentError('web_cancelled');
   const adapter=adapterResolver(provider,options);
   const found=await probeBskBrowser(options);
   if(!found)throw new WebAgentError('web_browser_unavailable','未检测到已连接的 BrowserSkill 浏览器');
   const started=await runBsk(found.bin,['session','start','--browser',found.browser.instance_id],{timeout_ms:15_000,signal:opts.signal});
   const sessionId=String(started.json?.session_id??'');
   if(started.code!==0||!sessionId)throw new WebAgentError('web_browser_unavailable','无法启动 bsk 后台会话窗口');
   ownedBskSessions.add(sessionId);
   try{
    const nav=await runBsk(found.bin,['navigate',adapter.startUrl,'--session',sessionId,'--timeout','45s'],{timeout_ms:50_000,signal:opts.signal});
    if(nav.code!==0)throw new WebAgentError('web_browser_unavailable','bsk 导航站点失败');
    const page=await waitBskPageReady(found.bin,sessionId,adapter,60_000,opts.signal);
    if(page.visibility==='hidden'){
     await wakeBskCompositor(found.bin,sessionId,opts.signal);
     await evalInBsk(found.bin,sessionId,FORCE_VISIBLE,{signal:opts.signal});
    }
    await applyBskOptions(found.bin,sessionId,adapter,opts,opts.signal);
    const session=new BskChatSession(found.bin,sessionId,adapter,page.url);
    session.diagnostics.visibility_initial=String(page.visibility??'');
    if(page.visibility==='hidden')session.diagnostics.visibility_overridden=true;
    return session;
   }catch(error){
    await stopBskSession(found.bin,sessionId);
    throw error;
   }
  },
  dispose(){void closeOwnedBskSessions(options);},
 };
}

export async function probeBskProviderHealth(
 provider:WebProvider,
 adapterResolver:(provider:WebProviderId,options:WebChatTransportOptions)=>WebSiteAdapter,
 options:WebChatTransportOptions={},
):Promise<'logged_in'|'login_required'|'challenge'|'unknown'>{
 const found=await probeBskBrowser(options);
 if(!found)return 'unknown';
 const adapter=adapterResolver(provider,options);
 const started=await runBsk(found.bin,['session','start','--browser',found.browser.instance_id],{timeout_ms:15_000});
 const sessionId=String(started.json?.session_id??'');
 if(started.code!==0||!sessionId)return 'unknown';
 ownedBskSessions.add(sessionId);
 try{
  const nav=await runBsk(found.bin,['navigate',adapter.startUrl,'--session',sessionId,'--timeout','40s'],{timeout_ms:45_000});
  if(nav.code!==0)return 'unknown';
  await waitBskPageReady(found.bin,sessionId,adapter,45_000);
  return providerHealth('ready');
 }catch(error){
  if(error instanceof WebAgentError){
   if(error.reason_code==='web_login_required')return providerHealth('login');
   if(error.reason_code==='web_challenge_required')return providerHealth('challenge');
  }
  return 'unknown';
 }finally{
  await stopBskSession(found.bin,sessionId);
 }
}
