/** 文件职责：读取并保存系统级四类步骤提示词；项目创建时复制快照，既有项目不随系统修改联动。 */
import type {Pool,PoolClient} from 'pg';
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

export async function saveSystemStepPrompts(db:Queryable,value:unknown):Promise<SystemStepPrompts>{
 const prompts=validateSystemStepPrompts(value);
 await db.query(`INSERT INTO ai_distill.system_codex_config(id,step_prompts) VALUES(1,$1::jsonb)
  ON CONFLICT(id) DO UPDATE SET step_prompts=EXCLUDED.step_prompts,updated_at=now()`,[JSON.stringify(prompts)]);
 return prompts;
}
