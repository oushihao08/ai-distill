/**
 * 职责：API 进程入口：创建 Hono 应用、按配置监听地址，并在容器部署时提供同源前端静态文件。
 * 关键方法与用途：启动入口绑定 API、可选静态文件路由，并在进程退出时关闭服务与连接池。
 * 使用场景：通过 `bun run server/index.ts` 启动本地 API；容器可设置 `SERVE_WEB=1` 提供工作台。
 */
import {localQueueEnabled,assertLocalQueueEnvironment} from './execution-queue/runtime';
import {join,resolve,sep} from 'node:path';
import {storageDirectory} from './paths';
import { createPool } from './db';
import { createApp } from './app';
import {configureLogger,installFatalErrorLogging,logEvent,classifyLogError} from './logging';
// 服务入口默认每机独立；仅显式 legacy 用于受控兼容。
process.env.EXECUTION_QUEUE_MODE ??= 'local';
const logger=configureLogger({root:storageDirectory(),service:'api'});
installFatalErrorLogging();
let pool:ReturnType<typeof createPool>|undefined;
let server:ReturnType<typeof Bun.serve>;
try{
 pool=createPool();
 if(localQueueEnabled())await assertLocalQueueEnvironment(pool,storageDirectory());
 const app = createApp(pool, storageDirectory());
 const serveWeb=process.env.SERVE_WEB==='1';
 const webRoot=resolve(import.meta.dir,'../web/dist');
 const indexFile=Bun.file(join(webRoot,'index.html'));
 if(serveWeb&&!await indexFile.exists())throw new Error('SERVE_WEB=1 但 web/dist/index.html 不存在');
 server = Bun.serve({ hostname: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3700), fetch: async request => {
  const url=new URL(request.url);
  if(url.pathname==='/api'||url.pathname.startsWith('/api/'))return app.fetch(request);
  if(serveWeb&&(request.method==='GET'||request.method==='HEAD')){
   let pathname:string;
   try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('Not Found',{status:404});}
   const filePath=resolve(webRoot,`.${pathname}`);
   if(filePath===webRoot||filePath.startsWith(`${webRoot}${sep}`)){
    const file=Bun.file(filePath);
    if(await file.exists())return new Response(file);
   }
   return new Response(indexFile);
  }
  return app.fetch(request);
 }, maxRequestBodySize: 101 * 1024 * 1024, idleTimeout: 60 });
}catch(error){logEvent('service.start_failed',{level:'error',component:'http',...classifyLogError(error)});try{if(pool)await pool.end();}finally{await logger.close();}throw error;}
console.log(`接口已启动：http://${process.env.HOST??'127.0.0.1'}:${server.port}`);
logEvent('service.started',{level:'info',component:'http',pid:process.pid});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
 logEvent('service.shutdown_requested',{level:'info',signal});
 try { await server.stop(); await pool?.end(); logEvent('service.stopped',{level:'info'});await logger.close();process.exit(0); }
 catch(error) { console.error('接口关闭失败。');logEvent('service.shutdown_failed',{level:'error',...classifyLogError(error)});await logger.close();process.exit(1); }
});
