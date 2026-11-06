/**
 * 职责：校验并冻结项目作答使用的 OpenRouter 服务端工具策略。
 * 关键入口：读取／合并步骤5配置，并把项目策略覆盖到本次 OpenRouter 模型快照。
 * 使用场景：项目设置接口保存策略；作答派发时生成不可变 attempt 配置。
 */
import type {AnswerLocalTool,ModelApiConfig,OpenRouterServerTool} from '../../shared/types';
import {ANSWER_LOCAL_TOOLS,OPENROUTER_SERVER_TOOLS} from '../../shared/types';

export interface AnswerToolPolicy {
 server_tools:OpenRouterServerTool[];
 local_tools:AnswerLocalTool[];
 max_tool_calls?:number;
}

function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}

export function parseAnswerToolPolicy(value:unknown):AnswerToolPolicy{
 if(!record(value)||Object.keys(value).some(key=>!['server_tools','local_tools','max_tool_calls'].includes(key))||!Array.isArray(value.server_tools)||!Array.isArray(value.local_tools??[]))throw new Error('OpenRouter作答工具设置无效');
 if(value.server_tools.length>OPENROUTER_SERVER_TOOLS.length||value.server_tools.some(tool=>typeof tool!=='string'||!OPENROUTER_SERVER_TOOLS.includes(tool as OpenRouterServerTool))||new Set(value.server_tools).size!==value.server_tools.length)throw new Error('OpenRouter服务端工具设置无效');
 const local=(value.local_tools??[]) as unknown[];if(local.length>ANSWER_LOCAL_TOOLS.length||local.some(tool=>typeof tool!=='string'||!ANSWER_LOCAL_TOOLS.includes(tool as AnswerLocalTool))||new Set(local).size!==local.length)throw new Error('本地作答工具设置无效');
 if(value.max_tool_calls!==undefined&&(!value.server_tools.length&&!local.length||!Number.isSafeInteger(value.max_tool_calls)||Number(value.max_tool_calls)<1||Number(value.max_tool_calls)>100))throw new Error('OpenRouter工具调用上限须为1至100');
 return{server_tools:[...value.server_tools] as OpenRouterServerTool[],local_tools:[...local] as AnswerLocalTool[],...(value.max_tool_calls!==undefined?{max_tool_calls:Number(value.max_tool_calls)}:{})};
}

export function readAnswerToolPolicyFromStepConfig(value:unknown):AnswerToolPolicy|undefined{
 if(!record(value)||value.answer_server_tools===undefined)return undefined;
 return parseAnswerToolPolicy(value.answer_server_tools);
}

export function mergeAnswerToolPolicyIntoStepConfig(value:unknown,policy:AnswerToolPolicy):Record<string,unknown>{
 if(value!==undefined&&value!==null&&!record(value))throw new Error('作答步骤配置无效');
 return{...(record(value)?value:{}),answer_server_tools:parseAnswerToolPolicy(policy)};
}

function isOpenRouter(config:ModelApiConfig):boolean{
 if(config.provider==='openrouter')return true;
 try{return config.provider==='qwen'&&new URL(config.base_url).hostname==='openrouter.ai';}catch{return false;}
}

export function applyAnswerToolPolicy(config:ModelApiConfig,policy:AnswerToolPolicy|undefined):ModelApiConfig{
 if(!policy||!isOpenRouter(config))return config;
 const {server_tools:_,local_tools:__,max_tool_calls:___,...plain}=config;
 return policy.server_tools.length||policy.local_tools.length?{...plain,...(policy.server_tools.length?{server_tools:[...policy.server_tools]}:{}),...(policy.local_tools.length?{local_tools:[...policy.local_tools]}:{}),...(policy.max_tool_calls!==undefined?{max_tool_calls:policy.max_tool_calls}:{})}:plain;
}

/** 题目只冻结其声明需要的工具；项目未开启的能力明确拒绝，不从旧结果或全局默认静默补齐。 */
export function requiredAnswerToolPolicy(policy:AnswerToolPolicy|undefined,required:string[]):AnswerToolPolicy|undefined{
 if(!required.length)return undefined;
 if(!policy)throw new Error('题目需要工具，但项目未配置作答工具');
 const available=new Set([...policy.server_tools,...policy.local_tools]);
 const missing=required.filter(tool=>!available.has(tool as any));
 if(missing.length)throw new Error(`题目需要的作答工具未启用：${missing.join('、')}`);
 return{server_tools:policy.server_tools.filter(tool=>required.includes(tool)),local_tools:policy.local_tools.filter(tool=>required.includes(tool)),...(policy.max_tool_calls!==undefined?{max_tool_calls:policy.max_tool_calls}:{})};
}
