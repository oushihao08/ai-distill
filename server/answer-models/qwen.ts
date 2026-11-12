/**
 * 职责：保留 Qwen 作答客户端的兼容入口；实际供应商配置、凭证和 HTTP 调用统一由 llm-api 管理。
 * 关键入口：resolveQwenConfig() / createQwenClient() 供已有作答调用方和脚本使用。
 */
import {resolveQwenConfig} from '../llm-api';
import {createAnswerClient} from './dispatch';
import type {AnswerRequest} from './provider';
import type {ModelApiResult,QwenApiConfig} from '../llm-api';
export {resolveQwenConfig,ModelApiError as QwenError} from '../llm-api';
export type {ModelApiErrorKind as QwenErrorKind} from '../llm-api';
export type QwenConfig=QwenApiConfig;
export type QwenAnswerInput=AnswerRequest<QwenConfig>;
export type QwenAnswer=Omit<ModelApiResult,'provider'>;
export function createQwenClient(env:NodeJS.ProcessEnv=process.env,request:(input:string,init?:RequestInit)=>Promise<Response>=fetch){
 const api=createAnswerClient(env,request);
 return{async answer(input:QwenAnswerInput):Promise<QwenAnswer>{return await api.answer({...input,config:resolveQwenConfig(input.config,env)});}};
}
