/**
 * 职责：在同一个网页对话里完成“提问 → 取回单个JSON → 业务校验 → 反馈修正”的回路，并处理输出被截断后的续写。
 * 主要入口：`runWebJsonChat()`；调用方为 preparation.ts、authoring.ts、redaction.ts（仅离线作业台）。
 * 边界：只与 `WebChatTransport` 交互，不读写目录、不入库；校验由调用方提供（整理用原编译器，出题用原接收转换）。
 */
import {extractJsonFromReply,isLikelyTruncatedJson,WebAgentError,type WebChatReply,type WebChatTransport,type WebChatTurn} from '../web-agent';
import type {WebAgentSettings} from '../../shared/web-agent';
import {logEvent,classifyLogError} from '../logging';

export interface WebChatRoundLog{round:number;kind:'first'|'continue'|'correction';chars:number;elapsed_ms:number;conversation_url:string}
export interface WebJsonChatOptions<T>{
  transport:WebChatTransport;settings:WebAgentSettings;first:WebChatTurn;timeout_ms:number;signal?:AbortSignal;
  /** 抛错即反馈给网页修正；错误可带 reason_code / validation_details。 */
  check:(value:unknown)=>T|Promise<T>;
  /** 每轮回复落盘等记录钩子；不得抛出会影响主流程的错误。 */
  onRound?:(log:WebChatRoundLog)=>void|Promise<void>;
  max_corrections?:number;max_continuations?:number;
  /** 非敏感任务标识（如 task_type），透传给传输用于标注会话。 */
  label?:string;
}
export interface WebJsonChatResult<T>{value:T;conversation_url:string;rounds:WebChatRoundLog[]}

const OPEN_FENCE=/^\s*(`{3,}|~{3,})[a-zA-Z0-9_-]*[ \t]*\r?\n/;
const INLINE_JSON_FENCE=/^[\s\S]*?(?:^|\n)\s*(`{3,}|~{3,})json[ \t]*\r?\n/i;
const CLOSE_FENCE=/\n?(`{3,}|~{3,})\s*$/;
const TRAILING_EMPTY_FENCE=/\r?\n+(`{3,}|~{3,})[a-zA-Z0-9_-]*[ \t]*\r?\n+\1\s*$/;

/** 去掉开头围栏（含前置简短说明文字后的 ```json 围栏）与结尾围栏，保留其内部JSON文本。 */
export function stripFences(text:string){
  const stripped=OPEN_FENCE.test(text)?text.replace(OPEN_FENCE,''):text.replace(INLINE_JSON_FENCE,'');
  return stripped.replace(TRAILING_EMPTY_FENCE,'').replace(CLOSE_FENCE,'');
}
/** 拼接被截断的多段回复：去掉前序段由DOM代码块自动补上的结尾围栏，去掉后续段重开的开头围栏，并兼容模型在无开头围栏续写末尾写孤立 ``` 被CommonMark渲染为空代码块的情形。 */
export function stitchReplies(parts:string[]){
  if(parts.length<=1)return parts[0]??'';
  return parts.map((part,index)=>{
    let chunk=part;
    const hadOpenFence=index>0&&(OPEN_FENCE.test(chunk)||INLINE_JSON_FENCE.test(chunk));
    if(hadOpenFence)chunk=OPEN_FENCE.test(chunk)?chunk.replace(OPEN_FENCE,''):chunk.replace(INLINE_JSON_FENCE,'');
    if(index<parts.length-1){
      chunk=!hadOpenFence&&TRAILING_EMPTY_FENCE.test(chunk)?chunk.replace(TRAILING_EMPTY_FENCE,''):chunk.replace(CLOSE_FENCE,'');
    }else if(index>0&&!hadOpenFence&&TRAILING_EMPTY_FENCE.test(chunk)){
      chunk=chunk.replace(TRAILING_EMPTY_FENCE,'\n```');
    }
    return chunk;
  }).join('');
}
function continuePrompt(stitched:string){
  const tail=stripFences(stitched).slice(-80);
  return [
    `上一条回复在中途到达单轮长度上限被截断，末尾停在：${JSON.stringify(tail)}。`,
    '注意：网页前端会把本条新回复当作独立Markdown消息渲染，不会继承上一条未闭合的代码块。',
    '因此你的回复第1行必须写 ```json ，第2行起严格紧接上述末尾之后继续输出剩余JSON字符（不要重复已输出的任何字符，不要从头开始），输出结束时最后一行写 ``` 闭合代码块；代码块外不要写任何文字。',
  ].join('\n');
}
/** 去掉围栏后已能完整解析的拼接结果不再算截断（模型续写时漏写结尾围栏的情形）。 */
function stillTruncated(text:string){
 if(!isLikelyTruncatedJson(text))return false;
 try{JSON.parse(stripFences(text));return false;}catch{return true;}
}

