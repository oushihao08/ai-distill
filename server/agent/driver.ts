/**
 * 职责：管理可插拔 Agent CLI 驱动注册表，按模型标识命名空间（`<driver>:<model>`）或模型特征分发任务，并汇总多驱动模型目录。
 * 核心入口：
 * - `registerAgentDriver()` / `unregisterAgentDriver()`：动态扩展或卸载 CLI 驱动。
 * - `isRegisteredAgentProvider()`：判断配置中的 `provider` 标识是否属于已注册的 CLI Agent 驱动。
 * - `resolveAgentDriver()`：将业务模型字符串解析为目标驱动与底层模型名。
 * - `readAgentDriverCatalogs()` / `readMergedAgentModelCatalog()`：汇总各驱动可选模型与推理强度。
 * 不变量与修改禁区：
 * - 默认 `codex` 驱动不可卸载；未带前缀且未命中其他驱动 `matchesModel` 的模型名固定回退到 `codex`。
 * - 独立评分、模型作答、返修建议、材料整理固定开启 `isolate_context` 隔离宿主上下文。
 */
import {runCodex} from '../codex/client';
import {readCodexModelCatalog,type AdvertisedModel} from '../codex/models';
import {runAgy} from '../antigravity/client';
import {AGY_DRIVER_ID,isAgyModel,readAgyModelCatalog,stripAgyPrefix} from '../antigravity/models';
import type {CliClientOptions} from './cli-runtime';
import {registerAgentProcess} from './processes';
import type {AgentResult,AgentTask} from './runner';

export interface AgentDriver {
 readonly id:string;
 readonly label:string;
 /** 可选：当模型未带 `<id>:` 前缀时，判断该无前缀模型名是否归属本驱动。 */
 matchesModel?(model:string):boolean;
 /** 读取该驱动在本机公开的模型与推理强度目录。 */
 readModelCatalog(credentialHome?:string):AdvertisedModel[];
 /** 执行单次任务并返回符合 AgentResult 契约的结果。 */
 execute<T>(task:AgentTask<T>&{developer_instructions:string;resolved_model:string}):Promise<Omit<AgentResult<T>,'result'>&{result:T}>;
}

export interface AgentDriverCatalog {
 id:string;
 label:string;
 model_options:AdvertisedModel[];
}

function isIsolatedTask(task_type:string):boolean{
 return task_type==='independent_scoring'||task_type==='model_answer'||task_type==='revision_advice'||task_type==='material_preparation';
}

async function executeCliDriverTask<T>(
 provider:string,
 task:AgentTask<T>&{developer_instructions:string;resolved_model:string},
 runner:(options:CliClientOptions<T>)=>Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number;returned_model?:string|null}>
):Promise<Omit<AgentResult<T>,'result'>&{result:T}>{
 let unregister:(()=>void)|undefined;
 const result=await runner({
  directory:task.directory,
  execution_profile:task.execution_profile,
  working_directory:task.working_directory,
  prompt:task.prompt,
  model:task.resolved_model,
  reasoning_effort:task.reasoning_effort,
  schema:task.schema,
  output_format:task.output_format,
  input_files:task.input_files,
  validate:task.validate,
  timeout_ms:task.timeout_ms,
  signal:task.signal,
  call_id:task.call_id,
  developer_instructions:task.developer_instructions,
  isolate_context:isIsolatedTask(task.task_type),
  onProcess(pid){
   if(pid===null){unregister?.();unregister=undefined;}
   else unregister=registerAgentProcess(pid);
  },
 });
 return{
  result:result.result,
  session_id:result.session_id,
  usage:result.usage,
  diagnostic_path:result.events_path,
  duration_ms:result.duration_ms,
  provider,
  model:task.model,
  requested_model:task.model,
  returned_model:result.returned_model??null,
 };
}

export const codexDriver:AgentDriver={
 id:'codex',
 label:'Codex CLI',
 readModelCatalog(credentialHome?:string){
  return readCodexModelCatalog(credentialHome);
 },
 execute<T>(task:AgentTask<T>&{developer_instructions:string;resolved_model:string}){
  return executeCliDriverTask('codex',task,runCodex);
 },
};

export const agyDriver:AgentDriver={
 id:AGY_DRIVER_ID,
 label:'Antigravity CLI',
 matchesModel(model:string){
  return isAgyModel(model);
 },
 readModelCatalog(){
  return readAgyModelCatalog();
 },
 execute<T>(task:AgentTask<T>&{developer_instructions:string;resolved_model:string}){
  return executeCliDriverTask(AGY_DRIVER_ID,task,runAgy);
 },
};

const drivers=new Map<string,AgentDriver>([
 [codexDriver.id,codexDriver],
 [agyDriver.id,agyDriver],
]);

export function registerAgentDriver(driver:AgentDriver):void{
 const id=driver?.id?.trim().toLowerCase();
 if(!id||!/^[a-z][a-z0-9_-]{0,31}$/.test(id))throw new Error('Agent驱动标识无效');
 drivers.set(id,{...driver,id});
}

export function unregisterAgentDriver(id:string):boolean{
 const normalized=id.trim().toLowerCase();
 if(normalized==='codex')throw new Error('默认codex驱动不可卸载');
 return drivers.delete(normalized);
}

export function resetAgentDrivers():void{
 drivers.clear();
 drivers.set(codexDriver.id,codexDriver);
 drivers.set(agyDriver.id,agyDriver);
}

export function listAgentDrivers():AgentDriver[]{
 return [...drivers.values()];
}

export type AgentProviderName='codex'|'agy';

export function isRegisteredAgentProvider(provider:unknown):provider is AgentProviderName{
 return typeof provider==='string'&&drivers.has(provider.trim().toLowerCase());
}

export function isAgentProviderConfig<T extends {provider?:unknown}>(config:T):config is Extract<T,{provider:AgentProviderName}>{
 return Boolean(config&&isRegisteredAgentProvider(config.provider));
}

export function resolveAgentDriver(model:string):{driver:AgentDriver;resolvedModel:string}{
 const trimmed=model.trim();
 const prefixMatch=trimmed.match(/^([a-z][a-z0-9_-]{0,31}):(.+)$/i);
 if(prefixMatch){
  const driverId=prefixMatch[1]!.toLowerCase();
  const rest=prefixMatch[2]!.trim();
  if(!rest)throw new Error('Agent模型名称无效');
  const driver=drivers.get(driverId);
  if(!driver)throw new Error(`未注册的Agent驱动: ${driverId}`);
  return{driver,resolvedModel:driverId===AGY_DRIVER_ID?stripAgyPrefix(rest):rest};
 }
 for(const driver of drivers.values()){
  if(driver.id!=='codex'&&driver.matchesModel?.(trimmed)){
   return{driver,resolvedModel:trimmed};
  }
 }
 const fallback=drivers.get('codex')??codexDriver;
 return{driver:fallback,resolvedModel:trimmed};
}

export function readAgentDriverCatalogs(credentialHome?:string):AgentDriverCatalog[]{
 return listAgentDrivers().map(driver=>({
  id:driver.id,
  label:driver.label,
  model_options:driver.readModelCatalog(credentialHome),
 }));
}

export function readMergedAgentModelCatalog(credentialHome?:string):AdvertisedModel[]{
 const seen=new Set<string>();
 const result:AdvertisedModel[]=[];
 for(const driver of listAgentDrivers()){
  for(const item of driver.readModelCatalog(credentialHome)){
   if(!seen.has(item.slug)){
    seen.add(item.slug);
    result.push(item);
   }
  }
 }
 return result;
}
