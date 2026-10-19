/**
 * 职责：把已隔离的作答输入转换为独立 llm-api 请求，按冻结供应商配置调用API或隔离Codex并返回答案。
 * 关键入口：resolveAnswerConfig() 保留历史 Qwen 默认配置；createAnswerClient() 供作答队列使用。
 * 仅发送隔离后的作答指令、题面、白名单附件及允许的成果呈现清单；不透传 rubric、标答、目标分数或历史作答数据。
 */
import {createModelApiClient,resolveModelApiConfig,resolveQwenConfig,ModelApiError,type ModelApiConfig} from '../llm-api';
import type {AnswerClient,AnswerRequest} from './provider';
import {SYSTEM_STEP_PROMPTS} from '../../shared/step-prompts';
import {runAgent} from '../agent/runner';
import {validateAgentModelSettings} from '../agent/config';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {CodexAnswerConfig,AnswerExecutionConfig} from './provider';
export type ResolvedAnswerConfig=AnswerExecutionConfig;
export const ANSWER_SYSTEM_PROMPT=SYSTEM_STEP_PROMPTS[5];
export function resolveAnswerConfig(raw:unknown,env:NodeJS.ProcessEnv=process.env):ResolvedAnswerConfig{
 const provider=raw&&typeof raw==='object'&&!Array.isArray(raw)?(raw as Record<string,unknown>).provider:undefined;
 if(provider==='codex'){
  const value=raw as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['provider','model','reasoning_effort'].includes(key)))throw new ModelApiError('configuration');
  try{return{provider:'codex',...validateAgentModelSettings(value)};}catch{throw new ModelApiError('configuration');}
 }
 return provider===undefined||provider==='qwen'?resolveQwenConfig(raw,env):resolveModelApiConfig(raw,env);
}
export function answerMessages(input:AnswerRequest){
 if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['config','question','materials','system_prompt','timeout_ms','signal','call_id','observe_reasoning','directory'].includes(key))||typeof input.question!=='string'||!input.question.trim()||!Array.isArray(input.materials)||input.system_prompt!==undefined&&(typeof input.system_prompt!=='string'||!input.system_prompt.trim())||input.call_id!==undefined&&(typeof input.call_id!=='string'||!input.call_id.trim())||input.observe_reasoning!==undefined&&typeof input.observe_reasoning!=='boolean')throw new ModelApiError('configuration');
 const materials=input.materials.map(material=>{
  if(!material||typeof material!=='object'||Object.keys(material).some(key=>!['name','text'].includes(key))||typeof material.name!=='string'||!material.name.trim()||typeof material.text!=='string'||!material.text.trim())throw new ModelApiError('configuration');
  return{name:material.name,text:material.text};
 });
 return[{role:'system' as const,content:input.system_prompt??ANSWER_SYSTEM_PROMPT},{role:'user' as const,content:JSON.stringify({question:input.question,materials})}];
}
export function createAnswerClient(env:NodeJS.ProcessEnv=process.env,request:(input:string,init?:RequestInit)=>Promise<Response>=fetch):AnswerClient<ResolvedAnswerConfig>{
 const api=createModelApiClient(env,request);
 return{async answer(input){try{
  const config=resolveAnswerConfig(input.config,env);
  if(config.provider==='codex'){
   if(typeof input.directory!=='string'||!input.directory.trim())throw new ModelApiError('configuration');
   const messages=answerMessages(input);await mkdir(resolve(input.directory),{recursive:true,mode:0o700});
   const started=Date.now();
   const agent=await runAgent<string>({task_type:'model_answer',directory:input.directory,prompt:JSON.stringify({messages}),model:config.model,reasoning_effort:config.reasoning_effort,output_format:'text',timeout_ms:input.timeout_ms,signal:input.signal,call_id:input.call_id,validate(value){if(typeof value!=='string'||!value.trim())throw new Error('答案为空');return value.trim();}});
   const finished=Date.now();
   return{text:agent.result,requested_model:config.model,model:agent.model,request_id:null,completion_id:agent.session_id,usage:agent.usage&&typeof agent.usage==='object'?agent.usage as Record<string,unknown>:null,started_at:new Date(started).toISOString(),finished_at:new Date(finished).toISOString(),duration_ms:agent.duration_ms,execution_mode:'agent',reasoning_effort:config.reasoning_effort,agent_session_id:agent.session_id};
  }
  const messages=answerMessages(input);
  const {provider,...result}=await api.complete({config,messages,timeout_ms:input.timeout_ms,signal:input.signal,...(input.call_id?{call_id:input.call_id}:{}),...(input.observe_reasoning?{observe_reasoning:true}:{})});
  return{...result,execution_mode:'api'};
 }catch(error){throw error;}}};
}
