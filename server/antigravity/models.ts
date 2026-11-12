/**
 * 职责：Antigravity CLI (agy) 模型目录与推理档位映射：提供带 `agy:` 命名空间的模型建议清单，并将业务层的 (model, reasoning_effort) 解析为 agy CLI 实际接受的模型标识与 --effort 参数。
 * 关键方法与用途：`readAgyModelCatalog()` 返回可选模型与推理档位建议；`resolveAgyModelAndEffort()` 将 `agy:<family>` 或具体模型名与档位映射为 CLI 调用参数；`isAgyModel()` 判断模型是否归属 Antigravity 驱动。
 * 使用场景：由 `server/antigravity/client.ts` 与 `server/agent/driver.ts` 调用。
 */
import {existsSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {AdvertisedModel} from '../codex/models';

export const AGY_DRIVER_ID='agy';
export const AGY_MODEL_PREFIX='agy:';

const TIERED_FAMILIES:Record<string,readonly string[]>={
 'gemini-4-carbon':['low','medium','high'],
 'gemini-4-argon':['low','medium','high'],
 'gemini-3.8-flash':['low','medium','high'],
 'claude-sonnet-5-5':['low','medium','high'],
 'claude-opus-5-5':['low','medium','high'],
};

const DEFAULT_AGY_MODELS:AdvertisedModel[]=[
 {slug:'agy:gemini-4-carbon',supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'}]},
 {slug:'agy:gemini-4-argon',supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'}]},
 {slug:'agy:gemini-3.8-flash',supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'}]},
 {slug:'agy:claude-sonnet-5-5',supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'}]},
 {slug:'agy:claude-opus-5-5',supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'}]},
 {slug:'agy:claude-sonnet-4-6',supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'},{effort:'xhigh'},{effort:'max'}]},
 {slug:'agy:claude-opus-4-6-thinking',supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'},{effort:'xhigh'},{effort:'max'}]},
 {slug:'agy:gpt-oss-120b',supported_reasoning_levels:[{effort:'medium'}]},
];

const NATIVE_AGY_PATTERNS=[
 /^gemini-(?:4-carbon|4-argon|3\.8-flash)(?:-(?:low|medium|high))?$/i,
 /^claude-(?:sonnet-5-5|opus-5-5)(?:-(?:low|medium|high))?$/i,
 /^claude-(?:sonnet-4-6|opus-4-6-thinking)$/i,
 /^gpt-oss-120b(?:-medium)?$/i,
];

export function defaultAgyBinary():string{
 if(process.env.AGY_BIN?.trim())return process.env.AGY_BIN.trim();
 const localBin=join(homedir(),'.local','bin',process.platform==='win32'?'agy.exe':'agy');
 if(existsSync(localBin))return localBin;
 return process.platform==='win32'?'agy.exe':'agy';
}

export function isAgyModel(model:string):boolean{
 const trimmed=model.trim();
 if(/^agy:/i.test(trimmed))return true;
 return NATIVE_AGY_PATTERNS.some(pattern=>pattern.test(trimmed));
}

export function stripAgyPrefix(model:string):string{
 return model.trim().replace(/^agy:/i,'').trim();
}

export function normalizeAgyEffort(effort:string):'low'|'medium'|'high'|'xhigh'|'max'{
 const normalized=effort.trim().toLowerCase();
 if(normalized==='low'||normalized==='medium'||normalized==='high'||normalized==='xhigh'||normalized==='max')return normalized;
 if(normalized==='ultra')return'max';
 return'medium';
}

export function resolveAgyModelAndEffort(model:string,effort:string):{model:string;effort:'low'|'medium'|'high'|'xhigh'|'max'}{
 const raw=stripAgyPrefix(model);
 const normalizedEffort=normalizeAgyEffort(effort);
 if(!raw)throw new Error('Antigravity模型名称不能为空');
 const familyTiers=TIERED_FAMILIES[raw.toLowerCase()];
 if(familyTiers){
  const tierSuffix=normalizedEffort==='low'?'low':normalizedEffort==='medium'?'medium':'high';
  return{model:`${raw.toLowerCase()}-${tierSuffix}`,effort:normalizedEffort};
 }
 const tierMatch=raw.match(/^((?:gemini-(?:4-carbon|4-argon|3\.8-flash)|claude-(?:sonnet-5-5|opus-5-5)))-(low|medium|high)$/i);
 if(tierMatch){
  return{model:`${tierMatch[1]!.toLowerCase()}-${tierMatch[2]!.toLowerCase()}`,effort:normalizedEffort};
 }
 if(raw.toLowerCase()==='gpt-oss-120b')return{model:'gpt-oss-120b-medium',effort:normalizedEffort};
 return{model:raw,effort:normalizedEffort};
}

/** 读取本机 Antigravity 模型目录；支持从可选缓存文件读取，缺省返回内置已核实模型族。 */
export function readAgyModelCatalog(agyHome=process.env.AGY_HOME??join(homedir(),'.gemini','antigravity-cli')):AdvertisedModel[]{
 try{
  const cachePath=join(agyHome,'models_cache.json');
  if(existsSync(cachePath)){
   const parsed=JSON.parse(readFileSync(cachePath,'utf8'));
   if(Array.isArray(parsed?.models)){
    const custom=parsed.models.flatMap((item:unknown)=>{
     if(!item||typeof item!=='object'||!('slug'in item)||typeof item.slug!=='string'||!item.slug.trim())return[];
     const slug=item.slug.trim().startsWith(AGY_MODEL_PREFIX)?item.slug.trim():`${AGY_MODEL_PREFIX}${item.slug.trim()}`;
     const rawLevels=Array.isArray((item as {supported_reasoning_levels?:unknown}).supported_reasoning_levels)?(item as {supported_reasoning_levels:unknown[]}).supported_reasoning_levels:[];
     const efforts=[...new Set(rawLevels.flatMap((level:unknown)=>level&&typeof level==='object'&&'effort'in level&&typeof level.effort==='string'&&level.effort.trim()?[level.effort.trim()]:[]))];
     return efforts.length?[{slug,supported_reasoning_levels:efforts.map(effort=>({effort}))}]:[];
    });
    if(custom.length)return custom;
   }
  }
 }catch{
  // 忽略损坏缓存，回退默认目录
 }
 return DEFAULT_AGY_MODELS.map(model=>({slug:model.slug,supported_reasoning_levels:model.supported_reasoning_levels.map(level=>({...level}))}));
}
