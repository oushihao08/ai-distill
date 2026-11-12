/**
 * 职责：验证独立 Agent 任务入口与多驱动后端注册表、适配器的契约边界。
 * 关键验证：每个调用只传递本次任务、显式配置、取消和业务结果校验器；支持 codex 默认路由、agy 命名空间路由及自定义驱动动态注册。
 */
import {describe,expect,it} from 'bun:test';
import {configureAgentAdapter,runAgent,type AgentAdapter,type AgentTask} from './runner';
import {isRegisteredAgentProvider,registerAgentDriver,resetAgentDrivers,resolveAgentDriver,readMergedAgentModelCatalog} from './driver';

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
 it('routes models across codex, agy, and dynamically registered custom AgentDrivers',async()=>{
  try{
   expect(isRegisteredAgentProvider('codex')).toBe(true);
   expect(isRegisteredAgentProvider('agy')).toBe(true);
   expect(isRegisteredAgentProvider('openrouter')).toBe(false);
   expect(resolveAgentDriver('gpt-6.1-sol')).toMatchObject({driver:{id:'codex'},resolvedModel:'gpt-6.1-sol'});
   expect(resolveAgentDriver('codex:gpt-5.6-sol')).toMatchObject({driver:{id:'codex'},resolvedModel:'gpt-5.6-sol'});
   expect(resolveAgentDriver('agy:gemini-4-argon')).toMatchObject({driver:{id:'agy'},resolvedModel:'gemini-4-argon'});
   expect(resolveAgentDriver('gemini-3.8-flash-medium')).toMatchObject({driver:{id:'agy'},resolvedModel:'gemini-3.8-flash-medium'});
   expect(()=>resolveAgentDriver('unregistered:model-x')).toThrow('未注册的Agent驱动');

   let capturedResolvedModel='';
   registerAgentDriver({
    id:'custom-cli',
    label:'Custom CLI',
    readModelCatalog:()=>[{slug:'custom-cli:alpha',supported_reasoning_levels:[{effort:'high'}]}],
    async execute(task){
     capturedResolvedModel=task.resolved_model;
     return{
      result:task.validate({ok:true}),
      session_id:'custom-session',
      usage:{total_tokens:42},
      diagnostic_path:'/tmp/custom-events.jsonl',
      duration_ms:5,
      provider:'custom-cli',
      model:task.model,
      requested_model:task.model,
      returned_model:'alpha-v2',
     };
    },
   });
   expect(readMergedAgentModelCatalog().some(item=>item.slug==='custom-cli:alpha')).toBe(true);
   const res=await runAgent({
    task_type:'smoke',
    directory:'/tmp/custom-task',
    prompt:'test custom driver',
    model:'custom-cli:alpha',
    reasoning_effort:'high',
    schema:{type:'object'},
    validate:v=>v as {ok:boolean},
   });
   expect(capturedResolvedModel).toBe('alpha');
   expect(res.provider).toBe('custom-cli');
   expect(res.requested_model).toBe('custom-cli:alpha');
   expect(res.returned_model).toBe('alpha-v2');
  }finally{
   resetAgentDrivers();
  }
 });
});
