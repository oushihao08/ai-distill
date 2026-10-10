/**
 * 职责：API 价格输入校验：核对供应商、模型、币种、token 单价、来源和有效期。
 * 关键方法与用途：`validateApiPrice()` 校验并归一化供应商、模型、币种、费率、来源及有效期。
 * 使用场景：价格导入或计费前调用；不把缺失价格推断成零。
 */
export interface ApiPriceInput {provider:string;model:string;currency:string;input_per_million:number;output_per_million:number;cached_input_per_million?:number;cache_write_per_million?:number;source:string;valid_from:string;valid_until?:string|null}
export function validateApiPrice(raw:unknown):ApiPriceInput{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('API价格须为JSON对象');
 const value=raw as Record<string,unknown>,allowed=['provider','model','currency','input_per_million','output_per_million','cached_input_per_million','cache_write_per_million','source','valid_from','valid_until'];
 if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('API价格包含不支持字段');
 const name=(n:unknown):n is string=>typeof n==='string'&&!!n.trim()&&n.length<=200;
 const rate=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
 if(!name(value.provider)||!name(value.model)||typeof value.currency!=='string'||!/^[A-Z]{3}$/.test(value.currency)||!rate(value.input_per_million)||!rate(value.output_per_million)||!name(value.source)||value.source.length>500||typeof value.valid_from!=='string'||!Number.isFinite(Date.parse(value.valid_from)))throw new Error('API价格字段无效');
 if(value.cached_input_per_million!==undefined&&!rate(value.cached_input_per_million)||value.cache_write_per_million!==undefined&&!rate(value.cache_write_per_million))throw new Error('缓存token价格无效');
 if(value.valid_until!==undefined&&value.valid_until!==null&&(typeof value.valid_until!=='string'||!Number.isFinite(Date.parse(value.valid_until))||Date.parse(value.valid_until)<=Date.parse(value.valid_from)))throw new Error('价格有效期无效');
 return {provider:value.provider,model:value.model,currency:value.currency,input_per_million:value.input_per_million,output_per_million:value.output_per_million,...(value.cached_input_per_million!==undefined?{cached_input_per_million:value.cached_input_per_million as number}:{}),...(value.cache_write_per_million!==undefined?{cache_write_per_million:value.cache_write_per_million as number}:{}),source:value.source,valid_from:new Date(value.valid_from).toISOString(),valid_until:value.valid_until?new Date(value.valid_until as string).toISOString():null};
}
