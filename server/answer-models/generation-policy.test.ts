/**
 * 职责：验证作答时长配置的缺省兼容、输入边界和长推理超时免评分资格。
 * 主要验证边界：默认关闭、严格超过阈值、可信推理增量、仅本地超时和断流间隔。
 */
import {expect,test} from 'bun:test';
import {
 answerProviderConfigFromStepConfig,
 DEFAULT_ANSWER_GENERATION_POLICY,
 MAX_REASONING_EVENT_GAP_MS,
 isQualifiedLongGenerationTimeout,
 mergeAnswerGenerationPolicyIntoStepConfig,
 readAnswerGenerationPolicyFromStepConfig,
 serializeAnswerGenerationPolicyMinutes,
 parseAnswerGenerationPolicyMinutes,
 resolveAnswerGenerationPolicy,
 resolveAnswerCallSettings,
} from './generation-policy';

test('missing policy preserves the current 60-minute request and keeps score skipping disabled',()=>{
 expect(resolveAnswerGenerationPolicy(undefined)).toEqual(DEFAULT_ANSWER_GENERATION_POLICY);
 expect(DEFAULT_ANSWER_GENERATION_POLICY).toMatchObject({request_timeout_ms:3_600_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:false});
});

test('policy reads are read-only defaults and merging preserves existing provider settings',()=>{
 const config={provider:'qwen',model:'qwen-plus',enable_thinking:true};
 expect(readAnswerGenerationPolicyFromStepConfig(config)).toEqual(DEFAULT_ANSWER_GENERATION_POLICY);
 const policy=parseAnswerGenerationPolicyMinutes({request_timeout_minutes:90,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:false});
 const merged=mergeAnswerGenerationPolicyIntoStepConfig(config,policy);
 expect(merged).toEqual({...config,answer_generation_policy:policy});
 expect(serializeAnswerGenerationPolicyMinutes(merged.answer_generation_policy)).toEqual({request_timeout_minutes:90,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:false,source:'project'});
 expect(config).toEqual({provider:'qwen',model:'qwen-plus',enable_thinking:true});
 expect(answerProviderConfigFromStepConfig(merged)).toEqual(config);
});

test('minute settings require integer durations with timeout strictly longer than the threshold',()=>{
 expect(parseAnswerGenerationPolicyMinutes({request_timeout_minutes:60,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:false})).toEqual({request_timeout_ms:3_600_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:false});
 for(const value of [
  {request_timeout_minutes:45,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:true},
  {request_timeout_minutes:0,reasoning_threshold_minutes:1,skip_scoring_on_qualified_timeout:false},
  {request_timeout_minutes:1.5,reasoning_threshold_minutes:1,skip_scoring_on_qualified_timeout:false},
  {request_timeout_minutes:60,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:true},
  {request_timeout_minutes:60,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:'true'},
 ])expect(()=>parseAnswerGenerationPolicyMinutes(value)).toThrow();
});

test('a stored opt-in cannot enable automatic skipping before provider timing is validated',()=>{
 expect(resolveAnswerGenerationPolicy({request_timeout_ms:5_400_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:true})).toMatchObject({request_timeout_ms:5_400_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:false});
});

test('request timeout remains separate from the reasoning threshold',()=>{
 const enabled={...DEFAULT_ANSWER_GENERATION_POLICY,request_timeout_ms:5_400_000,skip_scoring_on_qualified_timeout:true};
 expect(resolveAnswerCallSettings(enabled)).toEqual({timeout_ms:5_400_000,observe_reasoning:false});
 expect(resolveAnswerCallSettings({...enabled,skip_scoring_on_qualified_timeout:false})).toMatchObject({timeout_ms:5_400_000,observe_reasoning:false});
});

function evidence(span_ms:number,max_gap_ms=1_000,event_count=2){return{source:'openrouter_reasoning_details' as const,first_event_at:'2026-10-11T00:00:00.000Z',last_event_at:'2026-10-11T00:45:01.000Z',span_ms,max_gap_ms,event_count};}
const enabled={...DEFAULT_ANSWER_GENERATION_POLICY,skip_scoring_on_qualified_timeout:true};

test('observed reasoning span does not qualify before its delivery timing is validated',()=>{
 const base={kind:'timeout',reason_code:'local_deadline',generation_activity:evidence(DEFAULT_ANSWER_GENERATION_POLICY.reasoning_threshold_ms+1)};
 expect(isQualifiedLongGenerationTimeout(base,enabled)).toBe(false);
 expect(isQualifiedLongGenerationTimeout({...base,generation_activity:evidence(DEFAULT_ANSWER_GENERATION_POLICY.reasoning_threshold_ms)},enabled)).toBe(false);
 expect(isQualifiedLongGenerationTimeout({...base,reason_code:'provider_http_408'},enabled)).toBe(false);
 expect(isQualifiedLongGenerationTimeout({...base,kind:'network'},enabled)).toBe(false);
 expect(isQualifiedLongGenerationTimeout(base,DEFAULT_ANSWER_GENERATION_POLICY)).toBe(false);
});

test('missing, sparse, malformed or excessively gapped reasoning events fail closed',()=>{
 const base={kind:'timeout',reason_code:'local_deadline'};
 expect(isQualifiedLongGenerationTimeout(base,enabled)).toBe(false);
 expect(isQualifiedLongGenerationTimeout({...base,generation_activity:evidence(3_000_000,MAX_REASONING_EVENT_GAP_MS+1)},enabled)).toBe(false);
 expect(isQualifiedLongGenerationTimeout({...base,generation_activity:evidence(3_000_000,1_000,1)},enabled)).toBe(false);
 expect(isQualifiedLongGenerationTimeout({...base,generation_activity:{...evidence(3_000_000),source:'unknown'}},enabled)).toBe(false);
});

test('provider reasoning streams without validated delivery timing never qualify for automatic score skipping',()=>{
 const base={kind:'timeout',reason_code:'local_deadline'};
 for(const source of ['openrouter_reasoning_details','openrouter_reasoning','dashscope_reasoning_content'] as const){
  expect(isQualifiedLongGenerationTimeout({...base,generation_activity:{...evidence(3_000_000),source}},enabled)).toBe(false);
 }
});
