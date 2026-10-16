/**
 * 职责：校验项目达标判断配置。
 * 关键方法与用途：`validateAcceptanceConfig()` 校验模型集合及各模型百分制分数上限。
 * 使用场景：达标判断读取当前项目模型设置。
 */
import {HTTPException} from 'hono/http-exception';
import type {AcceptanceConfig} from './acceptance';
const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function readAggregation(value:unknown){
 if(!isRecord(value)||Object.keys(value).some(key=>!['mode','model_count','threshold'].includes(key))||value.mode!=='mean_at_most'||!Number.isInteger(value.model_count)||(value.model_count as number)<1||typeof value.threshold!=='number'||!Number.isFinite(value.threshold)||value.threshold<0||value.threshold>100)throw new HTTPException(400,{message:'均分规则无效'});
 return {mode:'mean_at_most' as const,model_count:value.model_count as number,threshold:value.threshold};
}
/** 新策略只保存聚合方式；历史逐模型配置仍允许读取，模型身份必须与项目集合一致。 */
export function validateAcceptancePolicy(raw:unknown):Pick<AcceptanceConfig,'aggregation'>|AcceptanceConfig{
 if(!isRecord(raw))throw new HTTPException(400,{message:'达标策略须为JSON对象'});
 if(Object.keys(raw).length===0)return {};
 if(Object.keys(raw).length===1&&Object.hasOwn(raw,'aggregation'))return {aggregation:readAggregation(raw.aggregation)};
 return validateAcceptanceConfig(raw);
}
export function validateAcceptanceConfig(raw:unknown):AcceptanceConfig{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HTTPException(400,{message:'达标设置须为JSON对象'});
 const value=raw as Record<string,unknown>;
 if(Object.keys(value).some(key=>!['required_models','minimum_score_by_model','aggregation'].includes(key)))throw new HTTPException(400,{message:'达标设置包含不支持字段'});
 if(!Array.isArray(value.required_models)||!value.required_models.length||value.required_models.length>20||value.required_models.some(model=>typeof model!=='string'||!model.trim()||model.length>160)||new Set(value.required_models).size!==value.required_models.length)throw new HTTPException(400,{message:'必须配置唯一的必需模型列表'});
 if(!value.minimum_score_by_model||typeof value.minimum_score_by_model!=='object'||Array.isArray(value.minimum_score_by_model))throw new HTTPException(400,{message:'必须按模型配置百分制分数上限'});
 const thresholds=value.minimum_score_by_model as Record<string,unknown>;
 if(Object.keys(thresholds).length!==value.required_models.length||value.required_models.some(model=>!Object.hasOwn(thresholds,model as string)||typeof thresholds[model as string]!=='number'||!Number.isFinite(thresholds[model as string])||(thresholds[model as string] as number)<0||(thresholds[model as string] as number)>100))throw new HTTPException(400,{message:'每个必需模型都必须有0至100的百分制分数上限，且不能配置额外模型'});
 return {required_models:[...value.required_models] as string[],minimum_score_by_model:thresholds as Record<string,number|null>,...(value.aggregation!==undefined?{aggregation:readAggregation(value.aggregation)}:{})};
}
