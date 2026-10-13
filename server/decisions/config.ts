/**
 * 职责：校验项目达标判断配置。
 * 关键方法与用途：`validateAcceptanceConfig()` 校验模型集合及各模型百分制分数上限。
 * 使用场景：达标判断读取当前项目模型设置。
 */
import {HTTPException} from 'hono/http-exception';
import type {AcceptanceConfig} from './acceptance';
export function validateAcceptanceConfig(raw:unknown):AcceptanceConfig{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HTTPException(400,{message:'达标设置须为JSON对象'});
 const value=raw as Record<string,unknown>;
 if(Object.keys(value).some(key=>!['required_models','minimum_score_by_model'].includes(key)))throw new HTTPException(400,{message:'达标设置包含不支持字段'});
 if(!Array.isArray(value.required_models)||!value.required_models.length||value.required_models.length>20||value.required_models.some(model=>typeof model!=='string'||!model.trim()||model.length>160)||new Set(value.required_models).size!==value.required_models.length)throw new HTTPException(400,{message:'必须配置唯一的必需模型列表'});
 if(!value.minimum_score_by_model||typeof value.minimum_score_by_model!=='object'||Array.isArray(value.minimum_score_by_model))throw new HTTPException(400,{message:'必须按模型配置百分制分数上限'});
 const thresholds=value.minimum_score_by_model as Record<string,unknown>;
 if(Object.keys(thresholds).length!==value.required_models.length||value.required_models.some(model=>!Object.hasOwn(thresholds,model as string)||typeof thresholds[model as string]!=='number'||!Number.isFinite(thresholds[model as string])||(thresholds[model as string] as number)<0||(thresholds[model as string] as number)>100))throw new HTTPException(400,{message:'每个必需模型都必须有0至100的百分制分数上限，且不能配置额外模型'});
 return {required_models:[...value.required_models] as string[],minimum_score_by_model:thresholds as Record<string,number|null>};
}
