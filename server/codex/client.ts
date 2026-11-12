/**
 * 职责：Codex CLI 客户端：组装 Codex 专属权限配置、登录检查与 NDJSON 事件解析；底层进程流控与沙箱管理委托给 `server/agent/cli-runtime.ts`。
 * 核心入口：
 * - `codexLoginStatus()`：检查 ChatGPT 套餐登录状态（拒绝 API Key 计费模式）。
 * - `configureCodexCredentialsHome()`：注册 `CODEX_HOME` 凭证目录读取器。
 * - `runCodex()`：按任务选择普通出题项目环境或仓库外受限沙箱执行，并校验返回结果。
 * 不变量与修改禁区：
 * - 普通出题（`fresh_authoring`）在项目工作目录运行并保留完整桌面工具能力；其余任务固定在仓库外临时目录与 `distill_role` 沙箱执行。
 * - 独立评分固定启用 `SCORE_ISOLATION_CONFIG`，关闭宿主 skill、插件与外部搜索。
 */
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {classifyLogError,logEvent,withLogContext} from '../logging';
import {
 buildSafeCliEnvironment,
 createCliResultError,
 executeCliProcess,
 prepareCliWorkspace,
 readSafeCliResultText,
 runWithCliTimeoutBoundary,
 type CliClientOptions,
 type CliRuntimeSpec,
} from '../agent/cli-runtime';

export type CodexOptions<T>=CliClientOptions<T>;

/** 评分只使用本次输入；记忆在所有调用中统一关闭，评分还关闭其他宿主上下文入口。 */
export const SCORE_ISOLATION_CONFIG={
 'features.skip_host_skill_discovery':true,
 'features.skill_search':false,'features.plugins':false,'features.apps':false,
 'features.hooks':false,'features.multi_agent':false,'features.shell_snapshot':false,
 'features.browser_use':false,'features.computer_use':false,
 'features.shell_tool':true,'features.unified_exec':true,
 'project_doc_max_bytes':0,'mcp_servers':{},'web_search':'disabled',
};

const CODEX_SPEC:CliRuntimeSpec={
 provider:'codex',
 label:'Codex',
 cliOperation:'codex_cli',
 execOperation:'codex_exec',
 tempPrefix:'ai-distill-codex-',
};

const bundledCodex='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const defaultBinary=process.env.CODEX_BIN??(process.platform==='darwin'&&existsSync(bundledCodex)?bundledCodex:process.platform==='win32'?'codex.exe':'codex');
let credentialsHomeProvider:(()=>Promise<string|undefined>)|undefined;

export function configureCodexCredentialsHome(provider:()=>Promise<string|undefined>){
 credentialsHomeProvider=provider;
}

function codexEnvironment(credentialsHome?:string){
 return buildSafeCliEnvironment({extraKeys:['CODEX_HOME'],credentialEnvKey:'CODEX_HOME',credentialsHome});
}

export async function codexLoginStatus(
 binary=defaultBinary,
 credentialsHome?:string,
 call_id?:string,
 onProcess?:(pid:number|null)=>void,
 signal?:AbortSignal
):Promise<{status:'chatgpt'|'api_key'|'unavailable'}>{
 try{
  const result=await executeCliProcess(CODEX_SPEC,binary,['login','status'],{
   timeout:10000,
   env:codexEnvironment(credentialsHome),
   call_id,
   onProcess,
   signal,
  });
  const text=result.stdout+'\n'+result.stderr;
  return{status:result.code!==0?'unavailable':/Logged in using ChatGPT/i.test(text)?'chatgpt':/Logged in using an API key/i.test(text)?'api_key':'unavailable'};
 }catch(error){
  if(signal?.aborted)throw error;
  return{status:'unavailable'};
 }
}

export async function runCodex<T>(options:CodexOptions<T>):Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number}>{
 return runWithCliTimeoutBoundary(CODEX_SPEC,options,runCodexInternal);
}

