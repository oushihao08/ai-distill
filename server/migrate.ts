/**
 * 职责：显式数据库迁移入口：在事务和互斥锁内按文件顺序应用未登记的 ai_distill 迁移。
 * 关键方法与用途：迁移主程序按文件名读取未登记 SQL，在 advisory lock 和事务中登记并应用。
 * 使用场景：通过 `bun run server/migrate.ts` 人工启动；不会由 API 请求自动触发。
 */
import { readdir } from 'node:fs/promises';
import { createPool } from './db';
import {classifyLogError,configureLogger,installFatalErrorLogging,logEvent} from './logging';
const logger=configureLogger({root:process.env.STORAGE_DIR??'.storage',service:'migration'});
installFatalErrorLogging();
let pool:ReturnType<typeof createPool>|undefined;
let client;
try {
  logEvent('service.started',{level:'info',component:'migration'});
  pool=createPool();
  logEvent('migration.started',{level:'info',component:'migration'});
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('ai-distill-migrations'))");
  await client.query('CREATE SCHEMA IF NOT EXISTS ai_distill');
  await client.query('CREATE TABLE IF NOT EXISTS ai_distill.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    const applied = await client.query('SELECT name FROM ai_distill.schema_migrations WHERE name=$1', [name]);
    if (applied.rowCount) continue;
    await client.query(await Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text());
    await client.query('INSERT INTO ai_distill.schema_migrations(name) VALUES($1)', [name]);
    logEvent('migration.applied',{level:'info',component:'migration',operation:name.slice(0,-4)});
    console.log(`已应用 ${name}`);
  }
  await client.query('COMMIT');
  logEvent('migration.completed',{level:'info',component:'migration',state:'succeeded'});
} catch(error) {
  logEvent('migration.failed',{level:'error',component:'migration',state:'failed',...classifyLogError(error)});
  if (client) { try { await client.query('ROLLBACK'); } catch (rollbackError) { logEvent('transaction.rollback_failed',{level:'error',component:'migration',transaction_name:'rollback:migration',...classifyLogError(rollbackError)});console.error('迁移连接已中断。'); } }
  console.error('数据库迁移失败，请核对网络、认证和迁移文件。未输出连接凭证。');
  process.exitCode = 1;
} finally {
  try { client?.release(); if(pool)await pool.end(); }
  catch(error) { logEvent('service.shutdown_failed',{level:'error',component:'migration',...classifyLogError(error)});process.exitCode=1; }
  finally { logEvent('service.stopped',{level:'info',component:'migration'});await logger.close(); }
}
