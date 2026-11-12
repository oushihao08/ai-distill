/**
 * 职责：为多 CLI Agent 驱动（Codex、Antigravity 等）提供统一的子进程流控、环境净化、工作区沙箱隔离与安全产物读取底座。
 * 核心入口：
 * - `executeCliProcess()`：带 64MiB/4MiB 流缓冲、进程组强杀、超时与取消控制的 CLI 子进程执行器。
 * - `prepareCliWorkspace()`：准备任务输出目录、仓库外临时沙箱拷贝、`schema.json`/`events.jsonl` 与清理钩子。
 * - `readSafeCliResultText()`：带 `O_NOFOLLOW` 与 32MiB 上限的产物文本安全读取。
 * - `runWithCliTimeoutBoundary()`：外层总超时控制与统一错误码包装。
 * 不变量与修改禁区：
 * - 子进程环境变量仅转发白名单与显式凭证目录，严禁透传 `DATABASE_URL` 或模型 API 密钥。
 * - `fresh_authoring` 下的结果读取必须保持 `O_NOFOLLOW` 与符号链接校验，防止越权读取宿主文件。
 */
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {constants} from 'node:fs';
import {appendFile,cp,mkdir,mkdtemp,open,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {classifyLogError,logEvent,withLogContext} from '../logging';

export interface CliClientOptions<T> {
 binary?:string;
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
 credentialsHome?:string;
 developer_instructions?:string;
 call_id?:string;
 onProcess?:(pid:number|null)=>void;
 isolate_context?:boolean;
}

export interface CliRuntimeSpec {
 /** 日志与错误前缀标识，如 `'codex'`、`'agy'`。 */
 provider:string;
 /** 面向错误消息的显示名，如 `'Codex'`、`'Antigravity'`。 */
 label:string;
 /** 子进程日志 operation 名，如 `'codex_cli'`、`'agy_cli'`。 */
 cliOperation:string;
 /** 调用日志 operation 名，如 `'codex_exec'`、`'agy_exec'`。 */
 execOperation:string;
 /** 临时沙箱目录前缀，如 `'ai-distill-codex-'`。 */
 tempPrefix:string;
}

const BASE_ENV_KEYS=[
 'HOME','PATH','LANG','TMPDIR',
 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
 'http_proxy','https_proxy','all_proxy','no_proxy',
 ...(process.platform==='win32'?['SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','COMSPEC','PATHEXT']:[]),
];

export function buildSafeCliEnvironment(options:{
 extraKeys?:string[];
 credentialEnvKey?:string;
 credentialsHome?:string;
}):NodeJS.ProcessEnv{
 const keys=[...BASE_ENV_KEYS,...(options.extraKeys??[])];
 const env=Object.fromEntries(keys.flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]));
 if(options.credentialEnvKey&&options.credentialsHome){
  env[options.credentialEnvKey]=options.credentialsHome;
 }
 return env;
}

export function createCliResultError(label:string,reason_code:string){
 return Object.assign(new Error(`${label}结果无效`),{kind:'invalid_response' as const,reason_code});
}

