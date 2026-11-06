/**
 * 验证项目 OpenRouter 服务端工具策略的校验、步骤配置合并及 attempt 配置覆盖边界。
 */
import {describe,expect,test} from 'bun:test';
import {applyAnswerToolPolicy,mergeAnswerToolPolicyIntoStepConfig,parseAnswerToolPolicy,readAnswerToolPolicyFromStepConfig} from './tool-policy';

describe('answer tool policy',()=>{
 test('validates and round-trips a project policy',()=>{
  const policy=parseAnswerToolPolicy({server_tools:['web_search','web_fetch','shell'],local_tools:['attachment_list','artifact_write'],max_tool_calls:12});
  const config=mergeAnswerToolPolicyIntoStepConfig({prompt:'保留'},policy);
  expect(config).toEqual({prompt:'保留',answer_server_tools:policy});
  expect(readAnswerToolPolicyFromStepConfig(config)).toEqual(policy);
 });

 test('rejects unknown, duplicated and unbounded tools',()=>{
  expect(()=>parseAnswerToolPolicy({server_tools:['browser']})).toThrow();
  expect(()=>parseAnswerToolPolicy({server_tools:['web_search','web_search']})).toThrow();
  expect(()=>parseAnswerToolPolicy({server_tools:[],max_tool_calls:1})).toThrow();
  expect(()=>parseAnswerToolPolicy({server_tools:['shell'],max_tool_calls:101})).toThrow();
 });

 test('overrides only OpenRouter-backed model snapshots and supports explicit disable',()=>{
  const router={provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',server_tools:['shell' as const],max_tool_calls:2};
  expect(applyAnswerToolPolicy(router,{server_tools:['web_search'],local_tools:['attachment_read'],max_tool_calls:8})).toEqual({...router,server_tools:['web_search'],local_tools:['attachment_read'],max_tool_calls:8});
  expect(applyAnswerToolPolicy(router,{server_tools:[],local_tools:[]})).toEqual({provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'});
  const deepseek={provider:'deepseek' as const,base_url:'https://api.deepseek.com',model:'deepseek-chat'};
  expect(applyAnswerToolPolicy(deepseek,{server_tools:['web_search'],local_tools:[]})).toBe(deepseek);
 });
});
