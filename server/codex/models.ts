import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {HTTPException} from 'hono/http-exception';
interface AdvertisedModel {slug:string;supported_reasoning_levels:{effort:string}[]}
function modelCatalog():AdvertisedModel[]{
 try{const value=JSON.parse(readFileSync(join(process.env.CODEX_HOME??join(process.env.HOME??'','.codex'),'models_cache.json'),'utf8'));if(!Array.isArray(value.models))return[];return value.models.filter((model:AdvertisedModel)=>typeof model?.slug==='string'&&Array.isArray(model.supported_reasoning_levels));}
 catch{return[];}
}
// The installed CLI's advertised capabilities are a configuration check, not a live invocation test.
export function validateCodexModel(model:string,effort:string,catalog=modelCatalog()){
 if(!catalog.length)throw new HTTPException(409,{message:'Codex模型清单不可用，请先完成本地套餐登录并刷新模型清单'});
 const entry=catalog.find(entry=>entry.slug===model);
 if(!entry)throw new HTTPException(400,{message:'模型不在当前Codex可用模型清单中'});
 if(!entry.supported_reasoning_levels.some(level=>level?.effort===effort))throw new HTTPException(400,{message:'此Codex模型不支持所选推理强度'});
}
