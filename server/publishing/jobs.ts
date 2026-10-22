/**
 * 职责：达标题目归档事务：重新验证当前达标依据与产物指纹，执行项目交付脚本并记录归档状态。
 * 关键方法与用途：`publishWorkflow()` 分段事务复核当前版本并执行项目交付；`readSiriserArchive()` 校验并下载五件套，`withdrawPublication()` 保留事件并撤回当前归档。
 * 使用场景：由 HTTP 工作流入口调用；同摘要重用归档记录，但仍执行项目交付脚本。
 */
import type {Pool} from 'pg';
import {canonicalJson} from '../../shared/workflow-config';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {questionResultDirectory,readCurrentRedactionForDocx,readOriginalFilesForDelivery} from '../materials/redacted-docx-export';
import {acceptanceSourceDigest,readAcceptanceSnapshot,buildAcceptanceInput,buildConfiguredAcceptanceConfig} from '../decisions/jobs';
import {decideAcceptance} from '../decisions/acceptance';
import {answerModelSetDigest,readProjectModelSet} from '../answer-models/model-set';
import {verifyFrozenProjectPrompt} from '../rule-files';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import {resolveProjectDelivery,runProjectDelivery,type DeliveryInput} from './project-delivery';
import {getOrGenerateWorkSimulation} from './work-simulation';
import {getAgentConcurrencyGate,readConcurrencySettings} from '../concurrency';
import {readQuestionMaterials} from '../question-materials';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
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
 if(!row||row.parent_name!=='Work法律全场景')throw new HTTPException(404,{message:'该题尚无Work五件套归档'});
 const models=await readProjectModelSet(db,row.project_id);
 const policy=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[row.project_id])).rows[0]?.config;
 const snapshot=await readAcceptanceSnapshot(db,workflowId,buildConfiguredAcceptanceConfig(models,policy),answerModelSetDigest(models));
 const digest=acceptanceSourceDigest(snapshot);
 if(row.result?.source_digest!==digest||decideAcceptance(buildAcceptanceInput(snapshot)).decision!=='accepted')throw new HTTPException(409,{message:'归档已不对应当前达标版本，请重新归档'});
 await verifyFrozenProjectPrompt(snapshot.question?.input?.project_prompt);
 // 展示期名可变，已归档成果仍由保存的输出路径定位，不能因首批筹备→第一期而搬动或重建。
 const archivedWorkbook=row.result?.archive_workbook?.archive_path;
 let directory:string;
 if(typeof archivedWorkbook==='string'){
  const parts=archivedWorkbook.split('/');
  if(isAbsolute(archivedWorkbook)||parts.some(part=>!part||part==='.'||part==='..'||part.includes('\\'))||parts[0]!=='附件库'||parts.at(-1)!=='题目归档数据.xlsx')throw new HTTPException(409,{message:'归档目录索引无效'});
  directory=dirname(resolve(assetRoot,archivedWorkbook));
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
interface Artifact {id:string;attempt_id:string|null;kind:string;storage_path:string;sha256:string;content?:string|null}
async function verifyArtifact(root:string,artifact:Artifact){
 if(typeof artifact.content==='string'){if(hash(artifact.content)!==artifact.sha256)throw new HTTPException(409,{message:'成果内容指纹变化，不能归档'});return;}
 if(!artifact||isAbsolute(artifact.storage_path))throw new HTTPException(409,{message:'成果文件索引无效'});
 try{
  const base=await realpath(resolve(root)),path=await realpath(join(base,artifact.storage_path));
  if(!path.startsWith(`${base}/`))throw new Error('unsafe artifact');
  const info=await stat(path);if(!info.isFile()||info.size>30*1024*1024)throw new Error('invalid artifact');
  const bytes=await readFile(path);if(hash(bytes)!==artifact.sha256)throw new Error('changed artifact');
 }catch{throw new HTTPException(409,{message:'成果文件缺失、越界或指纹变化，不能归档'});}
}
async function readVerifiedTextArtifact(root:string,artifact:Artifact){
 let bytes:Uint8Array;
 if(typeof artifact.content==='string')bytes=Buffer.from(artifact.content,'utf8');
 else{
  if(!artifact||isAbsolute(artifact.storage_path))throw new HTTPException(409,{message:'材料文件索引无效'});
  try{const base=await realpath(resolve(root)),path=await realpath(join(base,artifact.storage_path));if(!path.startsWith(`${base}/`))throw new Error('unsafe artifact');bytes=await readFile(path);}
  catch{throw new HTTPException(409,{message:'材料正文无法读取'});}
 }
 if(hash(bytes)!==artifact.sha256)throw new HTTPException(409,{message:'材料内容指纹变化'});
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.trim())throw new Error('empty');return text;}
 catch{throw new HTTPException(409,{message:'材料不是有效的 UTF-8 文本'});}
}

