import type {QwenAnswer,QwenErrorKind} from './qwen';
// Structural contract: existing Qwen remains compatible without changing its runtime.
export type AnswerProvider='qwen'|'kimi'|'deepseek'|'doubao'|'openrouter';
export interface AnswerModelConfig {provider:AnswerProvider;base_url:string;model:string;max_tokens?:number}
export interface AnswerRequest<T extends AnswerModelConfig=AnswerModelConfig> {config:T;question:string;materials:{name:string;text:string}[];timeout_ms?:number;signal?:AbortSignal}
export type AnswerResult=QwenAnswer;
export interface AnswerClient<T extends AnswerModelConfig=AnswerModelConfig> {answer(input:AnswerRequest<T>):Promise<AnswerResult>}
export interface AnswerFailure {kind:QwenErrorKind;retryable:boolean;http_status:number|null;provider_code:string|null;request_id:string|null}
