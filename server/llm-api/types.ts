/**
 * 职责：定义独立大模型 API 的供应商、消息、配置和返回契约；不依赖 Agent 或业务队列。
 * 关键入口：ModelApiConfig / ModelApiRequest / ModelApiResult 供各业务执行器和 API 客户端使用。
 */
import type {ModelApiConfig,ModelApiProvider,OpenRouterServerTool,AnswerLocalTool} from '@shared/types';
export type {ModelApiConfig,ModelApiProvider,OpenRouterServerTool,AnswerLocalTool} from '@shared/types';
export interface ModelApiMessage {role:'system'|'user'|'assistant';content:string}
export type ModelApiResponseFormat={type:'json_object'}|{type:'json_schema';json_schema:{name:string;strict:true;schema:Record<string,unknown>}};
export interface FunctionToolDefinition {type:'function';name:string;description:string;strict:true;parameters:Record<string,unknown>}
export type FunctionToolExecutor=(name:string,argumentsValue:unknown)=>Promise<string>;
export interface ModelApiRequest {config:ModelApiConfig;messages:ModelApiMessage[];response_format?:ModelApiResponseFormat;timeout_ms?:number;queue_timeout_ms?:number;signal?:AbortSignal;call_id?:string;observe_reasoning?:boolean;function_tools?:FunctionToolDefinition[];execute_function_tool?:FunctionToolExecutor}
export interface ModelApiResult {
 /** requested_model为冻结请求配置；model为供应商响应标识，未返回时为null，不据请求推断。 */
 text:string;requested_model:string;model:string|null;provider:ModelApiProvider;
 request_id:string|null;completion_id:string|null;usage:Record<string,unknown>|null;
 /** 供应商 usage 明确报告的内部推理 token；null 表示不可观测，不能解释为 0。 */
 reasoning_tokens?:number|null;
 /** Responses 轨迹中状态为 completed 的外部工具调用；普通无工具请求为 0。 */
 completed_tool_calls?:number;
 started_at:string;finished_at:string;duration_ms:number;queue_wait_ms?:number;
 generation_activity?:ReasoningActivityEvidence;
 tool_trace?:ServerToolTrace;
 execution_steps?:ExecutionStepEvidence;
 source_citations?:SourceCitation[];
}
export interface ServerToolCallEvidence {id:string|null;type:'web_search'|'web_fetch'|'shell'|AnswerLocalTool;status:'completed'|'failed'|'in_progress'|'unknown'}
export interface ServerToolTrace {api:'responses';calls:ServerToolCallEvidence[];usage:Record<string,number>}
export interface ExecutionStepEvidence {method:'completed_tool_calls';observed:number;completed:number;failed:number;effective_steps:number|null}
export interface SourceCitation {url:string;title:string|null;start_index:number|null;end_index:number|null}
export interface ReasoningActivityEvidence {source:'openrouter_reasoning_details'|'openrouter_reasoning'|'dashscope_reasoning_content';first_event_at:string;last_event_at:string;span_ms:number;max_gap_ms:number;event_count:number}
export type ModelApiErrorKind = 'configuration' | 'authentication' | 'quota' | 'rate_limit' | 'network' | 'timeout' | 'cancelled' | 'provider' | 'invalid_response';
export class ModelApiError extends Error {
 constructor(public readonly kind: ModelApiErrorKind, public readonly retryable = false, public readonly http_status: number | null = null, public readonly provider_code: string | null = null, public readonly request_id: string | null = null, public readonly reason_code?: string, public readonly generation_activity?:ReasoningActivityEvidence, public readonly generation_id?:string|null) {
  const messages: Record<ModelApiErrorKind, string> = {
   configuration: '大模型 API 配置或请求输入无效，请核对凭证、端点和模型参数',
   authentication: '大模型 API 认证或访问权限失败', quota: '大模型 API 账户欠费或订购状态阻断',
   rate_limit: '大模型 API 调用频率或 Token 用量受限', network: '大模型 API 网络请求失败',
   timeout: '大模型 API 请求超时', cancelled: '大模型 API 请求已取消', provider: '大模型 API 服务返回错误',
   invalid_response: '大模型 API 未返回完整有效的内容',
  };
  super(messages[kind]);
  this.name = 'ModelApiError';
 }
}

export function isModelApiRecord(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertOnlyModelApiFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
 if (!isModelApiRecord(value) || Object.keys(value).some(key => !fields.includes(key))) {
  throw new ModelApiError('configuration');
 }
}
