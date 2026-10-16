/**
 * 职责：在隔离容器中使用固定版本Claude Code执行Work文件作答，收集候选真实文件和执行证据。
 * 入口：runFileAnswer；仅接收题面、获准脱敏附件、成果清单和冻结模型配置，不读取作者Skill、Rubric或标答。
 * 当前作为执行基础模块，尚未接入持久作答队列；真实运行须先获容器启动与构建授权。
 */
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative} from 'node:path';
import {resolveModelApiConfig,type ModelApiConfig} from '../llm-api';
import {readModelApiKey} from '../llm-api/config';
import {logEvent} from '../logging';

export interface FileAnswerInvocation {args:string[];stdin:string;env:NodeJS.ProcessEnv;signal?:AbortSignal;timeout_ms:number}
interface ProcessResult {code:number;stdout:string;stderr:string}
export interface FileAnswerInput {
 directory:string;image:string;question:string;materials:{name:string;text:string}[];
 deliverables:{path:string;required:boolean}[];config:ModelApiConfig;timeout_ms:number;signal?:AbortSignal;
}
export interface FileAnswerFile {path:string;storage_path:string;sha256:string;size_bytes:number}
export interface FileAnswerResult {
 text:string;requested_model:string;model:string|null;usage:Record<string,unknown>|null;duration_ms:number;
 files:FileAnswerFile[];execution:{framework:'claude-code';version:'2.1.114';session_id:string;events_path:string;image:string};
}
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function safePath(value:string){return typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=200&&!isAbsolute(value)&&!/[\\\x00-\x1f\x7f]/.test(value)&&!value.split('/').some(p=>!p||p==='.'||p==='..');}

