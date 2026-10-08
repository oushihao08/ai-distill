import { Pool } from 'pg';
export function createPool(env = process.env) {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error('缺少 DATABASE_URL，请配置本地 .env');
  const url = new URL(raw);
  // Explicit TLS verification; avoid sslmode=require replacing the verified SSL options.
  const requireBinding = url.searchParams.get('channel_binding') === 'require';
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'channel_binding']) url.searchParams.delete(key);
  const pool = new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, enableChannelBinding: requireBinding, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
  pool.on('error', () => console.error('数据库连接异常，请检查连接配置或网络；连接信息未输出。'));
  return pool;
}
