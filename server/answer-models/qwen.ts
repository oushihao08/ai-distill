export interface QwenConfig {
 provider: 'qwen';
 base_url: string;
 model: string;
 enable_thinking?: boolean;
 max_tokens?: number;
}
export interface QwenAnswerInput {
 config: QwenConfig;
 question: string;
 materials: { name: string; text: string }[];
 timeout_ms?: number;
 signal?: AbortSignal;
}
export interface QwenAnswer {
 text: string;
 requested_model: string;
 model: string | null;
 request_id: string | null;
 completion_id: string | null;
 usage: Record<string, unknown> | null;
 started_at: string;
 finished_at: string;
 duration_ms: number;
}
export type QwenErrorKind = 'configuration' | 'authentication' | 'quota' | 'rate_limit' | 'network' | 'timeout' | 'cancelled' | 'provider' | 'invalid_response';
export class QwenError extends Error {
 constructor(public readonly kind: QwenErrorKind, public readonly retryable = false, public readonly http_status: number | null = null, public readonly provider_code: string | null = null, public readonly request_id: string | null = null) {
  const messages: Record<QwenErrorKind, string> = {
   configuration: 'Qwen 配置或作答输入无效，请核对凭证、端点和模型参数',
   authentication: 'Qwen 认证或访问权限失败', quota: 'Qwen 账户欠费或订购状态阻断',
   rate_limit: 'Qwen 调用频率或 Token 用量受限', network: 'Qwen 网络请求失败',
   timeout: 'Qwen 请求超时', cancelled: 'Qwen 请求已取消', provider: 'Qwen 服务返回错误',
   invalid_response: 'Qwen 未返回完整有效的答案',
  };
  super(messages[kind]);
  this.name = 'QwenError';
 }
}
function record(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
 if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) throw new QwenError('configuration');
}
export function resolveQwenConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): QwenConfig {
 onlyFields(raw, ['provider', 'base_url', 'model', 'enable_thinking', 'max_tokens']);
 const routerDefault = Boolean(env.OPEN_ROUTER_KEY?.trim()) && !(env.QWEN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim());
 const base = raw.base_url === undefined ? (env.QWEN_BASE_URL?.trim() || (routerDefault ? 'https://openrouter.ai/api/v1' : undefined)) : raw.base_url;
 const model = raw.model === undefined ? (env.QWEN_MODEL?.trim() || (typeof base === 'string' && /^https:\/\/openrouter\.ai\/api\/v1\/?$/.test(base) ? 'qwen/qwen-plus' : undefined)) : raw.model;
 if (raw.provider !== undefined && raw.provider !== 'qwen') throw new QwenError('configuration');
 if (typeof base !== 'string') throw new QwenError('configuration');
 let url: URL;
 try { url = new URL(base); } catch { throw new QwenError('configuration'); }
 const legacy = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'];
 const workspace = /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|ap-northeast-1|us-east-1|cn-hongkong)\.maas\.aliyuncs\.com$/;
 const router = url.hostname === 'openrouter.ai';
 if (url.protocol !== 'https:' || (!router && !legacy.includes(url.hostname) && !workspace.test(url.hostname)) || url.port || url.username || url.password || url.search || url.hash || !(router ? /^\/api\/v1\/?$/ : /^\/compatible-mode\/v1\/?$/).test(url.pathname)) throw new QwenError('configuration');
 if (typeof model !== 'string' || !(router ? /^qwen\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/).test(model)) throw new QwenError('configuration');
 if (raw.enable_thinking !== undefined && typeof raw.enable_thinking !== 'boolean') throw new QwenError('configuration');
 if (raw.max_tokens !== undefined && (!Number.isSafeInteger(raw.max_tokens) || (raw.max_tokens as number) <= 0)) throw new QwenError('configuration');
 return {
  provider: 'qwen', base_url: url.href.replace(/\/$/, ''), model,
  ...(raw.enable_thinking !== undefined ? { enable_thinking: raw.enable_thinking as boolean } : {}),
  ...(raw.max_tokens !== undefined ? { max_tokens: raw.max_tokens as number } : {}),
 };
}

