/**
 * 职责：达标题目归档事务：重新验证当前有效评分与达标版本，调用项目独有准备/交付入口，执行项目交付脚本并记录归档状态。
 * 关键方法与用途：`publishWorkflow()` 分段事务复核当前版本并执行项目交付；`readSiriserArchive()` 校验并下载五件套，`withdrawPublication()` 保留事件并撤回当前归档。
 * 使用场景：由 HTTP 工作流入口调用；同摘要重用归档记录，但仍执行项目交付脚本。
 */
import {readWorkflowModelSet} from '../answer-models/workflow-models';
import type {Pool} from 'pg';
import {cachedExternalCall} from '../execution-queue/runtime';
import {canonicalJson} from '../../shared/workflow-config';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {questionResultDirectory} from '../materials/redacted-docx-export';
import {acceptanceSourceDigest,readAcceptanceSnapshot,buildAcceptanceInput,buildConfiguredAcceptanceConfig} from '../decisions/jobs';
import {decideAcceptance} from '../decisions/acceptance';
import {answerModelSetDigest} from '../answer-models/model-set';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import {projectStepPolicies,resolveStepProjectKey} from '../lifecycle/steps';
import {executeProjectDelivery} from '../lifecycle/project-delivery';
import {resolveProjectDelivery,runProjectDelivery,type DeliveryInput,type ProjectArchiveModule} from './project-delivery';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const publicationConflict=(reason_code:string,message:string)=>Object.assign(new HTTPException(409,{message}),{reason_code});
function archiveProvenance(projectId:string,workflowId:string,frozen:any,projectName?:string,workflowTitle?:string){
 const origin=frozen?.material_origin??{kind:'legacy',redaction_attempt_id:String(frozen?.redaction_attempt_id??'')};
 const materials=Array.isArray(frozen?.materials)?frozen.materials.map((item:any)=>({artifact_id:String(item.id),sha256:String(item.sha256)})):[];
 return{project_id:projectId,project_name:projectName??null,workflow_id:workflowId,workflow_title:workflowTitle??null,material_origin:origin,materials};
}
async function readArchiveProvenance(db:any,projectId:string,workflowId:string,frozen:any,projectName?:string,workflowTitle?:string){
 const provenance=archiveProvenance(projectId,workflowId,frozen,projectName,workflowTitle);
 if(provenance.material_origin.kind==='library_v1'){
  const row=(await db.query('SELECT s.snapshot_manifest,p.name AS package_name FROM ai_distill.question_library_sources s JOIN ai_distill.library_packages p ON p.id=s.package_id WHERE s.workflow_id=$1',[workflowId])).rows[0];
  const source_files=Array.isArray(row?.snapshot_manifest?.files)?row.snapshot_manifest.files.map((file:any)=>({file_id:String(file.library_file_id),material_id:String(file.material_id),original_name:String(file.original_name),sha256:String(file.source_sha256)})):[];
  return{...provenance,standard_material_package_name:row?.package_name??null,source_files};
 }
 return provenance;
}
async function insertPublicationEvent(db:any,workflowId:string,projectId:string,attemptId:string,eventType:'archived'|'withdrawn',provenance:unknown){
 await db.query('INSERT INTO ai_distill.workflow_publication_events(id,workflow_id,project_id,attempt_id,event_type,provenance) VALUES($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),workflowId,projectId,attemptId,eventType,JSON.stringify(provenance)]);
}

/** 下载当前达标归档的五件套；校验版本和ZIP摘要，不暴露内部私有快照。 */
export async function readSiriserArchive(pool:Pool,workflowId:string,assetRoot:string){
 const db=await pool.connect();
 try{
 const row=(await db.query(`SELECT w.project_id,w.title,w.source_key,p.name AS project_name,p.parent_name,p.phase_name,s.result
 FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL
 JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=8 AND s.status='succeeded'
 WHERE w.id=$1 AND w.deleted_at IS NULL`,[workflowId])).rows[0];
 if(!row||!projectStepPolicies.archiveDownload.execute(resolveStepProjectKey({parent_name:row.parent_name}),{parent_name:row.parent_name}))throw new HTTPException(404,{message:'该题尚无Work五件套归档'});
 const models=await readWorkflowModelSet(db,row.project_id,workflowId);
 const policy=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[row.project_id])).rows[0]?.config;
 const snapshot=await readAcceptanceSnapshot(db,workflowId,buildConfiguredAcceptanceConfig(models,policy),answerModelSetDigest(models));
 const digest=acceptanceSourceDigest(snapshot);
 if(row.result?.source_digest!==digest||decideAcceptance(buildAcceptanceInput(snapshot)).decision!=='accepted')throw new HTTPException(409,{message:'归档已不对应当前达标版本，请重新归档'});
 // 展示期名可变，已归档成果仍由保存的输出路径定位，不能因首批筹备→第一期而搬动或重建。
 const archivedWorkbook=row.result?.archive_workbook?.archive_path;
 const archivedOutput=row.result?.delivery?.output_path;
 let directory:string;
 if(typeof archivedOutput==='string'||typeof archivedWorkbook==='string'){
  const indexed=typeof archivedOutput==='string'?archivedOutput:archivedWorkbook;
  const parts=indexed.split('/');
  if(isAbsolute(indexed)||parts.some((part:string)=>!part||part==='.'||part==='..'||part.includes('\\'))||parts[0]!=='附件库'||(typeof archivedOutput!=='string'&&parts.at(-1)!=='题目归档数据.xlsx'))throw new HTTPException(409,{message:'归档目录索引无效'});
  directory=typeof archivedOutput==='string'?resolve(assetRoot,indexed):dirname(resolve(assetRoot,indexed));
  const root=await realpath(assetRoot),actual=await realpath(directory).catch(()=>null);
  if(!actual||!actual.startsWith(`${root}/`))throw new HTTPException(409,{message:'归档目录缺失或越界'});
 }else directory=await questionResultDirectory(assetRoot,row.parent_name,row.phase_name??'',row.phase_name?(row.source_key||row.title):row.title);
 try{
  const state=JSON.parse(await readFile(join(directory,'Siriser五件套.json'),'utf8'));
  if(state.workflow_id!==workflowId||state.source_digest!==digest||state.delivery_digest!==row.result?.delivery?.digest||state.question_version!==row.result.question_version||state.rubric_version!==row.result.rubric_version||typeof state.zip_relative_path!=='string'||state.zip_relative_path.split('/').some((part:string)=>!part||part==='.'||part==='..')||!state.zip_relative_path.startsWith('Siriser五件套/'))throw new Error('invalid package binding');
  const base=await realpath(directory),path=await realpath(resolve(directory,state.zip_relative_path));
  if(!path.startsWith(`${base}/`))throw new Error('unsafe package path');
  const info=await stat(path);if(!info.isFile()||info.size>200*1024*1024)throw new Error('invalid package file');
  const bytes=await readFile(path);if(hash(bytes)!==state.zip_sha256||bytes.length!==state.zip_bytes)throw new Error('changed package');
  return{bytes,filename:String(state.filename)};
 }catch{throw new HTTPException(409,{message:'五件套文件缺失、版本或指纹不一致，请重新执行项目交付'});}
 }finally{db.release();}
}
/**
 * 归档前核对当前版本的有效评分、达标及答案绑定；项目独有的材料和成果要求交给项目准备/交付入口。
 * 相同达标摘要和脚本摘要复用已归档标记；每次点击仍执行项目交付入口。
 */
