/**
 * 职责：驱动一个网页聊天会话（独占一个 Chrome target）：上传文件、写入提示词、发送、等待生成结束并读取回复；多轮 `ask` 复用同一对话。
 * 公开入口：`CdpChatSession`（实现 `WebChatSession`）、`waitForPageReady()`、`applySessionOptions()`；由 `transport.ts` 创建，测试经假聊天页驱动。
 * 判定均来自站点适配器的页面内表达式；本模块只做编排：多信号等待（生成中标志消失 + 站点完成信号 + 回复文本稳定）、超时/取消、错误分类。
 * 遇到登录页、验证码、限额、繁忙只抛带 reason_code 的错误，不尝试绕过或点击验证。临时上传文件写入私有目录（0700/0600）并在 ask 结束后删除。
 */
import {chmod,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {CdpClient,CdpProtocolError} from './cdp';
import {classifyNotice,classifyPage,classifyShortReply} from './classify';
import {jsArg,type AttachmentInfo,type ChatStateInfo,type OptionStateInfo,type PageStateInfo,type WebSiteAdapter} from './sites/types';
import {WebAgentError,type WebChatFile,type WebChatOpenOptions,type WebChatReply,type WebChatSession,type WebChatTurn} from './types';

export interface SessionContext{
 client:CdpClient;
 adapter:WebSiteAdapter;
 targetId:string;
 sessionId:string;
 /** 私有临时目录根（0700），上传文件在其下的随机子目录中。 */
 tmpRoot:string;
 poll_ms?:number;
 /** 回复文本稳定判定时长；有站点完成信号时使用该值，否则使用其 3 倍。 */
 stable_ms?:number;
 onClosed?:()=>void;
}

/** 超过该字符数的提示词不走 Input.insertText（见 insertPrompt）。 */
const INSERT_TEXT_MAX=16_000;
const UPLOAD_REJECT=/(not supported|unsupported|file format|too large|file size|exceed|不支持|过大|超过|大小限制|无法上传|上传失败)/i;
const FORCE_VISIBLE=String.raw`(()=>{try{Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible';}});Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false;}});document.dispatchEvent(new Event('visibilitychange'));return true;}catch(e){return false;}})()`;

function sleep(ms:number,signal?:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new WebAgentError('web_cancelled'));return;}
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
  const onAbort=()=>{clearTimeout(timer);reject(new WebAgentError('web_cancelled'));};
  signal?.addEventListener('abort',onAbort,{once:true});
 });
}

