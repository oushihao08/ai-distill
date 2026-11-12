/**
 * 职责：给业务步骤提供统一 API 模型选项，复用既有系统模型目录和服务端连接配置。
 * 关键入口：readModelApiCatalog() 供 /api/llm-api/models 使用，返回默认模型和启用模型的非敏感配置。
 * 不变量与修改禁区：沿用 system_answer_models 表，排除 CLI Agent 驱动项；不修改项目作答集合、不读取或返回密钥。
 */
import type {Pool} from 'pg';
import {isRegisteredAgentProvider} from '../agent';
import {readModelApiDefaults,resolveModelApiConfig} from './config';
import type {ModelApiConfig} from './types';

export interface ModelApiOption {name:string;config:ModelApiConfig;is_default:boolean}
const identity=(config:ModelApiConfig)=>JSON.stringify([config.provider,config.base_url,config.model]);
export async function readModelApiCatalog(db:Pool){
 const defaults=readModelApiDefaults();
 const rows=await db.query('SELECT name,config FROM ai_distill.system_answer_models WHERE enabled=true ORDER BY name,id');
 const models:ModelApiOption[]=rows.rows.filter(row=>!isRegisteredAgentProvider(row.config?.provider)).map(row=>({name:row.name,config:resolveModelApiConfig(row.config,{}),is_default:false}));
 const match=models.find(item=>identity(item.config)===identity(defaults));
 if(match)match.is_default=true;
 else models.unshift({name:defaults.provider==='openrouter'&&defaults.model==='z-ai/glm-5.3-flash'?'GLM-5.3-Flash':defaults.model,config:defaults,is_default:true});
 return{defaults,models};
}
