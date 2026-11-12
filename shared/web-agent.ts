/**
 * 职责：网页Agent（DeepSeek/Gemini网页对话）通道的共享契约：提供方、冻结设置校验和固定槽位上限。
 * 主要入口：`validateWebAgentSettings()`；调用方为材料库整理（prepare）派发、出题步骤配置校验、CLI及网页执行器。
 * 边界：只描述任务冻结的网页执行设置，不含站点选择器、浏览器操作或凭证。
 */
export const WEB_AGENT_PROVIDERS = ['deepseek', 'gemini'] as const;
export type WebAgentProvider = (typeof WEB_AGENT_PROVIDERS)[number];
/** 网页通道独立槽位数；不占用Agent/API槽位。可由服务进程环境 `WEB_AGENT_SLOTS` 覆盖（1–6）。 */
export const WEB_AGENT_SLOT_LIMIT = 6;

export interface WebAgentSettings {
  provider: WebAgentProvider;
  /** 显式开关站点“深度思考”；缺省沿用站点默认。 */
  thinking?: boolean;
  /** 站点模型选择器上的可见标签；缺省沿用站点默认。 */
  model_label?: string;
}

export function isWebAgentProvider(value: unknown): value is WebAgentProvider {
  return typeof value === 'string' && (WEB_AGENT_PROVIDERS as readonly string[]).includes(value);
}

/** 严格校验冻结设置；未知字段拒绝，避免把未审计的开关带进任务快照。 */
export function validateWebAgentSettings(value: unknown): WebAgentSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('网页Agent设置须为对象');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['provider', 'thinking', 'model_label'].includes(key))) throw new Error('网页Agent设置包含未知字段');
  if (!isWebAgentProvider(record.provider)) throw new Error('网页Agent提供方仅支持deepseek或gemini');
  if (record.thinking !== undefined && typeof record.thinking !== 'boolean') throw new Error('网页Agent thinking须为布尔值');
  if (record.model_label !== undefined && (typeof record.model_label !== 'string' || !record.model_label.trim() || record.model_label.length > 80)) throw new Error('网页Agent model_label无效');
  return {
    provider: record.provider,
    ...(record.thinking !== undefined ? { thinking: record.thinking } : {}),
    ...(record.model_label !== undefined ? { model_label: record.model_label.trim() } : {}),
  };
}