async function runCodexInternal<T>(options:CodexOptions<T>):Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number}>{
 if(options.signal?.aborted)throw new Error('Codex执行已取消');
 const fresh=options.execution_profile==='fresh_authoring';
 const projectDelivery=options.execution_profile==='project_delivery';
 if(fresh&&(!options.working_directory||options.isolate_context||options.developer_instructions||options.output_format==='text'||options.input_files?.length)){
  throw new Error('普通出题执行配置冲突');
 }
 const binary=options.binary??defaultBinary;
 const call_id=options.call_id??randomUUID(),model=options.model,reasoning_effort=options.reasoning_effort,timeout_ms=options.timeout_ms??30*60*1000,startedAt=Date.now();
 await withLogContext({call_id,provider:'codex',model,reasoning_effort},async()=>logEvent('call.started',{level:'info',operation:'codex_exec',timeout_ms}));
 let credentialsHome:string|undefined;
 try{
  credentialsHome=options.credentialsHome??await credentialsHomeProvider?.();
  if(options.signal?.aborted)throw options.signal.reason;
 }catch(error){
  withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:'codex_exec',reason_code:'credentials_lookup_failed',...classifyLogError(error)}));
  throw Object.assign(new Error('Codex执行准备失败'),{kind:'configuration',reason_code:'credentials_lookup_failed'});
 }
 const login=await codexLoginStatus(binary,credentialsHome,call_id,options.onProcess,options.signal);
 if(options.signal?.aborted)throw options.signal.reason;
 await withLogContext({call_id,provider:'codex',model,reasoning_effort},async()=>logEvent('auth.checked',{level:login.status==='chatgpt'?'info':'error',operation:'codex_login',process_state:login.status==='chatgpt'?'authenticated':'unavailable'}));
 if(login.status!=='chatgpt'){
  await withLogContext({call_id,provider:'codex',model,reasoning_effort},async()=>logEvent('call.failed',{level:'error',operation:'codex_exec',reason_code:'authentication_required',...classifyLogError(new Error('Codex需要有效的ChatGPT套餐登录'))}));
  throw Object.assign(new Error('Codex需要有效的ChatGPT套餐登录'),{kind:'authentication',reason_code:'authentication_required'});
 }
 const started=Date.now();
 const ws=await prepareCliWorkspace(CODEX_SPEC,options,call_id);
 const filesystem:Record<string,string>={':root':'deny',':minimal':'read',[ws.directory]:'read',[ws.output]:'write'};
 // :minimal不包含安装在用户目录中的PowerShell/Bun/Node，显式开放运行时只读，业务文件仍限于本次工作区。
 if(process.platform==='win32')for(const runtime of [process.execPath,Bun.which('pwsh.exe'),Bun.which('node.exe')])if(runtime)filesystem[dirname(runtime)]??='read';
 const table=`{${Object.entries(filesystem).map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`;
 // Windows旧沙箱不能执行:root deny的分离读取权限；MXC保留同一目录/网络边界，能力不足时由CLI明确失败。
 const isolationArgs=[...(!fresh&&process.platform==='win32'?['-c','windows.sandbox="mxc"']:[]),...(options.isolate_context?Object.entries(SCORE_ISOLATION_CONFIG).flatMap(([key,value])=>['-c',`${key}=${JSON.stringify(value)}`]):[])];
 const args=['exec',...(fresh?['--dangerously-bypass-approvals-and-sandbox']:['--ignore-user-config','--ignore-rules']),'--ephemeral','--skip-git-repo-check','--cd',ws.directory,'--model',options.model,'--json','--color','never',...(fresh||options.output_format==='text'?[]:['--output-schema',ws.schemaPath]),'--output-last-message',ws.cliResultPath,...(fresh?[]:['-c','default_permissions="distill_role"','-c',`permissions.distill_role.filesystem=${table}`,'-c','permissions.distill_role.network.enabled=false','-c','approval_policy="never"']),...(projectDelivery?['-c','web_search="live"']:[]),'-c','features.memories=false','-c',`model_reasoning_effort=${JSON.stringify(options.reasoning_effort)}`,...isolationArgs,...(options.developer_instructions?['-c',`developer_instructions=${JSON.stringify(options.developer_instructions)}`]:[]),'-'];
 let eventBuffer='',session_id:string|undefined,completed:Record<string,any>|undefined,malformedEvent=false,failedEvent=false;
 const parseEvent=(line:string)=>{
  if(!line.trim())return;
  try{
   const event=JSON.parse(line),type=event.type;
   if(type==='thread.started'&&typeof event.thread_id==='string')session_id=event.thread_id;
   else if(type==='turn.completed')completed=event;
   else if(type==='turn.failed'||type==='error'&&!/^Reconnecting\.\.\./.test(event.message??''))failedEvent=true;
   if(type==='thread.started')logEvent('codex.thread_started',{level:'info'});
   else if(type==='turn.started')logEvent('codex.turn_started',{level:'info'});
   else if(type==='turn.completed')logEvent('codex.turn_completed',{level:'info',token_usage:event.usage});
   else if(type==='turn.failed'||type==='error')logEvent('codex.event_failed',{level:'warn',event_type:type});
  }catch{
   malformedEvent=true;
   logEvent('codex.event_parse_failed',{level:'warn',event_type:'malformed'});
  }
 };
 const onStdout=async(chunk:string)=>{
  await ws.eventsFile.write(chunk);
  eventBuffer+=chunk;
  const lines=eventBuffer.split('\n');
  eventBuffer=lines.pop()??'';
  for(const line of lines)parseEvent(line);
 };
 let invocation;
 try{
  await ws.writeRequestSnapshot({
   argv:args,
   configuration_home:credentialsHome??process.env.CODEX_HOME??join(homedir(),'.codex'),
  });
  invocation=await withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>executeCliProcess(CODEX_SPEC,binary,args,{
   directory:ws.directory,
   stdinText:options.prompt,
   env:codexEnvironment(credentialsHome),
   timeout:timeout_ms,
   signal:options.signal,
   onStdout,
   captureStdout:false,
   call_id,
   onProcess:options.onProcess,
  }));
  if(eventBuffer)parseEvent(eventBuffer);
  await ws.eventsFile.close();
  await ws.persistOutput();
 }catch(error){
  await ws.recordExecutionFailure(error,startedAt);
  throw error;
 }
 await ws.cleanupStaging();
 if(invocation.code!==0){
  await ws.recordNonZeroExit(invocation.code,invocation.stderr,startedAt);
 }
 try{
  if(malformedEvent)throw createCliResultError('Codex','invalid_json');
  if(typeof session_id!=='string'||!completed||failedEvent)throw createCliResultError('Codex','incomplete_turn');
  const completedEvent=completed;
  let value:unknown;
  try{
   const text=await readSafeCliResultText(ws.sourceOutput,ws.resultPath,fresh);
   value=options.output_format==='text'?text:JSON.parse(text);
  }catch(error){
   const code=error&&typeof error==='object'&&'code'in error?(error as {code?:unknown}).code:undefined;
   throw createCliResultError('Codex',code==='ENOENT'?'result_missing':code?'result_read_failed':'invalid_json');
  }
  withLogContext({call_id,provider:'codex',model,reasoning_effort,session_id},()=>logEvent('result.parsed',{level:'info'}));
  let validated:T;
  try{
   validated=options.validate(value);
  }catch(error){
   const reason=error&&typeof error==='object'&&'reason_code'in error?(error as {reason_code?:unknown}).reason_code:undefined;
   throw createCliResultError('Codex',typeof reason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(reason)?reason:'result_validation_failed');
  }
  const duration_ms=Date.now()-started;
  withLogContext({call_id,provider:'codex',model,reasoning_effort,session_id},()=>{
   logEvent('result.validated',{level:'info'});
   logEvent('call.completed',{level:'info',operation:'codex_exec',elapsed_ms:duration_ms,token_usage:completedEvent.usage});
  });
  return{result:validated,session_id,usage:completedEvent.usage??null,events_path:ws.events_path,duration_ms};
 }catch(error){
  const reason=error&&typeof error==='object'&&'reason_code'in error&&(error as {reason_code?:unknown}).reason_code;
  const reason_code=typeof reason==='string'?reason:'result_invalid';
  withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:'codex_exec',reason_code,...classifyLogError(error)}));
  throw Object.assign(new Error('Codex结果缺失、无效或执行未完整结束'),{kind:classifyLogError(error).error_kind,reason_code,retryable:false});
 }
}
