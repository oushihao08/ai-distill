/**
 * 职责：从进程环境中选择 MinerU 精准解析 API Token；保留主备两份凭证，切换只影响新请求。
 * 入口：`mineruToken()` 供 API、CLI 和入队校验共用；凭证不写入任务快照或日志。
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {storageDirectory} from '../../paths';

export function mineruToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
 const active = env.MINERU_ACTIVE_TOKEN?.trim() || 'primary';
 if (active !== 'primary' && active !== 'backup') throw new Error('MINERU_ACTIVE_TOKEN 仅支持 primary 或 backup');
 if (active === 'primary') return env.MINERU_KEY?.trim() || undefined;
 const token = env.MINERU_BACKUP_TOKEN?.trim();
 if (token) return token;
 try { return readFileSync(resolve(storageDirectory(env),'secrets','mineru-backup.token'),'utf8').trim() || undefined; }
 catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
  throw error;
 }
}
