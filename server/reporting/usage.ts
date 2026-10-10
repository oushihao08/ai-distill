/**
 * 职责：API 用量计费：按完整 token 和价格快照计算费用，缺数据保留未知并排除套餐计费。
 * 关键方法与用途：`calculateApiCallCost()` 按完整 token 与价格快照计算单次费用；`summarizeApiCosts()` 去重汇总并保留未知原因。
 * 使用场景：导出流程调用；Codex 套餐调用不按 API token 价格计费。
 */
export interface ApiCallUsage {
 call_id:string;
 billing:'api_key'|'codex_subscription'|'unknown';
 provider:string;model:string;currency:string;
 usage:Record<string,unknown>|null;
 price:{input_per_million:number;output_per_million:number;cached_input_per_million?:number;cache_write_per_million?:number;currency:string}|null;
}
export interface UsageCost {
 call_id:string;included:boolean;tokens:{input:number|null;output:number|null;cached_input:number|null;cache_write:number|null};
 cost:number|null;currency:string|null;unknown_reason?:'not_api_key_billing'|'usage_missing'|'token_usage_incomplete'|'price_missing'|'currency_mismatch'|'invalid_usage_or_price';
}
const token=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;
const at=(v:Record<string,unknown>|undefined,key:string)=>v&&token(v[key])?v[key] as number:undefined;
const cents=(v:number)=>Math.round((v+Number.EPSILON)*1e12)/1e12;
export function calculateApiCallCost(call:ApiCallUsage):UsageCost{
 const empty={call_id:call.call_id,included:call.billing==='api_key',tokens:{input:null,output:null,cached_input:null,cache_write:null},cost:null,currency:null} as UsageCost;
 if(call.billing!=='api_key')return {...empty,unknown_reason:'not_api_key_billing'};
 if(!call.usage)return {...empty,unknown_reason:'usage_missing'};
 const details=call.usage.prompt_tokens_details&&typeof call.usage.prompt_tokens_details==='object'?call.usage.prompt_tokens_details as Record<string,unknown>:undefined;
 const input=at(call.usage,'prompt_tokens')??at(call.usage,'input_tokens');
 const output=at(call.usage,'completion_tokens')??at(call.usage,'output_tokens');
 const cached=at(details,'cached_tokens')??at(call.usage,'cache_read_input_tokens')??at(call.usage,'cached_input_tokens')??0;
 const write=at(details,'cache_creation_tokens')??at(call.usage,'cache_write_input_tokens')??0;
 empty.tokens={input:input??null,output:output??null,cached_input:cached,cache_write:write};
 if(input===undefined||output===undefined)return {...empty,unknown_reason:'token_usage_incomplete'};
 if(cached>input||write>input||cached+write>input||!call.provider||!call.model||!call.currency||![input,output,cached,write].every(token))return {...empty,unknown_reason:'invalid_usage_or_price'};
 const price=call.price;
 if(!price)return {...empty,unknown_reason:'price_missing'};
 if(price.currency!==call.currency)return {...empty,unknown_reason:'currency_mismatch'};
 if(cached>0&&price.cached_input_per_million===undefined)return {...empty,unknown_reason:'price_missing'};
 if(write>0&&price.cache_write_per_million===undefined)return {...empty,unknown_reason:'price_missing'};
 const rates=[price.input_per_million,price.output_per_million,price.cached_input_per_million??price.input_per_million,price.cache_write_per_million??price.input_per_million];
 if(rates.some(value=>!Number.isFinite(value)||value<0))return {...empty,unknown_reason:'invalid_usage_or_price'};
 const cost=((input-cached-write)*rates[0]!+cached*rates[2]!+write*rates[3]!+output*rates[1]!)/1_000_000;
 return {...empty,cost:cents(cost),currency:call.currency};
}
export function summarizeApiCosts(calls:ApiCallUsage[]){
 const unique=new Map<string,UsageCost>();
 for(const call of calls){if(!call.call_id||unique.has(call.call_id))continue;unique.set(call.call_id,calculateApiCallCost(call));}
 const currencies:Record<string,{known_cost:number;known_calls:number;unknown_calls:number}>={};
 const reasons:Record<string,number>={};
 for(const result of unique.values()){
  if(!result.included)continue;
  if(result.unknown_reason){reasons[result.unknown_reason]=(reasons[result.unknown_reason]??0)+1;continue;}
  const currency=result.currency!;currencies[currency]??={known_cost:0,known_calls:0,unknown_calls:0};currencies[currency]!.known_cost=cents(currencies[currency]!.known_cost+result.cost!);currencies[currency]!.known_calls++;
 }
 const unknownCalls=Object.values(reasons).reduce((sum,count)=>sum+count,0);
 return {calls:[...unique.values()],currencies,unknown_reasons:reasons,unknown_calls:unknownCalls};
}
