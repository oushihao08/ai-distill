import type {AnswerClient,AnswerModelConfig,AnswerRequest,AnswerResult} from './provider';
export type DomesticConfig=AnswerModelConfig & {provider:'kimi'|'deepseek'|'doubao'|'openrouter'};
export type DomesticErrorKind = 'configuration' | 'authentication' | 'quota' | 'rate_limit' | 'network' | 'timeout' | 'cancelled' | 'provider' | 'invalid_response';
export class DomesticError extends Error {
 constructor(public readonly kind: DomesticErrorKind, public readonly retryable = false, public readonly http_status: number | null = null, public readonly provider_code: string | null = null, public readonly request_id: string | null = null) {
  const messages: Record<DomesticErrorKind, string> = {
   configuration: '作答模型配置或作答输入无效，请核对凭证、端点和模型参数',
   authentication: '作答模型认证或访问权限失败', quota: '作答模型账户欠费或订购状态阻断',
   rate_limit: '作答模型调用频率或 Token 用量受限', network: '作答模型网络请求失败',
   timeout: '作答模型请求超时', cancelled: '作答模型请求已取消', provider: '作答模型服务返回错误',
   invalid_response: '作答模型未返回完整有效的答案',
  };
  super(messages[kind]);
  this.name = 'DomesticError';
 }
}
function record(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
 if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) throw new DomesticError('configuration');
}
const endpoints:Record<DomesticConfig['provider'], {base:string;hosts:string[];path:RegExp;keys:string[]}> = {
 kimi:{base:'https://api.moonshot.ai/v1',hosts:['api.moonshot.ai','api.moonshot.cn'],path:/^\/v1\/?$/,keys:['KIMI_API_KEY','MOONSHOT_API_KEY']},
 deepseek:{base:'https://api.deepseek.com',hosts:['api.deepseek.com'],path:/^\/(v1\/?)?$/,keys:['DEEPSEEK_API_KEY']},
 doubao:{base:'https://ark.cn-beijing.volces.com/api/v3',hosts:['ark.cn-beijing.volces.com'],path:/^\/api\/v3\/?$/,keys:['DOUBAO_API_KEY','ARK_API_KEY']},
 openrouter:{base:'https://openrouter.ai/api/v1',hosts:['openrouter.ai'],path:/^\/api\/v1\/?$/,keys:['OPEN_ROUTER_KEY']},
};
export function resolveDomesticConfig(raw:unknown,env:NodeJS.ProcessEnv=process.env):DomesticConfig {
 onlyFields(raw,['provider','base_url','model','max_tokens']);
 if(raw.provider!=='kimi' && raw.provider!=='deepseek' && raw.provider!=='doubao' && raw.provider!=='openrouter') throw new DomesticError('configuration');
 const provider=raw.provider,spec=endpoints[provider],prefix=provider.toUpperCase();
 const base=raw.base_url===undefined ? env[prefix+'_BASE_URL']?.trim() || spec.base : raw.base_url;
 const model=raw.model===undefined ? env[prefix+'_MODEL']?.trim() : raw.model;
 const modelPattern=provider==='openrouter'?/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/:/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
 if(typeof base!=='string' || typeof model!=='string' || !modelPattern.test(model)) throw new DomesticError('configuration');
 let url:URL;try {url=new URL(base);} catch {throw new DomesticError('configuration');}
 if(url.protocol!=='https:' || !spec.hosts.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !spec.path.test(url.pathname)) throw new DomesticError('configuration');
 if(raw.max_tokens!==undefined && (!Number.isSafeInteger(raw.max_tokens) || (raw.max_tokens as number)<=0)) throw new DomesticError('configuration');
 return {provider,base_url:url.href.replace(/\/$/,''),model,...(raw.max_tokens!==undefined ? {max_tokens:raw.max_tokens as number}: {})};
}

// Unknown error bodies and request IDs can echo inputs; never retain them.
function requestId(response:Response,_data:unknown):string|null {
 const id=response.headers.get('x-request-id');
 return id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ? id : null;
}
function providerError(response:Response,_data:unknown):DomesticError {
 const status=response.status;
 const kind:DomesticErrorKind=status===402?'quota':status===401||status===403?'authentication':status===429?'rate_limit':status===408?'timeout':[400,404,422].includes(status)?'configuration':'provider';
 return new DomesticError(kind,kind==='timeout'||kind==='rate_limit'||(kind==='provider'&&status>=500),status,null,requestId(response,null));
}
function parseAnswer(data: unknown, response: Response, config: DomesticConfig, started_at: string, started: number): AnswerResult {
 const invalid = () => new DomesticError('invalid_response', false, response.status, null, requestId(response, data));
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

export function createDomesticClient(env: NodeJS.ProcessEnv = process.env, request: (input: string, init?: RequestInit) => Promise<Response> = fetch): AnswerClient<DomesticConfig> {
 return { async answer(input: AnswerRequest<DomesticConfig>): Promise<AnswerResult> {
  onlyFields(input, ['config', 'question', 'materials', 'timeout_ms', 'signal']);
  if (typeof input.question !== 'string' || !input.question.trim() || !Array.isArray(input.materials)) throw new DomesticError('configuration');
  const materials = input.materials.map(material => {
   onlyFields(material, ['name', 'text']);
   if (typeof material.name !== 'string' || !material.name.trim() || typeof material.text !== 'string' || !material.text.trim()) throw new DomesticError('configuration');
   return { name: material.name, text: material.text };
  });
  const timeout = input.timeout_ms === undefined ? 120000 : input.timeout_ms;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647 || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw new DomesticError('configuration');
  if (input.signal?.aborted) throw new DomesticError('cancelled');
  const config = resolveDomesticConfig(input.config, env);
  // Resolve credentials at invocation time, outside the persisted configuration.
  const key = endpoints[config.provider].keys.map(name=>env[name]?.trim()).find(Boolean);
  if (!key || /\s/.test(key)) throw new DomesticError('configuration');
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
     ...(config.max_tokens !== undefined ? { max_tokens: config.max_tokens } : {}),
     messages: [{ role: 'user', content: JSON.stringify({ question: input.question, materials }) }],
    }),
   });
   if (abortKind) throw new DomesticError(abortKind, abortKind === 'timeout');
   let data: unknown;
   try { data = await response.json(); }
   catch (error) {
    if (abortKind) throw new DomesticError(abortKind, abortKind === 'timeout');
    if (!(error instanceof SyntaxError)) throw new DomesticError('network', true);
    if (response.ok) throw new DomesticError('invalid_response', false, response.status, null, requestId(response, null));
    data = null;
   }
   if (abortKind) throw new DomesticError(abortKind, abortKind === 'timeout');
   if (!response.ok) throw providerError(response, data);
   return parseAnswer(data, response, config, started_at, started);
  } catch (error) {
   if (abortKind) throw new DomesticError(abortKind, abortKind === 'timeout');
   if (error instanceof DomesticError) throw error;
   throw new DomesticError('network', true);
  } finally {
   clearTimeout(timer);
   input.signal?.removeEventListener('abort', cancel);
  }
 } };
}
