/**
 * 职责：Antigravity CLI (agy) 客户端：负责 agy 专属参数构造、NDJSON 会话步进状态机（含中途断流自愈判别与瞬时断网同会话续跑）、无关宿主全局 Skill 隔离与三级结果提取；底层子进程流控与沙箱管理委托给 `server/agent/cli-runtime.ts`。
 * 核心入口：
 * - `agyLoginStatus()`：检查本机 agy CLI 可用性。
 * - `createAgyStreamSessionState()` / `ingestAgyStreamLine()`：演进 `stream-json` 会话状态机。
 * - `assembleAgyChunkedOutput()`：无损合并 `_part_*.json` 与纯文本分片 `_part_*.txt` 为 `result.json`。
 * - `runAgy()`：按任务配置执行非交互会话（遇瞬时断网按原 `conversation_id` 自动续跑）并校验输出。
 * 不变量与修改禁区：
 * - `ingestAgyStreamLine()` 仅当最后一步为 `DONE` 的 `agent_response` 且步序晚于所有 `error_message` 时，才将带脏 `status='ERROR'` 的恢复会话判定为成功完成。
 * - `fresh_authoring` 下采用结构化 `_part_rubric.json` + 纯文本 `_part_*.txt` 分片落盘，避免长文本 JSON 转义失败与单步流式超时，严禁缩减正文质量或关闭可用工具。
 */
import {mkdir,readdir,readFile,stat,writeFile} from 'node:fs/promises';
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
 last_error_text?:string;
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
  if(/^error:/i.test(trimmed)){
   state.failed_event=true;
   state.last_error_text=trimmed;
  }
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
    if(typeof res.error==='string'&&res.error.trim())state.last_error_text=res.error.trim();
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

function joinTextFragments(parts:string[]):string{
 let merged='';
 for(const part of parts){
  if(!part)continue;
  if(!merged){merged=part;continue;}
  merged=merged.endsWith('\n')||part.startsWith('\n')?merged+part:`${merged}\n${part}`;
 }
 return merged;
}

/**
 * 若最终 `result.json` 尚未生成（或因中途断流残缺损坏），但输出目录内已存在分片文件（`_part_*.json` / `_part_*.txt`），
 * 则按确定性规则将结构化分片（如 `_part_rubric.json`）与纯文本分片（`_part_question.txt`、`_part_approach.txt`、`_part_ref_*.txt`）
 * 及历史兼容 JSON 分片（`_part_answer*.json`）无损合并为 `result.json`。
 */
export async function assembleAgyChunkedOutput(sourceOutput:string,resultPath:string,fresh:boolean):Promise<boolean>{
 try{
  const existing=await stat(resultPath);
  if(existing.isFile()&&existing.size>0){
   try{
    const existingText=await readSafeCliResultText(sourceOutput,resultPath,fresh);
    JSON.parse(existingText);
    return false;
   }catch(parseError){
    if(!(parseError instanceof SyntaxError))throw parseError;
    logEvent('agy.result_json_corrupted_try_parts',{level:'warn'});
   }
  }
 }catch(error){
  if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;
 }
 const allEntries=await readdir(sourceOutput);
 const jsonEntries=allEntries
  .filter((name:string)=>/^_part_.*\.json$/i.test(name))
  .sort((a:string,b:string)=>{
   const aIsRubric=a.toLowerCase().includes('rubric')?0:1;
   const bIsRubric=b.toLowerCase().includes('rubric')?0:1;
   return aIsRubric!==bIsRubric?aIsRubric-bIsRubric:a.localeCompare(b,undefined,{numeric:true});
  });
 const txtEntries=allEntries
  .filter((name:string)=>/^_part_.*\.txt$/i.test(name))
  .sort((a:string,b:string)=>a.localeCompare(b,undefined,{numeric:true}));
 if(!jsonEntries.length&&!txtEntries.length)return false;

 const merged:Record<string,unknown>={};
 const jsonRefFragments:string[]=[];
 for(const name of jsonEntries){
  const text=await readSafeCliResultText(sourceOutput,join(sourceOutput,name),fresh);
  const part=JSON.parse(text);
  if(!part||typeof part!=='object'||Array.isArray(part))continue;
  for(const [key,val] of Object.entries(part as Record<string,unknown>)){
   if(/^(?:ref_part|reference_answer_part)\d*$/i.test(key)){
    if(typeof val==='string'&&val)jsonRefFragments.push(val);
   }else if(key==='reference_answer'&&typeof val==='string'&&val){
    if(typeof merged.reference_answer==='string'&&merged.reference_answer){
     merged.reference_answer=joinTextFragments([merged.reference_answer,val]);
    }else{
     merged.reference_answer=val;
    }
   }else{
    merged[key]=val;
   }
  }
 }

 const txtRefFragments:string[]=[];
 for(const name of txtEntries){
  const text=await readSafeCliResultText(sourceOutput,join(sourceOutput,name),fresh);
  if(!text)continue;
  if(/^_part_question\.txt$/i.test(name)){
   if(typeof merged.question!=='string'||!merged.question.trim())merged.question=text;
  }else if(/^_part_(?:answer_)?approach\.txt$/i.test(name)){
   if(typeof merged.answer_approach!=='string'||!merged.answer_approach.trim())merged.answer_approach=text;
  }else if(/^_part_(?:ref(?:erence)?(?:_answer)?|answer)(?:[_-]?\d+)?\.txt$/i.test(name)){
   txtRefFragments.push(text);
  }
 }

 if((typeof merged.reference_answer!=='string'||!merged.reference_answer.trim())&&txtRefFragments.length){
  merged.reference_answer=joinTextFragments(txtRefFragments);
 }else if((typeof merged.reference_answer!=='string'||!merged.reference_answer.trim())&&jsonRefFragments.length){
  merged.reference_answer=jsonRefFragments.join('');
 }
 if(!Object.keys(merged).length)return false;
 await writeFile(resultPath,JSON.stringify(merged),{mode:0o600});
 logEvent('agy.chunked_result_assembled',{level:'info',part_count:jsonEntries.length+txtEntries.length});
 return true;
}

