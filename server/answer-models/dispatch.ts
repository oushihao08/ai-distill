import {resolveQwenConfig,createQwenClient,type QwenConfig} from './qwen';
import {resolveDomesticConfig,createDomesticClient,type DomesticConfig} from './domestic';
import type {AnswerClient} from './provider';
export type ResolvedAnswerConfig=QwenConfig|DomesticConfig;
export function resolveAnswerConfig(raw:unknown,env:NodeJS.ProcessEnv=process.env):ResolvedAnswerConfig {
 const provider=raw&&typeof raw==='object'&&!Array.isArray(raw)?(raw as Record<string,unknown>).provider:undefined;
 return provider===undefined||provider==='qwen'?resolveQwenConfig(raw,env):resolveDomesticConfig(raw,env);
}
export function createAnswerClient(env:NodeJS.ProcessEnv=process.env,request:(input:string,init?:RequestInit)=>Promise<Response>=fetch):AnswerClient<ResolvedAnswerConfig>{
 return {async answer(input){try{
  const config=resolveAnswerConfig(input.config,env);
  return config.provider==='qwen'?await createQwenClient(env,request).answer({...input,config}):await createDomesticClient(env,request).answer({...input,config});
 }catch(error){throw error;}}};
}
