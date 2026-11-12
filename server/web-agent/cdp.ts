/**
 * 职责：零依赖的最小 Chrome DevTools Protocol 客户端（Bun 自带 WebSocket），负责请求/响应关联、事件分发、断线、超时与取消。
 * 公开入口：`CdpClient.connect()`、`send()`、`on()`、`waitForEvent()`、`close()`、`CdpProtocolError`。
 * 调用方：`browser.ts`（浏览器级连接）与 `session.ts`（经 `Target.attachToTarget{flatten:true}` 的 sessionId 多路复用）；测试用假 WebSocket 服务器覆盖。
 * 断线时所有挂起请求以 `web_browser_unavailable` 失败；超时为 `web_timeout`；取消为 `web_cancelled`。错误信息不含协议负载。
 */
import {WebAgentError} from './types';

export class CdpProtocolError extends Error{
 readonly code:number;
 constructor(readonly method:string,code:number,message:string){
  super(`CDP ${method} 失败(${code})：${message.slice(0,200)}`);
  this.name='CdpProtocolError';
  this.code=code;
 }
}

export interface CdpSendOptions{sessionId?:string;timeout_ms?:number;signal?:AbortSignal}
export interface CdpEvent{method:string;params:any;sessionId?:string}
type Pending={resolve:(value:any)=>void;reject:(error:unknown)=>void;method:string;cleanup:()=>void};

export class CdpClient{
 private nextId=1;
 private readonly pending=new Map<number,Pending>();
 private readonly listeners=new Set<(event:CdpEvent)=>void>();
 private closedFlag=false;
 private readonly closeHandlers=new Set<()=>void>();

 private constructor(private readonly socket:WebSocket){
  socket.addEventListener('message',event=>this.onMessage(event.data));
  socket.addEventListener('close',()=>this.onClosed());
  socket.addEventListener('error',()=>this.onClosed());
 }

 /** 连接 `ws://` 地址；超时或失败统一为 `web_browser_unavailable`。 */
 static connect(url:string,options:{timeout_ms?:number}={}):Promise<CdpClient>{
  return new Promise((resolve,reject)=>{
   let socket:WebSocket;
   try{socket=new WebSocket(url);}catch{reject(new WebAgentError('web_browser_unavailable','无法建立调试连接'));return;}
   const timer=setTimeout(()=>{try{socket.close();}catch{/* 连接尚未建立，关闭失败无需处理 */}reject(new WebAgentError('web_browser_unavailable','调试连接超时'));},options.timeout_ms??10000);
   socket.addEventListener('open',()=>{clearTimeout(timer);resolve(new CdpClient(socket));},{once:true});
   socket.addEventListener('error',()=>{clearTimeout(timer);reject(new WebAgentError('web_browser_unavailable','调试连接失败'));},{once:true});
   socket.addEventListener('close',()=>{clearTimeout(timer);reject(new WebAgentError('web_browser_unavailable','调试连接关闭'));},{once:true});
  });
 }

 get closed(){return this.closedFlag;}

 onClose(handler:()=>void):()=>void{
  if(this.closedFlag){queueMicrotask(handler);return()=>{};}
  this.closeHandlers.add(handler);
  return()=>this.closeHandlers.delete(handler);
 }

 send<T=any>(method:string,params:Record<string,unknown>={},options:CdpSendOptions={}):Promise<T>{
  if(this.closedFlag)return Promise.reject(new WebAgentError('web_browser_unavailable','调试连接已关闭'));
  if(options.signal?.aborted)return Promise.reject(new WebAgentError('web_cancelled'));
  const id=this.nextId++;
  return new Promise<T>((resolve,reject)=>{
   const timeout=options.timeout_ms??30000;
   const timer=setTimeout(()=>finish(()=>reject(new WebAgentError('web_timeout',`${method} 无响应`))),timeout);
   const onAbort=()=>finish(()=>reject(new WebAgentError('web_cancelled')));
   options.signal?.addEventListener('abort',onAbort,{once:true});
   const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);};
   const finish=(action:()=>void)=>{if(!this.pending.delete(id))return;cleanup();action();};
   this.pending.set(id,{resolve:value=>finish(()=>resolve(value)),reject:error=>finish(()=>reject(error)),method,cleanup});
   try{
    this.socket.send(JSON.stringify({id,method,params,...(options.sessionId?{sessionId:options.sessionId}:{})}));
   }catch{
    finish(()=>reject(new WebAgentError('web_browser_unavailable','调试连接写入失败')));
   }
  });
 }

 /** 订阅事件；`sessionId` 缺省时接收所有会话事件。返回取消订阅函数。 */
 on(method:string,handler:(params:any,event:CdpEvent)=>void,sessionId?:string):()=>void{
  const listener=(event:CdpEvent)=>{
   if(event.method!==method)return;
   if(sessionId!==undefined&&event.sessionId!==sessionId)return;
   handler(event.params,event);
  };
  this.listeners.add(listener);
  return()=>this.listeners.delete(listener);
 }

 waitForEvent<T=any>(method:string,options:{sessionId?:string;predicate?:(params:any)=>boolean;timeout_ms?:number;signal?:AbortSignal}={}):Promise<T>{
  if(this.closedFlag)return Promise.reject(new WebAgentError('web_browser_unavailable','调试连接已关闭'));
  if(options.signal?.aborted)return Promise.reject(new WebAgentError('web_cancelled'));
  return new Promise<T>((resolve,reject)=>{
   const done=(action:()=>void)=>{clearTimeout(timer);off();offClose();options.signal?.removeEventListener('abort',onAbort);action();};
   const off=this.on(method,params=>{if(!options.predicate||options.predicate(params))done(()=>resolve(params));},options.sessionId);
   const offClose=this.onClose(()=>done(()=>reject(new WebAgentError('web_browser_unavailable','调试连接已关闭'))));
   const timer=setTimeout(()=>done(()=>reject(new WebAgentError('web_timeout',`等待 ${method} 超时`))),options.timeout_ms??30000);
   const onAbort=()=>done(()=>reject(new WebAgentError('web_cancelled')));
   options.signal?.addEventListener('abort',onAbort,{once:true});
  });
 }

 close():void{
  if(this.closedFlag)return;
  try{this.socket.close();}catch{/* 已关闭 */}
  this.onClosed();
 }

 private onMessage(data:unknown){
  let message:any;
  try{message=JSON.parse(typeof data==='string'?data:new TextDecoder().decode(data as ArrayBuffer));}catch{return;}
  if(typeof message?.id==='number'){
   const entry=this.pending.get(message.id);
   if(!entry)return;
   if(message.error)entry.reject(new CdpProtocolError(entry.method,Number(message.error.code)||0,String(message.error.message??'')));
   else entry.resolve(message.result??{});
   return;
  }
  if(typeof message?.method==='string'){
   const event:CdpEvent={method:message.method,params:message.params??{},sessionId:message.sessionId};
   for(const listener of [...this.listeners]){
    try{listener(event);}catch{/* 单个监听器异常不影响其他监听器与读循环 */}
   }
  }
 }

 private onClosed(){
  if(this.closedFlag)return;
  this.closedFlag=true;
  const error=new WebAgentError('web_browser_unavailable','调试连接已断开');
  for(const entry of [...this.pending.values()])entry.reject(error);
  this.pending.clear();
  for(const handler of [...this.closeHandlers])handler();
  this.closeHandlers.clear();
  this.listeners.clear();
 }
}
