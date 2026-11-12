/**
 * 职责：用 `Bun.serve` 提供本地假聊天页（`sites/fake.ts`），供测试与 `verify-web-agent.ts` 的 `provider:'fake'` 使用。
 * 公开入口：`startFakeChatServer()`；路径 `/`、`/c/*` 为聊天页，`/login` 为带密码框的登录页，`/captcha` 为验证码页。
 * 仅监听 127.0.0.1 随机端口，无持久化；调用方负责 `stop()`。
 */
import {fakeChatPageHtml} from './sites/fake';

export interface FakeChatServer{url:string;port:number;stop():void}

export function startFakeChatServer():FakeChatServer{
 const server=Bun.serve({
  port:0,
  hostname:'127.0.0.1',
  fetch(request){
   const path=new URL(request.url).pathname;
   const headers={'content-type':'text/html; charset=utf-8'};
   if(path==='/login')return new Response('<!doctype html><title>login</title><form><input type="password"><button>Log in</button></form>',{headers});
   if(path==='/captcha')return new Response('<!doctype html><title>verify</title><div id="captcha">Verify you are human</div>',{headers});
   return new Response(fakeChatPageHtml(),{headers});
  },
 });
 const port=Number(server.port);
 return {url:`http://127.0.0.1:${port}/`,port,stop:()=>server.stop(true)};
}