async function runProcess(call:FileAnswerInvocation):Promise<ProcessResult>{
 if(call.signal?.aborted)throw new Error('文件作答已取消');
 return new Promise((resolve,reject)=>{
  const child=spawn('docker',call.args,{env:call.env,stdio:['pipe','pipe','pipe']});
  const stdout:Buffer[]=[],stderr:Buffer[]=[];let bytes=0,settled=false;
  const finish=(error?:Error,result?:ProcessResult)=>{if(settled)return;settled=true;clearTimeout(timer);call.signal?.removeEventListener('abort',abort);if(error){child.kill('SIGTERM');reject(error);}else resolve(result!);};
  const abort=()=>finish(new Error('文件作答已取消'));
  const timer=setTimeout(()=>finish(new Error('文件作答超过本次时限')),call.timeout_ms);
  call.signal?.addEventListener('abort',abort,{once:true});
  const collect=(target:Buffer[],chunk:Buffer)=>{bytes+=chunk.length;if(bytes>25*1024*1024)finish(new Error('文件作答执行记录超过大小限制'));else target.push(chunk);};
  child.stdout.on('data',chunk=>collect(stdout,Buffer.from(chunk)));child.stderr.on('data',chunk=>collect(stderr,Buffer.from(chunk)));
  child.on('error',()=>finish(new Error('Docker执行器无法启动')));
  child.stdin.on('error',()=>finish(new Error('Docker输入管道已关闭')));
  child.on('close',code=>finish(undefined,{code:code??-1,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')}));
  child.stdin.end(call.stdin);
 });
}

async function collectFiles(root:string):Promise<FileAnswerFile[]>{
 const files:FileAnswerFile[]=[];let total=0;
 const walk=async(folder:string):Promise<void>=>{
  for(const name of await readdir(folder)){
   const path=join(folder,name),info=await lstat(path);
   if(info.isSymbolicLink())throw new Error('候选输出包含符号链接，不能发布');
   if(info.isDirectory())await walk(path);
   else{
    const label=relative(root,path).split('/').join('/');
    if(!info.isFile()||!safePath(label)||info.size>30*1024*1024||files.length>=100)throw new Error('候选输出文件无效或超过大小限制');
    total+=info.size;if(total>100*1024*1024)throw new Error('候选输出总量超过大小限制');
    const data=await readFile(path);files.push({path:label,storage_path:path,sha256:hash(data),size_bytes:data.length});
   }
  }
 };
 await walk(root);return files.sort((a,b)=>a.path.localeCompare(b.path));
}

/** Docker只接收本次公开任务；模型及参数不静默替换，任何失败保留为失败。 */
export async function runFileAnswer(input:FileAnswerInput,options:{env?:NodeJS.ProcessEnv;execute?:(call:FileAnswerInvocation)=>Promise<ProcessResult>}={}):Promise<FileAnswerResult>{
 if(!input||Object.keys(input).some(k=>!['directory','image','question','materials','deliverables','config','timeout_ms','signal'].includes(k)))throw new Error('文件作答输入字段无效');
 if(input.signal?.aborted)throw new Error('文件作答已取消');
 const env=options.env??process.env,execute=options.execute??runProcess;
 const config=resolveModelApiConfig(input.config,env);
 if(config.provider!=='openrouter'||Object.keys(config).some(k=>!['provider','base_url','model'].includes(k)))throw new Error('当前Claude Code文件执行器不支持这些供应商或模型参数，不会静默修改');
 if(typeof input.directory!=='string'||!isAbsolute(input.directory)||typeof input.image!=='string'||!/^[-a-zA-Z0-9_./:]+$/.test(input.image)||typeof input.question!=='string'||!input.question.trim()||!Number.isSafeInteger(input.timeout_ms)||input.timeout_ms<=0)throw new Error('文件作答任务配置无效');
 if(!Array.isArray(input.materials)||!input.materials.length||input.materials.some(m=>!m||typeof m.name!=='string'||!m.name.trim()||typeof m.text!=='string'||!m.text.trim()||Object.keys(m).some(k=>!['name','text'].includes(k))))throw new Error('文件作答附件无效');
 if(!Array.isArray(input.deliverables)||!input.deliverables.length||!input.deliverables.some(d=>d.required)||input.deliverables.some(d=>!safePath(d.path)||typeof d.required!=='boolean')||new Set(input.deliverables.map(d=>d.path)).size!==input.deliverables.length)throw new Error('文件作答成果清单无效');
 await mkdir(input.directory,{recursive:true,mode:0o700});const root=await realpath(input.directory);
 if(root.includes(','))throw new Error('文件作答执行目录不支持逗号');
 const runRoot=join(root,`candidate-${randomUUID()}`),inputs=join(runRoot,'input_files'),outputs=join(runRoot,'output');
 await mkdir(inputs,{recursive:true,mode:0o755});await mkdir(outputs,{mode:0o777});await chmod(outputs,0o777);
 const maps=[];for(const [index,m] of input.materials.entries()){
  const name=`材料-${String(index+1).padStart(3,'0')}.txt`;await writeFile(join(inputs,name),m.text,{mode:0o444});maps.push(`${m.name}：/app/input_files/${name}`);
 }
 const instruction=[input.question,'','获准输入文件（只读）：',...maps,'','将实际成果写入 /app/output/：',...input.deliverables.map(d=>`/app/output/${d.path}（${d.required?'必交':'可选'}）`),'只依据获准案件材料独立完成任务；必要法规研究、计算和文件制作可使用容器工具。最终回复完成情况，不能用回复正文冒充已经生成的文件。'].join('\n');
 const instructionPath=join(runRoot,'instruction.md');await writeFile(instructionPath,instruction,{mode:0o444});
 const childEnv:NodeJS.ProcessEnv={...Object.fromEntries(['PATH','HOME','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','LANG'].flatMap(k=>env[k]===undefined?[]:[[k,env[k]!]])),ANTHROPIC_BASE_URL:'https://openrouter.ai/api',ANTHROPIC_AUTH_TOKEN:readModelApiKey(config,env),ANTHROPIC_API_KEY:'',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
 const common=['run','--rm','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--workdir','/app','--tmpfs','/tmp:rw,mode=1777','--tmpfs','/home/agent:rw,uid=1000,gid=1000,mode=700','--tmpfs','/app:rw,mode=1777'];
 const version=await execute({args:[...common,input.image,'claude','--version'],stdin:'',env:childEnv,signal:input.signal,timeout_ms:30000});
 if(version.code!==0)throw new Error('Docker镜像或容器无法运行，不能开始文件作答');
 if(!/^2\.1\.114(?:\s|$)/.test(version.stdout.trim()))throw new Error('文件作答镜像须预装Claude Code 2.1.114');
 const name=`ai-distill-${randomUUID()}`;
 const args=[...common,'--name',name,'--interactive','--mount',`type=bind,src=${inputs},dst=/app/input_files,readonly`,'--mount',`type=bind,src=${outputs},dst=/app/output`,'--mount',`type=bind,src=${instructionPath},dst=/app/instruction.md,readonly`,...['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'].flatMap(k=>['--env',k]),input.image,'claude','--print','--output-format','stream-json','--verbose','--model',config.model,'--setting-sources','','--settings','{}','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-chrome','--no-session-persistence','--permission-mode','bypassPermissions','--tools','Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch'];
 const started=Date.now();let finished=false;
 try{
  const result=await execute({args,stdin:instruction,env:childEnv,signal:input.signal,timeout_ms:input.timeout_ms});
  finished=true;
  const eventsPath=join(runRoot,'events.jsonl');await writeFile(eventsPath,result.stdout,{mode:0o600});
  if(result.code!==0||input.signal?.aborted)throw new Error(input.signal?.aborted?'文件作答已取消':'Claude Code文件作答执行失败');
  let terminal:any,returnedModel:string|null=null;
  for(const line of result.stdout.split('\n').filter(s=>s.trim())){let event:any;try{event=JSON.parse(line);}catch{throw new Error('Claude Code未返回完整结果，执行记录格式无效');}if(event.type==='assistant'&&typeof event.message?.model==='string')returnedModel=event.message.model;if(event.type==='result'){if(terminal)throw new Error('Claude Code返回多个完成结果');terminal=event;}}
  if(!terminal||terminal.subtype!=='success'||terminal.is_error!==false||typeof terminal.result!=='string'||!terminal.result.trim()||typeof terminal.session_id!=='string'||!terminal.session_id)throw new Error('Claude Code未返回完整结果，不能发布候选成果');
  const files=await collectFiles(outputs);
  if(input.deliverables.some(d=>d.required&&!files.some(f=>f.path===d.path&&f.size_bytes>0)))throw new Error('Claude Code未生成全部必交文件');
  return{text:terminal.result,requested_model:config.model,model:returnedModel,usage:terminal.usage&&typeof terminal.usage==='object'?terminal.usage:null,duration_ms:Date.now()-started,files,execution:{framework:'claude-code',version:'2.1.114',session_id:terminal.session_id,events_path:eventsPath,image:input.image}};
 }finally{
  if(!finished){try{await execute({args:['rm','--force',name],stdin:'',env:childEnv,timeout_ms:10000});}catch{logEvent('file_answer.container_cleanup_failed',{level:'error',component:'answer',reason_code:'container_cleanup_failed'});}}
 }
}