// Only documented codes are retained. Provider message/type/param and unknown codes
// can echo private inputs, so they never become error properties or causes.
const quotaCodes = new Set(['Arrearage', 'isv.OUT_OF_SERVICE', 'PrepaidBillOverdue', 'CommodityNotPurchased']);
const authCodes = new Set(['InvalidApiKey', 'invalid_api_key', 'AccessDenied', 'access_denied', 'AccessDenied.Unpurchased', 'Model.AccessDenied', 'Workspace.AccessDenied', 'NOT AUTHORIZED']);
const rateCodes = new Set(['Throttling', 'Throttling.RateQuota', 'Throttling.AllocationQuota', 'insufficient_quota', 'Throttling.BurstRate', 'Throttling.Concurrency', 'Throttling.ServiceOverloaded', 'Throttling.ResourceExhausted', 'LimitRequests', 'limit_requests', 'limit_burst_rate', 'ResourceExhausted']);
const configCodes = new Set(['InvalidParameter', 'InvalidParameter.NotSupportEnableThinking', 'invalid_parameter_error', 'invalid_request_error', 'invalid_value', 'model_not_supported', 'ModelNotFound', 'WorkSpaceNotFound']);
const providerCodes = new Set(['InternalError', 'ServiceUnavailable', 'DataInspectionFailed', 'data_inspection_failed']);
function requestId(response: Response, data: unknown): string | null {
 const ids = [response.headers.get('x-request-id'), response.headers.get('x-dashscope-request-id'), record(data) ? data.request_id : null];
 return ids.find((id): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) ?? null;
}
function providerError(response: Response, data: unknown): QwenError {
 const details = record(data) && record(data.error) ? data.error : data;
 const rawCode = record(details) ? details.code : undefined;
 const code = typeof rawCode === 'number' && [400,401,402,403,404,408,422,429,500,502,503].includes(rawCode) ? String(rawCode) : typeof rawCode === 'string' && [quotaCodes, authCodes, rateCodes, configCodes, providerCodes].some(codes => codes.has(rawCode)) ? rawCode : null;
 let kind: QwenErrorKind = 'provider';
 if ((code && quotaCodes.has(code)) || response.status === 402) kind = 'quota';
 else if (response.status === 408) kind = 'timeout';
 else if ((code && authCodes.has(code)) || response.status === 401 || response.status === 403) kind = 'authentication';
 else if ((code && rateCodes.has(code)) || response.status === 429) kind = 'rate_limit';
 else if ((code && configCodes.has(code)) || response.status === 400 || response.status === 404 || response.status === 422) kind = 'configuration';
 const retryable = kind === 'timeout' || kind === 'rate_limit' || (kind === 'provider' && response.status >= 500);
 return new QwenError(kind, retryable, response.status, code, requestId(response, data));
}
function parseAnswer(data: unknown, response: Response, config: QwenConfig, started_at: string, started: number): QwenAnswer {
 const invalid = () => new QwenError('invalid_response', false, response.status, null, requestId(response, data));
 if (!record(data) || data.error !== undefined || !Array.isArray(data.choices) || data.choices.length !== 1) throw invalid();
 const choice = data.choices[0];
 if (!record(choice) || choice.finish_reason !== 'stop' || !record(choice.message)) throw invalid();
 const message = choice.message;
 if (message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim() || (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) || message.function_call != null || message.refusal != null) throw invalid();
 if (data.usage != null && !record(data.usage)) throw invalid();
 if (data.model != null && (typeof data.model !== 'string' || !data.model.trim())) throw invalid();
 if (data.id != null && typeof data.id !== 'string') throw invalid();
 return {
  text: message.content, requested_model: config.model, model: typeof data.model === 'string' ? data.model : null,
  request_id: requestId(response, data), completion_id: typeof data.id === 'string' ? data.id : null,
  usage: record(data.usage) ? data.usage : null,
  started_at, finished_at: new Date().toISOString(), duration_ms: Math.max(0, Math.round(performance.now() - started)),
 };
}

export function createQwenClient(env: NodeJS.ProcessEnv = process.env, request: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
 return { async answer(input: QwenAnswerInput): Promise<QwenAnswer> {
  onlyFields(input, ['config', 'question', 'materials', 'timeout_ms', 'signal']);
  if (typeof input.question !== 'string' || !input.question.trim() || !Array.isArray(input.materials)) throw new QwenError('configuration');
  const materials = input.materials.map(material => {
   onlyFields(material, ['name', 'text']);
   if (typeof material.name !== 'string' || !material.name.trim() || typeof material.text !== 'string' || !material.text.trim()) throw new QwenError('configuration');
   return { name: material.name, text: material.text };
  });
  const timeout = input.timeout_ms ?? 120000;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647 || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw new QwenError('configuration');
  if (input.signal?.aborted) throw new QwenError('cancelled');
  const config = resolveQwenConfig(input.config, env);
  // Resolve credentials at invocation time, outside the persisted configuration.
  const router = new URL(config.base_url).hostname === 'openrouter.ai';
  const key = router ? env.OPEN_ROUTER_KEY?.trim() : (env.QWEN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim());
  if (!key || /\s/.test(key)) throw new QwenError('configuration');
  const started_at = new Date().toISOString(); const started = performance.now();
  const controller = new AbortController();
  let abortKind: 'timeout' | 'cancelled' | undefined;
  const abort = (kind: 'timeout' | 'cancelled') => {
   if (!controller.signal.aborted) { abortKind = kind; controller.abort(); }
  };
  const cancel = () => abort('cancelled');
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abort('timeout'), timeout);
  try {
   const response = await request(config.base_url + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: controller.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
     model: config.model, stream: false,
     ...(config.enable_thinking !== undefined ? (router ? { reasoning: { enabled: config.enable_thinking }, provider: { require_parameters: true } } : { enable_thinking: config.enable_thinking }) : {}),
     ...(config.max_tokens !== undefined ? { max_tokens: config.max_tokens } : {}),
     messages: [{ role: 'user', content: JSON.stringify({ question: input.question, materials }) }],
    }),
   });
   if (abortKind) throw new QwenError(abortKind, abortKind === 'timeout');
   let data: unknown;
   try { data = await response.json(); }
   catch (error) {
    if (abortKind) throw new QwenError(abortKind, abortKind === 'timeout');
    if (!(error instanceof SyntaxError)) throw new QwenError('network', true);
    if (response.ok) throw new QwenError('invalid_response', false, response.status, null, requestId(response, null));
    data = null;
   }
   if (abortKind) throw new QwenError(abortKind, abortKind === 'timeout');
   if (!response.ok) throw providerError(response, data);
   return parseAnswer(data, response, config, started_at, started);
  } catch (error) {
   if (abortKind) throw new QwenError(abortKind, abortKind === 'timeout');
   if (error instanceof QwenError) throw error;
   throw new QwenError('network', true);
  } finally {
   clearTimeout(timer);
   input.signal?.removeEventListener('abort', cancel);
  }
 } };
}
