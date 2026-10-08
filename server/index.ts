import { createPool } from './db';
import { createApp } from './app';
const pool = createPool();
const app = createApp(pool, process.env.STORAGE_DIR ?? '.storage');
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3100), fetch: app.fetch, maxRequestBodySize: 101 * 1024 * 1024, idleTimeout: 60 });
console.log(`接口已启动：http://127.0.0.1:${server.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
 try { await server.stop(); await pool.end(); process.exit(0); }
 catch { console.error('接口关闭失败。'); process.exit(1); }
});
