/**
 * 职责：从网页聊天回复文本中确定性提取唯一完整 JSON 值，并判断文本是否像被截断的 JSON。
 * 公开入口：`extractJsonFromReply(text)`、`isLikelyTruncatedJson(text)`；供 worker 的 web agent 执行器解析脱敏/整理/出题回复。
 * 规则：优先唯一的 ```json 围栏；无围栏时整段可解析才接受；多候选、截断、非 JSON 一律抛带 reason 的 `WebAgentError`，不猜测补全。
 * `WebAgentError.reason_code` 固定为 `web_reply_incomplete`（截断）或 `web_ui_changed` 以外的调用方可见原因放在 `json_reason`。
 */
import {WebAgentError} from './types';

export type JsonExtractReason='empty'|'truncated'|'multiple_candidates'|'invalid_json'|'no_json';
export class JsonExtractError extends WebAgentError{
 readonly json_reason:JsonExtractReason;
 constructor(json_reason:JsonExtractReason){
  super('web_reply_incomplete',`回复 JSON 不可用(${json_reason})`);
  this.name='JsonExtractError';
  this.json_reason=json_reason;
 }
}

interface Fence{lang:string;body:string;closed:boolean}

/** 按行解析 Markdown 围栏；支持 3 个以上反引号或波浪线，结束围栏须不短于开始围栏。 */
function parseFences(text:string):Fence[]{
 const fences:Fence[]=[];
 const lines=text.split(/\r?\n/);
 let open:{marker:string;lang:string;body:string[]}|null=null;
 for(const line of lines){
  if(!open){
   const match=/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line);
   if(match)open={marker:match[1],lang:match[2].toLowerCase(),body:[]};
   continue;
  }
  const close=/^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  if(close&&close[1][0]===open.marker[0]&&close[1].length>=open.marker.length){
   fences.push({lang:open.lang,body:open.body.join('\n'),closed:true});
   open=null;
  }else open.body.push(line);
 }
 if(open)fences.push({lang:open.lang,body:open.body.join('\n'),closed:false});
 return fences;
}

function tryParse(source:string):{ok:true;value:unknown}|{ok:false}{
 try{return {ok:true,value:JSON.parse(source)};}catch{return {ok:false};}
}

/** 括号配平扫描：忽略字符串内的括号；返回 depth>0 表示尚未闭合或在字符串中结束。 */
function scanStructure(text:string):{depth:number;inString:boolean;started:boolean}{
 let depth=0,inString=false,escaped=false,started=false;
 for(const ch of text){
  if(inString){
   if(escaped)escaped=false;
   else if(ch==='\\')escaped=true;
   else if(ch==='"')inString=false;
   continue;
  }
  if(ch==='"'){inString=true;started=true;continue;}
  if(ch==='{'||ch==='['){depth++;started=true;}
  else if(ch==='}'||ch===']')depth--;
 }
 return {depth,inString,started};
}

/**
 * 判断是否像被截断的 JSON：存在以 `{`/`[` 开头但括号未闭合、字符串未结束，或 ```json 围栏未关闭；
 * 已能完整解析的文本不算截断。纯说明文字返回 false。
 */
export function isLikelyTruncatedJson(text:string):boolean{
 const trimmed=text.trim();
 if(!trimmed)return false;
 const fences=parseFences(trimmed);
 const json=fences.filter(fence=>fence.lang==='json'||(!fence.lang&&/^\s*[\[{]/.test(fence.body)));
 const last=json[json.length-1];
 if(last){
  if(!last.closed)return true;
  if(tryParse(last.body).ok)return false;
  const state=scanStructure(last.body);
  return state.started&&(state.depth>0||state.inString);
 }
 if(fences.length)return false;
 if(!/^[\[{]/.test(trimmed))return false;
 if(tryParse(trimmed).ok)return false;
 const state=scanStructure(trimmed);
 return state.depth>0||state.inString;
}

/**
 * 提取唯一完整 JSON 值。
 * - 多个 ```json 围栏 → `multiple_candidates`；围栏未关闭或括号未闭合 → `truncated`；
 * - 无围栏时整段文本必须可解析，否则 `no_json`/`invalid_json`；
 * - 不裁剪前后说明文字去猜测 JSON 范围。
 */
export function extractJsonFromReply(text:string):unknown{
 const trimmed=text.trim();
 if(!trimmed)throw new JsonExtractError('empty');
 const fences=parseFences(trimmed);
 const jsonFences=fences.filter(fence=>fence.lang==='json');
 if(jsonFences.length>1)throw new JsonExtractError('multiple_candidates');
 if(jsonFences.length===1){
  const fence=jsonFences[0];
  if(!fence.closed)throw new JsonExtractError('truncated');
  const parsed=tryParse(fence.body.trim());
  if(parsed.ok)return parsed.value;
  const state=scanStructure(fence.body);
  throw new JsonExtractError(state.depth>0||state.inString?'truncated':'invalid_json');
 }
 const bare=fences.filter(fence=>!fence.lang);
 if(bare.length>1)throw new JsonExtractError('multiple_candidates');
 if(bare.length===1){
  const fence=bare[0];
  const outside=trimmed.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\s*\1\s*$|\n\s*\1\s*\n|$)/m,'').trim();
  if(!fence.closed)throw new JsonExtractError('truncated');
  const parsed=tryParse(fence.body.trim());
  if(parsed.ok&&!outside)return parsed.value;
 }
 const whole=tryParse(trimmed);
 if(whole.ok)return whole.value;
 if(/^[\[{]/.test(trimmed)){
  const state=scanStructure(trimmed);
  throw new JsonExtractError(state.depth>0||state.inString?'truncated':'invalid_json');
 }
 throw new JsonExtractError('no_json');
}
