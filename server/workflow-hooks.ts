/**
 * 职责：冻结并执行受信任项目的 TypeScript 钩子，仅收集附加结果，不改写主产物。
 * 入口：freezeHookScript() 冻结声明文件；runHookScript() 在临时目录执行或调用空实现。
 * 调用方：阶段钩子协调器及异步消费者。脚本是受信任代码，目录与环境隔离不等于 OS 沙箱。
 */
import {randomUUID} from 'node:crypto';
import {createModelApiClient,resolveModelApiConfig,type ModelApiResult} from './llm-api';
import {runExternalCall} from './external-call';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,open,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {canonicalJson,validateWorkflowConfig,type HookAction} from '../shared/workflow-config';

export interface FrozenHook {
 project_root:string;action:HookAction;files:{path:string;sha256:string;size_bytes:number}[];digest:string;
}
export interface HookPayload {
 stage:'authoring'|'answer'|'scoring';position:'before'|'after';attempt_id:string;workflow_id:string;
 idempotency_key:string;input:Record<string,unknown>;output?:Record<string,unknown>;
}
export interface HookAddition {purpose:string;text:string}
export interface HookResult {notes:string[];data:Record<string,unknown>;additions?:HookAddition[];artifacts?:{name:string;text:string;sha256:string}[];model_result?:ModelApiResult&{call_id:string;config:NonNullable<HookAction['model_request']>['config']}}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const failure=(message:string)=>new Error(`项目钩子${message}`);
async function sourceBytes(root:string,path:string){
 const target=resolve(root,path);
 if(!target.startsWith(root+sep)||await realpath(target)!==target)throw failure('路径无效或包含符号链接');
 const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>1024*1024)throw failure('文件不是有效普通文件或过大');
  const bytes=await handle.readFile();if(bytes.length>1024*1024)throw failure('文件过大');return bytes;
 }finally{await handle.close();}
}
/** 文件集合包含入口及所有项目内依赖；复制到临时目录后未声明的相对依赖无法加载。 */
export async function freezeHookScript(projectRoot:string,raw:HookAction):Promise<FrozenHook>{
 try{
  const action=validateWorkflowConfig({hooks:{before:[raw]}})!.hooks.before[0]!;
  if(action.model_request)action.model_request.config=resolveModelApiConfig(action.model_request.config,{});
  const project_root=await realpath(resolve(projectRoot)),files:FrozenHook['files']=[];let size=0;
  for(const path of [...action.files].sort()){
   const bytes=await sourceBytes(project_root,path);size+=bytes.length;if(size>5*1024*1024)throw failure('声明文件总量过大');
   files.push({path,sha256:sha(bytes),size_bytes:bytes.length});
  }
  const snapshot={project_root,action,files};return {...snapshot,digest:sha(canonicalJson(snapshot))};
 }catch(error){if(error instanceof Error&&error.message.startsWith('项目钩子'))throw error;throw failure('脚本冻结失败，请核对声明路径');}
}
/** 输出只允许附加意见与数据，不接受题面、答案、成绩、绑定或状态的覆盖字段。 */
function parseResult(text:string,hook:FrozenHook,payload:HookPayload):HookResult{
 let raw:unknown;try{raw=JSON.parse(text);}catch{throw failure('返回结果不是有效JSON');}
 if(!object(raw)||Object.keys(raw).some(key=>!['notes','data','additions','artifacts','model_request'].includes(key)))throw failure('返回结果包含未知或越权字段');
 if(raw.model_request!==undefined&&raw.model_request!==true)throw failure('模型请求格式无效');
 if(raw.model_request===true&&!hook.action.model_request)throw failure('模型请求未经冻结配置授权');
 const notes=raw.notes??[],data=raw.data??{};
 if(!Array.isArray(notes)||notes.length>100||notes.some(note=>typeof note!=='string'||note.length>10000)||!object(data))throw failure('返回结果结构无效');
 let additions:HookAddition[]|undefined,artifacts:HookResult['artifacts'];
 if(raw.additions!==undefined){
  if(payload.stage==='answer'||payload.position!=='before'||hook.action.mode!=='sync'||!hook.action.input_purpose||!Array.isArray(raw.additions)||raw.additions.length>20)throw failure('附加输入未获本阶段声明许可');
  additions=raw.additions.map(value=>{if(!object(value)||Object.keys(value).some(key=>!['purpose','text'].includes(key))||value.purpose!==hook.action.input_purpose||typeof value.text!=='string'||!value.text.trim()||value.text.length>100000)throw failure('附加输入格式或用途无效');return {purpose:value.purpose as string,text:value.text};});
 }
 if(raw.artifacts!==undefined){
  if(!Array.isArray(raw.artifacts)||raw.artifacts.length>20)throw failure('附加产物格式无效');
  artifacts=raw.artifacts.map(value=>{if(!object(value)||Object.keys(value).some(key=>!['name','text'].includes(key))||typeof value.name!=='string'||!value.name.trim()||value.name.length>200||/[\\/\x00-\x1f]/.test(value.name)||typeof value.text!=='string'||value.text.length>100000)throw failure('附加产物格式无效');return {name:value.name,text:value.text,sha256:sha(value.text)};});
 }
 return {notes:notes as string[],data,...(additions?{additions}:{}),...(artifacts?{artifacts}:{})};
}
/** 子进程仅继承运行所需环境；不打印 stderr 或供应商错误，取消和超时均等待进程退出再清理。 */
async function execute(path:string,cwd:string,stdin:string,timeout:number,signal?:AbortSignal):Promise<string>{
 if(signal?.aborted)throw failure('执行已取消');
 return await new Promise<string>((resolveRun,rejectRun)=>{
  const child=spawn(process.execPath,['--no-install',path],{cwd,env:{PATH:process.env.PATH??'',HOME:cwd,TMPDIR:cwd},stdio:['pipe','pipe','ignore']});
  let error:Error|undefined,settled=false,size=0;const chunks:Buffer[]=[];
  const stop=(reason:Error)=>{error??=reason;child.kill('SIGKILL');};
  const abort=()=>stop(failure('执行已取消'));
  const timer=setTimeout(()=>stop(failure('执行超时')),timeout);
  const finish=(code:number|null)=>{
   if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
   if(error)rejectRun(error);else if(code!==0)rejectRun(failure('脚本执行失败'));else resolveRun(Buffer.concat(chunks).toString('utf8'));
  };
  child.stdout.on('data',(bytes:Buffer)=>{size+=bytes.length;if(size>1024*1024)stop(failure('返回结果过大'));else chunks.push(bytes);});
  child.once('error',()=>{error=failure('脚本无法启动');finish(null);});child.once('close',finish);
  child.stdin.on('error',()=>stop(failure('脚本输入发送失败')));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdin.end(stdin);
 });
}
export async function runHookScript(hook:FrozenHook|undefined,payload:HookPayload,options:{signal?:AbortSignal;complete?:ReturnType<typeof createModelApiClient>['complete']}={}):Promise<HookResult>{
 if(options.signal?.aborted)throw failure('执行已取消');
 if(!hook)return {notes:[],data:{}};
 let directory:string|undefined;
 try{
  const {digest,...snapshot}=hook;
  if(sha(canonicalJson(snapshot))!==digest)throw failure('冻结指纹无效');
  const validated=validateWorkflowConfig({hooks:{before:[hook.action]}})!.hooks.before[0]!;
  if(canonicalJson(validated)!==canonicalJson(hook.action)||hook.files.length!==hook.action.files.length||hook.files.some(file=>!hook.action.files.includes(file.path))||new Set(hook.files.map(file=>file.path)).size!==hook.files.length)throw failure('冻结声明无效');
  directory=await mkdtemp(join(tmpdir(),'ai-distill-hook-'));
  for(const file of hook.files){
   const bytes=await sourceBytes(hook.project_root,file.path);
   if(bytes.length!==file.size_bytes||sha(bytes)!==file.sha256)throw failure('脚本或依赖文件已变化，请重新派发');
   const target=join(directory,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{mode:0o600,flag:'wx'});
  }
  const stdin=JSON.stringify({...payload,version:1,params:hook.action.params});
  if(Buffer.byteLength(stdin)>32*1024*1024)throw failure('输入过大');
  const raw=await execute(join(directory,hook.action.script),directory,stdin,hook.action.timeout_ms,options.signal);
  const result=parseResult(raw,hook,payload);
  if((JSON.parse(raw) as {model_request?:boolean}).model_request){
   const declared=hook.action.model_request!,call_id=randomUUID();
   // 脚本只能触发预先声明的动作，消息由宿主阶段白名单组装，不接收脚本任意消息或密钥。
   const response=await runExternalCall({attempt_id:payload.attempt_id,operation:'project_hook_model',call_id},id=>(options.complete??createModelApiClient().complete)({config:declared.config,messages:[{role:'system',content:declared.prompt},{role:'user',content:JSON.stringify({stage:payload.stage,position:payload.position,input:payload.input,...(payload.output?{output:payload.output}:{})})}],timeout_ms:hook.action.timeout_ms,signal:options.signal,call_id:id}));
   if(options.signal?.aborted)throw failure('执行已取消');
   result.model_result={...response,call_id,config:declared.config};
   if(hook.action.input_purpose&&payload.position==='before'&&payload.stage!=='answer'&&hook.action.mode==='sync')result.additions=[...(result.additions??[]),{purpose:hook.action.input_purpose,text:response.text}];
  }
  return result;
 }catch(error){if(error instanceof Error&&error.message.startsWith('项目钩子'))throw error;throw failure('执行失败，请核对文件及配置');}
 finally{if(directory)await rm(directory,{recursive:true,force:true});}
}

/** 补充说明单独标注来源及用途，不替换项目规则或核心输入。 */
export function hookAdditionText(additions?:HookAddition[]):string{
 return additions?.length?'\n\n【本次前置钩子附加说明】\n'+additions.map(item=>`用途：${item.purpose}\n${item.text}`).join('\n\n'):'';
}
