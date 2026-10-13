/**
 * 职责：工作台的轻量工作流投影；状态读取不传正文，内容读取只提供当前题目、作答与评分。
 * 入口：readProjectWorkflowViews() 批量读取列表状态；stepResultProjection() 构造服务端字段白名单；readWorkflowAttempts() 返回有限历史摘要与当前引用结果。
 * 调用方：app.ts 的工作流详情和项目状态接口；不修改执行器、数据库原始记录或版本绑定。
 */
import type {Pool} from 'pg';
import {readProjectWorkflowStepRows,workflowStepReadiness,type WorkflowStepState} from './project-folders';
import {STEP_REGISTRY} from '../shared/step-registry';

/** 当前页一次读取状态和有限尝试摘要，避免每道题重复读取项目、附件和全部历史。 */
export async function readProjectWorkflowViews(pool:Pool,projectId:string,ids:string[]){
 try{
  const [states,attempts]=await Promise.all([
   readProjectWorkflowStepRows(pool,projectId,ids),
   pool.query(`SELECT DISTINCT ON (a.workflow_id,a.ordinal,a.status) a.workflow_id,a.id,a.ordinal,a.status,a.error,a.started_at,a.finished_at,NULL AS input,NULL AS config,
    CASE WHEN a.ordinal=2 THEN jsonb_build_object('issues',a.result->'issues') WHEN a.ordinal=5 AND a.result->>'outcome'='qualified_timeout_unscored' THEN jsonb_build_object('outcome',a.result->'outcome','reason_code',a.result->'reason_code','generation_activity',a.result->'generation_activity') WHEN a.ordinal=5 AND a.result#>>'{error,reason_code}' IS NOT NULL THEN jsonb_build_object('error',jsonb_build_object('reason_code',a.result#>'{error,reason_code}')) WHEN a.ordinal=7 THEN jsonb_build_object('decision',a.result->'decision','model_scores',a.result->'model_scores','reasons',a.result->'reasons') ELSE NULL END AS result
    FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id
    WHERE w.project_id=$1 AND w.deleted_at IS NULL AND a.workflow_id=ANY($2::uuid[]) AND a.ordinal NOT IN (3,10)
    ORDER BY a.workflow_id,a.ordinal,a.status,a.attempt DESC`,[projectId,ids]),
  ]);
  const views:Record<string,{steps:unknown[];attempts:unknown[]}>= {};
  for(const id of ids){
   const rows=states.rows.filter(row=>row.workflow_id===id);
   if(!rows.length)continue;
   const map=new Map<number,WorkflowStepState>(rows.map(row=>[row.ordinal,row]));
   views[id]={steps:rows.map(row=>{
    const eligibility=workflowStepReadiness(row.ordinal,map),stage=STEP_REGISTRY.find(item=>item.ordinal===row.ordinal)!;
    return{...row,status:row.ordinal===1&&row.has_pdf?row.extraction_status??row.status:row.status,name:stage.name,display_position:stage.position,ready:eligibility.ready,ready_reason:eligibility.ready?null:eligibility.reason};
   }),attempts:attempts.rows.filter(row=>row.workflow_id===id)};
  }
  return views;
 }catch(error){throw error;}
}

export function stepResultProjection(alias:string,content:boolean){
 const models=`(SELECT COALESCE(jsonb_agg(jsonb_build_object('model_id',m->'model_id','name',m->'name','status',m->'status','attempt_id',m->'attempt_id','minimum_score',m->'minimum_score','outcome',m->'outcome','reason_code',m->'reason_code','generation_activity',m->'generation_activity')), '[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.result->'models')='array' THEN ${alias}.result->'models' ELSE '[]'::jsonb END) m)`;
 return `CASE
  WHEN ${alias}.ordinal=4 THEN ${content?`(SELECT jsonb_object_agg(key,value) FROM jsonb_each(COALESCE(${alias}.result,'{}'::jsonb)) WHERE key IN ('header','question_id','task_name','task_type','question','rubric','answer_approach','reference_answer','answer_requirements','question_version','rubric_version'))`:`NULL`}
  WHEN ${alias}.ordinal=5 THEN jsonb_build_object('models',${content?`${alias}.result->'models'`:models})
  WHEN ${alias}.ordinal=6 THEN jsonb_build_object('models',${alias}.result->'models')
  WHEN ${alias}.ordinal=7 THEN jsonb_build_object('decision',${alias}.result->'decision','model_scores',${alias}.result->'model_scores','reasons',${alias}.result->'reasons')
  ELSE NULL END`;
}

/** 历史只保留最近 20 条摘要；当前模型结果由 steps 中的 attempt_id 显式关联，不以历史时间猜测。 */
export async function readWorkflowAttempts(pool:Pool,id:string,content:boolean){
 try{return await pool.query(`WITH selected AS (
  SELECT id FROM (SELECT DISTINCT ON (ordinal) id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal<>10 ORDER BY ordinal,attempt DESC) latest
  UNION SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND status IN ('waiting','running')
  UNION SELECT id FROM (SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='succeeded' ORDER BY attempt DESC LIMIT 1) authored
  UNION SELECT id FROM (SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal<>10 ORDER BY started_at DESC,id DESC LIMIT 20) recent
  UNION SELECT a.id FROM ai_distill.step_attempts a WHERE a.workflow_id=$1 AND EXISTS (
   SELECT 1 FROM ai_distill.steps s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.result->'models')='array' THEN s.result->'models' ELSE '[]'::jsonb END) m
   WHERE s.workflow_id=$1 AND s.ordinal IN (5,6) AND (m->>'attempt_id'=a.id::text OR m->>'score_attempt_id'=a.id::text OR m->>'answer_attempt_id'=a.id::text))
 ) SELECT a.id,a.ordinal,a.status,a.error,a.started_at,a.finished_at,
  CASE WHEN $2 AND a.ordinal=6 THEN jsonb_build_object('context',jsonb_build_object('rubric',a.input#>'{context,rubric}','binding',jsonb_build_object('answer_attempt_id',a.input#>'{context,binding,answer_attempt_id}')))
   WHEN a.ordinal=5 THEN jsonb_build_object('model_id',a.input->'model_id','model_name',a.input->'model_name') ELSE NULL END AS input,
  NULL AS config,
  CASE WHEN a.ordinal=2 THEN jsonb_build_object('issues',a.result->'issues') WHEN a.ordinal=7 THEN jsonb_build_object('decision',a.result->'decision','model_scores',a.result->'model_scores','reasons',a.result->'reasons')
   WHEN $2 AND a.ordinal=6 AND EXISTS (SELECT 1 FROM ai_distill.steps s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.result->'models')='array' THEN s.result->'models' ELSE '[]'::jsonb END) m WHERE s.workflow_id=$1 AND s.ordinal=6 AND m->>'score_attempt_id'=a.id::text)
    THEN jsonb_build_object('raw_text',a.result->'raw_text','report',a.result->'report','validation',a.result->'validation')
   WHEN a.ordinal=5 THEN jsonb_build_object('model_name',a.result->'model_name','model_id',a.result->'model_id','outcome',a.result->'outcome','reason_code',a.result->'reason_code','generation_activity',a.result->'generation_activity','error',CASE WHEN a.result#>>'{error,reason_code}' IS NULL THEN NULL ELSE jsonb_build_object('reason_code',a.result#>'{error,reason_code}') END) ELSE NULL END AS result
 FROM ai_distill.step_attempts a JOIN selected ON selected.id=a.id WHERE a.ordinal<>10 ORDER BY a.ordinal,a.attempt`,[id,content]);}catch(error){throw error;}
}
