/**
 * 职责：提供独立 Agent 执行任务的公共契约与单次调用入口。
 * 关键方法：`runAgent()` 将明确任务交给所选执行适配器。
 * 使用场景：worker 中的业务执行器调用本模块，不直接依赖 CLI 进程接口。
 */
import {runCodex} from '../codex/client';
import {AGENT_DEVELOPER_INSTRUCTIONS} from './system-instructions';
export {SCORE_ISOLATION_CONFIG} from '../codex/client';
import {registerAgentProcess} from './processes';

/** 单次任务的模型和工作目录等运行设置由业务队列冻结后传入。 */
export interface AgentTask<T=unknown>{
 task_type:string;
 directory:string;
	execution_profile?:'fresh_authoring'|'project_delivery';
 working_directory?:string;
 prompt:string;
 model:string;
 reasoning_effort:string;
 schema?:Record<string,unknown>;
 output_format?:'text';
 input_files?:{name:string;text:string}[];
 validate:(value:unknown)=>T;
 timeout_ms?:number;
 signal?:AbortSignal;
 call_id?:string;
}

export interface AgentResult<T=unknown>{
 result:T;session_id:string;usage:unknown;diagnostic_path:string;duration_ms:number;provider:string;
 /** 历史适配器字段；Codex后端一直记录请求配置，不作为实际返回模型证据。 */
 model:string;
 /** runAgent统一补齐请求模型；字段可选以兼容已有适配器与历史记录。 */
 requested_model?:string;
 /** 仅由后端明确提供的返回模型，缺少证据时为null，不从model推断。 */
 returned_model?:string|null;
}
export type AgentAdapter<T=unknown>=(task:AgentTask<T>&{developer_instructions:string})=>Promise<Omit<AgentResult<T>,'result'>&{result:T}>;

let configuredAdapter:AgentAdapter<any>=runCodexAdapter;
/** 后端选择集中在模块装配处，业务调用始终使用相同任务契约。 */
export function configureAgentAdapter(adapter:AgentAdapter<any>|null){configuredAdapter=adapter??runCodexAdapter;}

/** 评分、模型作答与普通出题不注入通用开发者指令；其余业务任务保留通用边界指令。 */
export async function runAgent<T>(task:AgentTask<T>,adapter:AgentAdapter<T>=configuredAdapter as AgentAdapter<T>):Promise<AgentResult<T>>{
 if(!task.task_type.trim()||!task.prompt.trim()||!task.directory.trim()||!task.model.trim()||!task.reasoning_effort.trim())throw new Error('Agent任务配置无效');
 if(task.execution_profile==='fresh_authoring'&&(task.task_type!=='question_authoring'||!task.working_directory?.trim()))throw new Error('普通出题执行配置无效');
 if(task.execution_profile==='project_delivery'&&task.task_type!=='project_delivery')throw new Error('项目交付执行配置无效');
 const result=await adapter({...task,developer_instructions:task.task_type==='independent_scoring'||task.task_type==='model_answer'||task.execution_profile==='fresh_authoring'?'':AGENT_DEVELOPER_INSTRUCTIONS});
 return {...result,requested_model:task.model,returned_model:result.returned_model??null};
}

async function runCodexAdapter<T>(task:AgentTask<T>&{developer_instructions:string}){
 let unregister:(()=>void)|undefined;
 const result=await runCodex({directory:task.directory,execution_profile:task.execution_profile,working_directory:task.working_directory,prompt:task.prompt,model:task.model,reasoning_effort:task.reasoning_effort,schema:task.schema,output_format:task.output_format,input_files:task.input_files,validate:task.validate,timeout_ms:task.timeout_ms,signal:task.signal,call_id:task.call_id,developer_instructions:task.developer_instructions,isolate_context:task.task_type==='independent_scoring'||task.task_type==='model_answer'||task.task_type==='revision_advice'||task.task_type==='material_preparation',onProcess(pid){if(pid===null){unregister?.();unregister=undefined;}else unregister=registerAgentProcess(pid);}});
 return{result:result.result,session_id:result.session_id,usage:result.usage,diagnostic_path:result.events_path,duration_ms:result.duration_ms,provider:'codex',model:task.model,requested_model:task.model,returned_model:null};
}
