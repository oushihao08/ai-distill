/**
 * 职责：作答供应商公共契约：定义固定模型配置、纯文字请求、完整答案和 usage 元数据。
 * 关键方法与用途：`AnswerProvider`、`AnswerClient` 和请求／结果类型定义供应商统一契约；不执行网络请求。
 * 使用场景：由 `dispatch.ts`、供应商适配器和 `jobs.ts` 共同实现与消费。
 */
import type {ModelApiConfig,ModelApiProvider,ModelApiResult,ModelApiErrorKind} from '../llm-api';
// Structural contract: existing Qwen remains compatible without changing its runtime.
export type AnswerProvider=ModelApiProvider|'codex';
export type AnswerModelConfig=ModelApiConfig;
export interface CodexAnswerConfig {provider:'codex';model:string;reasoning_effort:string}
export type AnswerExecutionConfig=AnswerModelConfig|CodexAnswerConfig;
export interface AnswerRequest<T extends AnswerExecutionConfig=AnswerExecutionConfig> {config:T;question:string;materials:{name:string;text:string}[];system_prompt?:string;timeout_ms?:number;signal?:AbortSignal;call_id?:string;observe_reasoning?:boolean;directory?:string}
export type AnswerResult=Omit<ModelApiResult,'provider'>&{execution_mode?:'api'|'agent';reasoning_effort?:string;agent_session_id?:string};
export interface AnswerClient<T extends AnswerExecutionConfig=AnswerExecutionConfig> {answer(input:AnswerRequest<T>):Promise<AnswerResult>}
export interface AnswerFailure {kind:ModelApiErrorKind;retryable:boolean;http_status:number|null;provider_code:string|null;request_id:string|null}
