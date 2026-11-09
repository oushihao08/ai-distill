/**
 * 职责：校验各供应商的安全端点与模型参数，读取通用 API 默认配置和服务端凭证。
 * 关键入口：resolveModelApiConfig() / readModelApiDefaults() 冻结非敏感配置；readModelApiKey() 仅在请求时取密钥。
 * 不按密钥猜测通用默认供应商；Qwen 旧配置兼容由 resolveQwenConfig() 单独保留。
 */
import {ModelApiError,type ModelApiConfig} from './types';
import {ANSWER_LOCAL_TOOLS,DEFAULT_MODEL_API_MODEL,OPENROUTER_SERVER_TOOLS,type AnswerLocalTool,type OpenRouterServerTool} from '@shared/types';
export type QwenApiConfig=ModelApiConfig&{provider:'qwen'};
export type OtherApiConfig=ModelApiConfig&{provider:'kimi'|'deepseek'|'doubao'|'openrouter'|'siliconflow'|'nvidia'};
function record(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
 if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) throw new ModelApiError('configuration');
}
export function resolveQwenConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): QwenApiConfig {
 onlyFields(raw, ['provider', 'base_url', 'model', 'enable_thinking', 'max_tokens','server_tools','local_tools','max_tool_calls']);
 const routerDefault = Boolean(env.OPEN_ROUTER_KEY?.trim()) && !(env.QWEN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim());
 const base = raw.base_url === undefined ? (env.QWEN_BASE_URL?.trim() || (routerDefault ? 'https://openrouter.ai/api/v1' : undefined)) : raw.base_url;
 const model = raw.model === undefined ? (env.QWEN_MODEL?.trim() || (typeof base === 'string' && /^https:\/\/openrouter\.ai\/api\/v1\/?$/.test(base) ? 'qwen/qwen-plus' : undefined)) : raw.model;
 if (raw.provider !== undefined && raw.provider !== 'qwen') throw new ModelApiError('configuration');
 if (typeof base !== 'string') throw new ModelApiError('configuration');
 let url: URL;
 try { url = new URL(base); } catch { throw new ModelApiError('configuration'); }
 const legacy = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'];
 const workspace = /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|ap-northeast-1|us-east-1|cn-hongkong)\.maas\.aliyuncs\.com$/;
 const router = url.hostname === 'openrouter.ai';
 if (url.protocol !== 'https:' || (!router && !legacy.includes(url.hostname) && !workspace.test(url.hostname)) || url.port || url.username || url.password || url.search || url.hash || !(router ? /^\/api\/v1\/?$/ : /^\/compatible-mode\/v1\/?$/).test(url.pathname)) throw new ModelApiError('configuration');
 if (typeof model !== 'string' || !(router ? /^qwen\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/).test(model)) throw new ModelApiError('configuration');
 if (raw.enable_thinking !== undefined && typeof raw.enable_thinking !== 'boolean') throw new ModelApiError('configuration');
 if (raw.max_tokens !== undefined && (!Number.isSafeInteger(raw.max_tokens) || (raw.max_tokens as number) <= 0)) throw new ModelApiError('configuration');
 const tools=resolveServerTools(raw.server_tools,raw.max_tool_calls,router),local=resolveLocalTools(raw.local_tools,router);
 if(raw.max_tool_calls!==undefined&&!tools.server_tools?.length&&!local.local_tools?.length)throw new ModelApiError('configuration');
 return {
  provider: 'qwen', base_url: url.href.replace(/\/$/, ''), model,
  ...(raw.enable_thinking !== undefined ? { enable_thinking: raw.enable_thinking as boolean } : {}),
  ...(raw.max_tokens !== undefined ? { max_tokens: raw.max_tokens as number } : {}),
  ...tools,...local,
 };
}

