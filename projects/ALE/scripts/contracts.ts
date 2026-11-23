/**
 * 职责：定义《ALE 数据交付技术规范》第 1–7 节的核心数据结构、领域配额常量、轨迹 Token/轮次精确复算算法、线性插值分位数统计及文件安全原语。
 * 主要公开入口：`ALE_DOMAIN_QUOTAS`、`recomputeTrajectoryMetrics()`、`summarizeDistribution()`、`isGitLfsPointer()`、`sha256Hex()`。
 * 调用方：由同目录 `verify-task.ts`、`batch-package.ts` 与 `delivery.ts` 共同引用；无数据库或网络副作用。
 */
import { createHash } from 'node:crypto';

export const ALE_DOMAIN_QUOTAS: Record<string, number> = {
  computing_math: 200,
  life_science: 200,
  health_medicine: 200,
  business_finance: 200,
  engineering: 200,
  visual_media: 200,
  physical_science: 100,
};

export const ALE_OTHER_DOMAIN_MAX_QUOTA = 50;

export const ALE_CALIBRATION_MODELS = new Set(['GPT-6.1-Sol', 'Opus-5.5', 'gpt-6.1-sol', 'opus-5.5']);
export const ALE_CLEAN_SUCCESS_MODELS = new Set(['opus-5', 'gpt-5.6-sol', 'Opus-5', 'GPT-5.6-Sol']);

export const ALE_FORBIDDEN_FILENAMES = new Set([
  '.git',
  '.DS_Store',
  '__MACOSX',
  '__pycache__',
  'node_modules',
  '.venv',
]);

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';

/** 规范第 6 节：质检记录最小字段 */
export interface AleCheckRecord {
  check_id: string;
  task_id: string;
  version_or_hash: string;
  scope: string;
  execution_mode: 'static' | 'dynamic_env' | 'trajectory_audit';
  expected: string;
  observed: string;
  status: CheckStatus;
  evidence_path: string;
}

export interface RecomputedTrajectoryMetrics {
  model_turns: number;
  tool_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  has_any_usage: boolean;
  mentioned_canary: boolean;
  suspicious_commands: string[];
}

export interface DistributionSummary {
  count: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

export function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function isSafeRelativePath(relPath: string, maxBytes = 200): boolean {
  if (!relPath || Buffer.byteLength(relPath, 'utf8') > maxBytes) return false;
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath) || /[\\\x00-\x1f\x7f]/.test(relPath)) return false;
  return !relPath.split('/').some((seg) => !seg || seg === '.' || seg === '..');
}

/** 规范第 1 节：不接受 Git LFS 指针文件 */
export function isGitLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.byteLength > 1024) return false;
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 256))).toString('utf8');
  return head.startsWith('version https://git-lfs.github.com/spec/v1') && head.includes('oid sha256:');
}

/** 规范第 1 节：检测明显的空占位或过期外链标记 */
export function detectPlaceholderIssue(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return '文件内容为空';
  if (/^(?:TODO|TBD|PLACEHOLDER|COMING_SOON)\b/i.test(trimmed) && trimmed.length < 120) {
    return '文件仅为未完成占位符';
  }
  if (/https?:\/\/[^\s"'<>]+(?:expired|placeholder\.invalid|example\.com\/download)/i.test(trimmed)) {
    return '包含占位或已失效下载链接';
  }
  return null;
}

/**
 * 规范第 5 节：从原始 trajectory.jsonl 逐事件精确复算轮次、工具调用数与原始 usage。
 * - 一次模型响应计 1 轮（role === 'assistant' | 'model' 或 type === 'model_response'）；
 * - 工具返回（role === 'tool' | 'tool_result'）不计轮；
 * - 同一轮模型响应内的多个并行 tool_calls 不额外加轮，tool_calls 另计总数；
 * - usage 缺失时返回 null，绝不填 0。
 */
export function recomputeTrajectoryMetrics(jsonlText: string, canary?: string): RecomputedTrajectoryMetrics {
  const lines = jsonlText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('trajectory.jsonl 为空');

  let modelTurns = 0;
  let toolCalls = 0;
  let inputSum = 0;
  let outputSum = 0;
  let totalSum = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawTotal = false;
  let mentionedCanary = false;
  const suspicious: string[] = [];

  const forbiddenPatterns = [
    /\bgit\s+(?:log|reflog|show)\b/i,
    /\/tests\/(?:grade\.py|rubric\.json|reference)\b/i,
    /\/solution\/(?:solve\.sh|artifacts)\b/i,
  ];

  for (const [idx, raw] of lines.entries()) {
    let event: Record<string, any>;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new Error(`trajectory.jsonl 第 ${idx + 1} 行不是合法 JSON`);
    }
    const serialized = raw;
    if (canary && canary.length >= 8 && serialized.includes(canary)) {
      mentionedCanary = true;
    }

    const role = event.role ?? event.message?.role ?? event.type;
    const isModelResponse =
      role === 'assistant' ||
      role === 'model' ||
      event.type === 'model_response' ||
      event.type === 'response.completed';

    if (isModelResponse) {
      modelTurns += 1;
      const calls =
        event.tool_calls ??
        event.message?.tool_calls ??
        (Array.isArray(event.content) ? event.content.filter((c: any) => c?.type === 'tool_use' || c?.type === 'function_call') : []);
      if (Array.isArray(calls)) {
        toolCalls += calls.length;
        for (const call of calls) {
          const argText = typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.input ?? call?.arguments ?? '');
          for (const pat of forbiddenPatterns) {
            if (pat.test(argText)) suspicious.push(`turn_${modelTurns}:${pat.source}`);
          }
        }
      }
      const usage = event.usage ?? event.message?.usage ?? event.response?.usage;
      if (usage && typeof usage === 'object') {
        if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
          inputSum += usage.input_tokens;
          sawInput = true;
        }
        if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
          outputSum += usage.output_tokens;
          sawOutput = true;
        }
        if (typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)) {
          totalSum += usage.total_tokens;
          sawTotal = true;
        } else if (
          typeof usage.input_tokens === 'number' &&
          typeof usage.output_tokens === 'number'
        ) {
          totalSum += usage.input_tokens + usage.output_tokens;
          sawTotal = true;
        }
      }
    }
  }

  return {
    model_turns: modelTurns,
    tool_calls: toolCalls,
    input_tokens: sawInput ? inputSum : null,
    output_tokens: sawOutput ? outputSum : null,
    total_tokens: sawTotal ? totalSum : null,
    has_any_usage: sawInput || sawOutput || sawTotal,
    mentioned_canary: mentionedCanary,
    suspicious_commands: suspicious,
  };
}

/** 线性插值分位数（与 NumPy percentile method='linear' 一致，用于第 5/7 节显式声明算法） */
export function linearQuantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const weight = pos - lower;
  const result = sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
  return Number(result.toFixed(4));
}

export function summarizeDistribution(values: number[]): DistributionSummary {
  if (!values.length) {
    return { count: 0, mean: null, p50: null, p90: null, max: null };
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    count: values.length,
    mean: Number((sum / values.length).toFixed(4)),
    p50: linearQuantile(values, 0.5),
    p90: linearQuantile(values, 0.9),
    max: Math.max(...values),
  };
}
