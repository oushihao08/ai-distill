/** 验证脱敏执行预算校验及 DeepSeek 默认配置，不读取环境凭证、不调用模型。 */
import {expect,test} from 'bun:test';
import {DEFAULT_REDACTION_EXECUTION,resolveRedactionExecution,estimateRedactionTokens} from './redaction-execution';
import {readModelApiDefaults} from '../llm-api/config';
import {mergeRedactionDefaults} from './redaction-config';
test('脱敏统一默认是DeepSeek V4.1 Flash并关闭思考',()=>{
 expect(readModelApiDefaults({})).toMatchObject({provider:'openrouter',model:'deepseek/deepseek-v4.1-flash',enable_thinking:false});
});
test('显式模型和思考配置不被默认值覆盖',()=>{
 const api={provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'deepseek/deepseek-v4.1-flash',enable_thinking:true} as const;
 const merged=mergeRedactionDefaults({provider:'api',api,prompt:'规则'},{model:'',reasoning_effort:''});expect('api'in merged?merged.api:undefined).toMatchObject(api);
 expect(readModelApiDefaults({LLM_API_MODEL:'z-ai/glm-5.3-flash'}).enable_thinking).toBeUndefined();
});
test('预算拒绝无界并发、非法时限及未知字段',()=>{
 for(const value of [{concurrency:9},{request_timeout_ms:0},{max_fields:0},{max_calls:-1},{unknown:1}])expect(()=>resolveRedactionExecution(value as any)).toThrow();
 expect(resolveRedactionExecution({concurrency:2,max_calls:3})).toMatchObject({concurrency:2,max_calls:3});
 expect(DEFAULT_REDACTION_EXECUTION.concurrency).toBe(8);
 expect(estimateRedactionTokens('姓名张三')).toBeGreaterThan(estimateRedactionTokens('abcd'));
});