/** 经 `Runtime.evaluate` 执行站点表达式；表达式异常 → web_ui_changed，目标页已不存在 → web_browser_unavailable。 */
export async function evaluateExpression<T>(ctx:Pick<SessionContext,'client'|'sessionId'>,expression:string,options:{timeout_ms?:number;signal?:AbortSignal}={}):Promise<T>{
 try{
  const result=await ctx.client.send<any>('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true},{sessionId:ctx.sessionId,timeout_ms:options.timeout_ms??30000,signal:options.signal});
  if(result.exceptionDetails)throw new WebAgentError('web_ui_changed','页面表达式执行失败');
  return result.result?.value as T;
 }catch(error){
  if(error instanceof CdpProtocolError)throw new WebAgentError('web_browser_unavailable','页面已关闭或不可用');
  throw error;
 }
}

/** 保证页面可见状态：后台窗口若报告 hidden，DeepSeek 不渲染消息列表；仅在检测到 hidden 时覆盖可见性并记录。 */
export async function ensureVisible(ctx:SessionContext,state:{visibility?:string}):Promise<boolean>{
 if(state.visibility!=='hidden')return false;
 await ctx.client.send('Page.addScriptToEvaluateOnNewDocument',{source:FORCE_VISIBLE},{sessionId:ctx.sessionId}).catch(()=>undefined);
 return evaluateExpression<boolean>(ctx,FORCE_VISIBLE);
}

/** 等待聊天输入框出现；登录页/验证码立即抛错；超时为 web_timeout。 */
export async function waitForPageReady(ctx:SessionContext,options:{timeout_ms:number;signal?:AbortSignal}):Promise<PageStateInfo>{
 const deadline=Date.now()+options.timeout_ms;
 let last:PageStateInfo|null=null;
 while(Date.now()<deadline){
  last=await evaluateExpression<PageStateInfo>(ctx,ctx.adapter.pageState,{signal:options.signal,timeout_ms:15000}).catch(error=>{
   if(error instanceof WebAgentError&&error.reason_code==='web_ui_changed')return null;
   throw error;
  });
  if(last){
   const kind=classifyPage(last);
   if(kind==='login')throw new WebAgentError('web_login_required');
   if(kind==='challenge')throw new WebAgentError('web_challenge_required');
   if(kind==='ready')return last;
  }
  await sleep(500,options.signal);
 }
 throw new WebAgentError('web_timeout','页面未出现聊天输入框');
}

/** 默认关闭联网搜索；`thinking`/`model_label` 仅在显式传入且站点支持时改变站点默认。 */
export async function applySessionOptions(ctx:SessionContext,opts:WebChatOpenOptions,signal?:AbortSignal):Promise<void>{
 const {adapter}=ctx;
 const read=()=>evaluateExpression<OptionStateInfo>(ctx,adapter.options,{signal});
 const want:Array<['thinking'|'search',boolean]>=[];
 if(adapter.supports.search_toggle)want.push(['search',false]);
 if(adapter.supports.thinking&&typeof opts.thinking==='boolean')want.push(['thinking',opts.thinking]);
 for(const [kind,on] of want){
  const state=await read();
  if(state[kind]===null)throw new WebAgentError('web_ui_changed',`未找到 ${kind} 开关`);
  if(state[kind]===on)continue;
  await evaluateExpression(ctx,adapter.setOption(kind,on),{signal});
  await sleep(400,signal);
  if((await read())[kind]!==on)throw new WebAgentError('web_ui_changed',`无法切换 ${kind} 开关`);
 }
 if(opts.model_label&&adapter.supports.model&&adapter.modelOpen&&adapter.modelChoose&&adapter.modelClose){
  await evaluateExpression(ctx,adapter.modelOpen,{signal});
  await sleep(700,signal);
  const chosen=await evaluateExpression<{ok:boolean;labels:string[]}>(ctx,adapter.modelChoose(opts.model_label),{signal});
  await sleep(500,signal);
  await evaluateExpression(ctx,adapter.modelClose,{signal}).catch(()=>undefined);
  if(!chosen.ok)throw new WebAgentError('web_ui_changed',`未找到模型选项；可选：${chosen.labels.join('；').slice(0,300)}`);
 }
}

function safeFileName(name:string,index:number):string{
 const base=basename(name.replace(/\\/g,'/')).replace(/[\u0000-\u001f]/g,'').trim();
 return base&&base!=='.'&&base!=='..'?base:`file-${index+1}`;
}
function toBytes(content:Uint8Array|string):Uint8Array{return typeof content==='string'?new TextEncoder().encode(content):content;}

export class CdpChatSession implements WebChatSession{
 private closedFlag=false;
 private closeStarted=false;
 private chain:Promise<unknown>=Promise.resolve();
 private currentUrl:string;
 private activeAbort:AbortController|null=null;
 readonly diagnostics={visibility_overridden:false,visibility_initial:'' as string};

 constructor(private readonly ctx:SessionContext,initialUrl:string){
  this.currentUrl=initialUrl;
  ctx.client.onClose(()=>{this.closedFlag=true;});
  ctx.client.on('Target.targetDestroyed',params=>{if(params?.targetId===ctx.targetId)this.closedFlag=true;});
 }

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
  if(!this.ctx.client.closed){
   await this.ctx.client.send('Target.closeTarget',{targetId:this.ctx.targetId},{timeout_ms:5000}).catch(()=>undefined);
  }
  this.ctx.onClosed?.();
 }

 private evalx<T>(expression:string,signal?:AbortSignal,timeout_ms?:number){return evaluateExpression<T>(this.ctx,expression,{signal,timeout_ms});}

 private async doAsk(turn:WebChatTurn,opts:{timeout_ms:number;signal?:AbortSignal}):Promise<WebChatReply>{
  if(this.closedFlag)throw new WebAgentError('web_browser_unavailable','会话已关闭');
  if(opts.signal?.aborted)throw new WebAgentError('web_cancelled');
  const started=Date.now();
  const deadline=started+opts.timeout_ms;
  const local=new AbortController();
  this.activeAbort=local;
  const onAbort=()=>local.abort();
  opts.signal?.addEventListener('abort',onAbort,{once:true});
  const signal=local.signal;
  const tempDirs:string[]=[];
  try{
   const reply=await this.runTurn(turn,deadline,signal,tempDirs,started);
   return reply;
  }catch(error){
   if(opts.signal?.aborted||(error instanceof WebAgentError&&error.reason_code==='web_cancelled')){
    await this.bestEffortStop();
    await this.close();
    throw error instanceof WebAgentError?error:new WebAgentError('web_cancelled');
   }
   if(error instanceof WebAgentError&&error.reason_code==='web_timeout')await this.bestEffortStop();
   throw error;
  }finally{
   opts.signal?.removeEventListener('abort',onAbort);
   if(this.activeAbort===local)this.activeAbort=null;
   for(const dir of tempDirs)await rm(dir,{recursive:true,force:true}).catch(()=>undefined);
  }
 }

 private async bestEffortStop(){
  if(this.ctx.client.closed)return;
  try{await evaluateExpression<boolean>(this.ctx,this.ctx.adapter.stop,{timeout_ms:5000});}catch{/* 页面已不可用时无需停止 */}
 }

 private remaining(deadline:number){
  const left=deadline-Date.now();
  if(left<=0)throw new WebAgentError('web_timeout');
  return left;
 }

 private async runTurn(turn:WebChatTurn,deadline:number,signal:AbortSignal,tempDirs:string[],started:number):Promise<WebChatReply>{
  const {adapter}=this.ctx;
  const files=turn.files??[];
  if(!turn.prompt.trim())throw new WebAgentError('web_ui_changed','提示词为空');
  if(files.length>adapter.max_files)throw new WebAgentError('web_upload_rejected',`文件数 ${files.length} 超过站点上限 ${adapter.max_files}`);
  const prepared=files.map((file,index)=>({name:safeFileName(file.name,index),bytes:toBytes(file.content)}));
  for(const file of prepared){
   if(file.bytes.byteLength===0)throw new WebAgentError('web_upload_rejected','文件为空');
   if(file.bytes.byteLength>adapter.max_file_bytes)throw new WebAgentError('web_upload_rejected','文件超过站点单文件大小上限');
  }
  const page=await waitForPageReady(this.ctx,{timeout_ms:Math.min(60_000,this.remaining(deadline)),signal});
  this.diagnostics.visibility_initial=this.diagnostics.visibility_initial||String(page.visibility??'');
  if(await ensureVisible(this.ctx,page))this.diagnostics.visibility_overridden=true;
  const before=await this.evalx<ChatStateInfo>(adapter.chatState,signal);
  const baseChips=(await this.evalx<AttachmentInfo[]>(adapter.attachments,signal)).length;
  if(prepared.length){
   const paths=await this.writeTempFiles(prepared,tempDirs);
   await this.uploadFiles(paths,signal);
   await this.waitAttachments(baseChips+prepared.length,baseChips,deadline,signal);
  }
  await this.insertPrompt(turn.prompt,deadline,signal);
  await this.sendMessage(before,deadline,signal);
  await this.waitReply(before,deadline,signal);
  return this.readReply(started,signal);
 }

 private async writeTempFiles(files:Array<{name:string;bytes:Uint8Array}>,tempDirs:string[]):Promise<string[]>{
  await mkdir(this.ctx.tmpRoot,{recursive:true,mode:0o700});
  await chmod(this.ctx.tmpRoot,0o700).catch(()=>undefined);
  const dir=await mkdtemp(join(this.ctx.tmpRoot,'up-'));
  tempDirs.push(dir);
  await chmod(dir,0o700).catch(()=>undefined);
  const paths:string[]=[];
  for(const [index,file] of files.entries()){
   const sub=join(dir,String(index));
   await mkdir(sub,{mode:0o700});
   const path=join(sub,file.name);
   await writeFile(path,file.bytes,{mode:0o600});
   paths.push(path);
  }
  return paths;
 }

 private async uploadFiles(paths:string[],signal:AbortSignal){
  const {adapter,client,sessionId}=this.ctx;
  const mode=adapter.upload;
  if(mode.mode==='input'){
   const found=await client.send<any>('Runtime.evaluate',{expression:`document.querySelector(${jsArg(mode.selector)})`,returnByValue:false},{sessionId,signal});
   const objectId=found.result?.objectId;
   if(!objectId)throw new WebAgentError('web_ui_changed','未找到文件上传控件');
   await client.send('DOM.setFileInputFiles',{files:paths,objectId},{sessionId,signal});
   return;
  }
  await client.send('Page.setInterceptFileChooserDialog',{enabled:true},{sessionId,signal});
  try{
   let remaining=paths;
   while(remaining.length){
    const opened=client.waitForEvent<{backendNodeId:number;mode:string}>('Page.fileChooserOpened',{sessionId,timeout_ms:20000,signal});
    opened.catch(()=>undefined);
    if(!await this.evalx<boolean>(mode.prepare,signal))throw new WebAgentError('web_ui_changed','未找到上传菜单入口');
    let point:{x:number;y:number}|null=null;
    for(let i=0;i<20&&!point;i++){
     point=await this.evalx<{x:number;y:number}|null>(mode.target,signal);
     if(!point)await sleep(250,signal);
    }
    if(!point)throw new WebAgentError('web_ui_changed','未找到“上传文件”菜单项');
    await this.mouseClick(point,signal);
    const event=await opened;
    const batch=event.mode==='selectSingle'?remaining.slice(0,1):remaining;
    await client.send('DOM.setFileInputFiles',{files:batch,backendNodeId:event.backendNodeId},{sessionId,signal});
    remaining=remaining.slice(batch.length);
    if(remaining.length)await sleep(800,signal);
   }
  }finally{
   await client.send('Page.setInterceptFileChooserDialog',{enabled:false},{sessionId}).catch(()=>undefined);
  }
 }

 private async mouseClick(point:{x:number;y:number},signal?:AbortSignal){
  const {client,sessionId}=this.ctx;
  const base={x:point.x,y:point.y,button:'left',buttons:1};
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y},{sessionId,signal});
  await client.send('Input.dispatchMouseEvent',{...base,type:'mousePressed',clickCount:1},{sessionId,signal});
  await client.send('Input.dispatchMouseEvent',{...base,type:'mouseReleased',buttons:0,clickCount:1},{sessionId,signal});
 }

 /** 等待新增附件全部就绪；失败态或站点上传错误提示 → web_upload_rejected。 */
 private async waitAttachments(expected:number,base:number,deadline:number,signal:AbortSignal){
  const begun=Date.now();
  for(;;){
   this.remaining(deadline);
   const list=await this.evalx<AttachmentInfo[]>(this.ctx.adapter.attachments,signal);
   if(list.some(item=>item.state==='failed'))throw new WebAgentError('web_upload_rejected','站点标记文件上传/解析失败');
   if(list.length>=expected&&list.every(item=>item.state==='ready'))return;
   const notice=await this.evalx<string>(this.ctx.adapter.notice,signal);
   const reason=classifyNotice(notice);
   if(reason)throw new WebAgentError(reason);
   if(UPLOAD_REJECT.test(notice))throw new WebAgentError('web_upload_rejected','站点提示文件不被接受');
   if(list.length<=base&&Date.now()-begun>30_000)throw new WebAgentError('web_upload_rejected','站点未接收上传文件');
   await sleep(this.ctx.poll_ms??400,signal);
  }
 }

 /**
  * 写入提示词：短文本用 `Input.insertText`（等同输入法提交）；超过 `INSERT_TEXT_MAX` 字符改用站点表达式一次性写值并派发 input 事件——
  * 实测 Chrome 的 `Input.insertText` 随长度超线性变慢（220KB 约 20 秒，有界面窗口更慢），而写值约 30ms。两条路径都核对非空白字符数。
  */
 private async insertPrompt(text:string,deadline:number,signal:AbortSignal){
  const {adapter,client,sessionId}=this.ctx;
  const want=text.replace(/\s+/g,'').length;
  if(!await this.evalx<boolean>(adapter.composerFocus,signal))throw new WebAgentError('web_ui_changed','未找到输入框');
  let length=-1;
  if(text.length<=INSERT_TEXT_MAX){
   await client.send('Input.insertText',{text},{sessionId,signal,timeout_ms:Math.min(60_000,this.remaining(deadline))});
   length=await this.evalx<number>(adapter.composerLength,signal);
  }
  if(length!==want){
   length=await this.evalx<number>(adapter.composerFallback(text),signal,60_000);
   if(length!==want)throw new WebAgentError('web_ui_changed','提示词未能完整写入输入框');
  }
 }

 private async sendMessage(before:ChatStateInfo,deadline:number,signal:AbortSignal){
  const {adapter,client,sessionId}=this.ctx;
  const readyDeadline=Math.min(deadline,Date.now()+60_000);
  while(!await this.evalx<boolean>(adapter.sendReady,signal)){
   if(Date.now()>readyDeadline)throw new WebAgentError('web_ui_changed','发送按钮未就绪');
   await sleep(300,signal);
  }
  if(!await this.evalx<boolean>(adapter.send,signal)){
   await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},{sessionId,signal});
   await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},{sessionId,signal});
  }
  const submitDeadline=Math.min(deadline,Date.now()+45_000);
  for(;;){
   const state=await this.evalx<ChatStateInfo>(adapter.chatState,signal);
   if(state.users>before.users||(state.last_user_key&&state.last_user_key!==before.last_user_key))return;
   const length=await this.evalx<number>(adapter.composerLength,signal);
   if(length===0&&state.generating)return;
   const notice=classifyNotice(await this.evalx<string>(adapter.notice,signal));
   if(notice)throw new WebAgentError(notice);
   if(Date.now()>submitDeadline)throw new WebAgentError('web_ui_changed','点击发送后消息未提交');
   await sleep(this.ctx.poll_ms??400,signal);
  }
 }

 /** 多信号等待：助手消息出现 → 不再生成 → 完成信号 → 回复签名在稳定窗口内不变。 */
 private async waitReply(before:ChatStateInfo,deadline:number,signal:AbortSignal){
  const {adapter}=this.ctx;
  const stable=this.ctx.stable_ms??2000;
  const poll=this.ctx.poll_ms??400;
  const begun=Date.now();
  let signature='',changedAt=Date.now(),polls=0;
  for(;;){
   this.remaining(deadline);
   const state=await this.evalx<ChatStateInfo>(adapter.chatState,signal);
   if(polls++%3===0){
    const reason=classifyNotice(await this.evalx<string>(adapter.notice,signal));
    if(reason){await this.bestEffortStop();throw new WebAgentError(reason);}
    if(state.visibility==='hidden'&&await ensureVisible(this.ctx,state))this.diagnostics.visibility_overridden=true;
   }
   const started=state.assistants>before.assistants||(!!state.last_assistant_key&&state.last_assistant_key!==before.last_assistant_key);
   if(!started){
    if(Date.now()-begun>180_000&&!state.generating)throw new WebAgentError('web_ui_changed','发送后未出现助手回复');
    await sleep(poll,signal);
    continue;
   }
   if(state.reply_sig!==signature){signature=state.reply_sig;changedAt=Date.now();}
   const quiet=Date.now()-changedAt;
   if(!state.generating&&state.reply_len>0&&quiet>=(state.complete?stable:stable*3))return;
   await sleep(poll,signal);
  }
 }

 private async readReply(started:number,signal:AbortSignal):Promise<WebChatReply>{
  const text=await this.evalx<string>(this.ctx.adapter.lastReply,signal,60_000);
  const reason=classifyShortReply(text);
  if(reason)throw new WebAgentError(reason);
  if(!text.trim())throw new WebAgentError('web_reply_incomplete','回复为空');
  const href=await this.evalx<string>('location.href',signal);
  this.currentUrl=href;
  return {text,conversation_url:href,elapsed_ms:Date.now()-started};
 }
}

export type {WebChatFile};