const MAX_AGY_TRANSIENT_RESUMES=4;
const MAX_AGY_COLD_RETRIES=2;
/** stdout连续20分钟无任何事件视为卡死（正常单步最长约1.5分钟），结束后续传或回收已落盘结果，不再干等总超时。 */
const AGY_STALL_TIMEOUT_MS=20*60*1000;
const PERMANENT_AGY_ERROR_RE=/invalid model|not recognized as a known model|authentication required|unauthenticated|unauthorized|invalid_argument|permission denied|quota|billing|insufficient credits/i;

function isTransientAgyInterruption(
 state:AgyStreamSessionState,
 exitCode:number|null,
 stderr:string,
 signal?:AbortSignal
):boolean{
 if(signal?.aborted)return false;
 if(typeof state.session_id!=='string'||!state.session_id.trim())return false;
 if(state.completed_result&&!state.failed_event&&exitCode===0&&!state.malformed_event)return false;
 const diag=`${state.last_error_text??''}\n${stderr}`;
 if(PERMANENT_AGY_ERROR_RE.test(diag))return false;
 if(state.malformed_event&&exitCode===0&&!state.failed_event&&state.error_step_count===0)return false;
 return exitCode!==0||state.failed_event||!state.completed_result;
}

function isColdStartRetryableAgyError(
 state:AgyStreamSessionState,
 exitCode:number|null,
 stderr:string,
 signal?:AbortSignal
):boolean{
 if(signal?.aborted)return false;
 if(typeof state.session_id==='string'&&state.session_id.trim())return false;
 if(exitCode===0)return false;
 const diag=`${state.last_error_text??''}\n${stderr}`;
 return !PERMANENT_AGY_ERROR_RE.test(diag);
}

async function abortableDelay(ms:number,signal?:AbortSignal):Promise<void>{
 if(ms<=0)return;
 if(signal?.aborted)throw new Error('Antigravity执行已取消');
 await new Promise<void>((resolveDelay,rejectDelay)=>{
  const onAbort=()=>{
   clearTimeout(timer);
   rejectDelay(new Error(signal?.reason instanceof Error&&signal.reason.message.includes('超时')?'Antigravity执行超时':'Antigravity执行已取消'));
  };
  const timer=setTimeout(()=>{
   signal?.removeEventListener('abort',onAbort);
   resolveDelay();
  },ms);
  signal?.addEventListener('abort',onAbort,{once:true});
 });
}

async function collectCustomizationEntryNames(dirs:string[]):Promise<string[]>{
 const names=new Set<string>();
 for(const dir of dirs){
  try{
   for(const entry of await readdir(dir,{withFileTypes:true})){
    if(!entry.name.startsWith('.')&&(entry.isDirectory()||entry.isSymbolicLink())){
     names.add(entry.name);
    }
   }
  }catch(error){
   const code=(error as NodeJS.ErrnoException)?.code;
   if(code!=='ENOENT'&&code!=='ENOTDIR'){
    logEvent('agy.skill_exclusion_scan_skipped',{level:'warn',...classifyLogError(error)});
   }
  }
 }
 return [...names].sort();
}

