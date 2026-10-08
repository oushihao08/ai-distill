import { readdir } from 'node:fs/promises';
import { createPool } from './db';
const pool = createPool();
let client;
try {
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
    console.log(`已应用 ${name}`);
  }
  await client.query('COMMIT');
} catch {
  if (client) { try { await client.query('ROLLBACK'); } catch { console.error('迁移连接已中断。'); } }
  console.error('数据库迁移失败，请核对网络、认证和迁移文件。未输出连接凭证。');
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
