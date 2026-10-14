/** 职责：脱敏执行预算及可序列化进度；resolveRedactionExecution 固定有界策略，estimateRedactionTokens 为打包提供保守估算。仅供脱敏执行器、队列和定向测试使用，不改变模型或脱敏规则。 */
export interface RedactionExecutionPolicy {
 max_fields:number;max_characters:number;max_input_tokens:number;max_output_tokens:number;concurrency:number;
 queue_timeout_ms:number;request_timeout_ms:number;task_timeout_ms:number;stall_timeout_ms:number;max_calls:number;
}
export type {RedactionProgress} from '../../shared/types';
// Fixed per-task ceiling matches the shared API worker's default 8 slots; the global gate still caps
// aggregate traffic, so one task can use otherwise-idle capacity without creating unbounded requests.
// These are operating bounds, not a provider-speed promise. Queue time is included in request/task deadlines.
export const DEFAULT_REDACTION_EXECUTION:Readonly<RedactionExecutionPolicy>=Object.freeze({max_fields:256,max_characters:10000,max_input_tokens:12000,max_output_tokens:16384,concurrency:8,queue_timeout_ms:45000,request_timeout_ms:180000,task_timeout_ms:1200000,stall_timeout_ms:360000,max_calls:0});
export function resolveRedactionExecution(value:Partial<RedactionExecutionPolicy>={}):RedactionExecutionPolicy{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_REDACTION_EXECUTION,key)))throw new Error('脱敏执行预算无效');
 const policy={...DEFAULT_REDACTION_EXECUTION,...value};
 for(const [key,n] of Object.entries(policy))if(!Number.isSafeInteger(n)||n<(key==='max_calls'?0:1)||n>2147483647)throw new Error('脱敏执行预算无效');
 if(policy.concurrency>8||policy.max_fields>1024)throw new Error('脱敏执行并发或字段预算超限');
 return policy;
}
/** 不是模型 tokenizer 的精确计数；中文按每字符1.5 token、ASCII按每4字符1 token估算，打包另外保留输出余量。 */
export function estimateRedactionTokens(text:string){let units=0;for(const ch of text)units+=ch.codePointAt(0)!<=127?0.25:1.5;return Math.ceil(units);}
