/**
 * 职责：Codex CLI 客户端：普通出题使用项目环境与文件交付，其余任务保持受限执行；校验登录并记录结果、事件与取消。
 * 关键方法与用途：`codexLoginStatus()` 检查套餐登录；`configureCodexCredentialsHome()` 校验凭证目录；`runCodex()` 按任务选择工作区与权限，并收集结果。
 * 使用场景：出题、脱敏、skill 和评分执行器通过此客户端调用，不直接拼接子进程参数。
 */
import {spawn} from 'node:child_process';
import {existsSync,constants} from 'node:fs';
import {appendFile} from 'node:fs/promises';
import {cp,mkdtemp,mkdir,open,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {classifyLogError,logEvent,withLogContext} from '../logging';
export interface CodexOptions<T> {binary?:string;directory:string;execution_profile?:'fresh_authoring';working_directory?:string;prompt:string;model:string;reasoning_effort:string;schema?:Record<string,unknown>;output_format?:'text';input_files?:{name:string;text:string}[];validate:(value:unknown)=>T;timeout_ms?:number;signal?:AbortSignal;credentialsHome?:string;developer_instructions?:string;call_id?:string;onProcess?:(pid:number|null)=>void;isolate_context?:boolean}
/** 评分只使用本次输入；记忆在所有调用中统一关闭，评分还关闭其他宿主上下文入口。 */
export const SCORE_ISOLATION_CONFIG={
 'features.skip_host_skill_discovery':true,
 'features.skill_search':false,'features.plugins':false,'features.apps':false,
 'features.hooks':false,'features.multi_agent':false,'features.shell_snapshot':false,
 'features.browser_use':false,'features.computer_use':false,
 'features.shell_tool':true,'features.unified_exec':true,
 'project_doc_max_bytes':0,'mcp_servers':{},'web_search':'disabled',
};
const bundledCodex='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const defaultBinary=process.env.CODEX_BIN??(process.platform==='darwin'&&existsSync(bundledCodex)?bundledCodex:'codex');
let credentialsHomeProvider:(()=>Promise<string|undefined>)|undefined;
export function configureCodexCredentialsHome(provider:()=>Promise<string|undefined>){credentialsHomeProvider=provider;}
function environment(credentialsHome?:string){const env=Object.fromEntries(['HOME','PATH','LANG','TMPDIR','CODEX_HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]));if(credentialsHome)env.CODEX_HOME=credentialsHome;return env;}
function resultError(reason_code:string){return Object.assign(new Error('Codex结果无效'),{kind:'invalid_response' as const,reason_code});}
async function execute(binary:string,args:string[],options:{directory?:string;prompt?:string;timeout:number;signal?:AbortSignal;credentialsHome?:string;onStdout?:(chunk:string)=>void|Promise<void>;captureStdout?:boolean;call_id?:string;onProcess?:(pid:number|null)=>void}){
 if(options.signal?.aborted)throw new Error(options.signal.reason instanceof Error&&options.signal.reason.message==='Codex执行超时'?'Codex执行超时':'Codex执行已取消');
 try {
  const call_id=options.call_id??randomUUID(),started=performance.now(),startedAt=Date.now(),deadline=started+options.timeout;
  return await withLogContext({call_id,provider:'codex'},()=>new Promise<{stdout:string;stderr:string;code:number|null}>((resolveResult,reject)=>{
   const child=spawn(binary,args,{cwd:options.directory,env:environment(options.credentialsHome),detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
   let observed=false;
   let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,stopped:string|undefined,outputTask=Promise.resolve();
   if(typeof child.pid==='number'){try{options.onProcess?.(child.pid);observed=!!options.onProcess;}catch(error){logEvent('process.registration_failed',{level:'warn',operation:'codex_cli',...classifyLogError(error)});}}
   logEvent('process.spawned',{level:'info',operation:'codex_cli',child_pid:child.pid,timeout_ms:options.timeout});
   const stop=(reason:string)=>{if(stopped)return;stopped=reason;const kind=reason.includes('超时')?'timeout':'cancelled';logEvent('process.kill_requested',{level:'warn',process_state:kind,elapsed_ms:Math.round(performance.now()-started)});try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch(error){logEvent('process.kill_failed',{level:'error',process_state:kind,...classifyLogError(error)});try{child.kill('SIGKILL');}catch(failure){logEvent('process.kill_failed',{level:'error',process_state:kind,...classifyLogError(failure)});}}};
   const timer=setTimeout(()=>{const fired=performance.now();logEvent('timeout.fired',{level:'error',timeout_ms:options.timeout,elapsed_ms:Math.round(fired-started),timer_lateness_ms:Math.max(0,Math.round(fired-deadline))});stop('Codex执行超时');},options.timeout);
   const cancel=()=>{if(options.signal?.reason instanceof Error&&options.signal.reason.message==='Codex执行超时'){stop('Codex执行超时');return;}logEvent('cancel.requested',{level:'warn',process_state:'cancelled',elapsed_ms:Math.round(performance.now()-started)});stop('Codex执行已取消');};options.signal?.addEventListener('abort',cancel,{once:true});
   if(options.signal?.aborted)cancel();
   child.stdout.on('data',chunk=>{child.stdout.pause();outputTask=outputTask.then(async()=>{const size=Buffer.byteLength(chunk);if(stdoutBytes+size>64*1024*1024){stop('Codex输出超过限制');return;}stdoutBytes+=size;const value=chunk.toString();if(options.captureStdout!==false)stdout+=value;await options.onStdout?.(value);if(!stopped)child.stdout.resume();}).catch(()=>stop('Codex执行事件记录失败'));});
   child.stderr.on('data',chunk=>{const size=Buffer.byteLength(chunk);if(stderrBytes+size>4*1024*1024){stop('Codex错误输出超过限制');return;}stderrBytes+=size;stderr+=chunk.toString();});
   child.stdin.on('error',()=>stop('Codex执行输入发送失败'));
   child.stdin.end(options.prompt??'');
   let exitRecorded=false;
   const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);if(observed){observed=false;try{options.onProcess?.(null);}catch(error){logEvent('process.registration_cleanup_failed',{level:'warn',operation:'codex_cli',...classifyLogError(error)});}}};
   child.on('error',error=>{cleanup();logEvent('process.error',{level:'error',elapsed_ms:Math.round(performance.now()-started),...classifyLogError(error)});reject(new Error('Codex执行器不可用'));});
   child.on('exit',(code,signal)=>{exitRecorded=true;logEvent('process.exited',{level:code===0?'info':'warn',exit_code:code??undefined,signal:signal??undefined,elapsed_ms:Math.round(performance.now()-started),wall_elapsed_ms:Date.now()-startedAt});});
   child.on('close',async(code,signal)=>{await outputTask;cleanup();logEvent('process.closed',{level:stopped||code!==0?'warn':'info',exit_code:code??undefined,signal:signal??undefined,process_state:exitRecorded?'exited':'unknown',elapsed_ms:Math.round(performance.now()-started),wall_elapsed_ms:Date.now()-startedAt});if(stopped)reject(new Error(stopped));else resolveResult({stdout,stderr,code});});
  }));
 }catch(error){if(error instanceof Error&&error.message.startsWith('Codex'))throw error;throw new Error('Codex执行失败');}
}
export async function codexLoginStatus(binary=defaultBinary,credentialsHome?:string,call_id?:string,onProcess?:(pid:number|null)=>void,signal?:AbortSignal):Promise<{status:'chatgpt'|'api_key'|'unavailable'}>{
 try{const result=await execute(binary,['login','status'],{timeout:10000,credentialsHome,call_id,onProcess,signal});const text=result.stdout+'\n'+result.stderr;return{status:result.code!==0?'unavailable':/Logged in using ChatGPT/i.test(text)?'chatgpt':/Logged in using an API key/i.test(text)?'api_key':'unavailable'};}
 catch(error){if(signal?.aborted)throw error;return{status:'unavailable'};}
}
export async function runCodex<T>(options:CodexOptions<T>):Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number}>{
 const call_id=options.call_id??randomUUID(),timeout_ms=options.timeout_ms??30*60*1000,started=performance.now(),controller=new AbortController(),timer=setTimeout(()=>{withLogContext({call_id,provider:'codex',model:options.model,reasoning_effort:options.reasoning_effort},()=>logEvent('timeout.fired',{level:'error',timeout_ms,elapsed_ms:Math.round(performance.now()-started)}));controller.abort(new Error('Codex执行超时'));},timeout_ms);
 const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 try{return await runCodexInternal({...options,call_id,timeout_ms,signal});}
 catch(error){
  const cause=controller.signal.aborted?new Error('Codex执行超时'):options.signal?.aborted?new Error('Codex执行已取消'):error;
  const classified=classifyLogError(cause),rawReason=cause&&typeof cause==='object'&&'reason_code'in cause?(cause as {reason_code?:unknown}).reason_code:undefined;
  const reason_code=typeof rawReason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(rawReason)?rawReason:`codex_${classified.error_kind}`;
  throw Object.assign(new Error(cause instanceof Error?cause.message:'Codex执行失败'),{kind:classified.error_kind,reason_code,call_id,retryable:classified.retryable??false,occurred_at:new Date().toISOString()});
 }
 finally{clearTimeout(timer);}
}
async function runCodexInternal<T>(options:CodexOptions<T>):Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number}>{
 if(options.signal?.aborted)throw new Error('Codex执行已取消');
 const fresh=options.execution_profile==='fresh_authoring';
 if(fresh&&(!options.working_directory||options.isolate_context||options.developer_instructions||options.output_format==='text'||options.input_files?.length))throw new Error('普通出题执行配置冲突');
 const binary=options.binary??defaultBinary;
 const call_id=options.call_id??randomUUID(),model=options.model,reasoning_effort=options.reasoning_effort,timeout_ms=options.timeout_ms??30*60*1000,startedAt=Date.now();
 await withLogContext({call_id,provider:'codex',model,reasoning_effort},async()=>logEvent('call.started',{level:'info',operation:'codex_exec',timeout_ms}));
 let credentialsHome:string|undefined;
 try{credentialsHome=options.credentialsHome??await credentialsHomeProvider?.();if(options.signal?.aborted)throw options.signal.reason;}
 catch(error){withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:'codex_exec',reason_code:'credentials_lookup_failed',...classifyLogError(error)}));throw Object.assign(new Error('Codex执行准备失败'),{kind:'configuration',reason_code:'credentials_lookup_failed'});}
 const login=await codexLoginStatus(binary,credentialsHome,call_id,options.onProcess,options.signal);
 if(options.signal?.aborted)throw options.signal.reason;
 await withLogContext({call_id,provider:'codex',model,reasoning_effort},async()=>logEvent('auth.checked',{level:login.status==='chatgpt'?'info':'error',operation:'codex_login',process_state:login.status==='chatgpt'?'authenticated':'unavailable'}));
 if(login.status!=='chatgpt'){await withLogContext({call_id,provider:'codex',model,reasoning_effort},async()=>logEvent('call.failed',{level:'error',operation:'codex_exec',reason_code:'authentication_required',...classifyLogError(new Error('Codex需要有效的ChatGPT套餐登录'))}));throw Object.assign(new Error('Codex需要有效的ChatGPT套餐登录'),{kind:'authentication',reason_code:'authentication_required'});}
 const started=Date.now();
 let directory:string,output:string,resultPath:string,cliResultPath:string,schemaPath:string,events_path:string,sourceOutput:string,stagingRoot='',eventsFile!:Awaited<ReturnType<typeof open>>;
 try{
  const sourceDirectory=await realpath(resolve(options.directory));sourceOutput=join(sourceDirectory,'output');
  await mkdir(sourceOutput,{recursive:true,mode:0o700});
  if(await realpath(sourceOutput)!==sourceOutput)throw new Error('Codex执行输出目录不能是外部链接');
  events_path=join(sourceOutput,'events.jsonl');
  await rm(join(sourceOutput,'result.json'),{force:true});await rm(join(sourceOutput,'result.txt'),{force:true});if(fresh){await rm(join(sourceOutput,'题目.md'),{force:true});await rm(join(sourceOutput,'completion.txt'),{force:true});}await rm(events_path,{force:true});await writeFile(events_path,'',{mode:0o600,flag:'wx'});eventsFile=await open(events_path,'a');
  if(options.output_format!=='text'&&!options.schema)throw new Error('结构化任务缺少输出 schema');
  const schema=options.schema?JSON.stringify(options.schema):undefined;
  if(schema)await writeFile(join(sourceOutput,'schema.json'),schema,{mode:0o600});
  // 普通出题正常加载项目上下文；其他任务在仓库外隔离，避免继承宿主规则。
  if(fresh){directory=await realpath(resolve(options.working_directory!));}
  else{stagingRoot=await realpath(await mkdtemp(join(tmpdir(),'ai-distill-codex-')));directory=join(stagingRoot,'workspace');await cp(sourceDirectory,directory,{recursive:true,filter:path=>resolve(path)!==sourceOutput});}
  for(const file of options.input_files??[]){
   if(!file.name||file.name==='.'||file.name==='..'||/[\\/]/.test(file.name)||file.name==='output')throw new Error('输入文件名无效');
   await writeFile(join(directory,file.name),file.text,{mode:0o600,flag:'wx'});
  }
  output=fresh?sourceOutput:join(directory,'output');await mkdir(output,{recursive:true,mode:0o700});
  if(await realpath(output)!==output)throw new Error('Codex执行输出目录不能是外部链接');
  const resultName=options.output_format==='text'?'result.txt':'result.json';
  resultPath=join(sourceOutput,resultName);cliResultPath=join(output,fresh?'completion.txt':resultName);schemaPath=join(output,'schema.json');
  if(schema)await writeFile(schemaPath,schema,{mode:0o600});
 }catch(error){
  try{await eventsFile?.close();}catch(closeError){withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('codex.events_close_failed',{level:'warn',...classifyLogError(closeError)}));}
  try{if(stagingRoot)await rm(stagingRoot,{recursive:true,force:true});}catch(cleanupError){withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('codex.workspace_cleanup_failed',{level:'warn',...classifyLogError(cleanupError)}));}
  withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:'codex_exec',reason_code:'workspace_setup_failed',...classifyLogError(error)}));throw Object.assign(new Error('Codex执行准备失败'),{kind:'configuration',reason_code:'workspace_setup_failed'});
 }
 const filesystem={':root':'deny',':minimal':'read',[directory]:'read',[output]:'write'};
 const table=`{${Object.entries(filesystem).map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`;
 const isolationArgs=options.isolate_context?Object.entries(SCORE_ISOLATION_CONFIG).flatMap(([key,value])=>['-c',`${key}=${JSON.stringify(value)}`]):[];
 const args=['exec',...(fresh?['--dangerously-bypass-approvals-and-sandbox']:['--ignore-user-config','--ignore-rules']),'--ephemeral','--skip-git-repo-check','--cd',directory,'--model',options.model,'--json','--color','never',...(fresh||options.output_format==='text'?[]:['--output-schema',schemaPath]),'--output-last-message',cliResultPath,...(fresh?[]:['-c','default_permissions="distill_role"','-c',`permissions.distill_role.filesystem=${table}`,'-c','permissions.distill_role.network.enabled=false','-c','approval_policy="never"']),'-c','features.memories=false','-c',`model_reasoning_effort=${JSON.stringify(options.reasoning_effort)}`,...isolationArgs,...(options.developer_instructions?['-c',`developer_instructions=${JSON.stringify(options.developer_instructions)}`]:[]),'-'];
 let eventBuffer='',session_id:string|undefined,completed:Record<string,any>|undefined,malformedEvent=false,failedEvent=false;
 const parseEvent=(line:string)=>{
  if(!line.trim())return;
  try{
   const event=JSON.parse(line),type=event.type;
   if(type==='thread.started'&&typeof event.thread_id==='string')session_id=event.thread_id;
   else if(type==='turn.completed')completed=event;
   else if(type==='turn.failed'||type==='error'&&!/^Reconnecting\.\.\./.test(event.message??''))failedEvent=true;
   if(type==='thread.started')logEvent('codex.thread_started',{level:'info'});else if(type==='turn.started')logEvent('codex.turn_started',{level:'info'});else if(type==='turn.completed')logEvent('codex.turn_completed',{level:'info',token_usage:event.usage});else if(type==='turn.failed'||type==='error')logEvent('codex.event_failed',{level:'warn',event_type:type});
  }catch{malformedEvent=true;logEvent('codex.event_parse_failed',{level:'warn',event_type:'malformed'});}
 };
 const onStdout=async(chunk:string)=>{
  await eventsFile.write(chunk);eventBuffer+=chunk;
  const lines=eventBuffer.split('\n');eventBuffer=lines.pop()??'';
  for(const line of lines)parseEvent(line);
 };
 const persistOutput=async()=>{if(!fresh)await cp(output,sourceOutput,{recursive:true,force:true});};
 let invocation;
 try{
  // 快照不是任务输入；普通出题完整访问下仍可物理读取，不记录环境变量或登录凭证。
  let input_manifest:unknown;
  if(fresh){try{input_manifest=JSON.parse(await readFile(join(options.directory,'input/input.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  if(options.isolate_context||fresh)await writeFile(join(sourceOutput,'request.json'),JSON.stringify({argv:args,stdin:options.prompt,cwd:directory,execution_profile:options.execution_profile,model,reasoning_effort,configuration_home:credentialsHome??process.env.CODEX_HOME??join(homedir(),'.codex'),input_manifest,developer_instructions:options.developer_instructions,schema:options.schema,output_format:options.output_format}),{mode:0o600});
  invocation=await withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>execute(binary,args,{directory,prompt:options.prompt,timeout:timeout_ms,signal:options.signal,credentialsHome,onStdout,captureStdout:false,call_id,onProcess:options.onProcess}));
  if(eventBuffer)parseEvent(eventBuffer);
  await eventsFile.close();await persistOutput();
 }
 catch(error){
  try{await eventsFile.close();await appendFile(events_path,JSON.stringify({type:'distill.failed',message:error instanceof Error?error.message:'Codex执行失败'})+'\n');}
  catch(eventWriteError){withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('codex.events_write_failed',{level:'error',...classifyLogError(eventWriteError)}));}
  try{await persistOutput();}catch(persistError){withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('codex.output_persist_failed',{level:'error',...classifyLogError(persistError)}));}
  try{if(stagingRoot)await rm(stagingRoot,{recursive:true,force:true});}catch(cleanupError){withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('codex.workspace_cleanup_failed',{level:'warn',...classifyLogError(cleanupError)}));}
  withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:'codex_exec',elapsed_ms:Date.now()-startedAt,...classifyLogError(error)}));throw error;
 }
 try{if(stagingRoot)await rm(stagingRoot,{recursive:true,force:true});}catch(cleanupError){withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('codex.workspace_cleanup_failed',{level:'warn',...classifyLogError(cleanupError)}));}
 if(invocation.code!==0){
  try{await appendFile(events_path,JSON.stringify({type:'distill.process_failed',exit_code:invocation.code,...(invocation.stderr.trim()?{stderr:invocation.stderr.trim().slice(-4096)}:{})})+'\n');}
  catch(error){withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('codex.events_write_failed',{level:'error',...classifyLogError(error)}));}
  withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:'codex_exec',reason_code:'process_exit_nonzero',error_kind:'provider',exit_code:invocation.code,elapsed_ms:Date.now()-startedAt}));throw Object.assign(new Error('Codex执行失败，详情保留在私有事件记录'),{kind:'provider',reason_code:'process_exit_nonzero'});
 }
 try{
  if(malformedEvent)throw resultError('invalid_json');
  if(typeof session_id!=='string'||!completed||failedEvent)throw resultError('incomplete_turn');
  const completedEvent=completed;
  let value:unknown;
  try{let text:string;if(fresh){if(await realpath(sourceOutput)!==sourceOutput)throw new Error('invalid result directory');const handle=await open(resultPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=await handle.stat();if(!info.isFile()||info.size>32*1024*1024)throw new Error('invalid result file');text=await handle.readFile('utf8');}finally{await handle.close();}}else text=await readFile(resultPath,'utf8');value=options.output_format==='text'?text:JSON.parse(text);}catch(error){const code=error&&typeof error==='object'?'code'in error?(error as {code?:unknown}).code:undefined:undefined;throw resultError(code==='ENOENT'?'result_missing':code?'result_read_failed':'invalid_json');}
  withLogContext({call_id,provider:'codex',model,reasoning_effort,session_id},()=>logEvent('result.parsed',{level:'info'}));
  let validated:T;try{validated=options.validate(value);}catch(error){const reason=error&&typeof error==='object'&&'reason_code'in error?(error as {reason_code?:unknown}).reason_code:undefined;throw resultError(typeof reason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(reason)?reason:'result_validation_failed');}
  const duration_ms=Date.now()-started;
  withLogContext({call_id,provider:'codex',model,reasoning_effort,session_id},()=>{logEvent('result.validated',{level:'info'});logEvent('call.completed',{level:'info',operation:'codex_exec',elapsed_ms:duration_ms,token_usage:completedEvent.usage});});
  return{result:validated,session_id,usage:completedEvent.usage??null,events_path,duration_ms};
 }catch(error){const reason=error&&typeof error==='object'&&'reason_code'in error&&(error as {reason_code?:unknown}).reason_code;const reason_code=typeof reason==='string'?reason:'result_invalid';withLogContext({call_id,provider:'codex',model,reasoning_effort},()=>{const failure={level:'error',operation:'codex_exec',reason_code,...classifyLogError(error)};logEvent('result.invalid',failure);logEvent('call.failed',failure);});throw Object.assign(new Error('Codex结果缺失、无效或执行未完整结束'),{kind:classifyLogError(error).error_kind,reason_code,retryable:false});}
}
