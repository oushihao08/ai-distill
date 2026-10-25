/**
 * 职责：工作台的轻量工作流投影；状态读取不传正文，内容读取只提供当前题目、作答与评分。
 * 入口：readProjectWorkflowViews() 批量读取列表状态；readWorkflowStepHistory() 分页读取安全执行记录；stepResultProjection() 构造服务端字段白名单；readWorkflowAttempts() 返回有限历史摘要与当前引用结果。
 * 调用方：app.ts 的工作流详情和项目状态接口；不修改执行器、数据库原始记录或版本绑定。
 */
import type {Pool} from 'pg';
import {readProjectWorkflowStepRows,workflowStepReadiness,type WorkflowStepState} from './project-folders';
import {STEP_REGISTRY} from '../shared/step-registry';

type ProjectWorkflowView={steps:(WorkflowStepState&Record<string,any>)[];attempt_summary:{has_authored:boolean}};

/** 列表只取步骤状态与活动/已出题标记；完整执行记录在用户打开详情时再读取。 */
export async function readProjectWorkflowViews(pool:Pool,projectId:string,ids:string[],snapshot?:{states:Awaited<ReturnType<typeof readProjectWorkflowStepRows>>;hasAuthored:Map<string,boolean>}):Promise<Record<string,ProjectWorkflowView>>{
 try{
  if(snapshot)return projectWorkflowViewsFromSnapshot(snapshot,ids);
  const [states,attemptSummary]=await Promise.all([
   readProjectWorkflowStepRows(pool,projectId,ids),
   pool.query(`SELECT a.workflow_id,
     COALESCE(bool_or(a.ordinal=4 AND a.status='succeeded'),false) AS has_authored
    FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id
    WHERE w.project_id=$1 AND w.deleted_at IS NULL AND a.workflow_id=ANY($2::uuid[]) AND a.ordinal NOT IN (3,10)
    GROUP BY a.workflow_id`,[projectId,ids]),
  ]);
  return projectWorkflowViewsFromSnapshot({states,hasAuthored:new Map(attemptSummary.rows.map((row:any)=>[String(row.workflow_id),Boolean(row.has_authored)]))},ids);
 }catch(error){throw error;}
}

/** 项目详情已经读取的步骤状态行和出题标记可直接复用，避免首屏再次扫描同一批工作流。 */
export function projectWorkflowViewsFromSnapshot(snapshot:{states:Awaited<ReturnType<typeof readProjectWorkflowStepRows>>;hasAuthored:Map<string,boolean>},ids:string[]):Record<string,ProjectWorkflowView>{
 const views:Record<string,ProjectWorkflowView>={};
 for(const id of ids){
  const rows=snapshot.states.rows.filter(row=>row.workflow_id===id);
  if(!rows.length)continue;
  const map=new Map<number,WorkflowStepState>(rows.map(row=>[row.ordinal,row]));
  views[id]={steps:rows.map(row=>{
   const eligibility=workflowStepReadiness(row.ordinal,map),stage=STEP_REGISTRY.find(item=>item.ordinal===row.ordinal)!;
   const extraction=row.ordinal===1&&row.has_pdf&&row.extraction_status!=='skipped';
   return{...row,status:extraction?row.extraction_status??row.status:row.status,error:extraction?row.extraction_error??row.error:row.error,started_at:extraction?row.extraction_started_at??row.started_at:row.started_at,finished_at:extraction?row.extraction_finished_at??row.finished_at:row.finished_at,name:stage.name,display_position:stage.position,ready:eligibility.ready,ready_reason:eligibility.ready?null:eligibility.reason};
  }),attempt_summary:{has_authored:snapshot.hasAuthored.get(id)??false}};
 }
 return views;
}

/** 只返回步骤执行元信息；入库包含内部 PDF 提取尝试，不返回冻结输入或私有结果正文。 */
export async function readWorkflowStepHistory(pool:Pool,id:string,ordinal:number,offset:number){
 const [rows,total]=await Promise.all([
  pool.query("SELECT a.id,a.ordinal,a.attempt,a.status,a.error,a.started_at,a.finished_at,CASE WHEN a.ordinal=7 THEN a.result->>'decision' END AS decision FROM ai_distill.step_attempts a WHERE a.workflow_id=$1 AND (a.ordinal=$2 OR ($2=1 AND a.ordinal=2)) ORDER BY a.started_at DESC,a.id DESC LIMIT 20 OFFSET $3",[id,ordinal,offset]),
  pool.query("SELECT count(*)::int AS count FROM ai_distill.step_attempts a WHERE a.workflow_id=$1 AND (a.ordinal=$2 OR ($2=1 AND a.ordinal=2))",[id,ordinal]),
 ]);
 return{attempts:rows.rows,total:Number(total.rows[0]?.count??0),offset,limit:20};
}

