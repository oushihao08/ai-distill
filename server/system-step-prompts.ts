/**
 * 文件职责：系统四类步骤提示词的读取、完整输入校验与保存。
 * 入口：readSystemStepPrompts() 供项目创建与设置读取；saveSystemStepPrompts()/validateSystemStepPrompts() 供系统设置API使用。
 * 新项目复制默认值，既有项目与已冻结尝试不随系统修改联动；本模块不派发任务。
 */
import type {Pool,PoolClient} from 'pg';
import {validateAgentModelSettings} from './agent/config';
import {SYSTEM_STEP_PROMPTS} from '../shared/step-prompts';

export type SystemStepPrompts=Record<4|5|6|9,string>;
type Queryable=Pick<Pool,'query'>|Pick<PoolClient,'query'>;

export async function readSystemStepPrompts(db:Queryable):Promise<SystemStepPrompts>{
 const result=await db.query('SELECT step_prompts FROM ai_distill.system_codex_config WHERE id=1');
 const saved=result.rows[0]?.step_prompts;
 return Object.fromEntries(([4,5,6,9] as const).map(ordinal=>[
  ordinal,typeof saved?.[ordinal]==='string'&&saved[ordinal].trim()?saved[ordinal]:SYSTEM_STEP_PROMPTS[ordinal],
 ])) as SystemStepPrompts;
}

export function validateSystemStepPrompts(value:unknown):SystemStepPrompts{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['4','5','6','9'].includes(key)))throw new Error('系统提示词配置格式无效');
 const input=value as Record<string,unknown>;
 const prompts={} as SystemStepPrompts;
 for(const ordinal of [4,5,6,9] as const){
  const prompt=input[ordinal];
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)throw new Error('四类系统提示词均须填写，且每项不超过12000字符');
  prompts[ordinal]=prompt;
 }
 return prompts;
}

export async function saveSystemStepPrompts(db:Queryable,value:unknown,authoringDefaults?:unknown):Promise<SystemStepPrompts>{
 const prompts=validateSystemStepPrompts(value);
 const defaults=authoringDefaults===undefined?undefined:validateAuthoringDefaults(authoringDefaults);
 if(defaults){
  await db.query(`INSERT INTO ai_distill.system_codex_config(id,step_prompts,authoring_defaults) VALUES(1,$1::jsonb,$2::jsonb)
   ON CONFLICT(id) DO UPDATE SET step_prompts=EXCLUDED.step_prompts,authoring_defaults=EXCLUDED.authoring_defaults,updated_at=now()`,[JSON.stringify(prompts),JSON.stringify(defaults)]);
  return prompts;
 }
 await db.query(`INSERT INTO ai_distill.system_codex_config(id,step_prompts) VALUES(1,$1::jsonb)
  ON CONFLICT(id) DO UPDATE SET step_prompts=EXCLUDED.step_prompts,updated_at=now()`,[JSON.stringify(prompts)]);
 return prompts;
}

/** 出题专用默认值不继承通用Agent默认，避免影响评分和脱敏。 */
export const DEFAULT_AUTHORING_SETTINGS={model:'gpt-6.1-sol',reasoning_effort:'low'} as const;
export interface AuthoringDefaults {model:string;reasoning_effort:string}
export function validateAuthoringDefaults(value:unknown):AuthoringDefaults{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('出题默认设置须为JSON对象');
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(key=>!['model','reasoning_effort'].includes(key)))throw new Error('出题默认设置包含未知字段');
 return validateAgentModelSettings(input);
}
export async function readSystemAuthoringDefaults(db:Queryable):Promise<AuthoringDefaults>{
 const result=await db.query('SELECT authoring_defaults FROM ai_distill.system_codex_config WHERE id=1');
 return validateAuthoringDefaults(result.rows[0]?.authoring_defaults??DEFAULT_AUTHORING_SETTINGS);
}
