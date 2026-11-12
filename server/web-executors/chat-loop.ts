/**
 * 职责：在同一个网页对话里完成“提问 → 取回单个JSON → 业务校验 → 反馈修正”的回路，并处理输出被截断后的续写。
 * 主要入口：`runWebJsonChat()`；调用方为 redaction.ts、preparation.ts、authoring.ts 三个网页执行器。
 * 边界：只与 `WebChatTransport` 交互，不读写目录、不入库；校验由调用方提供（脱敏用原编译器，出题用原接收转换）。
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
}
export interface WebJsonChatResult<T>{value:T;conversation_url:string;rounds:WebChatRoundLog[]}

const CONTINUE_PROMPT='上一条回复在中途被截断。请严格从被截断处继续输出剩余内容：不要重复已经输出的任何字符，不要重新开始，不要添加说明，不要再使用代码围栏。';
const FENCE=/^\s*```[a-zA-Z0-9_-]*\s*\n/;
/** 去掉开头围栏行与结尾围栏，保留其内部文本。 */
export function stripFences(text:string){return text.replace(FENCE,'').replace(/\n?```\s*$/,'');}
/** 拼接被截断的多段回复；后续段若又以围栏开头则去掉开头围栏，结尾围栏保留以标示结束。 */
export function stitchReplies(parts:string[]){return parts.map((part,index)=>index===0?part:part.replace(FENCE,'')).join('');}
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
  return JSON.parse(stripFences(text));
}

/** 单个对话内最多 max_corrections 次修正；同一回复内容重复出现即停止，避免无进展循环。 */
export async function runWebJsonChat<T>(options:WebJsonChatOptions<T>):Promise<WebJsonChatResult<T>>{
  const deadline=Date.now()+options.timeout_ms,rounds:WebChatRoundLog[]=[];
  const maxCorrections=options.max_corrections??3,maxContinuations=options.max_continuations??8;
  const remaining=()=>{const left=Math.floor(deadline-Date.now());if(left<=0)throw new WebAgentError('web_timeout','网页对话达到本次执行预算');return left;};
  const session=await options.transport.open(options.settings.provider,{signal:options.signal,thinking:options.settings.thinking,model_label:options.settings.model_label});
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
        parts.push((await ask({prompt:CONTINUE_PROMPT},'continue')).text);
      }
      const text=stitchReplies(parts);
      let value:unknown;
      try{value=parseJson(text,truncated);}
      catch(error){
        if(lastInvalid===text||corrections>=maxCorrections)throw Object.assign(error instanceof WebAgentError?error:new WebAgentError('web_reply_incomplete','网页回复不是完整的单个JSON'),{reason_code:(error as any)?.reason_code??'invalid_json'});
        lastInvalid=text;corrections++;kind='correction';
        turn={prompt:`校验结果：${JSON.stringify({valid:false,reason_code:'invalid_json'})}。请只输出一个完整的\`\`\`json代码块，内容为修正后的完整JSON。`};continue;
      }
      try{return{value:await options.check(value),conversation_url:session.url(),rounds};}
      catch(error){
        if(lastInvalid===text||corrections>=maxCorrections)throw error;
        lastInvalid=text;corrections++;kind='correction';
        turn={prompt:`同一校验器结果：${feedback(error)}。修正实际条目并返回完整JSON（只输出一个\`\`\`json代码块）。`};
      }
    }
  }finally{await session.close().catch(error=>logEvent('web_agent.session_close_failed',{level:'warn',...classifyLogError(error)}));}
}
