/**
 * 职责：Antigravity CLI (agy) 客户端：负责 agy 专属参数构造、NDJSON 会话步进状态机（含中途断流自动续跑判别）与三级结果提取；底层子进程流控与沙箱管理委托给 `server/agent/cli-runtime.ts`。
 * 核心入口：
 * - `agyLoginStatus()`：检查本机 agy CLI 可用性。
 * - `createAgyStreamSessionState()` / `ingestAgyStreamLine()`：演进 `stream-json` 会话状态机。
 * - `runAgy()`：按任务配置执行单次非交互会话并校验输出。
 * 不变量与修改禁区：
 * - `ingestAgyStreamLine()` 仅当最后一步为 `DONE` 的 `agent_response` 且步序晚于所有 `error_message` 时，才将带脏 `status='ERROR'` 的恢复会话判定为成功完成。
 * - `fresh_authoring` 下的分片写入约束提示防止单次超大工具调用触发网关流中断。
 */
import {readdir,readFile,stat,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {classifyLogError,logEvent,withLogContext} from '../logging';
import {defaultAgyBinary,resolveAgyModelAndEffort} from './models';
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

export type AgyOptions<T>=CliClientOptions<T>;

export const AGY_SCORE_ISOLATION_SETTINGS={};

const AGY_SPEC:CliRuntimeSpec={
 provider:'agy',
 label:'Antigravity',
 cliOperation:'agy_cli',
 execOperation:'agy_exec',
 tempPrefix:'ai-distill-agy-',
};

export interface AgyStepSnapshot {
 index:number;
 type:string;
 state:string;
}

export interface AgyStreamSessionState {
 session_id?:string;
 returned_model:string|null;
 last_step?:AgyStepSnapshot;
 last_done_response_index?:number;
 last_error_step_index?:number;
 error_step_count:number;
 completed_result?:Record<string,any>;
 recovered_completion:boolean;
 malformed_event:boolean;
 failed_event:boolean;
}

export function createAgyStreamSessionState():AgyStreamSessionState{
 return{
  returned_model:null,
  error_step_count:0,
  recovered_completion:false,
  malformed_event:false,
  failed_event:false,
 };
}

/**
 * 演进 agy stream-json 会话状态机。
 * agy 在单轮会话中途若发生流中断（step_type='error_message'）并自动续跑成功，
 * 末尾 event='result' 仍会携带历史脏标记 status='ERROR'；
 * 此处依据步进状态机判别：仅当最后一步为 DONE 的 agent_response 且晚于所有 error_message 步时，视为自愈完成。
 */
export function ingestAgyStreamLine(state:AgyStreamSessionState,line:string):void{
 const trimmed=line.trim();
 if(!trimmed)return;
 if(!trimmed.startsWith('{')){
  if(/^error:/i.test(trimmed))state.failed_event=true;
  return;
 }
 try{
  const parsed=JSON.parse(trimmed);
  const eventKind=parsed.event;
  if(eventKind==='init'){
   if(typeof parsed.conversation_id==='string'&&parsed.conversation_id)state.session_id=parsed.conversation_id;
   if(typeof parsed.init?.model==='string'&&parsed.init.model)state.returned_model=parsed.init.model;
   logEvent('agy.session_started',{level:'info'});
  }else if(eventKind==='step_update'){
   const step=parsed.step_update;
   if(!state.session_id&&typeof step?.conversation_id==='string'&&step.conversation_id){
    state.session_id=step.conversation_id;
   }
   if(typeof step?.step_index==='number'&&typeof step?.step_type==='string'&&typeof step?.state==='string'){
    state.last_step={index:step.step_index,type:step.step_type,state:step.state};
    if(step.step_type==='error_message'){
     state.last_error_step_index=step.step_index;
     state.error_step_count+=1;
    }else if(step.step_type==='agent_response'&&step.state==='DONE'){
     state.last_done_response_index=step.step_index;
    }
   }
  }else if(eventKind==='result'){
   const res=parsed.result;
   if(res&&typeof res==='object'){
    if(typeof res.conversation_id==='string'&&res.conversation_id)state.session_id=res.conversation_id;
    const hasPayload=res.structured_output!==undefined||(typeof res.response==='string'&&res.response.trim().length>0);
    const recovered=
     res.status!=='SUCCESS'&&
     state.last_step?.type==='agent_response'&&
     state.last_step.state==='DONE'&&
     state.last_done_response_index!==undefined&&
     (state.last_error_step_index===undefined||state.last_done_response_index>state.last_error_step_index)&&
     hasPayload;
    if(res.status==='SUCCESS'||recovered){
     state.completed_result=res;
     state.recovered_completion=recovered;
     logEvent('agy.turn_completed',{
      level:'info',
      token_usage:res.usage,
      ...(recovered?{recovered:true,recovered_error_steps:state.error_step_count}:{}),
     });
    }else{
     state.failed_event=true;
     logEvent('agy.event_failed',{level:'warn',event_type:String(res.status??'ERROR')});
    }
   }else{
    state.failed_event=true;
   }
  }
 }catch{
  state.malformed_event=true;
  logEvent('agy.event_parse_failed',{level:'warn',event_type:'malformed'});
 }
}

function agyEnvironment(credentialsHome?:string){
 return buildSafeCliEnvironment({extraKeys:['USER','LOGNAME','AGY_HOME'],credentialEnvKey:'AGY_HOME',credentialsHome});
}

/**
 * 若最终 `result.json` 尚未生成，但输出目录内已存在分片文件（`_part_*.json`），
 * 则按确定性规则将 `_part_rubric.json` 与 `_part_answer*.json` 无损合并为 `result.json`。
 */
export async function assembleAgyChunkedOutput(sourceOutput:string,resultPath:string,fresh:boolean):Promise<boolean>{
 try{
  const existing=await stat(resultPath);
  if(existing.isFile()&&existing.size>0)return false;
 }catch(error){
  if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;
 }
 const entries=(await readdir(sourceOutput)).filter((name:string)=>/^_part_.*\.json$/i.test(name)).sort();
 if(!entries.length)return false;
 const rubricFirst=entries.slice().sort((a:string,b:string)=>{
  const aIsRubric=a.includes('rubric')?0:1;
  const bIsRubric=b.includes('rubric')?0:1;
  return aIsRubric!==bIsRubric?aIsRubric-bIsRubric:a.localeCompare(b);
 });
 const merged:Record<string,unknown>={};
 const refFragments:string[]=[];
 for(const name of rubricFirst){
  const text=await readSafeCliResultText(sourceOutput,join(sourceOutput,name),fresh);
  const part=JSON.parse(text);
  if(!part||typeof part!=='object'||Array.isArray(part))continue;
  for(const [key,val] of Object.entries(part as Record<string,unknown>)){
   if(/^(?:ref_part|reference_answer_part)\d*$/i.test(key)){
    if(typeof val==='string'&&val)refFragments.push(val);
   }else if(key==='reference_answer'&&typeof val==='string'&&val){
    if(typeof merged.reference_answer==='string'&&merged.reference_answer){
     merged.reference_answer=`${merged.reference_answer}\n${val}`;
    }else{
     merged.reference_answer=val;
    }
   }else{
    merged[key]=val;
   }
  }
 }
 if((typeof merged.reference_answer!=='string'||!merged.reference_answer)&&refFragments.length){
  merged.reference_answer=refFragments.join('');
 }
 if(!Object.keys(merged).length)return false;
 await writeFile(resultPath,JSON.stringify(merged),{mode:0o600});
 logEvent('agy.chunked_result_assembled',{level:'info',part_count:entries.length});
 return true;
}

export async function agyLoginStatus(
 binary=defaultAgyBinary(),
 credentialsHome?:string,
 call_id?:string,
 onProcess?:(pid:number|null)=>void,
 signal?:AbortSignal
):Promise<{status:'authenticated'|'unavailable'}>{
 try{
  const result=await executeCliProcess(AGY_SPEC,binary,['--help'],{
   timeout:10000,
   env:agyEnvironment(credentialsHome),
   call_id,
   onProcess,
   signal,
  });
  const text=result.stdout+'\n'+result.stderr;
  return{status:result.code===0&&/Usage of agy/i.test(text)?'authenticated':'unavailable'};
 }catch(error){
  if(signal?.aborted)throw error;
  return{status:'unavailable'};
 }
}

export async function runAgy<T>(options:AgyOptions<T>):Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number;returned_model:string|null}>{
 return runWithCliTimeoutBoundary(AGY_SPEC,options,runAgyInternal);
}

