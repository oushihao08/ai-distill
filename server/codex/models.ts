/**
 * 职责：本机 Codex 模型目录：读取缓存公开的模型和推理档位，并校验所选设置。
 * 关键方法与用途：`readCodexModelCatalog()` 读取本机模型能力；`validateCodexModelSettings()`／`validateCodexModel()` 校验模型与推理档位。
 * 使用场景：由 Codex 设置接口和项目／步骤配置校验复用。
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {HTTPException} from 'hono/http-exception';
export interface AdvertisedModel {slug:string;supported_reasoning_levels:{effort:string}[]}
const defaultCodexHome=()=>process.env.CODEX_HOME??join(process.env.HOME??'','.codex');
export function readCodexModelCatalog(codexHome=defaultCodexHome()):AdvertisedModel[]{
 try{
  const value=JSON.parse(readFileSync(join(codexHome,'models_cache.json'),'utf8'));
  if(!Array.isArray(value.models))return[];
  return value.models.flatMap((model:unknown)=>{
   if(!model||typeof model!=='object'||!('slug'in model)||typeof model.slug!=='string'||!model.slug.trim()||!('supported_reasoning_levels'in model)||!Array.isArray(model.supported_reasoning_levels))return[];
   if(model.slug==='gpt-6-astra')return[];
   const efforts=[...new Set(model.supported_reasoning_levels.flatMap((level:unknown)=>level&&typeof level==='object'&&'effort'in level&&typeof level.effort==='string'&&level.effort.trim()?[level.effort]:[]))];
   return efforts.length?[{slug:model.slug,supported_reasoning_levels:efforts.map(effort=>({effort}))}]:[];
  });
 }
 catch{return[];}
}

export function validateCodexModelSettings(value:unknown,catalog=readCodexModelCatalog()):{model:string;reasoning_effort:string}{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HTTPException(400,{message:'Codex默认设置须为JSON对象'});
 const {model,reasoning_effort}=value as Record<string,unknown>;
 if(typeof model!=='string'||!model.trim()||model.length>160)throw new HTTPException(400,{message:'Codex模型无效'});
 if(typeof reasoning_effort!=='string'||!reasoning_effort.trim()||reasoning_effort.length>20)throw new HTTPException(400,{message:'推理强度无效'});
 if(!catalog.length)throw new HTTPException(409,{message:'Codex模型清单不可用，请先完成本地套餐登录并刷新模型清单'});
 const entry=catalog.find(item=>item.slug===model);
 if(!entry)throw new HTTPException(400,{message:'模型不在当前Codex可用模型清单中'});
 if(!entry.supported_reasoning_levels.some(level=>level.effort===reasoning_effort))throw new HTTPException(400,{message:'此Codex模型不支持所选推理强度'});
 return{model,reasoning_effort};
}
// The installed CLI's advertised capabilities are a configuration check, not a live invocation test.
export function validateCodexModel(model:string,effort:string,catalog=readCodexModelCatalog()){
 validateCodexModelSettings({model,reasoning_effort:effort},catalog);
}
