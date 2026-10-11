/**
 * 职责：定义独立大模型 API 的供应商、消息、配置和返回契约；不依赖 Agent 或业务队列。
 * 关键入口：ModelApiConfig / ModelApiRequest / ModelApiResult 供各业务执行器和 API 客户端使用。
 */
import type {ModelApiConfig,ModelApiProvider} from '@shared/types';
export type {ModelApiConfig,ModelApiProvider} from '@shared/types';
export interface ModelApiMessage {role:'system'|'user'|'assistant';content:string}
export type ModelApiResponseFormat={type:'json_object'}|{type:'json_schema';json_schema:{name:string;strict:true;schema:Record<string,unknown>}};
export interface ModelApiRequest {config:ModelApiConfig;messages:ModelApiMessage[];response_format?:ModelApiResponseFormat;timeout_ms?:number;signal?:AbortSignal;call_id?:string}
export interface ModelApiResult {
 text:string;requested_model:string;model:string|null;provider:ModelApiProvider;
 request_id:string|null;completion_id:string|null;usage:Record<string,unknown>|null;
 started_at:string;finished_at:string;duration_ms:number;
}
export type ModelApiErrorKind = 'configuration' | 'authentication' | 'quota' | 'rate_limit' | 'network' | 'timeout' | 'cancelled' | 'provider' | 'invalid_response';
export class ModelApiError extends Error {
 constructor(public readonly kind: ModelApiErrorKind, public readonly retryable = false, public readonly http_status: number | null = null, public readonly provider_code: string | null = null, public readonly request_id: string | null = null, public readonly reason_code?: string) {
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
