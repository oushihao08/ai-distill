import {HTTPException} from 'hono/http-exception';
import type {AcceptanceConfig} from './acceptance';
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
export function validateRevisionBudget(raw:unknown):AcceptanceConfig['revision_budget']{
 if(raw===undefined)return undefined;
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HTTPException(400,{message:'返修预算须为JSON对象'});
 const budget=raw as Record<string,unknown>;
 if(Object.keys(budget).some(key=>!['max_content_revisions','max_technical_retries','max_duration_ms','max_calls'].includes(key))||Object.entries(budget).some(([key,n])=>key==='max_duration_ms'? !Number.isSafeInteger(n)||Number(n)<1:!count(n)))throw new HTTPException(400,{message:'返修预算字段或数值无效'});
 return {...budget} as AcceptanceConfig['revision_budget'];
}
export function validateAcceptanceConfig(raw:unknown):AcceptanceConfig{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HTTPException(400,{message:'达标设置须为JSON对象'});
 const value=raw as Record<string,unknown>;
 if(Object.keys(value).some(key=>!['required_models','minimum_score_by_model','revision_budget'].includes(key)))throw new HTTPException(400,{message:'达标设置包含不支持字段'});
 if(!Array.isArray(value.required_models)||!value.required_models.length||value.required_models.length>20||value.required_models.some(model=>typeof model!=='string'||!model.trim()||model.length>160)||new Set(value.required_models).size!==value.required_models.length)throw new HTTPException(400,{message:'必须配置唯一的必需模型列表'});
 if(!value.minimum_score_by_model||typeof value.minimum_score_by_model!=='object'||Array.isArray(value.minimum_score_by_model))throw new HTTPException(400,{message:'必须按模型配置最低分'});
 const thresholds=value.minimum_score_by_model as Record<string,unknown>;
 if(Object.keys(thresholds).length!==value.required_models.length||value.required_models.some(model=>!Object.hasOwn(thresholds,model as string)||typeof thresholds[model as string]!=='number'||!Number.isFinite(thresholds[model as string])||(thresholds[model as string] as number)<0))throw new HTTPException(400,{message:'每个必需模型都必须有非负最低分，且不能配置额外模型'});
 const revision_budget=validateRevisionBudget(value.revision_budget);
 return {required_models:[...value.required_models] as string[],minimum_score_by_model:thresholds as Record<string,number|null>,...(revision_budget?{revision_budget}:{})};
}
