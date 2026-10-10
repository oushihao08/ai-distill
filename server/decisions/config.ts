/**
 * 职责：达标及返修预算配置校验：限制模型评分门槛和内容、技术重试、耗时、调用预算。
 * 关键方法与用途：`validateAcceptanceConfig()` 校验模型门槛；`validateRevisionBudget()` 校验有限重试、时长和调用预算。
 * 使用场景：项目步骤配置和返修问题分类在接受用户输入前调用。
 */
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
export function validateAcceptanceBudgetConfig(raw:unknown):Pick<AcceptanceConfig,'revision_budget'>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HTTPException(400,{message:'达标设置须为JSON对象'});
 const value=raw as Record<string,unknown>;
 if(Object.keys(value).some(key=>key!=='revision_budget'))throw new HTTPException(400,{message:'步骤设置只接受返修预算；模型和分数上限请在项目作答模型中设置'});
 const revision_budget=validateRevisionBudget(value.revision_budget);
 return revision_budget?{revision_budget}:{};
}
export function validateAcceptanceConfig(raw:unknown):AcceptanceConfig{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HTTPException(400,{message:'达标设置须为JSON对象'});
 const value=raw as Record<string,unknown>;
 if(Object.keys(value).some(key=>!['required_models','minimum_score_by_model','revision_budget'].includes(key)))throw new HTTPException(400,{message:'达标设置包含不支持字段'});
 if(!Array.isArray(value.required_models)||!value.required_models.length||value.required_models.length>20||value.required_models.some(model=>typeof model!=='string'||!model.trim()||model.length>160)||new Set(value.required_models).size!==value.required_models.length)throw new HTTPException(400,{message:'必须配置唯一的必需模型列表'});
 if(!value.minimum_score_by_model||typeof value.minimum_score_by_model!=='object'||Array.isArray(value.minimum_score_by_model))throw new HTTPException(400,{message:'必须按模型配置百分制分数上限'});
 const thresholds=value.minimum_score_by_model as Record<string,unknown>;
 if(Object.keys(thresholds).length!==value.required_models.length||value.required_models.some(model=>!Object.hasOwn(thresholds,model as string)||typeof thresholds[model as string]!=='number'||!Number.isFinite(thresholds[model as string])||(thresholds[model as string] as number)<0||(thresholds[model as string] as number)>100))throw new HTTPException(400,{message:'每个必需模型都必须有0至100的百分制分数上限，且不能配置额外模型'});
 const revision_budget=validateRevisionBudget(value.revision_budget);
 return {required_models:[...value.required_models] as string[],minimum_score_by_model:thresholds as Record<string,number|null>,...(revision_budget?{revision_budget}:{})};
}
