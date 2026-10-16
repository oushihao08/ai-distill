/**
 * 职责：读取当前题目包与脱敏 DOCX 地址，筛选达标题目并生成项目工作簿。
 * 关键方法与用途：`collectProjectResults()` 组装题目数据；`buildProjectExport()` 生成可下载 XLSX；`withProjectExportLock()` 互斥导出并恢复中断记录。
 * 使用场景：由 `app.ts` 导出接口调用；`workbookSha256()` 标记导出文件完整性。
 */
import type {Pool,PoolClient} from 'pg';
import {readCurrentRedactedDocx} from '../materials/redacted-docx-export';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {HTTPException} from 'hono/http-exception';
import {buildResultWorkbook,type ResultExportRecord} from './results';
import {classifyLogError,logEvent,withLogContext} from '../logging';
import {verifyFrozenProjectPrompt} from '../rule-files';

const object=(value:unknown):Record<string,any>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:undefined;
const text=(value:unknown)=>typeof value==='string'?value:'';

/** 对要导出的达标题目核验出题时冻结的 skill 快照；不因项目后续编辑而改变历史 attempt。 */
export async function verifyProjectAuthoringRules(pool:Pool|PoolClient,projectId:string,workflowIds:string[]){
 if(!workflowIds.length)return;
 const project=(await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[projectId])).rows[0];
 if(!project)throw new HTTPException(409,{message:'项目不存在或已删除，不能导出当前成果'});
 const attempts=(await pool.query("SELECT DISTINCT ON (workflow_id) workflow_id,id,status,input FROM ai_distill.step_attempts WHERE workflow_id=ANY($1::uuid[]) AND ordinal=4 ORDER BY workflow_id,attempt DESC",[workflowIds])).rows;
 const byWorkflow=new Map(attempts.map((row:any)=>[String(row.workflow_id),row]));
 for(const workflowId of workflowIds){
  const attempt=byWorkflow.get(workflowId);
  if(!attempt||attempt.status!=='succeeded')throw new HTTPException(409,{message:'当前题目缺少有效的出题记录，不能导出'});
  await verifyFrozenProjectPrompt(attempt.input?.project_prompt);
 }
}

function attachmentAddress(storageRoot:string|undefined,storagePath:string){
 if(!storageRoot||!storagePath||isAbsolute(storagePath))throw new Error('input_attachment_path_invalid');
 const root=resolve(storageRoot),path=resolve(root,storagePath),within=relative(root,path);
 if(!within||within==='..'||within.startsWith(`..${sep}`)||isAbsolute(within))throw new Error('input_attachment_path_invalid');
 return pathToFileURL(path).href;
}