export interface PublicationBinding {project_id:string;title:string;parent_name:string|null;phase_name:string|null;source_key:string|null;acceptance_attempt_id:string;source_digest:string;delivery_digest:string}
export interface PublicationDependencies {
 expectedLegacyAgentConfig?:{model:string;reasoning_effort:string};
 exportsRoot?:string;
 attemptId?:string;
 expected?:PublicationBinding;
 signal?:AbortSignal;
 prepareArtifacts?:(binding:PublicationBinding)=>Promise<Record<string,unknown>>;
 deliver?:typeof runProjectDelivery;
 resolveDelivery?:typeof resolveProjectDelivery;
 prepare?:NonNullable<ProjectArchiveModule['prepare']>;
}
export async function publishWorkflow(pool:Pool,workflowId:string,root:string,deliveryIdentity?:{task_id:string;org:string},dependencies:PublicationDependencies={}){
 let db=await pool.connect();let connectionHeld=true;let attemptId:string|undefined;let restoreLogContext=()=>{},inTransaction=false;let failurePhase='snapshot';
 const resolveDelivery=dependencies.resolveDelivery??resolveProjectDelivery;
 try{
  await db.query('BEGIN');inTransaction=true;
  const workflow=(await db.query("SELECT w.project_id,w.title,w.source_key,p.name AS project_name,p.parent_name,p.phase_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
  dependencies.signal?.throwIfAborted();
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  restoreLogContext=enterLogContext({component:'publishing',operation:'publish',workflow_id:workflowId,project_id:workflow.project_id,ordinal:8});
  logEvent('publication.started',{level:'info'});
  const steps=await db.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal BETWEEN 4 AND 7',[workflowId]);
  if(steps.rows.length!==4||steps.rows.some(row=>row.status!=='succeeded'))throw publicationConflict('publication_steps_incomplete','当前出题、作答、评分及达标尚未全部成功');
  const modelSet=await readWorkflowModelSet(db,workflow.project_id,workflowId);
  if(!modelSet.length)throw publicationConflict('publication_model_set_missing','项目尚未配置作答模型');
  const acceptancePolicy=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
  const config=buildConfiguredAcceptanceConfig(modelSet,acceptancePolicy);
  const accepted=(await db.query("SELECT id,status,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=7 ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0];
  if(accepted?.status!=='succeeded'||accepted.result?.decision!=='accepted')throw publicationConflict('publication_acceptance_missing','当前版本尚未达标');
  const snapshot=await readAcceptanceSnapshot(db,workflowId,config,answerModelSetDigest(modelSet));
  const digest=acceptanceSourceDigest(snapshot),q=snapshot.question?.result;
  if(accepted.input?.source_digest!==digest||decideAcceptance(buildAcceptanceInput(snapshot)).decision!=='accepted')throw publicationConflict('publication_acceptance_snapshot_changed','达标依据已变化，请重新执行第七步');
  if(!q||!q.question?.trim()||!q.question_version||!q.rubric_version||!Array.isArray(q.rubric)||!q.rubric.length)throw publicationConflict('publication_question_incomplete','题目包不完整');
  for(const model of config.required_models){
   const answer=snapshot.answers.find(item=>item.model===model)!;
   const score=snapshot.scores.find(item=>item.answer_attempt_id===answer.id)!;
   const binding=score.result?.binding;
   const modelReport=q.scoring_policy?.contract==='model_report_v1';
   if(typeof answer.result?.text!=='string'||hash(answer.result.text)!==answer.result.answer_sha256||binding?.answer_sha256!==answer.result.answer_sha256||binding?.answer_attempt_id!==answer.id||binding?.question_version!==q.question_version||binding?.rubric_version!==q.rubric_version||binding?.input_digest!==answer.result.input_digest||score.status!=='succeeded'||(!modelReport&&score.result?.validation?.valid!==true)||!score.id)throw publicationConflict('publication_answer_score_binding_mismatch','答案或评分版本指纹不一致');
  }
  const frozen=snapshot.question!.input;
  const delivery=await resolveDelivery(workflow.parent_name);
  const deliveryDir=delivery.mode==='noop'?root:await questionResultDirectory(dependencies.exportsRoot??fileURLToPath(new URL('../../assets/out/',import.meta.url)),workflow.parent_name||workflow.project_name,workflow.phase_name??'',workflow.phase_name?(workflow.source_key||workflow.title):workflow.title);
  const binding:PublicationBinding={project_id:workflow.project_id,title:workflow.title,parent_name:workflow.parent_name??null,phase_name:workflow.phase_name??null,source_key:workflow.source_key??null,acceptance_attempt_id:accepted.id,source_digest:digest,delivery_digest:delivery.digest};
  if(dependencies.expected&&canonicalJson(binding)!==canonicalJson(dependencies.expected))throw new HTTPException(409,{message:'交付排队后来源、项目身份或脚本已变化，请核对后重新派发'});
  const deliveryIdentityDigest=hash(JSON.stringify(deliveryIdentity??null));
  const deliveryInput:DeliveryInput={version:1,project_id:workflow.project_id,workflow_id:workflowId,title:workflow.title,source_digest:digest,delivery_digest:delivery.digest,question_version:q.question_version,rubric_version:q.rubric_version,question:{...projectStepPolicies.publicationFields.execute(resolveStepProjectKey({content_contract:q.content_contract}),q),task_name:q.task_name,task_type:q.task_type,header:q.header,question:q.question,attachment_ids:q.attachment_ids,rubric:q.rubric,answer_approach:q.answer_approach,reference_answer:q.reference_answer,...(q.scoring_policy?{scoring_policy:q.scoring_policy}:{}),...(deliveryIdentity?{delivery_identity:deliveryIdentity}:{})},acceptance:accepted.result,attachments:[]};
  await db.query('COMMIT');inTransaction=false;
  db.release();connectionHeld=false;
  failurePhase='delivery';
  await executeProjectDelivery(workflow.parent_name, {
   delivery, input:deliveryInput, outputDir:deliveryDir,
   archive:{pool,workflowId,storageRoot:root,frozen,expectedLegacyAgentConfig:dependencies.expectedLegacyAgentConfig,signal:dependencies.signal},
   prepare:dependencies.prepare, deliver:dependencies.deliver,
   checkpoint:run=>cachedExternalCall(`publication_delivery:${digest}:${delivery.digest}:${deliveryIdentityDigest}`,run),
  });
  let supplemental:Record<string,unknown>={};
  // Office成果是公共能力，不以项目是否配置专用交付脚本为条件。
  if(dependencies.prepareArtifacts){
   try{supplemental=await dependencies.prepareArtifacts(binding);}
   catch(error){
    dependencies.signal?.throwIfAborted();
    logEvent('publication.supplemental_export_failed',{level:'warn',...classifyLogError(error)});
    supplemental={supplemental_exports:{status:'failed',...(error instanceof HTTPException?{error:error.message,http_status:error.status}:{})}};
   }
  }
  dependencies.signal?.throwIfAborted();
  if((await resolveDelivery(workflow.parent_name)).digest!==delivery.digest)throw new HTTPException(409,{message:'项目交付脚本已变化，请重新归档'});
  failurePhase='commit';
   db=await pool.connect();connectionHeld=true;
   await db.query('BEGIN');inTransaction=true;
   const currentWorkflow=(await db.query("SELECT w.project_id,w.title,w.source_key,p.name AS project_name,p.parent_name,p.phase_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
   const currentModelSet=await readWorkflowModelSet(db,workflow.project_id,workflowId);
   const currentAcceptancePolicy=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
   const currentAccepted=(await db.query("SELECT id,status,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=7 ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0];
   const currentSnapshot=await readAcceptanceSnapshot(db,workflowId,buildConfiguredAcceptanceConfig(currentModelSet,currentAcceptancePolicy),answerModelSetDigest(currentModelSet));
   if(!currentWorkflow||currentWorkflow.title!==workflow.title||currentWorkflow.project_id!==workflow.project_id||currentWorkflow.parent_name!==workflow.parent_name||currentWorkflow.phase_name!==workflow.phase_name||currentWorkflow.source_key!==workflow.source_key||currentAccepted?.id!==accepted.id||currentAccepted.status!=='succeeded'||currentAccepted.result?.decision!=='accepted'||answerModelSetDigest(currentModelSet)!==answerModelSetDigest(modelSet)||acceptanceSourceDigest(currentSnapshot)!==digest||currentAccepted.input?.source_digest!==digest||decideAcceptance(buildAcceptanceInput(currentSnapshot)).decision!=='accepted')throw new HTTPException(409,{message:'生成期间题目、模型或达标依据发生变化，请重新归档'});
  const previous=(await db.query("SELECT id,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded' AND input->>'source_digest'=$2 AND input->>'acceptance_attempt_id'=$3 AND input->>'delivery_digest'=$4 AND input->>'delivery_identity_digest'=$5 ORDER BY attempt DESC LIMIT 1",[workflowId,digest,accepted.id,delivery.digest,deliveryIdentityDigest])).rows[0];
  if(previous&&!dependencies.attemptId){
   if((await resolveDelivery(workflow.parent_name)).digest!==delivery.digest)throw new HTTPException(409,{message:'项目交付脚本已变化，请重新归档'});
   const latestEvent=(await db.query('SELECT event_type FROM ai_distill.workflow_publication_events WHERE workflow_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[workflowId])).rows[0];
   if(latestEvent?.event_type!=='archived'){
    const provenance=await readArchiveProvenance(db,workflow.project_id,workflowId,frozen,workflow.project_name,workflow.title);
    await insertPublicationEvent(db,workflowId,workflow.project_id,previous.id,'archived',provenance);
    await db.query("UPDATE ai_distill.steps SET implemented=true,status='succeeded',result=$2,error=NULL,started_at=COALESCE(started_at,now()),finished_at=now() WHERE workflow_id=$1 AND ordinal=8",[workflowId,JSON.stringify(previous.result)]);
    await db.query("UPDATE ai_distill.workflows SET status='succeeded' WHERE id=$1",[workflowId]);
   }
   await db.query('COMMIT');inTransaction=false;withLogContext({attempt_id:previous.id},()=>logEvent('publication.reused',{level:'info',state:'succeeded'}));return {id:previous.id,reused:true,completed:true};
  }
  if((await resolveDelivery(workflow.parent_name)).digest!==delivery.digest)throw new HTTPException(409,{message:'项目交付脚本已变化，请重新归档'});
  attemptId=dependencies.attemptId??crypto.randomUUID();
  const provenance=await readArchiveProvenance(db,workflow.project_id,workflowId,frozen,workflow.project_name,workflow.title);
  const result={source_digest:digest,acceptance_attempt_id:accepted.id,question_version:q.question_version,rubric_version:q.rubric_version,delivery:{mode:delivery.mode,digest:delivery.digest,status:'succeeded',...(delivery.mode==='script'?{output_path:relative(dependencies.exportsRoot??fileURLToPath(new URL('../../assets/out/',import.meta.url)),deliveryDir).split(sep).join('/')}:{})},material_provenance:provenance,...supplemental,archived_at:new Date().toISOString()};
  if(dependencies.attemptId){
   const saved=await db.query("UPDATE ai_distill.step_attempts SET status='succeeded',result=$2,error=NULL,finished_at=now() WHERE id=$1 AND workflow_id=$3 AND ordinal=8 AND status='running' AND id=(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$3 AND ordinal=8 ORDER BY attempt DESC LIMIT 1) RETURNING id",[attemptId,JSON.stringify(result),workflowId]);
   if(saved.rowCount!==1)throw new HTTPException(409,{message:'交付任务已取消或被新版本替代，结果未发布'});
  }else{
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,finished_at) SELECT $2,$1::uuid,8,COALESCE(max(attempt),0)+1,'succeeded',$3,$4,now() FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=8",[workflowId,attemptId,JSON.stringify({source_digest:digest,acceptance_attempt_id:accepted.id,delivery_digest:delivery.digest,delivery_identity_digest:deliveryIdentityDigest,material_provenance:provenance}),JSON.stringify(result)]);
  }
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='succeeded',result=$2,error=NULL,started_at=now(),finished_at=now() WHERE workflow_id=$1 AND ordinal=8",[workflowId,JSON.stringify(result)]);
  await insertPublicationEvent(db,workflowId,workflow.project_id,attemptId,'archived',provenance);
  await db.query("UPDATE ai_distill.workflows SET status='succeeded' WHERE id=$1",[workflowId]);
  dependencies.signal?.throwIfAborted();
  await db.query('COMMIT');inTransaction=false;withLogContext({attempt_id:attemptId},()=>logEvent('publication.completed',{level:'info',state:'succeeded'}));return {id:attemptId,reused:false,completed:true};
 }catch(error){
  const reasonCode=(error as {reason_code?:unknown})?.reason_code??(error instanceof HTTPException&&error.status===409?`publication_${failurePhase}_conflict_unclassified`:undefined);
  logEvent('publication.failed',{level:'error',state:'failed',failure_phase:failurePhase,...(error instanceof HTTPException?{http_status:error.status}:{}),...(typeof reasonCode==='string'?{reason_code:reasonCode}:{}),...classifyLogError(error)});
  if(inTransaction)try{await db.query('ROLLBACK');}catch(rollbackError){logEvent('transaction.rollback_failed',{level:'error',transaction_name:'rollback:publishing',...classifyLogError(rollbackError)});console.error('成果发布事务回滚失败，等待核对');}
  throw error;
 }finally{restoreLogContext();if(connectionHeld)db.release();}
}

/** 撤回当前归档状态并保留归档尝试、审计事件及交付文件，后续可重新归档。 */
export async function withdrawPublication(pool:Pool,workflowId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query("SELECT w.project_id,s.status FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=8 WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w,s",[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  if(workflow.status!=='succeeded')throw new HTTPException(409,{message:'当前题目没有可撤回的归档'});
  const attempt=(await db.query("SELECT id,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded' ORDER BY attempt DESC LIMIT 1 FOR UPDATE",[workflowId])).rows[0];
  if(!attempt)throw new HTTPException(409,{message:'归档历史不完整，不能撤回'});
  const provenance=attempt.input?.material_provenance??attempt.result?.material_provenance??{project_id:workflow.project_id,workflow_id:workflowId,material_origin:{kind:'legacy'},materials:[]};
  await insertPublicationEvent(db,workflowId,workflow.project_id,attempt.id,'withdrawn',provenance);
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=8",[workflowId]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[workflowId]);
  await db.query('COMMIT');return{withdrawn:true,attempt_id:attempt.id};
 }catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'撤回归档失败且事务状态不确定');}throw error;}finally{db.release();}
}

/** 读取归档与撤回审计事件；材料来源按归档快照返回，不回查材料库当前选择。 */
export async function readPublicationHistory(pool:Pool,workflowId:string){
 const result=await pool.query(`SELECT e.id,e.project_id,e.workflow_id,e.attempt_id,e.event_type,e.provenance,e.created_at,p.name AS project_name,w.title AS workflow_title,(w.id IS NOT NULL) AS workflow_exists
  FROM ai_distill.workflow_publication_events e JOIN ai_distill.projects p ON p.id=e.project_id
  LEFT JOIN ai_distill.workflows w ON w.id=e.workflow_id WHERE e.workflow_id=$1 ORDER BY e.created_at,e.id`,[workflowId]);
 return result.rows;
}