async function runAgyInternal<T>(options:AgyOptions<T>):Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number;returned_model:string|null}>{
 if(options.signal?.aborted)throw new Error('Antigravity执行已取消');
 const fresh=options.execution_profile==='fresh_authoring';
 if(fresh&&(!options.working_directory||options.isolate_context||options.developer_instructions||options.output_format==='text'||options.input_files?.length)){
  throw new Error('普通出题执行配置冲突');
 }
 const binary=options.binary??defaultAgyBinary();
 const resolved=resolveAgyModelAndEffort(options.model,options.reasoning_effort);
 const call_id=options.call_id??randomUUID(),model=options.model,reasoning_effort=options.reasoning_effort,timeout_ms=options.timeout_ms??30*60*1000,startedAt=Date.now();
 await withLogContext({call_id,provider:'agy',model,reasoning_effort},async()=>logEvent('call.started',{level:'info',operation:'agy_exec',timeout_ms}));

 const started=Date.now();
 const ws=await prepareCliWorkspace(AGY_SPEC,options,call_id);

 const boundaryInstruction=fresh
  ?`【执行环境边界】仅读取当前项目工作区与本次任务目录（${options.directory}）内的文件；禁止搜索或读取 ~/.gemini/antigravity/brain 等外部会话记录。\n【流式落盘防断流约束（严禁删减质量与篇幅）】Antigravity 单步流式输出受网关单步时限约束，超时会中断当前流并丢弃未闭合的工具调用。必须保持题面、rubric、作答思路与标准答案的最高完整度与深度，严禁为缩减单步耗时而删减、压缩或省略任何实质内容；写入 ${ws.resultPath} 时，禁止在单次 write_to_file 或单次 run_command 脚本中一次性内联全部字段（不得在同一工具调用中同时内联完整 rubric 与完整 reference_answer）：必须分步无损持久化到磁盘，第 1 步先将题面、表头、material_scope_selection 与 rubric 写入 ${ws.output}/_part_rubric.json，第 2 步（及必要时第 3 步）将 answer_approach 与 reference_answer 分片写入 ${ws.output}/_part_answer_1.json（与 _part_answer_2.json），最后合并分片写入 ${ws.resultPath}，校验通过后立即结束会话。`
  :'【执行环境边界】当前为独立沙箱目录。仅读取和操作当前工作目录（.）内的文件；禁止搜索、读取或遍历上层目录（..）、用户主目录（~ / /Users）或任何外部路径。';
 const combinedDeveloperInstructions=[options.developer_instructions?.trim(),boundaryInstruction].filter(Boolean).join('\n\n');
 const effectivePrompt=`<developer_instructions>\n${combinedDeveloperInstructions}\n</developer_instructions>\n\n${options.prompt}`;
 const stdinMessage=JSON.stringify({event:'user',message:{content:effectivePrompt}})+'\n';

 const args=[
  '--model',resolved.model,
  '--effort',resolved.effort,
  '--input-format','stream-json',
  '--output-format','stream-json',
  ...(fresh||options.output_format==='text'?[]:['--json-schema',ws.schemaPath]),
  ...(fresh?[]:['--sandbox','--disable-slash-commands','--settings',JSON.stringify(AGY_SCORE_ISOLATION_SETTINGS)]),
  '--dangerously-skip-permissions',
  '--print=',
 ];

 let eventBuffer='';
 const streamState=createAgyStreamSessionState();
 const onStdout=async(chunk:string)=>{
  await ws.eventsFile.write(chunk);
  eventBuffer+=chunk;
  const lines=eventBuffer.split('\n');
  eventBuffer=lines.pop()??'';
  for(const line of lines)ingestAgyStreamLine(streamState,line);
 };

 let invocation;
 try{
  await ws.writeRequestSnapshot({
   argv:args,
   resolved_model:resolved.model,
   configuration_home:options.credentialsHome??process.env.AGY_HOME??join(homedir(),'.gemini','antigravity-cli'),
  });
  invocation=await withLogContext({call_id,provider:'agy',model,reasoning_effort},()=>executeCliProcess(AGY_SPEC,binary,args,{
   directory:ws.directory,
   stdinText:stdinMessage,
   env:agyEnvironment(options.credentialsHome),
   timeout:timeout_ms,
   signal:options.signal,
   onStdout,
   captureStdout:false,
   call_id,
   onProcess:options.onProcess,
  }));
  if(eventBuffer)ingestAgyStreamLine(streamState,eventBuffer);
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
  if(streamState.malformed_event)throw createCliResultError('Antigravity','invalid_json');
  const session_id=streamState.session_id;
  const completedEvent=streamState.completed_result;
  if(typeof session_id!=='string'||!completedEvent||streamState.failed_event)throw createCliResultError('Antigravity','incomplete_turn');
  let value:unknown;
  try{
   if(fresh){
    if(typeof completedEvent.response==='string'){
     await writeFile(ws.cliResultPath,completedEvent.response,{mode:0o600});
    }
    await assembleAgyChunkedOutput(ws.sourceOutput,ws.resultPath,true);
    const text=await readSafeCliResultText(ws.sourceOutput,ws.resultPath,true);
    value=JSON.parse(text);
   }else if(options.output_format==='text'){
    const text=typeof completedEvent.response==='string'?completedEvent.response:'';
    await writeFile(ws.resultPath,text,{mode:0o600});
    value=text;
   }else{
    if(completedEvent.structured_output!==undefined){
     value=completedEvent.structured_output;
     await writeFile(ws.resultPath,JSON.stringify(value),{mode:0o600});
    }else{
     let parsedFromResponse=false;
     if(typeof completedEvent.response==='string'&&completedEvent.response.trim()){
      try{
       value=JSON.parse(completedEvent.response);
       parsedFromResponse=true;
       await writeFile(ws.resultPath,JSON.stringify(value),{mode:0o600});
      }catch{
       parsedFromResponse=false;
      }
     }
     if(!parsedFromResponse){
      try{
       await assembleAgyChunkedOutput(ws.sourceOutput,ws.resultPath,false);
       const text=await readFile(ws.resultPath,'utf8');
       value=JSON.parse(text);
      }catch(fileError){
       if(typeof completedEvent.response==='string'&&completedEvent.response.trim()&&(fileError as NodeJS.ErrnoException)?.code==='ENOENT'){
        throw new SyntaxError('invalid json response');
       }
       throw fileError;
      }
     }
    }
   }
  }catch(error){
   const code=error&&typeof error==='object'&&'code'in error?(error as {code?:unknown}).code:undefined;
   throw createCliResultError('Antigravity',code==='ENOENT'?'result_missing':code?'result_read_failed':'invalid_json');
  }
  withLogContext({call_id,provider:'agy',model,reasoning_effort,session_id},()=>logEvent('result.parsed',{level:'info'}));
  let validated:T;
  try{
   validated=options.validate(value);
  }catch(error){
   const reason=error&&typeof error==='object'&&'reason_code'in error?(error as {reason_code?:unknown}).reason_code:undefined;
   throw createCliResultError('Antigravity',typeof reason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(reason)?reason:'result_validation_failed');
  }
  const duration_ms=Date.now()-started;
  withLogContext({call_id,provider:'agy',model,reasoning_effort,session_id},()=>{
   logEvent('result.validated',{level:'info'});
   logEvent('call.completed',{level:'info',operation:'agy_exec',elapsed_ms:duration_ms,token_usage:completedEvent.usage});
  });
  return{result:validated,session_id,usage:completedEvent.usage??null,events_path:ws.events_path,duration_ms,returned_model:streamState.returned_model??resolved.model};
 }catch(error){
  const reason=error&&typeof error==='object'&&'reason_code'in error&&(error as {reason_code?:unknown}).reason_code;
  const reason_code=typeof reason==='string'?reason:'result_invalid';
  withLogContext({call_id,provider:'agy',model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:'agy_exec',reason_code,...classifyLogError(error)}));
  throw Object.assign(new Error('Antigravity结果缺失、无效或执行未完整结束'),{kind:classifyLogError(error).error_kind,reason_code,retryable:false});
 }
}
