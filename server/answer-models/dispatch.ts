/**
 * 职责：把已隔离的作答输入转换为独立 llm-api 请求，按冻结供应商配置调用并返回答案。
 * 关键入口：resolveAnswerConfig() 保留历史 Qwen 默认配置；createAnswerClient() 供作答队列使用。
 * 仅发送题面和允许附件，不把 rubric、标答、目标分数或其他输入透传给 API。
 */
import {createModelApiClient,resolveModelApiConfig,resolveQwenConfig,ModelApiError,type ModelApiConfig} from '../llm-api';
import type {AnswerClient,AnswerRequest} from './provider';
export type ResolvedAnswerConfig=ModelApiConfig;
export const ANSWER_SYSTEM_PROMPT='仅依据用户消息中的题面和附件独立作答。最终答案直接写在回复正文中，只返回纯文本；不得生成、上传或附加 DOCX、PDF 等文件，也不得声称已生成文件。';
export function resolveAnswerConfig(raw:unknown,env:NodeJS.ProcessEnv=process.env):ResolvedAnswerConfig{
 const provider=raw&&typeof raw==='object'&&!Array.isArray(raw)?(raw as Record<string,unknown>).provider:undefined;
 return provider===undefined||provider==='qwen'?resolveQwenConfig(raw,env):resolveModelApiConfig(raw,env);
}
export function answerMessages(input:AnswerRequest){
 if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['config','question','materials','timeout_ms','signal','call_id','observe_reasoning'].includes(key))||typeof input.question!=='string'||!input.question.trim()||!Array.isArray(input.materials)||input.call_id!==undefined&&(typeof input.call_id!=='string'||!input.call_id.trim())||input.observe_reasoning!==undefined&&typeof input.observe_reasoning!=='boolean')throw new ModelApiError('configuration');
 const materials=input.materials.map(material=>{
  if(!material||typeof material!=='object'||Object.keys(material).some(key=>!['name','text'].includes(key))||typeof material.name!=='string'||!material.name.trim()||typeof material.text!=='string'||!material.text.trim())throw new ModelApiError('configuration');
  return{name:material.name,text:material.text};
 });
 return[{role:'system' as const,content:ANSWER_SYSTEM_PROMPT},{role:'user' as const,content:JSON.stringify({question:input.question,materials})}];
}
export function createAnswerClient(env:NodeJS.ProcessEnv=process.env,request:(input:string,init?:RequestInit)=>Promise<Response>=fetch):AnswerClient<ResolvedAnswerConfig>{
 const api=createModelApiClient(env,request);
 return{async answer(input){try{
  const messages=answerMessages(input),config=resolveAnswerConfig(input.config,env);
  const {provider,...result}=await api.complete({config,messages,timeout_ms:input.timeout_ms,signal:input.signal,...(input.call_id?{call_id:input.call_id}:{}),...(input.observe_reasoning?{observe_reasoning:true}:{})});
  return result;
 }catch(error){throw error;}}};
}
