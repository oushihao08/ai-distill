// 批次清单契约。CLI 和工作台提交同一 JSON，启动前检查每个任务的身份与来源边。
import { HTTPException } from 'hono/http-exception';
import { validateFeishuTarget } from '../publishing/feishu-targets';
export const stages = ['redact', 'prepare', 'author', 'deliver'] as const;
export type Stage = (typeof stages)[number];
export type Channel = 'agent' | 'delivery';
export type Task = {
  id: string;
  type: Stage;
  weight: number;
  expected_minutes: number;
  owner?: string;
  input: {
    project_id: string;
    package_id?: string;
    revision_id?: string;
    extraction_job_id?: string;
    redaction_id?: string;
    redaction_from?: string;
    material_from?: string;
    author_from?: string;
    workflow_id?: string;
    author_attempt_id?: string;
    load_package_id?: string;
    select_source?: boolean;
    target_level?: string;
    link_id?: string;
    link_version?: number;
    title?: string;
    direction?: string;
    original_workflow_id?: string;
    previous_job_id?: string;
    force?: boolean;
    provider?: string;
    model?: string;
    reasoning_effort?: string;
    mode?: 'draft' | 'archived';
    base_token?: string;
    table_id?: string;
    record_id?: string;
    attachment_format?: 'docx' | 'pdf';
  };
};
export type Manifest = {
  version: 1;
  id: string;
  limits: { agent?: number; waiting?: number; delivery: number };
  tasks: Task[];
};
export function invalid(message: string): never {
  throw new HTTPException(400, { message });
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(v: unknown, keys: string[], label: string): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(label + ' 应为对象');
  for (const k of Object.keys(v)) if (!keys.includes(k)) invalid(label + ' 包含未知字段 ' + k);
  return v as Record<string, any>;
}
function bounded(v: unknown, max: number, label: string, integer = false) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max || (integer && !Number.isInteger(v)))
    invalid(label + ' 数值无效');
  return v;
}
const fields: Record<Stage, string[]> = {
  redact: ['package_id', 'revision_id', 'extraction_job_id', 'previous_job_id', 'model', 'reasoning_effort'],
  prepare: [
    'package_id',
    'revision_id',
    'extraction_job_id',
    'redaction_id',
    'redaction_from',
    'force',
    'model',
    'reasoning_effort'
  ],
  author: [
    'load_package_id',
    'select_source',
    'target_level',
    'workflow_id',
    'material_from',
    'link_id',
    'link_version',
    'title',
    'direction',
    'original_workflow_id',
    'redaction_id',
    'revision_id',
    'provider',
    'model',
    'reasoning_effort'
  ],
  deliver: [
    'author_from',
    'workflow_id',
    'author_attempt_id',
    'mode',
    'base_token',
    'table_id',
    'record_id',
    'attachment_format'
  ]
};
export function dependency(t: Task) {
  return t.input.redaction_from ?? t.input.material_from ?? t.input.author_from;
}
export function channel(t: Task): Channel {
  return t.type === 'deliver' ? 'delivery' : 'agent';
}
export function validateLimits(raw: unknown): Manifest['limits'] {
  const limits = object(raw, ['agent', 'waiting', 'delivery'], 'limits');
  for (const [k, v] of Object.entries(limits)) bounded(v, 32, 'limits.' + k, true);
  return { ...limits, delivery: limits.delivery ?? 4 };
}
export function validateManifest(raw: unknown): Manifest {
  const m = object(raw, ['version', 'id', 'limits', 'tasks'], '批次');
  if (m.version !== 1 || typeof m.id !== 'string' || !uuid.test(m.id)) invalid('需要 version=1 和批次 UUID');
  const limits = validateLimits(m.limits ?? {});
  if (!Array.isArray(m.tasks) || !m.tasks.length || m.tasks.length > 10000) invalid('清单应含 1 至 10000 项');
  const ids = new Map<string, Task>(),
    targets = new Set<string>();
  for (const item of m.tasks) {
    const t = object(item, ['id', 'type', 'owner', 'input', 'weight', 'expected_minutes'], '任务');
    if (typeof t.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(t.id) || ids.has(t.id))
      invalid('任务 ID 无效或重复');
    if (!stages.includes(t.type)) invalid(t.id + ' 不支持此步骤');
    if (t.owner !== undefined && (typeof t.owner !== 'string' || !t.owner.trim() || t.owner.length > 200))
      invalid('owner 无效');
    const type = t.type as Stage,
      i = object(t.input, ['project_id', ...fields[type]], t.id);
    const need = (keys: string[]) => {
      for (const k of keys) if (i[k] === undefined) invalid(t.id + ' 缺少 ' + k);
    };
    need(['project_id']);
    for (const [k, v] of Object.entries(i)) {
      if (k.endsWith('_id') && k !== 'table_id' && k !== 'record_id') {
        if (typeof v !== 'string' || !uuid.test(v)) invalid(t.id + ' ' + k + ' 应为 UUID');
        i[k] = v.toLowerCase();
      } else if (k === 'force' || k === 'select_source') {
        if (typeof v !== 'boolean') invalid('force 应为布尔值');
      } else if (k === 'link_version') bounded(v, Number.MAX_SAFE_INTEGER, k, true);
      else if (typeof v !== 'string' || !v.trim() || v.length > 10000) invalid(t.id + ' ' + k + ' 文本无效');
    }
    if ((i.model === undefined) !== (i.reasoning_effort === undefined))
      invalid(t.id + ' 模型与推理强度须成对指定');
    if (i.target_level && !['L2', 'L3', 'L4', 'L5'].includes(i.target_level)) invalid('target_level 无效');
    if (type === 'redact') need(['package_id', 'revision_id', 'extraction_job_id']);
    if (type === 'prepare') {
      need(['package_id', 'revision_id']);
      if ([i.redaction_from, i.redaction_id, i.extraction_job_id].filter(Boolean).length !== 1)
        invalid(t.id + ' 必须指定唯一整理来源');
    }
    if (type === 'author') {
      if ([i.workflow_id, i.link_id, i.load_package_id].filter(Boolean).length !== 1)
        invalid(t.id + ' 选择现有题、加载关系或显式加载包建题');
      if (i.link_id) need(['link_version', 'title']);
      else if (i.load_package_id) {
        need(['title']);
        if (i.link_version || i.select_source) invalid('加载新包不能指定加载关系版本');
        if (i.original_workflow_id && !i.direction) invalid('跨期加载须指定新方向');
      } else if (i.link_version || i.title || i.direction || i.select_source || i.target_level)
        invalid(t.id + ' 新建题参数不能用于现有题');
      if (
        [i.material_from, i.redaction_id, i.revision_id].filter(Boolean).length > 1 ||
        ((i.link_id || i.load_package_id) && !i.material_from && !i.redaction_id && !i.revision_id)
      )
        invalid(t.id + ' 出题材料来源冲突或缺失');
      if (i.provider && !['codex', 'agy'].includes(i.provider)) invalid(t.id + ' 仅支持本机 Agent');
    }
    if (type === 'deliver') {
      need(['mode', 'base_token', 'table_id']);
      validateFeishuTarget({ base_token: i.base_token, table_id: i.table_id });
      if (
        !['draft', 'archived'].includes(i.mode) ||
        (i.record_id && (i.mode !== 'draft' || !/^rec[a-zA-Z0-9]+$/.test(i.record_id)))
      )
        invalid(t.id + ' 交付模式或目标行无效');
      if (i.attachment_format && !['docx', 'pdf'].includes(i.attachment_format)) invalid(t.id + ' 附件格式无效');
      if (i.author_from) {
        if (i.mode === 'archived') invalid(t.id + ' 归档交付须指定已归档题的出题尝试');
        if (i.workflow_id || i.author_attempt_id) invalid(t.id + ' 重复指定交付来源');
      } else need(['workflow_id', 'author_attempt_id']);
    }
    const unique =
      type === 'redact'
        ? i.revision_id
        : type === 'prepare'
          ? [i.project_id, i.revision_id, i.redaction_from ?? i.redaction_id ?? i.extraction_job_id]
          : type === 'author'
            ? i.workflow_id
            : [i.base_token, i.table_id, i.record_id ?? i.workflow_id ?? i.author_from];
    if (unique) {
      const key = JSON.stringify([type, unique]);
      if (targets.has(key)) invalid(t.id + ' 重复业务目标');
      targets.add(key);
    }
    ids.set(t.id, {
      ...t,
      type,
      input: { ...i },
      weight: bounded(t.weight ?? 1, 1000, 'weight'),
      expected_minutes: bounded(
        t.expected_minutes ?? { redact: 16, prepare: 6, author: 17, deliver: 1 }[type],
        1440,
        'expected_minutes'
      )
    } as Task);
  }
  for (const t of ids.values()) {
    const dep = dependency(t);
    if (!dep) continue;
    const upstream = ids.get(dep);
    if (!upstream || upstream.input.project_id !== t.input.project_id) invalid(t.id + ' 上游不存在或期次不同');
    const allowed: Stage[] =
      t.type === 'prepare' ? ['redact'] : t.type === 'author' ? ['redact', 'prepare'] : ['author'];
    if (!allowed.includes(upstream.type)) invalid(t.id + ' 上游类型无效');
    if (t.type === 'deliver' && t.input.record_id && !upstream.input.workflow_id)
      invalid(t.id + ' 新建题无法替换另一题的飞书记录');
    if (t.type === 'author' && t.input.load_package_id && upstream.input.package_id !== t.input.load_package_id)
      invalid(t.id + ' 加载包与上游包不同');
    if (
      t.type === 'prepare' &&
      (t.input.package_id !== upstream.input.package_id || t.input.revision_id !== upstream.input.revision_id)
    )
      invalid(t.id + ' 整理与脱敏包版本不一致');
  }
  return { version: 1, id: m.id.toLowerCase(), limits, tasks: [...ids.values()] };
}
