/**
 * 职责：把已隔离的作答输入转换为独立 llm-api 请求，按冻结供应商配置调用 API 或隔离 Agent 并返回答案。
 * 关键入口：resolveAnswerConfig() 使用系统 API 默认并保留显式历史 Qwen 配置；createAnswerClient() 供作答队列使用。
 * 仅发送作答指令、题面及允许附件；不透传 rubric、标答或历史评测。结果区分 requested_model 与实际返回 model，Agent 无返回模型证据时后者为 null。
 */
import {createModelApiClient,readModelApiDefaults,resolveModelApiConfig,resolveQwenConfig,ModelApiError} from '../llm-api';
import type {AnswerClient,AnswerRequest,AnswerExecutionConfig} from './provider';
import {SYSTEM_STEP_PROMPTS} from '../../shared/step-prompts';
import {isAgentProviderConfig,isRegisteredAgentProvider,runAgent} from '../agent';
import {validateAgentModelSettings} from '../agent/config';
import {mkdir} from 'node:fs/promises';
import {answerLocalToolDefinitions,createAnswerLocalToolExecutor} from './local-tools';
import {resolve} from 'node:path';
export type ResolvedAnswerConfig=AnswerExecutionConfig;
export const ANSWER_SYSTEM_PROMPT=SYSTEM_STEP_PROMPTS[5];
const TOOL_SYSTEM_PROMPT='\n\n<available_tools>\n按题面真实需要使用本次实际提供的工具，不为增加调用数而调用。联网结论在正文标明可访问的来源链接。Shell用于计算、检索和校验，不等于操作用户设备。题面要求文件成果且提供 artifact_write 时，必须生成真实受管文件并用 artifact_render 读回校验；回复正文列出实际文件名、格式和关键内容，不得把计划、文件名或文本预览冒充已生成文件。artifact_render 对 DOCX/XLSX 只验证OOXML结构、摘要和规范化生成源，不代表像素级版式验收。\n</available_tools>';
export function resolveAnswerConfig(raw:unknown,env:NodeJS.ProcessEnv=process.env):ResolvedAnswerConfig{
 if(raw===undefined||raw===null||typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).length===0)return readModelApiDefaults(env);
 const provider=raw&&typeof raw==='object'&&!Array.isArray(raw)?(raw as Record<string,unknown>).provider:undefined;
 if(isRegisteredAgentProvider(provider)){
  const value=raw as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['provider','model','reasoning_effort'].includes(key)))throw new ModelApiError('configuration');
  try{return{provider,...validateAgentModelSettings(value)};}catch{throw new ModelApiError('configuration');}
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
 return{async answer(input){
  const config=resolveAnswerConfig(input.config,env);
  if(isAgentProviderConfig(config)){
   if(typeof input.directory!=='string'||!input.directory.trim())throw new ModelApiError('configuration');
   const messages=answerMessages(input);await mkdir(resolve(input.directory),{recursive:true,mode:0o700});
   const started=Date.now();
   const agent=await runAgent<string>({task_type:'model_answer',directory:input.directory,prompt:JSON.stringify({messages}),model:config.model,reasoning_effort:config.reasoning_effort,output_format:'text',timeout_ms:input.timeout_ms,signal:input.signal,call_id:input.call_id,validate(value){return typeof value==='string'?value:String(value??'');}});
   const finished=Date.now();
   return{text:agent.result,requested_model:config.model,model:agent.returned_model??null,request_id:null,completion_id:agent.session_id,usage:agent.usage&&typeof agent.usage==='object'?agent.usage as Record<string,unknown>:null,reasoning_tokens:null,completed_tool_calls:0,started_at:new Date(started).toISOString(),finished_at:new Date(finished).toISOString(),duration_ms:agent.duration_ms,execution_mode:'agent',reasoning_effort:config.reasoning_effort,agent_session_id:agent.session_id};
  }
  const messages=answerMessages(input);
  if(config.server_tools?.length||config.local_tools?.length)messages[0]={...messages[0]!,content:messages[0]!.content+TOOL_SYSTEM_PROMPT};
  if(config.local_tools?.length&&(!input.directory||!input.materials.length))throw new ModelApiError('configuration');
  const local=config.local_tools?.length?{function_tools:answerLocalToolDefinitions(config.local_tools),execute_function_tool:createAnswerLocalToolExecutor({materials:input.materials,directory:input.directory!,enabled:config.local_tools})}:{};
  const {provider,...result}=await api.complete({config,messages,timeout_ms:input.timeout_ms,signal:input.signal,...local,...(input.call_id?{call_id:input.call_id}:{}),...(input.observe_reasoning?{observe_reasoning:true}:{})});
  return{...result,execution_mode:'api'};
 }};
}