const endpoints:Record<OtherApiConfig['provider'], {base:string;hosts:string[];path:RegExp;keys:string[]}> = {
 kimi:{base:'https://api.moonshot.ai/v1',hosts:['api.moonshot.ai','api.moonshot.cn'],path:/^\/v1\/?$/,keys:['KIMI_API_KEY','MOONSHOT_API_KEY']},
 deepseek:{base:'https://api.deepseek.com',hosts:['api.deepseek.com'],path:/^\/(v1\/?)?$/,keys:['DEEPSEEK_API_KEY']},
 doubao:{base:'https://ark.cn-beijing.volces.com/api/v3',hosts:['ark.cn-beijing.volces.com'],path:/^\/api\/v3\/?$/,keys:['DOUBAO_API_KEY','ARK_API_KEY']},
 openrouter:{base:'https://openrouter.ai/api/v1',hosts:['openrouter.ai'],path:/^\/api\/v1\/?$/,keys:['OPEN_ROUTER_KEY']},
 siliconflow:{base:'https://api.siliconflow.com/v1',hosts:['api.siliconflow.com'],path:/^\/v1\/?$/,keys:['SILICONFLOW_API_KEY']},
 nvidia:{base:'https://integrate.api.nvidia.com/v1',hosts:['integrate.api.nvidia.com'],path:/^\/v1\/?$/,keys:['NVIDIA_API_KEY']},
};
export function resolveOtherApiConfig(raw:unknown,env:NodeJS.ProcessEnv=process.env):OtherApiConfig {
 onlyFields(raw,['provider','base_url','model','max_tokens','enable_thinking','provider_options','server_tools','local_tools','max_tool_calls']);
 if(raw.enable_thinking!==undefined&&((raw.provider!=='openrouter'&&raw.provider!=='siliconflow')||typeof raw.enable_thinking!=='boolean'))throw new ModelApiError('configuration');
 if(raw.provider!=='kimi' && raw.provider!=='deepseek' && raw.provider!=='doubao' && raw.provider!=='openrouter' && raw.provider!=='siliconflow' && raw.provider!=='nvidia') throw new ModelApiError('configuration');
 const provider=raw.provider,spec=endpoints[provider],prefix=provider.toUpperCase();
 // NVIDIA examples use both the API root and the full chat-completions URL; store one canonical root.
 const suppliedBase=raw.base_url===undefined ? env[prefix+'_BASE_URL']?.trim() || spec.base : raw.base_url;
 const base=provider==='nvidia'&&typeof suppliedBase==='string'?suppliedBase.replace(/\/chat\/completions\/?$/,''):suppliedBase;
 const model=raw.model===undefined ? env[prefix+'_MODEL']?.trim() : raw.model;
 const modelPattern=provider==='openrouter'||provider==='siliconflow'||provider==='nvidia'?/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/:/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
 if(typeof base!=='string' || typeof model!=='string' || !modelPattern.test(model)) throw new ModelApiError('configuration');
 let url:URL;try {url=new URL(base);} catch {throw new ModelApiError('configuration');}
 if(url.protocol!=='https:' || !spec.hosts.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !spec.path.test(url.pathname)) throw new ModelApiError('configuration');
 if(raw.max_tokens!==undefined && (!Number.isSafeInteger(raw.max_tokens) || (raw.max_tokens as number)<=0)) throw new ModelApiError('configuration');
 let provider_options:ModelApiConfig['provider_options'];
 if(raw.provider_options!==undefined){
  if(provider!=='openrouter')throw new ModelApiError('configuration');
  onlyFields(raw.provider_options,['only','allow_fallbacks']);const options=raw.provider_options;
  if(!Array.isArray(options.only)||options.only.length<1||options.only.length>4||options.only.some(item=>typeof item!=='string'||!/^[a-z0-9][a-z0-9_/-]{0,79}$/.test(item))||new Set(options.only).size!==options.only.length||typeof options.allow_fallbacks!=='boolean')throw new ModelApiError('configuration');
  provider_options={only:[...options.only] as string[],allow_fallbacks:options.allow_fallbacks};
 }
 const tools=resolveServerTools(raw.server_tools,raw.max_tool_calls,provider==='openrouter'),local=resolveLocalTools(raw.local_tools,provider==='openrouter');
 if(raw.max_tool_calls!==undefined&&!tools.server_tools?.length&&!local.local_tools?.length)throw new ModelApiError('configuration');
 return {provider,base_url:url.href.replace(/\/$/,''),model,...(raw.enable_thinking!==undefined?{enable_thinking:raw.enable_thinking as boolean}:{}),...(raw.max_tokens!==undefined ? {max_tokens:raw.max_tokens as number}: {}),...(provider_options?{provider_options}:{}),...tools,...local};
}