export async function executeCliProcess(
 spec:Pick<CliRuntimeSpec,'provider'|'label'|'cliOperation'>,
 binary:string,
 args:string[],
 options:{
  directory?:string;
  stdinText?:string;
  env:NodeJS.ProcessEnv;
  timeout:number;
  signal?:AbortSignal;
  onStdout?:(chunk:string)=>void|Promise<void>;
  captureStdout?:boolean;
  call_id?:string;
  onProcess?:(pid:number|null)=>void;
 }
):Promise<{stdout:string;stderr:string;code:number|null}>{
 const timeoutMsg=`${spec.label}执行超时`;
 const cancelMsg=`${spec.label}执行已取消`;
 if(options.signal?.aborted){
  const isTimeout=options.signal.reason instanceof Error&&options.signal.reason.message.includes('超时');
  throw new Error(isTimeout?timeoutMsg:cancelMsg);
 }
 try{
  const call_id=options.call_id??randomUUID(),started=performance.now(),startedAt=Date.now(),deadline=started+options.timeout;
  return await withLogContext({call_id,provider:spec.provider},()=>new Promise<{stdout:string;stderr:string;code:number|null}>((resolveResult,reject)=>{
   const child=spawn(binary,args,{cwd:options.directory,env:options.env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
   let observed=false;
   const stdoutDecoder=new StringDecoder('utf8'),stderrDecoder=new StringDecoder('utf8');
   let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,stopped:string|undefined,outputTask=Promise.resolve();
   if(typeof child.pid==='number'){
    try{options.onProcess?.(child.pid);observed=!!options.onProcess;}
    catch(error){logEvent('process.registration_failed',{level:'error',operation:spec.cliOperation,...classifyLogError(error)});}
   }
   logEvent('process.spawned',{level:'info',operation:spec.cliOperation,child_pid:child.pid,timeout_ms:options.timeout});
   const stop=(reason:string)=>{
    if(stopped)return;
    stopped=reason;
    const kind=reason.includes('超时')?'timeout':'cancelled';
    logEvent('process.kill_requested',{level:'warn',process_state:kind,elapsed_ms:Math.round(performance.now()-started)});
    try{
     if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');
     else child.kill('SIGKILL');
    }catch(error){
     logEvent('process.kill_failed',{level:'error',process_state:kind,...classifyLogError(error)});
     try{child.kill('SIGKILL');}catch(failure){logEvent('process.kill_failed',{level:'error',process_state:kind,...classifyLogError(failure)});}
    }
   };
   const timer=setTimeout(()=>{
    const fired=performance.now();
    logEvent('timeout.fired',{level:'error',timeout_ms:options.timeout,elapsed_ms:Math.round(fired-started),timer_lateness_ms:Math.max(0,Math.round(fired-deadline))});
    stop(timeoutMsg);
   },options.timeout);
   const cancel=()=>{
    if(options.signal?.reason instanceof Error&&options.signal.reason.message.includes('超时')){stop(timeoutMsg);return;}
    logEvent('cancel.requested',{level:'warn',process_state:'cancelled',elapsed_ms:Math.round(performance.now()-started)});
    stop(cancelMsg);
   };
   options.signal?.addEventListener('abort',cancel,{once:true});
   if(options.signal?.aborted)cancel();
   child.stdout.on('data',(chunk:Uint8Array)=>{
    child.stdout.pause();
    outputTask=outputTask.then(async()=>{
     const size=Buffer.byteLength(chunk);
     if(stdoutBytes+size>64*1024*1024){stop(`${spec.label}输出超过限制`);return;}
     stdoutBytes+=size;
     const value=stdoutDecoder.write(chunk);
     if(options.captureStdout!==false)stdout+=value;
     await options.onStdout?.(value);
     if(!stopped)child.stdout.resume();
    }).catch(()=>stop(`${spec.label}执行事件记录失败`));
   });
   child.stderr.on('data',(chunk:Uint8Array)=>{
    const size=Buffer.byteLength(chunk);
    if(stderrBytes+size>4*1024*1024){stop(`${spec.label}错误输出超过限制`);return;}
    stderrBytes+=size;
    stderr+=stderrDecoder.write(chunk);
   });
   child.stdin.on('error',()=>stop(`${spec.label}执行输入发送失败`));
   child.stdin.end(options.stdinText??'');
   let exitRecorded=false;
   const cleanup=()=>{
    clearTimeout(timer);
    options.signal?.removeEventListener('abort',cancel);
    if(observed){
     observed=false;
     try{options.onProcess?.(null);}
     catch(error){logEvent('process.registration_cleanup_failed',{level:'error',operation:spec.cliOperation,...classifyLogError(error)});}
    }
   };
   child.on('error',(error:Error)=>{
    cleanup();
    logEvent('process.error',{level:'error',elapsed_ms:Math.round(performance.now()-started),...classifyLogError(error)});
    reject(new Error(`${spec.label}执行器不可用`));
   });
   child.on('exit',(code:number|null,signal:string|null)=>{
    exitRecorded=true;
    logEvent('process.exited',{level:code===0?'info':'warn',exit_code:code??undefined,signal:signal??undefined,elapsed_ms:Math.round(performance.now()-started),wall_elapsed_ms:Date.now()-startedAt});
   });
   child.on('close',async(code:number|null,signal:string|null)=>{
    await outputTask;
    const tail=stdoutDecoder.end();
    if(options.captureStdout!==false)stdout+=tail;
    if(tail&&!stopped){
     try{await options.onStdout?.(tail);}
     catch{stop(`${spec.label}执行事件记录失败`);}
    }
    stderr+=stderrDecoder.end();
    cleanup();
    logEvent('process.closed',{level:stopped||code!==0?'warn':'info',exit_code:code??undefined,signal:signal??undefined,process_state:exitRecorded?'exited':'unknown',elapsed_ms:Math.round(performance.now()-started),wall_elapsed_ms:Date.now()-startedAt});
    if(stopped)reject(new Error(stopped));
    else resolveResult({stdout,stderr,code});
   });
  }));
 }catch(error){
  if(error instanceof Error&&error.message.startsWith(spec.label))throw error;
  throw new Error(`${spec.label}执行失败`);
 }
}

export async function runWithCliTimeoutBoundary<T extends CliClientOptions<any>,R>(
 spec:Pick<CliRuntimeSpec,'provider'|'label'>,
 options:T,
 runner:(resolvedOptions:T&{call_id:string;timeout_ms:number;signal:AbortSignal})=>Promise<R>
):Promise<R>{
 const call_id=options.call_id??randomUUID(),timeout_ms=options.timeout_ms??30*60*1000,started=performance.now(),controller=new AbortController();
 const timeoutMsg=`${spec.label}执行超时`;
 const timer=setTimeout(()=>{
  withLogContext({call_id,provider:spec.provider,model:options.model,reasoning_effort:options.reasoning_effort},()=>logEvent('timeout.fired',{level:'error',timeout_ms,elapsed_ms:Math.round(performance.now()-started)}));
  controller.abort(new Error(timeoutMsg));
 },timeout_ms);
 const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 try{
  return await runner({...options,call_id,timeout_ms,signal});
 }catch(error){
  const cause=controller.signal.aborted?new Error(timeoutMsg):options.signal?.aborted?new Error(`${spec.label}执行已取消`):error;
  const classified=classifyLogError(cause),rawReason=cause&&typeof cause==='object'&&'reason_code'in cause?(cause as {reason_code?:unknown}).reason_code:undefined;
  const reason_code=typeof rawReason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(rawReason)?rawReason:`${spec.provider}_${classified.error_kind}`;
  throw Object.assign(new Error(cause instanceof Error?cause.message:`${spec.label}执行失败`),{
   kind:classified.error_kind,
   reason_code,
   call_id,
   retryable:classified.retryable??false,
   occurred_at:new Date().toISOString(),
  });
 }finally{
  clearTimeout(timer);
 }
}

export interface PreparedCliWorkspace {
 fresh:boolean;
 directory:string;
 output:string;
 sourceOutput:string;
 resultPath:string;
 cliResultPath:string;
 schemaPath:string;
 events_path:string;
 eventsFile:Awaited<ReturnType<typeof open>>;
 persistOutput:()=>Promise<void>;
 cleanupStaging:()=>Promise<void>;
 recordExecutionFailure:(error:unknown,startedAt:number)=>Promise<void>;
 recordNonZeroExit:(code:number|null,stderr:string,startedAt:number)=>Promise<never>;
 writeRequestSnapshot:(extra:Record<string,unknown>)=>Promise<void>;
}

export async function prepareCliWorkspace<T>(
 spec:CliRuntimeSpec,
 options:CliClientOptions<T>,
 call_id:string
):Promise<PreparedCliWorkspace>{
 const fresh=options.execution_profile==='fresh_authoring';
 const {model,reasoning_effort}=options;
 let directory='',output='',resultPath='',cliResultPath='',schemaPath='',events_path='',sourceOutput='',stagingRoot='',eventsFile!:Awaited<ReturnType<typeof open>>;
 try{
  const sourceDirectory=await realpath(resolve(options.directory));
  sourceOutput=join(sourceDirectory,'output');
  await mkdir(sourceOutput,{recursive:true,mode:0o700});
  if(await realpath(sourceOutput)!==sourceOutput)throw new Error(`${spec.label}执行输出目录不能是外部链接`);
  events_path=join(sourceOutput,'events.jsonl');
  await rm(join(sourceOutput,'result.json'),{force:true});
  await rm(join(sourceOutput,'result.txt'),{force:true});
  for(const entry of await readdir(sourceOutput)){
   if(/^_part_.*\.json$/i.test(entry))await rm(join(sourceOutput,entry),{force:true});
  }
  if(fresh){
    await rm(join(sourceOutput,'题目.md'),{force:true});
    await rm(join(sourceOutput,'completion.txt'),{force:true});
  }
  await rm(events_path,{force:true});
  await writeFile(events_path,'',{mode:0o600,flag:'wx'});
  eventsFile=await open(events_path,'a');
  if(options.output_format!=='text'&&!options.schema)throw new Error('结构化任务缺少输出 schema');
  const schema=options.schema?JSON.stringify(options.schema):undefined;
  if(schema)await writeFile(join(sourceOutput,'schema.json'),schema,{mode:0o600});
  // 普通出题正常加载项目上下文；其他任务在仓库外隔离，避免继承宿主规则。
  if(fresh){
   directory=await realpath(resolve(options.working_directory!));
  }else{
   stagingRoot=await realpath(await mkdtemp(join(tmpdir(),spec.tempPrefix)));
   directory=join(stagingRoot,'workspace');
   await cp(sourceDirectory,directory,{recursive:true,filter:(path:string)=>resolve(path)!==sourceOutput});
  }
  for(const file of options.input_files??[]){
   if(!file.name||file.name==='.'||file.name==='..'||/[\\/]/.test(file.name)||file.name==='output')throw new Error('输入文件名无效');
   await writeFile(join(directory,file.name),file.text,{mode:0o600,flag:'wx'});
  }
  output=fresh?sourceOutput:join(directory,'output');
  await mkdir(output,{recursive:true,mode:0o700});
  if(await realpath(output)!==output)throw new Error(`${spec.label}执行输出目录不能是外部链接`);
  const resultName=options.output_format==='text'?'result.txt':'result.json';
  resultPath=join(sourceOutput,resultName);
  cliResultPath=join(output,fresh?'completion.txt':resultName);
  schemaPath=join(output,'schema.json');
  if(schema)await writeFile(schemaPath,schema,{mode:0o600});
 }catch(error){
  try{await eventsFile?.close();}catch(closeError){withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent(`${spec.provider}.events_close_failed`,{level:'error',...classifyLogError(closeError)}));}
  try{if(stagingRoot)await rm(stagingRoot,{recursive:true,force:true});}catch(cleanupError){withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent(`${spec.provider}.workspace_cleanup_failed`,{level:'error',...classifyLogError(cleanupError)}));}
  withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:spec.execOperation,reason_code:'workspace_setup_failed',...classifyLogError(error)}));
  throw Object.assign(new Error(`${spec.label}执行准备失败`),{kind:'configuration',reason_code:'workspace_setup_failed'});
 }

 const persistOutput=async()=>{
  if(!fresh)await cp(output,sourceOutput,{recursive:true,force:true});
 };
 const cleanupStaging=async()=>{
  try{if(stagingRoot)await rm(stagingRoot,{recursive:true,force:true});}
  catch(cleanupError){withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent(`${spec.provider}.workspace_cleanup_failed`,{level:'error',...classifyLogError(cleanupError)}));}
 };
 const recordExecutionFailure=async(error:unknown,startedAt:number)=>{
  try{
   await eventsFile.close();
   await appendFile(events_path,JSON.stringify({type:'distill.failed',message:error instanceof Error?error.message:`${spec.label}执行失败`})+'\n');
  }catch(eventWriteError){
   withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent(`${spec.provider}.events_write_failed`,{level:'error',...classifyLogError(eventWriteError)}));
  }
  try{await persistOutput();}catch(persistError){withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent(`${spec.provider}.output_persist_failed`,{level:'error',...classifyLogError(persistError)}));}
  await cleanupStaging();
  withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:spec.execOperation,elapsed_ms:Date.now()-startedAt,...classifyLogError(error)}));
 };
 const recordNonZeroExit=async(code:number|null,stderr:string,startedAt:number):Promise<never>=>{
  try{
   await appendFile(events_path,JSON.stringify({type:'distill.process_failed',exit_code:code,...(stderr.trim()?{stderr:stderr.trim().slice(-4096)}:{})})+'\n');
  }catch(error){
   withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent(`${spec.provider}.events_write_failed`,{level:'error',...classifyLogError(error)}));
  }
  withLogContext({call_id,provider:spec.provider,model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:spec.execOperation,reason_code:'process_exit_nonzero',error_kind:'provider',exit_code:code,elapsed_ms:Date.now()-startedAt}));
  throw Object.assign(new Error(`${spec.label}执行失败，详情保留在私有事件记录`),{kind:'provider',reason_code:'process_exit_nonzero'});
 };
 const writeRequestSnapshot=async(extra:Record<string,unknown>)=>{
  let input_manifest:unknown;
  if(fresh){
   try{input_manifest=JSON.parse(await readFile(join(options.directory,'input/input.json'),'utf8'));}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  if(options.isolate_context||fresh){
   await writeFile(join(sourceOutput,'request.json'),JSON.stringify({
    ...extra,
    stdin:options.prompt,
    cwd:directory,
    execution_profile:options.execution_profile,
    model,
    reasoning_effort,
    input_manifest,
    developer_instructions:options.developer_instructions,
    schema:options.schema,
    output_format:options.output_format,
   }),{mode:0o600});
  }
 };

 return{
  fresh,
  directory,
  output,
  sourceOutput,
  resultPath,
  cliResultPath,
  schemaPath,
  events_path,
  eventsFile,
  persistOutput,
  cleanupStaging,
  recordExecutionFailure,
  recordNonZeroExit,
  writeRequestSnapshot,
 };
}

export async function readSafeCliResultText(sourceOutput:string,resultPath:string,fresh:boolean):Promise<string>{
 if(!fresh)return readFile(resultPath,'utf8');
 if(await realpath(sourceOutput)!==sourceOutput)throw new Error('invalid result directory');
 const handle=await open(resultPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await handle.stat();
  if(!info.isFile()||info.size>32*1024*1024)throw new Error('invalid result file');
  return await handle.readFile('utf8');
 }finally{
  await handle.close();
 }
}
