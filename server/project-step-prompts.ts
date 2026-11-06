/**
 * 职责：维护主项目内出题、作答、评分提示词的一致性，并以乐观并发检查阻止旧页面覆盖新值。
 * 入口由项目步骤提示词、步骤配置、恢复默认和新建期次路由调用；只更新 config.prompt，不改历史任务快照。
 */
import { HTTPException } from 'hono/http-exception';

type Queryable={query:(sql:string,values?:unknown[])=>Promise<{rows:any[];rowCount?:number|null}>};
export type SharedPromptOrdinal=4|5|6;

export function sharedPromptOrdinal(value:number):value is SharedPromptOrdinal{return value===4||value===5||value===6;}

export async function lockProjectPromptScope(db:Queryable,projectId:string,ordinal:SharedPromptOrdinal,expectedPrompt?:unknown){
 const scope=(await db.query('SELECT id,project_group_id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[projectId])).rows[0];
 if(!scope)throw new HTTPException(404,{message:'项目不存在'});
 if(scope.project_group_id)await db.query('SELECT id FROM ai_distill.project_groups WHERE id=$1 FOR UPDATE',[scope.project_group_id]);
 const project=(await db.query(`SELECT p.id,p.project_group_id,c.config->>'prompt' AS prompt
  FROM ai_distill.projects p
  LEFT JOIN ai_distill.project_step_configs c ON c.project_id=p.id AND c.ordinal=$2
  WHERE p.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF p`,[projectId,ordinal])).rows[0];
 if(!project)throw new HTTPException(404,{message:'项目不存在'});
 if(typeof expectedPrompt==='string'&&(project.prompt??'')!==expectedPrompt)throw new HTTPException(409,{message:'提示词已在其他页面更新；当前草稿未保存，请复制草稿后刷新再合并'});
 return project as {id:string;project_group_id:string|null;prompt:string|null};
}

export async function propagateProjectGroupPrompt(db:Queryable,projectId:string,ordinal:SharedPromptOrdinal,prompt:string){
 await db.query(`INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config)
  SELECT sibling.id,$2,jsonb_build_object('prompt',$3::text)
  FROM ai_distill.projects source
  JOIN ai_distill.projects sibling ON sibling.deleted_at IS NULL AND (
   source.project_group_id IS NOT NULL AND sibling.project_group_id=source.project_group_id
   OR source.project_group_id IS NULL AND sibling.id=source.id)
  WHERE source.id=$1 AND source.deleted_at IS NULL
  ON CONFLICT(project_id,ordinal) DO UPDATE
  SET config=jsonb_set(ai_distill.project_step_configs.config,'{prompt}',to_jsonb($3::text),true),updated_at=now()`,[projectId,ordinal,prompt]);
}

export async function readProjectGroupPrompts(db:Queryable,projectGroupId:string){
 const rows=(await db.query(`SELECT DISTINCT ON(c.ordinal) c.ordinal,c.config->>'prompt' AS prompt
  FROM ai_distill.projects p JOIN ai_distill.project_step_configs c ON c.project_id=p.id
  WHERE p.project_group_id=$1 AND p.deleted_at IS NULL AND c.ordinal=ANY($2::int[]) AND NULLIF(c.config->>'prompt','') IS NOT NULL
  ORDER BY c.ordinal,p.phase_no DESC NULLS LAST,p.created_at DESC`,[projectGroupId,[4,5,6]])).rows;
 return Object.fromEntries(rows.map(row=>[Number(row.ordinal),row.prompt])) as Partial<Record<SharedPromptOrdinal,string>>;
}
