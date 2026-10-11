/**
 * 职责：项目报表取数：关联当前题目产物，筛选当前有效的达标题目用于导出。
 * 关键方法与用途：`collectProjectResults()` 读取当前可导出记录；`buildProjectExport()` 生成并登记工作簿。
 * 使用场景：由 `app.ts` 导出接口调用，`workbookSha256()` 用于文件完整性标识。
 */
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {buildResultWorkbook,type ResultExportRecord} from './results';
import {classifyLogError,logEvent,withLogContext} from '../logging';
const object=(value:unknown):Record<string,any>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:undefined;
export async function collectProjectResults(pool:Pool,projectId:string,batch?:string){
 const project=(await pool.query('SELECT id,name FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[projectId])).rows[0];
 if(!project)throw new Error('project_not_found');
 const workflows=await pool.query("SELECT w.id,w.source_key,w.title,s.status AS publication_status FROM ai_distill.workflows w LEFT JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=8 WHERE w.project_id=$1 AND w.deleted_at IS NULL AND ($2::text IS NULL OR w.source_key=$2) ORDER BY w.source_key,w.id",[projectId,batch??null]);
 const ids=workflows.rows.map((row:any)=>row.id);
 if(!ids.length)return {records:[] as ResultExportRecord[]};
 const [attempts,revisionRows]=await Promise.all([
  pool.query("SELECT id,workflow_id,ordinal,attempt,status,jsonb_build_object('context',jsonb_build_object('binding',jsonb_build_object('answer_attempt_id',input#>'{context,binding,answer_attempt_id}')),'source_digest',input->'source_digest') AS input,result,jsonb_build_object('model',config->'model') AS config,started_at,finished_at FROM ai_distill.step_attempts WHERE workflow_id=ANY($1::uuid[]) AND ordinal IN (4,5,6,7,8) ORDER BY workflow_id,ordinal,attempt",[ids]),
  pool.query("SELECT r.*,c.workflow_id,c.status AS chain_status,c.spent_duration_ms,c.calls_reserved FROM ai_distill.revision_rounds r JOIN ai_distill.revision_chains c ON c.id=r.chain_id WHERE c.workflow_id=ANY($1::uuid[]) ORDER BY c.created_at,r.round",[ids]),
 ]);
 const byWorkflow=new Map<string,any[]>();for(const row of attempts.rows){const values=byWorkflow.get(row.workflow_id)??[];values.push(row);byWorkflow.set(row.workflow_id,values);}
 const records:ResultExportRecord[]=workflows.rows.map((workflow:any)=>{
  const workflowRows=byWorkflow.get(workflow.id)??[];
  const current=workflowRows;
  const step=(ordinal:number)=>current.filter(row=>row.ordinal===ordinal);
  const questions=step(4),question=questions.at(-1),q=object(question?.result)??{};
  const answerAttempts=step(5).filter(row=>object(row.result)?.question_version===q.question_version&&(object(row.result)?.question_attempt_id===question?.id||Array.isArray(q.answer_source_attempt_ids)&&q.answer_source_attempt_ids.includes(object(row.result)?.question_attempt_id)));
  const scoreAttempts=step(6);
  const answers=answerAttempts.map((answer:any)=>{
   const result=object(answer.result)??{},config=object(answer.config)??{};
   const scores=scoreAttempts.filter(score=>object(object(object(score.input)?.context)?.binding)?.answer_attempt_id===answer.id);
   const latest=scores.at(-1),scoreResult=object(latest?.result)??{},report=object(scoreResult.report)??{};
   return {model:String(result.model??config.model??'unknown'),status:answer.status,answer:typeof result.text==='string'?result.text:'',score_status:latest?.status??'waiting',score_valid:scoreResult.validation?.valid===true,total:typeof report.total==='number'?report.total:null,max_score:typeof report.max_score==='number'?report.max_score:null,items:Array.isArray(report.items)?report.items.filter((item:any)=>item&&typeof item==='object').map((item:any)=>({id:String(item.id??''),score:Number(item.score??0),max_score:Number(item.max_score??0),reason:String(item.reason??'')})):[]};
  });
  const acceptance=step(7).at(-1),decision=object(acceptance?.result)??{};
  const publication=step(8).at(-1),publishedResult=object(publication?.result)??{};
  const published=workflow.publication_status==='succeeded'&&publication?.status==='succeeded'&&publishedResult.acceptance_attempt_id===acceptance?.id&&typeof publishedResult.source_digest==='string'&&publishedResult.source_digest===object(acceptance?.input)?.source_digest&&publishedResult.question_version===q.question_version&&publishedResult.rubric_version===q.rubric_version;
  const revisions=revisionRows.rows.filter(row=>row.workflow_id===workflow.id).map(row=>({kind:String(row.issue_kind),reason:String(row.decision?.reason??''),from_step:row.decision?.return_step??null,content_revision:Number(row.decision?.content_revisions??0),technical_retry:Number(row.decision?.technical_retries??0),summary:JSON.stringify({round:row.round,status:row.status,chain_status:row.chain_status,before_versions:row.before_versions,after_versions:row.after_versions,before_scores:row.before_scores,after_scores:row.after_scores}),duration_ms:Number(row.spent_duration_ms),calls:Number(row.calls_reserved)}));
  const accepted=acceptance?.status==='succeeded'&&decision.decision==='accepted';
  return {project_id:project.id,project_name:project.name,batch:workflow.source_key??'未分组',workflow_id:workflow.id,title:workflow.title,question:String(q.question??''),question_version:String(q.question_version??''),rubric_version:String(q.rubric_version??''),accepted,published,quarantined:decision.decision==='quarantine'||revisionRows.rows.some(row=>row.workflow_id===workflow.id&&row.chain_status==='isolated'),answers,revisions};
 });
 return {records};
}
export function workbookSha256(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
export async function buildProjectExport(pool:Pool,projectId:string,batch?:string){return withLogContext({component:'reporting',project_id:projectId,operation:'export'},async()=>{logEvent('export.started',{level:'info'});try{const result=await collectProjectResults(pool,projectId,batch);const records=result.records.filter(record=>record.accepted),bytes=buildResultWorkbook(records);logEvent('export.completed',{level:'info',state:'succeeded',attempt_count:records.length,output_bytes:bytes.length});return {...result,records,bytes};}catch(error){logEvent('export.failed',{level:'error',state:'failed',...classifyLogError(error)});throw error;}});}