/**
 * 在受限临时工作区（脱敏、整理、独立评分、盲作答等）写入 `.agents/skills.json` 与 `.agents/plugins.json` 排除清单，
 * 屏蔽 `~/.gemini/config/` 与 `~/.agents/skills` 中的无关全局宿主 Skill/插件，不触碰真实用户目录且不随 `output/` 考回业务目录。
 */
async function writeIsolatedAgyCustomizationExclusions(workspaceDir:string):Promise<void>{
 const home=homedir();
 const [excludedSkills,excludedPlugins]=await Promise.all([
  collectCustomizationEntryNames([
   join(home,'.gemini','config','skills'),
   join(home,'.agents','skills'),
  ]),
  collectCustomizationEntryNames([
   join(home,'.gemini','config','plugins'),
  ]),
 ]);
 const agentsDir=join(workspaceDir,'.agents');
 await mkdir(agentsDir,{recursive:true,mode:0o700});
 await writeFile(join(agentsDir,'skills.json'),JSON.stringify({exclude:excludedSkills}),{mode:0o600});
 await writeFile(join(agentsDir,'plugins.json'),JSON.stringify({exclude:excludedPlugins}),{mode:0o600});
}

function mergeTokenUsage(previous:unknown,next:unknown):unknown{
 if(!previous||typeof previous!=='object')return next??null;
 if(!next||typeof next!=='object')return previous;
 const out:Record<string,unknown>={...(previous as Record<string,unknown>),...(next as Record<string,unknown>)};
 for(const [key,val] of Object.entries(next as Record<string,unknown>)){
  const prevVal=(previous as Record<string,unknown>)[key];
  if(typeof val==='number'&&typeof prevVal==='number'){
   out[key]=prevVal+val;
  }
 }
 return out;
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
  ?`【执行环境边界】仅读取当前项目工作区与本次任务目录（${options.directory}）内的文件；禁止搜索或读取 ~/.gemini/antigravity/brain 等外部会话记录；禁止读取或调用与本题无关的宿主全局 Skill（~/.agents/skills、~/.gemini/*/skills）及仓库操作 Skill（.agents/skills），仅读取本次提示词明确指定的项目 Skill 及其引用文件。\n【纯文本分片落盘防断流与免转义约束（严禁删减质量与篇幅）】Antigravity 单步流式输出受网关单步时限约束，且将数万字长文内联进 JSON 字符串极易引发转义报错。必须保持题面、rubric、作答思路与标准答案的最高完整度与深度，严禁为缩减单步耗时而删减、压缩或省略任何实质内容；写入 ${ws.resultPath} 时，禁止在单次工具调用中一次性内联全部字段，也禁止将长篇 answer_approach 或 reference_answer 手写转义进 JSON 文件：第 1 步先将题面、表头、material_scope_selection、answer_requirements 与 rubric 写入 ${ws.output}/_part_rubric.json（题面较长时也可单独写纯文本 ${ws.output}/_part_question.txt）；第 2 步将 answer_approach 直接以纯文本（无需 JSON 转义）写入 ${ws.output}/_part_approach.txt；第 3 步起将 reference_answer 按自然章节分 1 至 3 片以纯文本直接写入 ${ws.output}/_part_ref_1.txt（及 _part_ref_2.txt、_part_ref_3.txt）；最后可用简短脚本按文件流读取分片拼装写入 ${ws.resultPath}（若未手动拼装，宿主也会在会话结束时自动无损合并上述分片为 ${ws.resultPath}），核验通过后立即结束会话。`
  :'【执行环境边界】当前为独立沙箱目录。仅读取和操作当前工作目录（.）内的文件；禁止搜索、读取或遍历上层目录（..）、用户主目录（~ / /Users）或任何外部路径（含宿主全局 Skill 目录）。';
 const combinedDeveloperInstructions=[options.developer_instructions?.trim(),boundaryInstruction].filter(Boolean).join('\n\n');
 const effectivePrompt=`<developer_instructions>\n${combinedDeveloperInstructions}\n</developer_instructions>\n\n${options.prompt}`;
 const stdinMessage=JSON.stringify({event:'user',message:{content:effectivePrompt}})+'\n';

 const baseArgs=[
  '--model',resolved.model,
  '--effort',resolved.effort,
  '--input-format','stream-json',
  '--output-format','stream-json',
  ...(fresh||options.output_format==='text'?[]:['--json-schema',ws.schemaPath]),
  '--disable-slash-commands',
  ...(fresh?[]:['--sandbox','--settings',JSON.stringify(AGY_SCORE_ISOLATION_SETTINGS)]),
  '--dangerously-skip-permissions',
  '--print=',
 ];

 const deadline=started+timeout_ms;
 let streamState=createAgyStreamSessionState();
 let accumulatedUsage:unknown=null;
 let invocation!:{stdout:string;stderr:string;code:number|null;stalled?:boolean};
 // 子进程超时、卡死或异常退出时，若作者已把完整题包写盘且通过同一校验，直接回收，不丢弃已完成成果。
 const recoverFromDisk=async(reason:string):Promise<{result:T;session_id:string;usage:unknown;events_path:string;duration_ms:number;returned_model:string|null}|undefined>=>{
  if(!fresh)return undefined;
  try{
   await assembleAgyChunkedOutput(ws.sourceOutput,ws.resultPath,true);
   const validated=options.validate(JSON.parse(await readSafeCliResultText(ws.sourceOutput,ws.resultPath,true)));
   const duration_ms=Date.now()-started,usage=accumulatedUsage??streamState.completed_result?.usage??null,session_id=streamState.session_id??'';
   withLogContext({call_id,provider:'agy',model,reasoning_effort,...(session_id?{session_id}:{})},()=>{
    logEvent('agy.result_recovered_from_disk',{level:'warn',reason_code:reason});
    logEvent('call.completed',{level:'info',operation:'agy_exec',elapsed_ms:duration_ms,token_usage:usage});
   });
   return{result:validated,session_id,usage,events_path:ws.events_path,duration_ms,returned_model:streamState.returned_model??resolved.model};
  }catch{return undefined;}
 };
 try{
  if(!fresh){
   await writeIsolatedAgyCustomizationExclusions(ws.directory);
  }
  await ws.writeRequestSnapshot({
   argv:baseArgs,
   resolved_model:resolved.model,
   configuration_home:options.credentialsHome??process.env.AGY_HOME??join(homedir(),'.gemini','antigravity-cli'),
  });
  let resumesUsed=0,coldRetriesUsed=0;
  for(let attempt=0;attempt<=MAX_AGY_TRANSIENT_RESUMES+MAX_AGY_COLD_RETRIES;attempt++){
   const resumingSessionId=attempt>0?streamState.session_id:undefined;
   const prevModel=streamState.returned_model;
   streamState=createAgyStreamSessionState();
   if(resumingSessionId)streamState.session_id=resumingSessionId;
   if(prevModel)streamState.returned_model=prevModel;

   const currentArgs=resumingSessionId
    ?[
      '--model',resolved.model,
      '--effort',resolved.effort,
      '--conversation',resumingSessionId,
      ...baseArgs.slice(4),
     ]
    :baseArgs;
   const resumePrompt=fresh
    ?`网络连接短暂中断。请先检查当前输出目录（${ws.output}）已落盘的分片或结果文件，在保留已完成内容的基础上从断点继续完成剩余步骤并交付 ${ws.resultPath}，严禁删减篇幅或重头重写已完成部分。`
    :'网络连接短暂中断。请先检查当前工作目录已生成的进度或结果文件，从断点继续完成剩余步骤与本地校验，并按原格式要求返回最终结果。';
   const currentStdin=resumingSessionId
    ?JSON.stringify({event:'user',message:{content:resumePrompt}})+'\n'
    :stdinMessage;

   let eventBuffer='';
   const onStdout=async(chunk:string)=>{
    await ws.eventsFile.write(chunk);
    eventBuffer+=chunk;
    const lines=eventBuffer.split('\n');
    eventBuffer=lines.pop()??'';
    for(const line of lines)ingestAgyStreamLine(streamState,line);
   };

   const remainingTimeout=Math.max(1,deadline-Date.now());
   invocation=await withLogContext({call_id,provider:'agy',model,reasoning_effort,...(resumingSessionId?{session_id:resumingSessionId}:{})},()=>executeCliProcess(AGY_SPEC,binary,currentArgs,{
    directory:ws.directory,
    stdinText:currentStdin,
    env:agyEnvironment(options.credentialsHome),
    timeout:remainingTimeout,
    signal:options.signal,
    onStdout,
    captureStdout:false,
    call_id,
    onProcess:options.onProcess,
    idleTimeout:AGY_STALL_TIMEOUT_MS,
   }));
   if(invocation.stalled){
    withLogContext({call_id,provider:'agy',model,reasoning_effort,...(streamState.session_id?{session_id:streamState.session_id}:{})},()=>
     logEvent('agy.session_stalled',{level:'warn',idle_timeout_ms:AGY_STALL_TIMEOUT_MS})
    );
   }
   if(eventBuffer.trim()){
    if(invocation.code===0){
     ingestAgyStreamLine(streamState,eventBuffer);
    }else{
     try{
      JSON.parse(eventBuffer.trim());
      ingestAgyStreamLine(streamState,eventBuffer);
     }catch{
      logEvent('agy.truncated_tail_ignored',{level:'warn',exit_code:invocation.code});
     }
    }
   }
   if(streamState.completed_result?.usage!==undefined){
    accumulatedUsage=mergeTokenUsage(accumulatedUsage,streamState.completed_result.usage);
   }

   // 断流续传与冷启动重试分开计数，互不挤占额度。
   const canResume=
    resumesUsed<MAX_AGY_TRANSIENT_RESUMES&&
    deadline-Date.now()>1000&&
    isTransientAgyInterruption(streamState,invocation.code,invocation.stderr,options.signal);
   const canColdRetry=
    !canResume&&
    coldRetriesUsed<MAX_AGY_COLD_RETRIES&&
    deadline-Date.now()>60_000&&
    isColdStartRetryableAgyError(streamState,invocation.code,invocation.stderr,options.signal);
   if(!canResume&&!canColdRetry)break;
   if(canResume)resumesUsed++;else coldRetriesUsed++;

   const nextAttempt=canResume?resumesUsed:coldRetriesUsed;
   const backoffMs=Math.min(nextAttempt*2000,Math.max(200,Math.floor((deadline-Date.now())/10)));
   withLogContext({call_id,provider:'agy',model,reasoning_effort,...(streamState.session_id?{session_id:streamState.session_id}:{})},()=>
    logEvent(canResume?'agy.session_resuming':'agy.cold_retrying',{level:'warn',resume_attempt:nextAttempt,exit_code:invocation.code??undefined})
   );
   if(canResume){
    await ws.eventsFile.write(JSON.stringify({type:'distill.session_resume',conversation_id:streamState.session_id,attempt:nextAttempt,exit_code:invocation.code})+'\n');
   }
   await abortableDelay(backoffMs,options.signal);
  }
  await ws.eventsFile.close();
  await ws.persistOutput();
 }catch(error){
  await ws.recordExecutionFailure(error,startedAt);
  // 仅超时可回收；用户取消必须尊重，不回收结果。
  if(error instanceof Error&&error.message===`${AGY_SPEC.label}执行超时`){
   const recovered=await recoverFromDisk('agy_timeout');
   if(recovered)return recovered;
  }
  throw error;
 }
 await ws.cleanupStaging();
 if(invocation.code!==0){
  const recovered=await recoverFromDisk(invocation.stalled?'agy_stalled':'process_exit_nonzero');
  if(recovered)return recovered;
  await ws.recordNonZeroExit(invocation.code,invocation.stderr,startedAt);
 }

 try{
  if(streamState.malformed_event)throw createCliResultError('Antigravity','invalid_json');
  const session_id=streamState.session_id;
  const completedEvent=streamState.completed_result;
  if(typeof session_id!=='string'||!completedEvent||streamState.failed_event){
   const recovered=await recoverFromDisk('incomplete_turn');
   if(recovered)return recovered;
   throw createCliResultError('Antigravity','incomplete_turn');
  }
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
  const finalUsage=accumulatedUsage??completedEvent.usage??null;
  withLogContext({call_id,provider:'agy',model,reasoning_effort,session_id},()=>{
   logEvent('result.validated',{level:'info'});
   logEvent('call.completed',{level:'info',operation:'agy_exec',elapsed_ms:duration_ms,token_usage:finalUsage});
  });
  return{result:validated,session_id,usage:finalUsage,events_path:ws.events_path,duration_ms,returned_model:streamState.returned_model??resolved.model};
 }catch(error){
  const reason=error&&typeof error==='object'&&'reason_code'in error&&(error as {reason_code?:unknown}).reason_code;
  const reason_code=typeof reason==='string'?reason:'result_invalid';
  withLogContext({call_id,provider:'agy',model,reasoning_effort},()=>logEvent('call.failed',{level:'error',operation:'agy_exec',reason_code,...classifyLogError(error)}));
  throw Object.assign(new Error('Antigravity结果缺失、无效或执行未完整结束'),{kind:classifyLogError(error).error_kind,reason_code,retryable:false});
 }
}
