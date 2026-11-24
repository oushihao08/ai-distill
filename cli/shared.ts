/**
 * 文件职责：CLI 共用基础工具（UUID 校验、SHA-256 计算、独占/原子 JSON 文件写入与文件锁、项目工作流分页拉取、可中断休眠、有界并发映射及远程参数解析）。
 * 关键入口：`assertUuid()`、`sha256Hex()`、`writeExclusiveJson()`、`atomicWriteJson()`、`withExclusiveFileLock()`、`readJsonObjectFile()`、`fetchAllProjectWorkflowItems()`、`abortableSleep()`、`mapWithConcurrency()`、`parseStrictFlagPairs()`、`createRemoteApiClient()`。
 * 边界：纯客户端基础设施，不直连数据库、不修改业务判据、不对写请求做自动重试。
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { ApiClient, CliError, type Fetcher } from './client';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function assertUuid(value: unknown, label: string): string {
  if (!isUuid(value)) throw new CliError(`${label} 须为 UUID`);
  return value;
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function ensurePlainObject<T extends Record<string, any> = Record<string, any>>(value: unknown, label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`${label} 响应结构无效`, { kind: 'invalid_response' });
  }
  return value as T;
}

/** 读取本地 JSON 对象文件；区分读取失败与非法 JSON/非对象形状。 */
export async function readJsonObjectFile<T extends Record<string, any> = Record<string, any>>(path: string, label: string): Promise<T> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    throw new CliError(`${label}文件无法读取`, { kind: 'file_error' });
  }
  try {
    return ensurePlainObject<T>(JSON.parse(source), label);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${label}文件不是有效JSON`, { kind: 'file_error' });
  }
}

/** 独占创建 0600 JSON 文件；目标已存在或父目录缺失时抛出自定义 file_error。 */
export async function writeExclusiveJson(path: string, value: unknown, errorMessage: string, trailingNewline = true): Promise<void> {
  const payload = JSON.stringify(value, null, 2) + (trailingNewline ? '\n' : '');
  try {
    await writeFile(path, payload, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new CliError(errorMessage, { kind: 'file_error' });
  }
}

/** 通过同目录临时文件原子替换目标 JSON，并在异常时确保清理临时文件。 */
export async function atomicWriteJson(path: string, value: unknown, trailingNewline = true): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(value, null, 2) + (trailingNewline ? '\n' : '');
  try {
    await writeFile(temporary, payload, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 短时独占 `.lock` 文件保护本地状态清单；失败不抢删他进程锁，也不自动重试。 */
export async function withExclusiveFileLock<T>(
  lockPath: string,
  run: () => Promise<T>,
  options: { busyMessage?: string; cleanupErrorMessage?: string } = {},
): Promise<T> {
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new CliError(options.busyMessage ?? '无法获取本地清单文件锁；请确认无并发进程正在写入', { kind: 'file_error' });
  }
  try {
    return await run();
  } finally {
    await lock.close();
    try {
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CliError(options.cleanupErrorMessage ?? '临时锁文件清理失败', { kind: 'file_error' });
      }
    }
  }
}

export interface WorkflowIdentityItem {
  id: string;
  workflow_kind?: string;
  source_workflow_id?: string | null;
}

/** 分页拉取项目工作流轻量身份清单，避免读取整期完整项目详情。 */
export async function fetchAllProjectWorkflowItems(
  get: (path: string) => Promise<any>,
  projectId: string,
  options: { kind?: 'all' | 'question' | 'material_package'; pageSize?: number; label?: string } = {},
): Promise<WorkflowIdentityItem[]> {
  const pageSize = options.pageSize ?? 500;
  const kindQuery = options.kind && options.kind !== 'all' ? `kind=${options.kind}&` : '';
  const label = options.label ?? '工作流分页';
  const items: WorkflowIdentityItem[] = [];
  for (let page = 1; ; page++) {
    const data = await get(`/api/projects/${projectId}/workflow-ids?${kindQuery}page=${page}&page_size=${pageSize}`);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') {
      throw new CliError(`${label}响应无效`, { kind: 'invalid_response' });
    }
    for (const raw of data.items) {
      items.push({ ...raw, id: assertUuid(raw?.id, 'workflow') });
    }
    if (!data.has_more) break;
  }
  return items;
}

/** 支持 AbortSignal 立即唤醒的有界等待，不泄露定时器或监听器。 */
export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

/** 按有界并发映射只读任务并严格保持原输入顺序；任一任务抛错或收到中断后停止领取剩余项。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let firstError: unknown;
  const worker = async () => {
    while (firstError === undefined) {
      if (signal?.aborted) {
        firstError = new CliError('等待已中断，后台任务继续执行', { kind: 'interrupted' });
        return;
      }
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        if (firstError === undefined) firstError = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  if (firstError !== undefined) throw firstError;
  return results;
}

/** 解析严格 `--key value` 参数对（用于 remote 子命令，拒绝缺值、重复或未知位置词）。 */
export function parseStrictFlagPairs(args: readonly string[], invalidMessage: string): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || flags.has(key.slice(2))) {
      throw new CliError(invalidMessage);
    }
    flags.set(key.slice(2), value);
  }
  return flags;
}

/** 从环境变量构造受本地回环保护的远程隧道客户端。 */
export function createRemoteApiClient(fetcher: Fetcher = fetch): ApiClient {
  const base = process.env.REMOTE_MATERIAL_API_URL;
  const token = process.env.REMOTE_MATERIAL_TOKEN;
  if (!base || !token) {
    throw new CliError('须在本机 .env 配置 REMOTE_MATERIAL_API_URL 和 REMOTE_MATERIAL_TOKEN');
  }
  return new ApiClient(base, fetcher, token);
}
