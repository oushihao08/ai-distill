/**
 * 职责：保留 Kimi / DeepSeek / 豆包 / OpenRouter 作答客户端的兼容入口；实际 HTTP 调用由 llm-api 管理。
 * 关键入口：resolveDomesticConfig() 与 createDomesticClient()；不在业务模块维护供应商网络实现。
 */
import {resolveOtherApiConfig,type OtherApiConfig} from '../llm-api';
import {createAnswerClient} from './dispatch';
import type {AnswerClient} from './provider';
export {ModelApiError as DomesticError} from '../llm-api';
export type {ModelApiErrorKind as DomesticErrorKind} from '../llm-api';
export type DomesticConfig=OtherApiConfig;
export const resolveDomesticConfig=resolveOtherApiConfig;
export function createDomesticClient(env:NodeJS.ProcessEnv=process.env,request:(input:string,init?:RequestInit)=>Promise<Response>=fetch):AnswerClient<DomesticConfig>{
 const client=createAnswerClient(env,request);
 return{async answer(input){return await client.answer({...input,config:resolveOtherApiConfig(input.config,env)});}};
}