/** 项目列表与轻量详情共用白名单；不得将models中的完整answer正文带入列表。 */
export function answerModelSummaryProjection(alias:string){
 return `(SELECT COALESCE(jsonb_agg(jsonb_build_object('model_id',m->'model_id','name',m->'name','status',m->'status','attempt_id',m->'attempt_id','minimum_score',m->'minimum_score','outcome',m->'outcome','reason_code',m->'reason_code','generation_activity',m->'generation_activity')), '[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.result->'models')='array' THEN ${alias}.result->'models' ELSE '[]'::jsonb END) m)`;
}
export function stepResultProjection(alias:string,content:boolean){
 const models=answerModelSummaryProjection(alias);
 return `CASE
  WHEN ${alias}.ordinal=9 THEN jsonb_build_object('progress',${alias}.result->'progress','error',jsonb_build_object('reason_code',${alias}.result#>'{error,reason_code}'))
  WHEN ${alias}.ordinal=4 THEN ${content?`(SELECT jsonb_object_agg(key,value) FROM jsonb_each(COALESCE(${alias}.result,'{}'::jsonb)) WHERE key IN ('content_contract','task_metadata','input_files','deliverables','reference_outputs','research_records','task_requirements','content_status','header','question_id','task_name','task_type','question','rubric','answer_approach','reference_answer','answer_requirements','question_version','rubric_version','scoring_policy'))`:`NULL`}
  WHEN ${alias}.ordinal=5 THEN jsonb_build_object('models',${content?`${alias}.result->'models'`:models})
  WHEN ${alias}.ordinal=6 THEN jsonb_build_object('models',${alias}.result->'models')
  WHEN ${alias}.ordinal=8 THEN jsonb_build_object('feishu_sync',CASE WHEN ${alias}.result->'feishu_sync' IS NOT NULL THEN jsonb_build_object('status',${alias}.result#>'{feishu_sync,status}','verification',${alias}.result#>'{feishu_sync,verification}','reason_code',${alias}.result#>'{feishu_sync,reason_code}','url',${alias}.result#>'{feishu_sync,url}','record_id',${alias}.result#>'{feishu_sync,record_id}') ELSE NULL END)
  WHEN ${alias}.ordinal=7 THEN jsonb_build_object('decision',${alias}.result->'decision','model_scores',${alias}.result->'model_scores','aggregate',${alias}.result->'aggregate','reasons',${alias}.result->'reasons')
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
  CASE WHEN a.ordinal=9 THEN jsonb_build_object('progress',a.result->'progress') WHEN a.ordinal=2 THEN jsonb_build_object('issues',a.result->'issues') WHEN a.ordinal=7 THEN jsonb_build_object('decision',a.result->'decision','model_scores',a.result->'model_scores','aggregate',a.result->'aggregate','reasons',a.result->'reasons')
   WHEN $2 AND a.ordinal=6 AND EXISTS (SELECT 1 FROM ai_distill.steps s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.result->'models')='array' THEN s.result->'models' ELSE '[]'::jsonb END) m WHERE s.workflow_id=$1 AND s.ordinal=6 AND m->>'score_attempt_id'=a.id::text)
    THEN jsonb_build_object('raw_text',a.result->'raw_text','report',a.result->'report','validation',a.result->'validation')
   WHEN a.ordinal=5 THEN jsonb_build_object('model_name',a.result->'model_name','model_id',a.result->'model_id','outcome',a.result->'outcome','reason_code',a.result->'reason_code','generation_activity',a.result->'generation_activity','error',CASE WHEN a.result#>>'{error,reason_code}' IS NULL THEN NULL ELSE jsonb_build_object('reason_code',a.result#>'{error,reason_code}') END) ELSE NULL END AS result
 FROM ai_distill.step_attempts a JOIN selected ON selected.id=a.id WHERE a.ordinal<>10 ORDER BY a.ordinal,a.attempt`,[id,content]);}catch(error){throw error;}
}