function feedback(error:unknown){
  const e=error as {reason_code?:string;validation_details?:unknown;message?:string};
  return JSON.stringify({valid:false,reason_code:e?.reason_code??'result_invalid',...(e?.validation_details!==undefined?{validation_details:e.validation_details}:{}),...(!e?.reason_code&&e?.message?{message:String(e.message).slice(0,500)}:{})});
}
function parseJson(text:string,truncated:boolean){
  if(!truncated)return extractJsonFromReply(text);
  try{return extractJsonFromReply(text);}catch{return JSON.parse(stripFences(text));}
}

/** 单个对话内最多 max_corrections 次修正；同一回复内容重复出现即停止，避免无进展循环。 */
export async function runWebJsonChat<T>(options:WebJsonChatOptions<T>):Promise<WebJsonChatResult<T>>{
  const deadline=Date.now()+options.timeout_ms,rounds:WebChatRoundLog[]=[];
  const maxCorrections=options.max_corrections??3,maxContinuations=options.max_continuations??8;
  const remaining=()=>{const left=Math.floor(deadline-Date.now());if(left<=0)throw new WebAgentError('web_timeout','网页对话达到本次执行预算');return left;};
  const session=await options.transport.open(options.settings.provider,{signal:options.signal,thinking:options.settings.thinking,model_label:options.settings.model_label,...(options.label?{label:options.label}:{})});
  const ask=async(turn:WebChatTurn,kind:WebChatRoundLog['kind']):Promise<WebChatReply>=>{
    if(options.signal?.aborted)throw new WebAgentError('web_cancelled','网页任务已取消');
    const reply=await session.ask(turn,{timeout_ms:remaining(),signal:options.signal});
    const log={round:rounds.length+1,kind,chars:reply.text.length,elapsed_ms:reply.elapsed_ms,conversation_url:reply.conversation_url};
    rounds.push(log);try{await options.onRound?.(log);}catch(error){logEvent('web_agent.round_record_failed',{level:'warn',...classifyLogError(error)});}
    return reply;
  };
  try{
    let turn:WebChatTurn=options.first,kind:WebChatRoundLog['kind']='first',corrections=0,lastInvalid:string|undefined;
    for(;;){
      const parts:string[]=[(await ask(turn,kind)).text];
      let continuations=0,truncated=false;
      while(stillTruncated(stitchReplies(parts))&&continuations<maxContinuations){
        truncated=true;continuations++;
        parts.push((await ask({prompt:continuePrompt(stitchReplies(parts))},'continue')).text);
      }
      const text=stitchReplies(parts);
      let value:unknown;
      try{value=parseJson(text,truncated);}
      catch(error){
        if(lastInvalid===text||corrections>=maxCorrections)throw Object.assign(error instanceof WebAgentError?error:new WebAgentError('web_reply_incomplete','网页回复不是完整的单个JSON'),{reason_code:(error as any)?.reason_code??'invalid_json'});
        lastInvalid=text;corrections++;kind='correction';
        turn={prompt:`校验结果：${JSON.stringify({valid:false,reason_code:'invalid_json'})}。请只输出一个完整的\`\`\`json代码块，内容为修正后的完整JSON。`};continue;
      }
      let checked:T;
      try{checked=await options.check(value);}
      catch(error){
        if(lastInvalid===text||corrections>=maxCorrections)throw error;
        lastInvalid=text;corrections++;kind='correction';
        turn={prompt:`同一校验器结果：${feedback(error)}。修正实际条目并返回完整JSON（只输出一个\`\`\`json代码块）。`};
        continue;
      }
      await session.complete?.('succeeded').catch(error=>logEvent('web_agent.session_complete_failed',{level:'warn',...classifyLogError(error)}));
      return{value:checked,conversation_url:session.url(),rounds};
    }
  }catch(error){
    await session.complete?.('failed',error instanceof Error?error.message:undefined).catch(()=>{});
    throw error;
  }finally{await session.close().catch(error=>logEvent('web_agent.session_close_failed',{level:'warn',...classifyLogError(error)}));}
}
