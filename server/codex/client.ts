import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {registerProcess,blockExecutor,classifyExecutorFailure} from '../monitoring/runtime';
import {appendFileSync} from 'node:fs';
import {mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
export interface CodexOptions<T> {binary?:string;directory:string;prompt:string;model:string;reasoning_effort:string;schema:Record<string,unknown>;validate:(value:unknown)=>T;timeout_ms?:number;signal?:AbortSignal;credentialsHome?:string;updateExecutorBlock?:boolean}
const bundledCodex='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const defaultBinary=process.env.CODEX_BIN??(process.platform==='darwin'&&existsSync(bundledCodex)?bundledCodex:'codex');
let credentialsHomeProvider:(()=>Promise<string|undefined>)|undefined;
export function configureCodexCredentialsHome(provider:()=>Promise<string|undefined>){credentialsHomeProvider=provider;}
function environment(credentialsHome?:string){const env=Object.fromEntries(['HOME','PATH','LANG','TMPDIR','CODEX_HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]));if(credentialsHome)env.CODEX_HOME=credentialsHome;return env;}
async function execute(binary:string,args:string[],options:{directory?:string;prompt?:string;timeout:number;signal?:AbortSignal;credentialsHome?:string;onStdout?:(chunk:string)=>void}){
 if(options.signal?.aborted)throw new Error('Codex执行已取消');
 try {
  return await new Promise<{stdout:string;stderr:string;code:number|null}>((resolveResult,reject)=>{
   const child=spawn(binary,args,{cwd:options.directory,env:environment(options.credentialsHome),detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
   const unregister=child.pid?registerProcess(child.pid,'codex'):()=>{};
   let stdout='',stderr='',stopped:string|undefined;
   const stop=(reason:string)=>{if(stopped)return;stopped=reason;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{child.kill('SIGKILL');}};
   const timer=setTimeout(()=>stop('Codex执行超时'),options.timeout);
   const cancel=()=>stop('Codex执行已取消');options.signal?.addEventListener('abort',cancel,{once:true});
   if(options.signal?.aborted)cancel();
   child.stdout.on('data',chunk=>{const value=chunk.toString();stdout+=value;try{options.onStdout?.(value);}catch{stop('Codex执行事件记录失败');}});
   child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
   child.stdin.on('error',()=>stop('Codex执行输入发送失败'));
   child.stdin.end(options.prompt??'');
   const cleanup=()=>{unregister();clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);};
   child.on('error',()=>{cleanup();reject(new Error('Codex执行器不可用'));});
   child.on('close',code=>{cleanup();if(stopped)reject(new Error(stopped));else resolveResult({stdout,stderr,code});});
  });
 }catch(error){if(error instanceof Error&&error.message.startsWith('Codex'))throw error;throw new Error('Codex执行失败');}
}
export async function codexLoginStatus(binary=defaultBinary,credentialsHome?:string):Promise<{status:'chatgpt'|'api_key'|'unavailable'}>{
 try{const result=await execute(binary,['login','status'],{timeout:10000,credentialsHome});const text=result.stdout+'\n'+result.stderr;return{status:result.code!==0?'unavailable':/Logged in using ChatGPT/i.test(text)?'chatgpt':/Logged in using an API key/i.test(text)?'api_key':'unavailable'};}
 catch{return{status:'unavailable'};}
}
export async function runCodex<T>(options:CodexOptions<T>):Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number}>{
 if(options.signal?.aborted)throw new Error('Codex执行已取消');
 const binary=options.binary??defaultBinary;
 const credentialsHome=options.credentialsHome??await credentialsHomeProvider?.();
 if((await codexLoginStatus(binary,credentialsHome)).status!=='chatgpt'){if(options.updateExecutorBlock!==false)await blockExecutor('codex','authentication');throw new Error('Codex需要有效的ChatGPT套餐登录');}
 const started=Date.now();
 const directory=await realpath(resolve(options.directory)),output=join(directory,'output');
 await mkdir(output,{recursive:true,mode:0o700});
 if(await realpath(output)!==output)throw new Error('Codex执行输出目录不能是外部链接');
 const resultPath=join(output,'result.json'),schemaPath=join(output,'schema.json'),events_path=join(output,'events.jsonl');
 await rm(resultPath,{force:true});await rm(events_path,{force:true});await writeFile(events_path,'',{mode:0o600,flag:'wx'});
 await writeFile(schemaPath,JSON.stringify(options.schema),{mode:0o600});
 const filesystem={':root':'deny',':minimal':'read',[directory]:'read',[output]:'write'};
 const table=`{${Object.entries(filesystem).map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`;
 const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--cd',directory,'--model',options.model,'--json','--color','never','--output-schema',schemaPath,'--output-last-message',resultPath,'-c','default_permissions="distill_role"','-c',`permissions.distill_role.filesystem=${table}`,'-c','permissions.distill_role.network.enabled=false','-c','approval_policy="never"','-c',`model_reasoning_effort=${JSON.stringify(options.reasoning_effort)}`,'-'];
 let invocation;
 try{invocation=await execute(binary,args,{directory,prompt:options.prompt,timeout:options.timeout_ms??30*60*1000,signal:options.signal,credentialsHome,onStdout:chunk=>appendFileSync(events_path,chunk)});}
 catch(error){appendFileSync(events_path,JSON.stringify({type:'distill.failed',message:error instanceof Error?error.message:'Codex执行失败'})+'\n');throw error;}
 // Only executor diagnostics are evidence of an account block. Model text may
 // itself discuss authentication or quotas and must never control dispatch.
 const failures=invocation.stdout.split('\n').flatMap(line=>{try{const event=JSON.parse(line);return event.type==='error'||event.type==='turn.failed'?[String(event.message??event.error?.message??'')]:[];}catch{return [];}}).join('\n');
 const block=classifyExecutorFailure(failures+(invocation.code!==0?'\n'+invocation.stderr:''));
 if(block&&options.updateExecutorBlock!==false)await blockExecutor('codex',block);
 if(invocation.code!==0)throw new Error('Codex执行失败，详情保留在私有事件记录');
 try{
  const events=invocation.stdout.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
  const session_id=events.find(event=>event.type==='thread.started')?.thread_id;
  const completed=events.find(event=>event.type==='turn.completed');
  if(typeof session_id!=='string'||!completed||events.some(event=>event.type==='turn.failed'||event.type==='error'&&!/^Reconnecting\.\.\./.test(event.message??'')))throw new Error('incomplete');
  const value=JSON.parse(await readFile(resultPath,'utf8'));
  return{result:options.validate(value),session_id,usage:completed.usage??null,events_path,duration_ms:Date.now()-started};
 }catch{throw new Error('Codex结果缺失、无效或执行未完整结束');}
}