/**
 * 归档前重新验证当前版本已通过出题、作答、评分和达标，并逐一核对产物指纹及附件绑定。
 * 相同达标摘要和脚本摘要复用已归档标记；每次点击仍执行项目交付入口。
 */
interface PublicationDependencies {
 resolveDelivery?:typeof resolveProjectDelivery;
 prepareWork?:typeof getOrGenerateWorkSimulation;
 readStructuredMaterials?:(db:import('pg').PoolClient,id:string)=>Promise<Awaited<ReturnType<typeof readCurrentRedactionForDocx>>|undefined>;
}
export async function publishWorkflow(pool:Pool,workflowId:string,root:string,deliveryIdentity?:{task_id:string;org:string},dependencies:PublicationDependencies={}){
 let db=await pool.connect();let connectionHeld=true;let attemptId:string|undefined;let restoreLogContext=()=>{},inTransaction=false;
 const resolveDelivery=dependencies.resolveDelivery??resolveProjectDelivery;
 const prepareWork=dependencies.prepareWork??getOrGenerateWorkSimulation;
 const readStructuredMaterials=dependencies.readStructuredMaterials??readCurrentRedactionForDocx;
 try{
  await db.query('BEGIN');inTransaction=true;
  const workflow=(await db.query("SELECT w.project_id,w.title,w.source_key,p.name AS project_name,p.parent_name,p.phase_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  if(deliveryIdentity&&(!/^LAW-\d{3,}$/.test(deliveryIdentity.task_id)||!/^[a-z0-9][a-z0-9-]{1,31}$/.test(deliveryIdentity.org)))throw new HTTPException(400,{message:'可选Harbor身份格式无效；生成Siriser五件套无需填写此项'});
  restoreLogContext=enterLogContext({component:'publishing',operation:'publish',workflow_id:workflowId,project_id:workflow.project_id,ordinal:8});
  logEvent('publication.started',{level:'info'});
  const steps=await db.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal BETWEEN 4 AND 7',[workflowId]);
  if(steps.rows.length!==4||steps.rows.some(row=>row.status!=='succeeded'))throw new HTTPException(409,{message:'当前出题、作答、评分及达标尚未全部成功'});
  const modelSet=await readProjectModelSet(db,workflow.project_id);
  if(!modelSet.length)throw new HTTPException(409,{message:'项目尚未配置作答模型'});
  const acceptancePolicy=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
  const config=buildConfiguredAcceptanceConfig(modelSet,acceptancePolicy);
  const accepted=(await db.query("SELECT id,status,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=7 ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0];
  if(accepted?.status!=='succeeded'||accepted.result?.decision!=='accepted')throw new HTTPException(409,{message:'当前版本尚未达标'});
  const snapshot=await readAcceptanceSnapshot(db,workflowId,config,answerModelSetDigest(modelSet));
  const digest=acceptanceSourceDigest(snapshot),q=snapshot.question?.result;
  await verifyFrozenProjectPrompt(snapshot.question?.input?.project_prompt);
  if(accepted.input?.source_digest!==digest||decideAcceptance(buildAcceptanceInput(snapshot)).decision!=='accepted')throw new HTTPException(409,{message:'达标依据已变化，请重新执行第七步'});
  if(!q||!q.question?.trim()||!q.question_version||!q.rubric_version||!Array.isArray(q.rubric)||!q.rubric.length)throw new HTTPException(409,{message:'题目包不完整'});
  const models=config.required_models.map(model=>{
   const answer=snapshot.answers.find(item=>item.model===model)!;
   const score=snapshot.scores.find(item=>item.answer_attempt_id===answer.id)!;
   const binding=score.result?.binding;
   if(typeof answer.result?.text!=='string'||hash(answer.result.text)!==answer.result.answer_sha256||binding?.answer_sha256!==answer.result.answer_sha256||binding?.answer_attempt_id!==answer.id||binding?.question_version!==q.question_version||binding?.rubric_version!==q.rubric_version||binding?.input_digest!==answer.result.input_digest||!score.id)throw new HTTPException(409,{message:'答案或评分版本指纹不一致'});
   return {model,answer_attempt_id:answer.id,answer_sha256:answer.result.answer_sha256,score_attempt_id:score.id};
  });
  const attemptIds=[snapshot.question!.id,...models.flatMap(item=>[item.answer_attempt_id,item.score_attempt_id])];
  const artifacts=(await db.query("SELECT id,attempt_id,kind,storage_path,sha256,content FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=ANY($2::uuid[]) AND kind IN ('authored_question','model_answer','score_report')",[workflowId,attemptIds])).rows as Artifact[];
  const required=[{attempt_id:snapshot.question!.id,kind:'authored_question'},...models.flatMap(item=>[{attempt_id:item.answer_attempt_id,kind:'model_answer'},{attempt_id:item.score_attempt_id,kind:'score_report'}])];
  for(const item of required){const matching=artifacts.filter(file=>file.attempt_id===item.attempt_id&&file.kind===item.kind);if(matching.length!==1)throw new HTTPException(409,{message:'当前题目、答案或评分缺少唯一产物'});await verifyArtifact(root,matching[0]!);}
  const frozen=snapshot.question!.input;
  if(!Array.isArray(q.attachment_ids)||!q.attachment_ids.length||!Array.isArray(frozen?.materials))throw new HTTPException(409,{message:'出题附件快照不完整'});
  let attachments:Artifact[];
  if(frozen.material_origin?.kind==='library_v1'){
   const source=await readQuestionMaterials(db,workflowId);
   if(canonicalJson(source.origin)!==canonicalJson(frozen.material_origin)||JSON.stringify(q.attachment_ids)!==JSON.stringify(source.attachments.map(item=>item.id)))throw new HTTPException(409,{message:'材料库冻结附件与题目版本不一致'});
   attachments=source.attachments.map(item=>({id:item.id,attempt_id:null,kind:source.origin.kind==='library_v1'&&source.origin.material_mode==='original'?'source_markdown':'redacted_markdown',storage_path:'',sha256:item.sha256,content:item.content}));
  }else{
   attachments=(await db.query("SELECT ar.id,ar.attempt_id,ar.kind,ar.storage_path,ar.sha256,ar.content FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id JOIN ai_distill.steps s ON s.workflow_id=ar.workflow_id AND s.ordinal=9 WHERE ar.workflow_id=$1 AND ar.id=ANY($2::uuid[]) AND ar.kind='redacted_markdown' AND a.ordinal=9 AND a.status='succeeded' AND s.status='succeeded'",[workflowId,q.attachment_ids])).rows as Artifact[];
  }
  for(const id of q.attachment_ids){const matching=attachments.filter(file=>file.id===id);if(matching.length!==1||!frozen.materials.some((item:any)=>item.id===id&&item.sha256===matching[0]!.sha256)||(frozen.material_origin?.kind!=='library_v1'&&matching[0]!.attempt_id!==frozen.redaction_attempt_id))throw new HTTPException(409,{message:'当前附件与出题快照不一致'});await verifyArtifact(root,matching[0]!);}
  const delivery=await resolveDelivery(workflow.parent_name);
  const deliveryDir=delivery.mode==='noop'?root:await questionResultDirectory(fileURLToPath(new URL('../../assets/out/',import.meta.url)),workflow.parent_name||workflow.project_name,workflow.phase_name??'',workflow.phase_name?(workflow.source_key||workflow.title):workflow.title);
  const structuredRedaction=workflow.parent_name==='Work法律全场景'?await readStructuredMaterials(db,workflowId):undefined;
  const deliveryAttachments=await Promise.all(q.attachment_ids.map(async(id:string,index:number)=>{
   const artifact=attachments.find(file=>file.id===id);
   if(!artifact)throw new HTTPException(409,{message:'归档冻结材料缺失'});
   const materialMode=frozen.material_origin?.kind==='library_v1'?frozen.material_origin.material_mode:'redacted';
   const documents=structuredRedaction&&structuredRedaction.redacted_sha256===artifact.sha256?[...structuredRedaction.materialDocuments.values()].map(item=>item.document):undefined;
   const prepared_documents=structuredRedaction&&'prepared_documents' in structuredRedaction?structuredRedaction.prepared_documents:undefined;
   let original_files:DeliveryInput['attachments'][number]['original_files'];
   if(materialMode==='original'){
    if(q.attachment_ids.length!==1)throw new HTTPException(409,{message:'原文归档的多附件映射不明确，不能生成五件套'});
    const snapshot=(await db.query('SELECT snapshot_manifest FROM ai_distill.question_library_sources WHERE workflow_id=$1',[workflowId])).rows[0]?.snapshot_manifest;
    const expected=Array.isArray(snapshot?.files)?snapshot.files.map((file:any)=>({material_id:String(file.material_id),original_name:String(file.original_name),sha256:String(file.source_sha256)})):[];
    const originals=await readOriginalFilesForDelivery(db,workflowId,root,expected);
    original_files=originals.map(file=>({name:file.name,sha256:file.sha256,content_base64:Buffer.from(file.bytes).toString('base64')}));
   }
   return{id:artifact.id,sha256:artifact.sha256,name:`材料-${String(index+1).padStart(3,'0')}.md`,text:await readVerifiedTextArtifact(root,artifact),material_mode:materialMode,...(documents?{documents}:{}),...(prepared_documents?{prepared_documents}:{}),...(original_files?{original_files}:{})};
  }));
  const deliveryIdentityDigest=hash(JSON.stringify(deliveryIdentity??null));
  const deliveryInput:DeliveryInput={version:1,project_id:workflow.project_id,workflow_id:workflowId,title:workflow.title,source_digest:digest,delivery_digest:delivery.digest,question_version:q.question_version,rubric_version:q.rubric_version,question:{...(q.content_contract?{content_contract:q.content_contract,task_metadata:q.task_metadata,input_files:q.input_files,deliverables:q.deliverables,reference_outputs:q.reference_outputs,research_records:q.research_records,task_requirements:q.task_requirements,content_status:q.content_status}:{}),task_name:q.task_name,task_type:q.task_type,header:q.header,question:q.question,attachment_ids:q.attachment_ids,rubric:q.rubric,answer_approach:q.answer_approach,reference_answer:q.reference_answer,...(q.scoring_policy?{scoring_policy:q.scoring_policy}:{}),...(deliveryIdentity?{delivery_identity:deliveryIdentity}:{})},acceptance:accepted.result,attachments:deliveryAttachments};
  if(workflow.parent_name==='Work法律全场景'){
   await db.query('COMMIT');inTransaction=false;
   db.release();connectionHeld=false;
   const generate=()=>prepareWork(pool,{project_id:workflow.project_id,workflow_id:workflowId,title:workflow.title,question_version:q.question_version,rubric_version:q.rubric_version,question:{...(q.content_contract?{content_contract:q.content_contract,task_metadata:q.task_metadata,input_files:q.input_files,deliverables:q.deliverables,reference_outputs:q.reference_outputs,research_records:q.research_records,task_requirements:q.task_requirements,content_status:q.content_status}:{}),task_name:q.task_name,task_type:q.task_type,header:q.header,question:q.question,rubric:q.rubric},attachments:deliveryAttachments.map(({name,text,material_mode})=>({name,text,material_mode}))},root,hash(`${digest}:${delivery.digest}`));
   if(q.content_contract==='work_legal_v1')deliveryInput.simulation=await generate();
   else{
    const gate=getAgentConcurrencyGate(root,readConcurrencySettings(process.env,root).agent);
    const permit=await gate.run(generate);
    if(!permit.acquired)throw new HTTPException(409,{message:'Agent 并发任务未取得执行槽位'});
    deliveryInput.simulation=permit.value;
   }
   db=await pool.connect();connectionHeld=true;
   await db.query('BEGIN');inTransaction=true;
   const currentWorkflow=(await db.query("SELECT w.project_id,w.title,w.source_key,p.name AS project_name,p.parent_name,p.phase_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
   const currentModelSet=await readProjectModelSet(db,workflow.project_id);
   const currentAcceptancePolicy=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
   const currentAccepted=(await db.query("SELECT id,status,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=7 ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0];
   const currentSnapshot=await readAcceptanceSnapshot(db,workflowId,buildConfiguredAcceptanceConfig(currentModelSet,currentAcceptancePolicy),answerModelSetDigest(currentModelSet));
   if(!currentWorkflow||currentWorkflow.title!==workflow.title||currentWorkflow.project_id!==workflow.project_id||currentWorkflow.parent_name!=='Work法律全场景'||currentAccepted?.id!==accepted.id||currentAccepted.status!=='succeeded'||currentAccepted.result?.decision!=='accepted'||answerModelSetDigest(currentModelSet)!==answerModelSetDigest(modelSet)||acceptanceSourceDigest(currentSnapshot)!==digest||currentAccepted.input?.source_digest!==digest||decideAcceptance(buildAcceptanceInput(currentSnapshot)).decision!=='accepted')throw new HTTPException(409,{message:'生成期间题目、模型或达标依据发生变化，请重新归档'});
   await verifyFrozenProjectPrompt(currentSnapshot.question?.input?.project_prompt);
  }
  const previous=(await db.query("SELECT id,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded' AND input->>'source_digest'=$2 AND input->>'acceptance_attempt_id'=$3 AND input->>'delivery_digest'=$4 AND input->>'delivery_identity_digest'=$5 ORDER BY attempt DESC LIMIT 1",[workflowId,digest,accepted.id,delivery.digest,deliveryIdentityDigest])).rows[0];
  if(previous){
   await runProjectDelivery(delivery,deliveryInput,deliveryDir);
   if((await resolveDelivery(workflow.parent_name)).digest!==delivery.digest)throw new HTTPException(409,{message:'项目交付脚本已变化，请重新归档'});
   await verifyFrozenProjectPrompt(snapshot.question?.input?.project_prompt);
   const latestEvent=(await db.query('SELECT event_type FROM ai_distill.workflow_publication_events WHERE workflow_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[workflowId])).rows[0];
   if(latestEvent?.event_type!=='archived'){
    const provenance=await readArchiveProvenance(db,workflow.project_id,workflowId,frozen,workflow.project_name,workflow.title);
    await insertPublicationEvent(db,workflowId,workflow.project_id,previous.id,'archived',provenance);
    await db.query("UPDATE ai_distill.steps SET implemented=true,status='succeeded',result=$2,error=NULL,started_at=COALESCE(started_at,now()),finished_at=now() WHERE workflow_id=$1 AND ordinal=8",[workflowId,JSON.stringify(previous.result)]);
    await db.query("UPDATE ai_distill.workflows SET status='succeeded' WHERE id=$1",[workflowId]);
   }
   await db.query('COMMIT');inTransaction=false;withLogContext({attempt_id:previous.id},()=>logEvent('publication.reused',{level:'info',state:'succeeded'}));return {id:previous.id,reused:true,completed:true};
  }
  await runProjectDelivery(delivery,deliveryInput,deliveryDir);
  await verifyFrozenProjectPrompt(snapshot.question?.input?.project_prompt);
  if((await resolveDelivery(workflow.parent_name)).digest!==delivery.digest)throw new HTTPException(409,{message:'项目交付脚本已变化，请重新归档'});
  attemptId=crypto.randomUUID();
  const provenance=await readArchiveProvenance(db,workflow.project_id,workflowId,frozen,workflow.project_name,workflow.title);
  const result={source_digest:digest,acceptance_attempt_id:accepted.id,question_version:q.question_version,rubric_version:q.rubric_version,delivery:{mode:delivery.mode,digest:delivery.digest,status:'succeeded'},material_provenance:provenance,archived_at:new Date().toISOString()};
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,finished_at) SELECT $2,$1::uuid,8,COALESCE(max(attempt),0)+1,'succeeded',$3,$4,now() FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=8",[workflowId,attemptId,JSON.stringify({source_digest:digest,acceptance_attempt_id:accepted.id,delivery_digest:delivery.digest,delivery_identity_digest:deliveryIdentityDigest,material_provenance:provenance}),JSON.stringify(result)]);
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='succeeded',result=$2,error=NULL,started_at=now(),finished_at=now() WHERE workflow_id=$1 AND ordinal=8",[workflowId,JSON.stringify(result)]);
  await insertPublicationEvent(db,workflowId,workflow.project_id,attemptId,'archived',provenance);
  await db.query("UPDATE ai_distill.workflows SET status='succeeded' WHERE id=$1",[workflowId]);
  await verifyFrozenProjectPrompt(snapshot.question?.input?.project_prompt);
  await db.query('COMMIT');inTransaction=false;withLogContext({attempt_id:attemptId},()=>logEvent('publication.completed',{level:'info',state:'succeeded'}));return {id:attemptId,reused:false,completed:true};
 }catch(error){
  logEvent('publication.failed',{level:'error',state:'failed',...classifyLogError(error)});
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
