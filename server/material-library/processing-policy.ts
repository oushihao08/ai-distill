/** 职责：从期次持久化配置解析材料处理意图；供材料派发与来源选择复用，不执行模型或写业务结果。 */
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {resolveMaterialProcessingMode,type MaterialProcessingMode} from '../../shared/material-library';

export async function readProjectMaterialProcessingMode(db:Pool|PoolClient,projectId:string):Promise<MaterialProcessingMode>{
 const row=(await db.query(`SELECT p.id,c.config FROM ai_distill.projects p
  LEFT JOIN ai_distill.project_step_configs c ON c.project_id=p.id AND c.ordinal=4
  WHERE p.id=$1 AND p.deleted_at IS NULL`,[projectId])).rows[0];
 if(!row)throw new HTTPException(404,{message:'期次不存在'});
 return resolveMaterialProcessingMode(row.config);
}

/** 项目上下文优先于客户端模板；原文模式不派脱敏，避免页面选择与执行分叉。 */
export function projectRedactionTemplate(mode:MaterialProcessingMode,requested?:string){
 if(mode==='original')throw new HTTPException(409,{message:'本期使用原文，无需派发脱敏；请使用已成功提取的原文版本'});
 if(requested&&requested!==mode)throw new HTTPException(409,{message:'所选脱敏方式与本期材料处理设置不一致'});
 return mode;
}

/** 原始成功与后续复核分开；旧结果无复核记录时保持原可用性。仅供内部固定SQL别名使用。 */
export function redactionJobCurrentValidationSql(alias:'j'|'redact_job'|'red_job'){
 return `(${alias}.result_summary->'latest_program_validation'->>'valid') IS DISTINCT FROM 'false'`;
}
