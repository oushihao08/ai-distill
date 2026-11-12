/**
 * 测试对象：`cdp.ts` 的最小 CDP 客户端。验证边界：用本地假 WebSocket 服务器覆盖请求/响应关联、事件分发、协议错误、超时、取消与断线；不启动浏览器。
 */
import {afterEach,describe,expect,test} from 'bun:test';
import {CdpClient,CdpProtocolError} from './cdp';
import {WebAgentError} from './types';

interface FakeServer{url:string;stop():void;sockets:Set<any>;received:any[]}
let servers:FakeServer[]=[];
let clients:CdpClient[]=[];

function startFake(handler:(message:any,ws:any)=>void):FakeServer{
 const sockets=new Set<any>(),received:any[]=[];
 const server=Bun.serve({
  port:0,hostname:'127.0.0.1',
  fetch(request,srv){return srv.upgrade(request)?undefined:new Response('no',{status:400});},
  websocket:{
   open(ws){sockets.add(ws);},
   close(ws){sockets.delete(ws);},
   message(ws,raw){const message=JSON.parse(String(raw));received.push(message);handler(message,ws);},
  },
 });
 const fake={url:`ws://127.0.0.1:${server.port}`,stop:()=>server.stop(true),sockets,received};
 servers.push(fake);
 return fake;
}
async function connect(url:string){const client=await CdpClient.connect(url);clients.push(client);return client;}
const reasonOf=(promise:Promise<unknown>)=>promise.then(()=>'ok',(error:unknown)=>error instanceof WebAgentError?error.reason_code:error instanceof CdpProtocolError?'protocol':'other');

afterEach(()=>{for(const client of clients)client.close();for(const server of servers)server.stop();clients=[];servers=[];});

describe('CdpClient',()=>{
 test('乱序响应按 id 关联，并携带 sessionId',async()=>{
  const fake=startFake((message,ws)=>{
   const delay=message.method==='slow'?60:0;
   setTimeout(()=>ws.send(JSON.stringify({id:message.id,result:{echo:message.method,session:message.sessionId??null}})),delay);
  });
  const client=await connect(fake.url);
  const [a,b]=await Promise.all([client.send('slow'),client.send('fast',{},{sessionId:'S1'})]);
  expect(a).toEqual({echo:'slow',session:null});
  expect(b).toEqual({echo:'fast',session:'S1'});
  expect(fake.received.map(item=>item.id)).toEqual([1,2]);
 });

 test('事件按方法与 sessionId 过滤，取消订阅后不再收到',async()=>{
  const fake=startFake((message,ws)=>{
   ws.send(JSON.stringify({method:'Page.loadEventFired',params:{n:1},sessionId:'A'}));
   ws.send(JSON.stringify({method:'Page.loadEventFired',params:{n:2},sessionId:'B'}));
   ws.send(JSON.stringify({id:message.id,result:{}}));
  });
  const client=await connect(fake.url);
  const all:number[]=[],onlyB:number[]=[];
  const offAll=client.on('Page.loadEventFired',params=>all.push(params.n));
  client.on('Page.loadEventFired',params=>onlyB.push(params.n),'B');
  await client.send('x');
  expect(all).toEqual([1,2]);
  expect(onlyB).toEqual([2]);
  offAll();
  await client.send('y');
  expect(all).toEqual([1,2]);
  expect(onlyB).toEqual([2,2]);
 });

 test('协议错误转为 CdpProtocolError，不泄露额外负载',async()=>{
  const fake=startFake((message,ws)=>ws.send(JSON.stringify({id:message.id,error:{code:-32601,message:'method not found'}})));
  const client=await connect(fake.url);
  const error=await client.send('Nope').catch(e=>e);
  expect(error).toBeInstanceOf(CdpProtocolError);
  expect((error as CdpProtocolError).code).toBe(-32601);
 });

 test('超时为 web_timeout，迟到响应被忽略且后续请求正常',async()=>{
  const fake=startFake((message,ws)=>{
   if(message.method==='hang')setTimeout(()=>ws.send(JSON.stringify({id:message.id,result:{late:true}})),150);
   else ws.send(JSON.stringify({id:message.id,result:{ok:true}}));
  });
  const client=await connect(fake.url);
  expect(await reasonOf(client.send('hang',{},{timeout_ms:50}))).toBe('web_timeout');
  await Bun.sleep(200);
  expect(await client.send<{ok:boolean}>('after')).toEqual({ok:true});
 });

 test('取消：执行中取消与预先取消均为 web_cancelled',async()=>{
  const fake=startFake(()=>{/* 不响应 */});
  const client=await connect(fake.url);
  const controller=new AbortController();
  const pending=reasonOf(client.send('wait',{},{signal:controller.signal,timeout_ms:5000}));
  setTimeout(()=>controller.abort(),30);
  expect(await pending).toBe('web_cancelled');
  expect(await reasonOf(client.send('again',{},{signal:controller.signal}))).toBe('web_cancelled');
  expect(fake.received.length).toBe(1);
 });

 test('断线：挂起请求以 web_browser_unavailable 失败，之后的发送同样失败并触发 onClose',async()=>{
  const fake=startFake((message,ws)=>{if(message.method==='die')ws.close();});
  const client=await connect(fake.url);
  let closed=0;
  client.onClose(()=>closed++);
  const pending=reasonOf(client.send('die',{},{timeout_ms:5000}));
  expect(await pending).toBe('web_browser_unavailable');
  expect(client.closed).toBe(true);
  expect(closed).toBe(1);
  expect(await reasonOf(client.send('late'))).toBe('web_browser_unavailable');
 });

 test('连接失败为 web_browser_unavailable',async()=>{
  const fake=startFake(()=>{});
  const url=fake.url;
  fake.stop();
  const result=await CdpClient.connect(url,{timeout_ms:1500}).then(()=>'ok',(error:unknown)=>error instanceof WebAgentError?error.reason_code:'other');
  expect(result).toBe('web_browser_unavailable');
 });

 test('waitForEvent：谓词匹配、超时与断线',async()=>{
  const fake=startFake((message,ws)=>{
   if(message.method==='emit'){
    ws.send(JSON.stringify({method:'Ev',params:{v:1},sessionId:'S'}));
    ws.send(JSON.stringify({method:'Ev',params:{v:2},sessionId:'S'}));
    ws.send(JSON.stringify({id:message.id,result:{}}));
   }
   if(message.method==='die')ws.close();
  });
  const client=await connect(fake.url);
  const waiting=client.waitForEvent<{v:number}>('Ev',{sessionId:'S',predicate:p=>p.v===2,timeout_ms:1000});
  await client.send('emit');
  expect((await waiting).v).toBe(2);
  expect(await reasonOf(client.waitForEvent('Never',{timeout_ms:40}))).toBe('web_timeout');
  const dying=reasonOf(client.waitForEvent('Never',{timeout_ms:2000}));
  client.send('die').catch(()=>undefined);
  expect(await dying).toBe('web_browser_unavailable');
 });
});
