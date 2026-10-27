/**
 * 职责：验证独立 Agent 任务入口与后端适配器的契约边界。
 * 关键验证：每个调用只传递本次任务、显式配置、取消和业务结果校验器。
 */
import {describe,expect,it} from 'bun:test';
import {configureAgentAdapter,runAgent,type AgentAdapter,type AgentTask} from './runner';

describe('runAgent',()=>{
 it('fresh authoring preserves execution settings without overriding native developer instructions',async()=>{
  let received:any;
  await runAgent({task_type:'question_authoring',execution_profile:'fresh_authoring',working_directory:'/tmp/project',directory:'/tmp/attempt',prompt:'查看指定 skill，出题',model:'fixture',reasoning_effort:'low',validate:(value:unknown)=>value} as any,async task=>{received=task;return{result:{},session_id:'new',usage:null,diagnostic_path:'private',duration_ms:1,provider:'fixture',model:'fixture'};});
  expect(received.developer_instructions).toBe('');expect(received.working_directory).toBe('/tmp/project');
  expect(received.execution_profile).toBe('fresh_authoring');
 });
 it('independent scoring never inherits the fresh authoring execution profile',async()=>{
  await expect(runAgent({task_type:'independent_scoring',execution_profile:'fresh_authoring',working_directory:'/tmp/project',directory:'/tmp/attempt',prompt:'score',model:'fixture',reasoning_effort:'low',validate:(v:unknown)=>v} as any)).rejects.toThrow('普通出题执行配置无效');
 });
 it('把本次任务和显式 Codex 配置交给后端适配器',async()=>{
  let received:(AgentTask<{ok:boolean}>&{developer_instructions:string})|undefined;
  const adapter:AgentAdapter<{ok:boolean}>=async task=>{received=task;return{result:{ok:true},session_id:'session-1',usage:null,diagnostic_path:'/private/events.jsonl',duration_ms:12,provider:'test-backend',model:'test-model'};};
  const result=await runAgent({
   task_type:'smoke',
   prompt:'只返回 ok=true',
   directory:'/tmp/agent-task',
   model:'gpt-6.1-sol',
   reasoning_effort:'low',
   call_id:'12345678-1234-1234-1234-123456789abc',
   schema:{type:'object'},
   validate:value=>value as {ok:boolean},
  },adapter);
  expect(received?.task_type).toBe('smoke');
  expect(received?.prompt).toBe('只返回 ok=true');
  expect(received?.model).toBe('gpt-6.1-sol');
  expect(received?.reasoning_effort).toBe('low');
  expect(received?.call_id).toBe('12345678-1234-1234-1234-123456789abc');
  expect(received?.directory).toBe('/tmp/agent-task');
  expect(received?.developer_instructions).toContain('独立任务执行器');
  expect(result.result).toEqual({ok:true});
  expect(result.provider).toBe('test-backend');
  expect(result.model).toBe('test-model');
  expect(result.requested_model).toBe('gpt-6.1-sol');
  expect(result.returned_model).toBeNull();
 });
 it('仅保留适配器明确返回的实际模型，不将旧model字段作为返回模型证据',async()=>{
  const task={task_type:'smoke',directory:'/tmp/agent-task',prompt:'只返回合成结果',model:'requested-model',reasoning_effort:'low',validate:(value:unknown)=>value};
  const result=await runAgent(task,async()=>({result:{ok:true},session_id:'session',usage:null,diagnostic_path:'private',duration_ms:1,provider:'fixture',model:'legacy-model',requested_model:'incorrect-request',returned_model:'actual-model'}));
  expect(result.model).toBe('legacy-model');expect(result.requested_model).toBe('requested-model');expect(result.returned_model).toBe('actual-model');
 });
 it('allows the module default backend to change without changing task callers',async()=>{
  configureAgentAdapter(async task=>({result:{ok:true},session_id:'api-session',usage:null,diagnostic_path:'api-call',duration_ms:7,provider:'api',model:task.model}));
  try{
   const result=await runAgent({task_type:'smoke',prompt:'return JSON',directory:'/tmp/agent-task',model:'api-model',reasoning_effort:'low',schema:{type:'object'},validate:value=>value as {ok:boolean}});
   expect(result.provider).toBe('api');expect(result.model).toBe('api-model');expect(result.session_id).toBe('api-session');
  }finally{configureAgentAdapter(null);}
 });
});
