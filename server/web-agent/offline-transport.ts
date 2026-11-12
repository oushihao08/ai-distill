/**
 * 职责：网页Agent“离线作业台”传输：不驱动浏览器。每轮对话按任务键落在本机目录；已交回的轮次直接回放回复，缺回复的轮次打包为zip导出并以 `web_offline_pending` 结束本次执行（即“已导出待交回”标记）。
 * 主要入口：`createOfflineChatTransport()`（网页执行器在 settings.mode='offline' 时使用）、`readOfflineTask()`、`importOfflineReply()`、`offlineRoot()`（CLI `offline export/import`）。
 * 目录：`<root>/web-offline/<任务键>/task.json`；每轮 `round-N/prompt.md`、`round-N/files/`、交回后的 `round-N/reply.md`，导出包 `round-N.zip`。
 * 边界：只读写该目录并调用系统 zip；格式与业务校验仍由调用方（chat-loop + 原编译器/validateDraft）完成；提示词变化视为输入已变，丢弃旧回复重新导出。
 */
import {mkdir,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {storageDirectory} from '../paths';
import {WebAgentError,type WebChatOpenOptions,type WebChatSession,type WebChatTransport,type WebChatTurn,type WebProviderId} from './types';
import {extractJsonFromReply} from './json-extract';

export type OfflineTaskStatus='exported'|'replaying'|'imported'|'failed';
export interface OfflineTaskState{task:string;provider:string;label:string|null;status:OfflineTaskStatus;round:number;zip_path:string|null;updated_at:string;message?:string}
export const OFFLINE_TASK_KEY=/^(redact|prepare|author)-[0-9a-f-]{36}$/;

export function offlineRoot(root?:string){return join(root??storageDirectory(),'web-offline');}
const taskDir=(task:string,root?:string)=>{if(!OFFLINE_TASK_KEY.test(task))throw new Error('离线任务键无效');return join(offlineRoot(root),task);};
/** 上传文件名与提示词对照表保持一致；只取单段名称防止写出目录外。 */
const safeName=(name:string)=>{const single=basename(name.replaceAll('\\','/'));return single&&single!=='.'&&single!=='..'?single:'file';};

async function writeJsonAtomic(path:string,value:unknown){const tmp=`${path}.${randomBytes(4).toString('hex')}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,path);}
export async function readOfflineTask(task:string,options:{root?:string}={}):Promise<OfflineTaskState|null>{
  try{return JSON.parse(await readFile(join(taskDir(task,options.root),'task.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
async function patchTask(dir:string,patch:Partial<OfflineTaskState>&{task:string}){
  let current:OfflineTaskState|null=null;try{current=JSON.parse(await readFile(join(dir,'task.json'),'utf8'));}catch{}
  const next={provider:'',label:null,status:'exported',round:0,zip_path:null,...current,...patch,updated_at:new Date().toISOString()} as OfflineTaskState;
  if(patch.message===undefined)delete next.message;
  await writeJsonAtomic(join(dir,'task.json'),next);return next;
}
/** 比较提示词时忽略每次执行都会变化的UUID（任务/尝试目录、调用ID）与ISO时间戳；其余内容变化视为输入已变。 */
export const stablePrompt=(text:string)=>text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'<uuid>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,'<time>');
const readText=(path:string)=>readFile(path,'utf8').catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});

function guide(provider:string,round:number,files:string[]){
  const site=provider==='gemini'?'https://gemini.google.com/app':'https://chat.deepseek.com/';
  return[
    `# 第 ${round} 轮操作说明`,'',
    round===1?`1. 打开 ${site}，新建一个对话。`:'1. 回到这个任务第 1 轮使用的**同一个**网页对话继续（不要新建）。对话丢失时：新建对话，先依次发送 `history/` 里的历史提示词与回复，再继续本轮。',
    files.length?`2. 上传 \`files/\` 下全部文件：${files.map(name=>`\`${name}\``).join('、')}。`:'2. 本轮没有文件需要上传。',
    '3. 复制 `prompt.md` 的全部内容粘贴到输入框并发送。',
    '4. 回复结束后用网页的“复制”按钮复制整条回复，保存为 `reply/reply-1.md`。',
    '   回复被截断时在网页发送“继续”，把后续每段依次保存为 `reply-2.md`、`reply-3.md`…（程序按序号拼接）。',
    '5. 把整个 zip（或解压后的整个文件夹）放回作业台原位置，运行 `bun run ai-distill offline import --out <作业台>`。',
    '   程序自动校验格式与业务规则：通过即入库；不通过会导出下一轮 zip（含具体错误），按新 zip 继续。',
  ].join('\n');
}

async function zipDirectory(source:string,target:string){
  await rm(target,{force:true});
  const proc=Bun.spawn(['zip','-r','-q','-X',target,'.'],{cwd:source,stdout:'ignore',stderr:'pipe'});
  if(await proc.exited!==0)throw new Error(`离线导出包生成失败：${(await new Response(proc.stderr).text()).slice(0,200)}`);
}

class OfflineChatSession implements WebChatSession{
  private round=0;
  constructor(private readonly dir:string,private readonly task:string,private readonly provider:string){}
  url(){return `offline://${this.task}`;}
  async ask(turn:WebChatTurn){
    const started=Date.now();this.round+=1;
    const roundDir=join(this.dir,`round-${this.round}`);
    const previousPrompt=await readText(join(roundDir,'prompt.md'));
    if(previousPrompt!==null&&stablePrompt(previousPrompt)===stablePrompt(turn.prompt)){
      const reply=await readText(join(roundDir,'reply.md'));
      if(reply!==null&&reply.trim()){await patchTask(this.dir,{task:this.task,status:'replaying',round:this.round});return{text:reply,conversation_url:this.url(),elapsed_ms:Date.now()-started};}
    }else if(previousPrompt!==null){
      // 提示词已变化：本轮及之后的旧回复全部作废，重新导出。
      for(let n=this.round;;n++){const d=join(this.dir,`round-${n}`);if(!(await stat(d).catch(()=>null)))break;await rm(d,{recursive:true,force:true});await rm(join(this.dir,`round-${n}.zip`),{force:true});}
    }
    const exportDir=join(roundDir,'export'),filesDir=join(exportDir,'files');
    await rm(exportDir,{recursive:true,force:true});
    await mkdir(filesDir,{recursive:true,mode:0o700});await mkdir(join(exportDir,'reply'),{recursive:true,mode:0o700});
    const names:string[]=[];
    for(const file of turn.files??[]){
      let name=safeName(file.name);while(names.includes(name))name=`_${name}`;names.push(name);
      await writeFile(join(filesDir,name),typeof file.content==='string'?file.content:Buffer.from(file.content),{mode:0o600});
    }
    await writeFile(join(roundDir,'prompt.md'),turn.prompt,{mode:0o600});
    await writeFile(join(exportDir,'prompt.md'),turn.prompt,{mode:0o600});
    if(this.round>1){
      await mkdir(join(exportDir,'history'),{recursive:true,mode:0o700});
      for(let n=1;n<this.round;n++){
        const p=await readText(join(this.dir,`round-${n}`,'prompt.md')),r=await readText(join(this.dir,`round-${n}`,'reply.md'));
        if(p!==null)await writeFile(join(exportDir,'history',`round-${n}-prompt.md`),p,{mode:0o600});
        if(r!==null)await writeFile(join(exportDir,'history',`round-${n}-reply.md`),r,{mode:0o600});
      }
    }
    // zip内条目名保持ASCII，避免不同解压工具对中文文件名编码不一致。
    await writeFile(join(exportDir,'README.md'),guide(this.provider,this.round,names),{mode:0o600});
    await writeFile(join(exportDir,'reply','HOW-TO-RETURN.txt'),'把网页回复保存为本目录下的 reply-1.md；被截断后的续写依次保存为 reply-2.md、reply-3.md。\n',{mode:0o600});
    await writeJsonAtomic(join(exportDir,'task.json'),{task:this.task,round:this.round,provider:this.provider});
    const zipPath=join(this.dir,`round-${this.round}.zip`);
    await zipDirectory(exportDir,zipPath);
    await patchTask(this.dir,{task:this.task,status:'exported',round:this.round,zip_path:zipPath});
    throw new WebAgentError('web_offline_pending',`第${this.round}轮已导出，等待交回网页回复`);
  }
  async complete(outcome:'succeeded'|'failed',message?:string){
    if(outcome==='succeeded'){await patchTask(this.dir,{task:this.task,status:'imported'});return;}
    const state=await readOfflineTask(this.task,{root:join(this.dir,'..','..')});
    if(state?.status==='exported')return; // 导出即结束本次执行，保留“待交回”状态
    await patchTask(this.dir,{task:this.task,status:'failed',...(message?{message:message.slice(0,500)}:{})});
  }
  async close(){}
}

export function createOfflineChatTransport(options:{task:string;root?:string}):WebChatTransport{
  const dir=taskDir(options.task,options.root);
  return{
    async open(provider:WebProviderId,opts?:WebChatOpenOptions){
      await mkdir(dir,{recursive:true,mode:0o700});
      await patchTask(dir,{task:options.task,provider,label:opts?.label??null,status:'replaying'});
      return new OfflineChatSession(dir,options.task,provider);
    },
  };
}

/** 交回：多段回复按序拼接（由调用方传入已拼接文本），预检能取出唯一完整JSON后写入该轮 reply.md。 */
export async function importOfflineReply(task:string,round:number,text:string,options:{root?:string}={}){
  const dir=taskDir(task,options.root),roundDir=join(dir,`round-${round}`);
  if(await readText(join(roundDir,'prompt.md'))===null)throw new Error(`任务 ${task} 没有第${round}轮导出记录`);
  extractJsonFromReply(text);
  const target=join(roundDir,'reply.md'),tmp=`${target}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp,text,{mode:0o600});await rename(tmp,target);
  return target;
}