function resolveServerTools(raw:unknown,maxToolCalls:unknown,allowed:boolean):Pick<ModelApiConfig,'server_tools'|'max_tool_calls'>{
 if(raw===undefined){if(maxToolCalls!==undefined&&(!Number.isSafeInteger(maxToolCalls)||(maxToolCalls as number)<1||(maxToolCalls as number)>100))throw new ModelApiError('configuration');return maxToolCalls===undefined?{}:{max_tool_calls:maxToolCalls as number};}
 if(!allowed||!Array.isArray(raw)||raw.length<1||raw.length>OPENROUTER_SERVER_TOOLS.length||raw.some(item=>typeof item!=='string'||!OPENROUTER_SERVER_TOOLS.includes(item as OpenRouterServerTool))||new Set(raw).size!==raw.length)throw new ModelApiError('configuration');
 if(maxToolCalls!==undefined&&(!Number.isSafeInteger(maxToolCalls)||(maxToolCalls as number)<1||(maxToolCalls as number)>100))throw new ModelApiError('configuration');
 return{server_tools:[...raw] as OpenRouterServerTool[],...(maxToolCalls!==undefined?{max_tool_calls:maxToolCalls as number}:{})};
}
function resolveLocalTools(raw:unknown,allowed:boolean):Pick<ModelApiConfig,'local_tools'>{
 if(raw===undefined)return{};
 if(!allowed||!Array.isArray(raw)||raw.length>ANSWER_LOCAL_TOOLS.length||raw.some(item=>typeof item!=='string'||!ANSWER_LOCAL_TOOLS.includes(item as AnswerLocalTool))||new Set(raw).size!==raw.length)throw new ModelApiError('configuration');
 return{local_tools:[...raw] as AnswerLocalTool[]};
}


export function resolveModelApiConfig(raw:unknown,env:NodeJS.ProcessEnv=process.env):ModelApiConfig{
 if(!record(raw))throw new ModelApiError('configuration');
 if(raw.provider==='qwen'){
  // Key-based OpenRouter inference belongs only to the legacy answer facade.
  const base_url=raw.base_url===undefined?env.QWEN_BASE_URL?.trim():raw.base_url,model=raw.model===undefined?env.QWEN_MODEL?.trim():raw.model;
  if(base_url===undefined||model===undefined)throw new ModelApiError('configuration');
  return resolveQwenConfig({...raw,base_url,model},env);
 }
 return resolveOtherApiConfig(raw,env);
}
export function readModelApiDefaults(env:NodeJS.ProcessEnv=process.env):ModelApiConfig{
 const provider=env.LLM_API_PROVIDER?.trim()||'openrouter';
 const model=env.LLM_API_MODEL?.trim()||(provider==='openrouter'?(env.OPENROUTER_MODEL?.trim()||DEFAULT_MODEL_API_MODEL):undefined);
 return resolveModelApiConfig({provider,...(env.LLM_API_BASE_URL?.trim()?{base_url:env.LLM_API_BASE_URL.trim()}:{}),...(model?{model}:{}),...(provider==='openrouter'&&model===DEFAULT_MODEL_API_MODEL?{enable_thinking:false}:{})},env);
}
export function readModelApiKey(config:ModelApiConfig,env:NodeJS.ProcessEnv):string{
 const router=new URL(config.base_url).hostname==='openrouter.ai';
 const key=router?env.OPEN_ROUTER_KEY?.trim():config.provider==='qwen'?(env.QWEN_API_KEY?.trim()||env.DASHSCOPE_API_KEY?.trim()):endpoints[config.provider].keys.map(name=>env[name]?.trim()).find(Boolean);
 if(!key||/\s/.test(key))throw new ModelApiError('configuration');
 return key;
}
