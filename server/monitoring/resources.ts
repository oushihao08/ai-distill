/**
 * 职责：本地资源采样与建议：采集 macOS／Windows 内存和登记进程数据，将未知值显式表达并计算派发建议。
 * 关键方法与用途：`parseMemoryPressure()`／`parseProcessRss()` 解析 macOS 采样；`sampleResources()` 按平台汇总内存及进程工作集；`adviseDispatch()` 计算是否暂停派发。
 * 使用场景：由 worker monitor 定时调用；未知采样保留为 unknown，不猜成零。
 */
import {execFile} from 'node:child_process';
import {freemem,totalmem} from 'node:os';
import {win32} from 'node:path';
import type {StepStatus} from '@shared/types';
export type Reading<T> = {status:'known';value:T}|{status:'unknown'};
const unknown = ():Reading<never>=>({status:'unknown'});
const known = <T>(value:T):Reading<T>=>({status:'known',value});
export type TaskState=StepStatus;
export type SafeEvent='started'|'heartbeat'|'completed'|'failed'|'cancelled';
export type AuthState='ready'|'blocked'|'unknown';
export type QuotaState='available'|'exhausted'|'unknown';
export type ErrorKind='none'|'authentication'|'quota'|'rate_limit'|'network'|'timeout'|'provider'|'configuration'|'cancelled'|'invalid_response'|'unknown';
export interface ExecutorStatus {state:TaskState;last_event?:{type:SafeEvent;at:string};authentication?:AuthState;quota?:QuotaState;error?:ErrorKind}
export interface MonitorInput {registered_pids:readonly number[];tasks?:readonly ExecutorStatus[]}
export type CommandReader=(file:string,args:readonly string[])=>Promise<string>;
export interface ResourceSnapshot {
 sampled_at:string;
 system:Reading<{total_bytes:number;available_bytes_estimate:number;available_percent:number;method:'macos_memory_pressure_percentage'|'windows_available_physical_memory'}>;
 processes:{pid:number;rss_bytes:Reading<number>}[];
 tasks:Reading<{running:number;states:Record<TaskState,number>;executors:{state:TaskState;last_event:Reading<{type:SafeEvent;at:string}>;authentication:AuthState;quota:QuotaState;error:ErrorKind}[]}>;
}
const positiveInteger=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const states:TaskState[]=['waiting','running','succeeded','failed','skipped'];
const events:SafeEvent[]=['started','heartbeat','completed','failed','cancelled'];
const errors:ErrorKind[]=['none','authentication','quota','rate_limit','network','timeout','provider','configuration','cancelled','invalid_response','unknown'];
export function parseMemoryPressure(text:string):ResourceSnapshot['system'] {
 const totalMatches=[...text.matchAll(/^The system has (\d+) \(/gm)];
 const percentMatches=[...text.matchAll(/^System-wide memory free percentage:\s*(\d+)%\s*$/gm)];
 if(totalMatches.length!==1||percentMatches.length!==1)return unknown();
 const total=Number(totalMatches[0]![1]),percent=Number(percentMatches[0]![1]);
 if(!positiveInteger(total)||!Number.isInteger(percent)||percent<0||percent>100)return unknown();
 return known({total_bytes:total,available_bytes_estimate:Math.floor(total*percent/100),available_percent:percent,method:'macos_memory_pressure_percentage'});
}
export function parseProcessRss(text:string,pid:number):Reading<number> {
 const lines=text.trim().split('\n');if(lines.length!==1)return unknown();
 const match=/^\s*(\d+)\s+(\d+)\s*$/.exec(lines[0]!);
 if(!match||Number(match[1])!==pid)return unknown();
 const bytes=Number(match[2])*1024;
 return Number.isSafeInteger(bytes)&&bytes>0?known(bytes):unknown();
}
function safeTasks(raw:MonitorInput['tasks']):ResourceSnapshot['tasks'] {
 if(!Array.isArray(raw))return unknown();
 const counts:Record<TaskState,number>={waiting:0,running:0,succeeded:0,failed:0,skipped:0};
 const executors:Extract<ResourceSnapshot['tasks'],{status:'known'}>['value']['executors']=[];
 for(const task of raw){
  if(!task||!states.includes(task.state))return unknown();
  counts[task.state as TaskState]++;
  const event=task.last_event;
  const validEvent=event&&events.includes(event.type)&&typeof event.at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(event.at)&&Number.isFinite(Date.parse(event.at));
  executors.push({state:task.state,last_event:validEvent?known({type:event.type,at:new Date(event.at).toISOString()}):unknown(),authentication:task.authentication==='ready'||task.authentication==='blocked'?task.authentication:'unknown',quota:task.quota==='available'||task.quota==='exhausted'?task.quota:'unknown',error:errors.includes(task.error as ErrorKind)?task.error!:'unknown'});
 }
 return known({running:counts.running,states:counts,executors});
}
const readCommand:CommandReader=async(file,args)=>{
 const windowsRoot=process.env.SystemRoot??'C:\\Windows';
 const env=process.platform==='win32'?{SystemRoot:windowsRoot,WINDIR:windowsRoot,PATH:win32.join(windowsRoot,'System32')}:{PATH:'/usr/bin:/bin',LC_ALL:'C'};
 try{return await new Promise<string>((resolve,reject)=>execFile(file,[...args],{timeout:3000,maxBuffer:64*1024,windowsHide:true,env},(error,stdout)=>error?reject(new Error('采样不可用')):resolve(stdout)));}catch{throw new Error('采样不可用');}
};
export async function sampleResources(input:MonitorInput,options:{read?:CommandReader;platform?:string;current_pid?:number;now?:()=>Date}={}):Promise<ResourceSnapshot> {
 const pid=options.current_pid??process.pid;
 if(!positiveInteger(pid)||!Array.isArray(input.registered_pids)||input.registered_pids.some(p=>!positiveInteger(p)))throw new Error('登记 PID 必须为正安全整数');
 const pids=[...new Set([pid,...input.registered_pids])];
 if(pids.length>256)throw new Error('登记 PID 数量超过采样上限');
 const read=options.read??readCommand,platform=options.platform??process.platform;
 const systemTask=async()=>{
  try{
   if(platform==='darwin')return parseMemoryPressure(await read('/usr/bin/memory_pressure',['-Q']));
   if(platform==='win32'){
    const total=totalmem(),available=freemem();
    if(!positiveInteger(total)||!Number.isSafeInteger(available)||available<0||available>total)return unknown();
    const percent=Math.floor(available/total*100);
    return known({total_bytes:total,available_bytes_estimate:Math.floor(total*percent/100),available_percent:percent,method:'windows_available_physical_memory' as const});
   }
   return unknown();
  }catch{return unknown();}
 };
 const processTask=async()=>{
  try{
   if(platform==='win32'){
    const shell=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const output=await read(shell,['-NoProfile','-NonInteractive','-Command',`ConvertTo-Json -InputObject @(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64) -Compress`]);
    const rows:unknown=JSON.parse(output);
    if(!Array.isArray(rows))throw new Error('进程采样结构无效');
    return pids.map(pid=>{
     const matches=rows.filter(row=>row&&typeof row==='object'&&row.Id===pid);
     return{pid,rss_bytes:matches.length===1&&positiveInteger(matches[0].WorkingSet64)?known(matches[0].WorkingSet64):unknown()};
    });
   }
   const text=await read('/bin/ps',['-p',pids.join(','),'-o','pid=,rss=']);
   const lines=text.split('\n').filter(line=>line.trim());
   return pids.map(pid=>{
    const matches=lines.filter(line=>new RegExp(`^\\s*${pid}\\s+`).test(line));
    return{pid,rss_bytes:matches.length===1?parseProcessRss(matches[0]!,pid):unknown()};
   });
  }catch{return pids.map(pid=>({pid,rss_bytes:unknown()}));}
 };
 const [system,processes]=await Promise.all([systemTask(),processTask()]);
 return{sampled_at:(options.now?.()??new Date()).toISOString(),system,processes,tasks:safeTasks(input.tasks)};
}
export interface DispatchThresholds {min_available_percent:number;max_running_tasks?:number}
export function adviseDispatch(snapshot:ResourceSnapshot,thresholds:DispatchThresholds):{decision:'pause'|'allow'|'unknown';reasons:string[]} {
 if(!Number.isFinite(thresholds.min_available_percent)||thresholds.min_available_percent<0||thresholds.min_available_percent>100||thresholds.max_running_tasks!==undefined&&!positiveInteger(thresholds.max_running_tasks))throw new Error('派发阈值无效');
 const reasons:string[]=[],uncertain:string[]=[];
 if(snapshot.system.status==='unknown')uncertain.push('system_memory_unknown');
 else if(snapshot.system.value.available_percent<thresholds.min_available_percent)reasons.push('low_available_memory');
 if(snapshot.tasks.status==='unknown')uncertain.push('executor_status_unknown');
 else{
  if(thresholds.max_running_tasks!==undefined&&snapshot.tasks.value.running>=thresholds.max_running_tasks)reasons.push('running_task_limit');
  for(const task of snapshot.tasks.value.executors){
   if(task.authentication==='blocked'||task.error==='authentication')reasons.push('authentication_blocked');
   if(task.quota==='exhausted'||task.error==='quota')reasons.push('quota_exhausted');
   if(task.error==='rate_limit')reasons.push('rate_limited');
   if(task.authentication==='unknown'||task.quota==='unknown'||task.error==='unknown')uncertain.push('executor_readiness_unknown');
  }
 }
 if(snapshot.processes.some(p=>p.rss_bytes.status==='unknown'))uncertain.push('process_memory_unknown');
 return{decision:reasons.length?'pause':uncertain.length?'unknown':'allow',reasons:[...new Set([...reasons,...uncertain])]};
}
