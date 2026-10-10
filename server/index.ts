/**
 * 职责：本地 API 进程入口：创建 Hono 应用并监听回环地址，负责退出时关闭服务与连接池。
 * 关键方法与用途：启动入口创建连接池和 Hono 应用、绑定回环地址，并在进程退出时关闭连接。
 * 使用场景：通过 `bun run server/index.ts` 启动本地 API；业务路由由 `createApp()` 提供。
 */
import { createPool } from './db';
import { createApp } from './app';
import {configureLogger,installFatalErrorLogging,logEvent,classifyLogError} from './logging';
const logger=configureLogger({root:process.env.STORAGE_DIR??'.storage',service:'api'});
installFatalErrorLogging();
let pool:ReturnType<typeof createPool>|undefined;
let server:ReturnType<typeof Bun.serve>;
try{
 pool=createPool();
 const app = createApp(pool, process.env.STORAGE_DIR ?? '.storage');
 server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3100), fetch: app.fetch, maxRequestBodySize: 101 * 1024 * 1024, idleTimeout: 60 });
}catch(error){logEvent('service.start_failed',{level:'error',component:'http',...classifyLogError(error)});try{if(pool)await pool.end();}finally{await logger.close();}throw error;}
console.log(`接口已启动：http://127.0.0.1:${server.port}`);
logEvent('service.started',{level:'info',component:'http',pid:process.pid});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
 logEvent('service.shutdown_requested',{level:'info',signal});
 try { await server.stop(); await pool?.end(); logEvent('service.stopped',{level:'info'});await logger.close();process.exit(0); }
 catch(error) { console.error('接口关闭失败。');logEvent('service.shutdown_failed',{level:'error',...classifyLogError(error)});await logger.close();process.exit(1); }
});