export async function collectProjectResults(pool:Pool|PoolClient,projectId:string,batch?:string,attachmentRoot=fileURLToPath(new URL('../../assets/out/',import.meta.url)),workflowId?:string){
 const project=(await pool.query('SELECT id,name,material_root,local_skill_path FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[projectId])).rows[0];
 if(!project)throw new Error('project_not_found');
 const workflows=await pool.query("SELECT w.id,w.source_key,w.title,s.status AS acceptance_status FROM ai_distill.workflows w LEFT JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=7 WHERE w.project_id=$1 AND w.deleted_at IS NULL AND ($2::text IS NULL OR w.source_key=$2) AND ($3::uuid IS NULL OR w.id=$3) ORDER BY w.source_key,w.id",[projectId,batch??null,workflowId??null]);
 const ids=workflows.rows.map((row:any)=>row.id);
 if(!ids.length)return {records:[] as ResultExportRecord[]};

 const attempts=await pool.query("SELECT id,workflow_id,ordinal,attempt,status,input,input->>'redaction_attempt_id' AS redaction_attempt_id,result FROM ai_distill.step_attempts WHERE workflow_id=ANY($1::uuid[]) AND ordinal IN (4,7) ORDER BY workflow_id,ordinal,attempt",[ids]);
 const byWorkflow=new Map<string,any[]>();
 for(const row of attempts.rows){const values=byWorkflow.get(row.workflow_id)??[];values.push(row);byWorkflow.set(row.workflow_id,values);}

 const questionAttemptByWorkflow=new Map<string,any>();
 const records:ResultExportRecord[]=workflows.rows.map((workflow:any)=>{
  const current=byWorkflow.get(workflow.id)??[];
  const latest=(ordinal:number)=>current.filter(row=>row.ordinal===ordinal).at(-1);
  const questionAttempt=latest(4),question=object(questionAttempt?.result)??{},acceptance=latest(7),decision=object(acceptance?.result)??{};
  const aggregate=object(decision.aggregate);
  if(questionAttempt?.id)questionAttemptByWorkflow.set(workflow.id,questionAttempt);
  return {
   workflow_id:String(workflow.id),title:text(workflow.title),accepted:workflow.acceptance_status==='succeeded'&&questionAttempt?.status==='succeeded'&&acceptance?.status==='succeeded'&&decision.decision==='accepted',
   ...(aggregate?.mode==='mean_at_most'&&typeof aggregate.model_count==='number'&&typeof aggregate.mean_percentage==='number'&&typeof aggregate.threshold==='number'?{acceptance_aggregate:{mode:'mean_at_most' as const,model_count:aggregate.model_count,mean_percentage:aggregate.mean_percentage,threshold:aggregate.threshold}}:{}),
   task_name:text(question.task_name),question:text(question.question),input_attachments:[],
   model_scores:Object.entries(object(decision.model_scores)??{}).map(([modelId,value])=>{
    const score=object(value)??{};
    return {model_id:modelId,name:modelId,...(score.score_contract==='model_report_v1'?{score_contract:'model_report_v1' as const,raw_score:typeof score.raw_score==='number'?score.raw_score:null,full_score:typeof score.full_score==='number'?score.full_score:null,veto_triggered:typeof score.veto_triggered==='boolean'?score.veto_triggered:null}:{}),score:typeof score.score==='number'?score.score:null,max_score:typeof score.max_score==='number'?score.max_score:null,percentage:typeof score.percentage==='number'?score.percentage:null};
   }),
   rubric:Array.isArray(question.rubric)?question.rubric:[],answer_approach:text(question.answer_approach),reference_answer:text(question.reference_answer),reference_answer_attachment:'',
  };
 });

 const acceptedWorkflowIds=records.filter(record=>record.accepted).map(record=>record.workflow_id);
 const latestAttemptResult=(current:any[],ordinal:number)=>current.filter(row=>row.ordinal===ordinal).at(-1)?.result;
 const modelRefs=records.flatMap(record=>{
  if(!record.accepted)return [];
  const acceptance=object(latestAttemptResult(byWorkflow.get(record.workflow_id)??[],7));
  return Array.isArray(acceptance?.evaluation_records)?acceptance.evaluation_records:[];
 });
 const answerAttemptIds=[...new Set(modelRefs.map((ref:unknown)=>text(object(ref)?.answer_attempt_id)).filter(Boolean))];
 if(answerAttemptIds.length){
  const answerRows=await pool.query("SELECT id,COALESCE(result->>'model_name',input->>'model_name') AS model_name FROM ai_distill.step_attempts WHERE id=ANY($1::uuid[]) AND ordinal=5",[answerAttemptIds]);
  const names=new Map(answerRows.rows.map((row:any)=>[String(row.id),text(row.model_name)]));
  for(const record of records){
   if(!record.accepted)continue;
   const acceptance=object(latestAttemptResult(byWorkflow.get(record.workflow_id)??[],7));
   const refs=Array.isArray(acceptance?.evaluation_records)?acceptance.evaluation_records:[];
   for(const score of record.model_scores){
    const ref=refs.map((item:unknown)=>object(item)).find((item:any)=>item?.model_id===score.model_id);
    const name=typeof ref?.answer_attempt_id==='string'?names.get(ref.answer_attempt_id):undefined;
    if(name)score.name=name;
   }
  }
 }
 const acceptedQuestionAttempts=acceptedWorkflowIds.map(id=>questionAttemptByWorkflow.get(id));
 await verifyProjectAuthoringRules(pool,projectId,acceptedWorkflowIds);
 if(acceptedQuestionAttempts.some((row:any)=>row?.status!=='succeeded'||!Array.isArray(object(row.result)?.attachment_ids)||!object(row.result)!.attachment_ids.length||object(row.result)!.attachment_ids.some((id:unknown)=>typeof id!=='string')))throw new Error('input_attachment_missing');
 if(acceptedQuestionAttempts.length){
  const attachmentRows=await pool.query(`
   SELECT DISTINCT q.id AS question_attempt_id,docx.id AS docx_id,docx.storage_path,docx.material_id,w.source_key,p.material_root,
    (SELECT count(*)::int FROM ai_distill.materials current_material WHERE current_material.workflow_id=q.workflow_id AND current_material.deleted_at IS NULL) AS material_count
   FROM ai_distill.step_attempts q
   JOIN ai_distill.workflows w ON w.id=q.workflow_id
   JOIN ai_distill.projects p ON p.id=w.project_id
   JOIN LATERAL jsonb_array_elements_text(COALESCE(q.result->'attachment_ids','[]'::jsonb)) selected(artifact_id) ON TRUE
   JOIN ai_distill.artifacts redacted ON redacted.id::text=selected.artifact_id AND redacted.workflow_id=q.workflow_id AND redacted.kind='redacted_markdown'
   JOIN ai_distill.step_attempts redaction ON redaction.id=redacted.attempt_id AND redaction.ordinal=9 AND redaction.status='succeeded'
   JOIN ai_distill.steps current_redaction ON current_redaction.workflow_id=q.workflow_id AND current_redaction.ordinal=9 AND current_redaction.status='succeeded'
   JOIN ai_distill.artifacts docx ON docx.workflow_id=q.workflow_id AND docx.attempt_id=redaction.id AND docx.kind='redacted_docx'
   JOIN ai_distill.materials m ON m.id=docx.material_id AND m.workflow_id=q.workflow_id AND m.deleted_at IS NULL
   WHERE q.id=ANY($1::uuid[]) AND redaction.id::text=q.input->>'redaction_attempt_id'
   ORDER BY q.id,docx.storage_path
  `,[acceptedQuestionAttempts.map((row:any)=>row.id)]);
  const countsByQuestionAttempt=new Map<string,number>();
  const materialIdsByQuestionAttempt=new Map<string,Set<string>>();
  const pathsByQuestionAttempt=new Map<string,string[]>();
  for(const row of attachmentRows.rows){
   // 复用下载入口的当前版本、路径、普通文件和指纹校验，不只相信索引。
   if(!await readCurrentRedactedDocx(pool,String(row.docx_id),attachmentRoot))throw new HTTPException(409,{message:'脱敏 DOCX 已缺失或失效，请重新生成'});
   countsByQuestionAttempt.set(row.question_attempt_id,Number(row.material_count));
   const materialIds=materialIdsByQuestionAttempt.get(row.question_attempt_id)??new Set<string>();
   materialIds.add(String(row.material_id));materialIdsByQuestionAttempt.set(row.question_attempt_id,materialIds);
   const storagePath=String(row.storage_path??'');
   const legacy=!storagePath.startsWith('附件库/');
   if(legacy&&(typeof row.material_root!=='string'||typeof row.source_key!=='string'||storagePath!==join('outputs',row.source_key,'脱敏材料.docx')))throw new Error('redacted_docx_path_invalid');
   const paths=pathsByQuestionAttempt.get(row.question_attempt_id)??[];
   paths.push(attachmentAddress(legacy?dirname(row.material_root):attachmentRoot,storagePath));
   pathsByQuestionAttempt.set(row.question_attempt_id,paths);
  }
  for(const workflowId of acceptedWorkflowIds){
   const attempt=questionAttemptByWorkflow.get(workflowId),record=records.find(item=>item.workflow_id===workflowId);
   if(!attempt)throw new Error('input_attachment_missing');
   const paths=pathsByQuestionAttempt.get(attempt.id)??[];
   if(!paths.length||paths.length!==countsByQuestionAttempt.get(attempt.id)||materialIdsByQuestionAttempt.get(attempt.id)?.size!==paths.length)throw new HTTPException(409,{message:`${record?.title??'题目'}尚未生成全部附件的当前脱敏 DOCX，请先归档并重新生成脱敏 DOCX`});
   if(record)record.input_attachments=paths;
  }
 }
 return {records};
}

export function workbookSha256(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}

export async function buildProjectExport(pool:Pool|PoolClient,projectId:string,batch?:string,attachmentRoot?:string,workflowId?:string){
 return withLogContext({component:'reporting',project_id:projectId,operation:'export'},async()=>{
  logEvent('export.started',{level:'info'});
  try{
   const result=await collectProjectResults(pool,projectId,batch,attachmentRoot,workflowId),records=result.records.filter(record=>record.accepted),bytes=buildResultWorkbook(records);
   await verifyProjectAuthoringRules(pool,projectId,records.map(record=>record.workflow_id));
   logEvent('export.completed',{level:'info',state:'succeeded',attempt_count:records.length,output_bytes:bytes.length});
   return {...result,records,bytes};
  }catch(error){logEvent('export.failed',{level:'error',state:'failed',...classifyLogError(error)});throw error;}
 });
}

/** 项目导出在同一显式事务内持有事务级锁，兼容 PostgreSQL transaction pooling。 */
export async function withProjectExportLock<T>(pool:Pool,projectId:string,run:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect();let transaction=false,destroy=false;
 try{
  destroy=true; // BEGIN 的响应若丢失，销毁连接以释放可能已建立的事务锁。
  await db.query('BEGIN');transaction=true;destroy=false;
  const locked=Boolean((await db.query("SELECT pg_try_advisory_xact_lock(hashtext('ai-distill-project-export'),hashtext($1)) AS acquired",[projectId])).rows[0]?.acquired);
  if(!locked){await db.query('ROLLBACK');transaction=false;logEvent('export.lock_busy',{level:'error',component:'reporting',operation:'export',project_id:projectId,reason_code:'project_export_or_reset_running',http_status:409});throw new HTTPException(409,{message:'项目导出或重置正在执行，请稍后重试'});}
  // 同一事务持锁期间，旧 running 记录已无执行者；不使用耗时阈值猜测。
  await db.query("UPDATE ai_distill.project_exports SET status='failed',error='导出执行已中断，请重新导出',finished_at=now() WHERE project_id=$1 AND status='running'",[projectId]);
  let result:T;
  try{result=await run(db);}
  catch(error){
   // 导出路由会先将失败记录写为终态；提交该记录后再把原始错误返回客户端。
   try{await db.query('COMMIT');transaction=false;}
   catch(commitError){destroy=true;logEvent('export.lock_transaction_release_failed',{level:'error',component:'reporting',project_id:projectId,reason_code:'commit_after_export_failure_failed',...classifyLogError(commitError)});}
   throw error;
  }
  try{await db.query('COMMIT');transaction=false;}
  catch(error){destroy=true;logEvent('export.lock_transaction_release_failed',{level:'error',component:'reporting',project_id:projectId,reason_code:'commit_after_export_success_failed',...classifyLogError(error)});throw error;}
  return result;
 }finally{
  if(transaction){try{await db.query('ROLLBACK');transaction=false;}catch(error){destroy=true;logEvent('export.lock_transaction_release_failed',{level:'error',component:'reporting',project_id:projectId,reason_code:'rollback_failed',...classifyLogError(error)});}}
  db.release(destroy);
 }
}
