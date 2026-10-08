import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,stat,writeFile,rm} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {acceptanceSourceDigest,readAcceptanceSnapshot,buildAcceptanceInput} from '../decisions/jobs';
import {decideAcceptance} from '../decisions/acceptance';
import {validateAcceptanceConfig} from '../decisions/config';
import {validateQuality} from '../authoring/validate';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
interface Artifact {id:string;attempt_id:string;kind:string;storage_path:string;sha256:string;content?:string|null}
async function verifyArtifact(root:string,artifact:Artifact){
 if(typeof artifact.content==='string'){if(hash(artifact.content)!==artifact.sha256)throw new HTTPException(409,{message:'成果内容指纹变化，不能发布'});return;}
 if(!artifact||isAbsolute(artifact.storage_path))throw new HTTPException(409,{message:'成果文件索引无效'});
 try{
  const base=await realpath(resolve(root)),path=await realpath(join(base,artifact.storage_path));
  if(!path.startsWith(`${base}/`))throw new Error('unsafe artifact');
  const info=await stat(path);if(!info.isFile()||info.size>30*1024*1024)throw new Error('invalid artifact');
  const bytes=await readFile(path);if(hash(bytes)!==artifact.sha256)throw new Error('changed artifact');
 }catch{throw new HTTPException(409,{message:'成果文件缺失、越界或指纹变化，不能发布'});}
}

export async function publishWorkflow(pool:Pool,workflowId:string,root:string){
 const db=await pool.connect();let output:string|undefined;let attemptId:string|undefined;
 try{
  await db.query('BEGIN');
  const workflow=(await db.query('SELECT w.input_revision,w.project_id,w.title FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w',[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
  const steps=await db.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal BETWEEN 4 AND 7',[workflowId]);
  if(steps.rows.length!==4||steps.rows.some(row=>row.status!=='succeeded'))throw new HTTPException(409,{message:'当前出题、作答、评分及达标尚未全部成功'});
  const raw=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=7',[workflow.project_id])).rows[0]?.config;
  const config=validateAcceptanceConfig(raw);
  const accepted=(await db.query("SELECT id,status,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=7 AND input_revision=$2 ORDER BY attempt DESC LIMIT 1",[workflowId,workflow.input_revision])).rows[0];
  if(accepted?.status!=='succeeded'||accepted.result?.decision!=='accepted')throw new HTTPException(409,{message:'当前版本尚未达标'});
  const snapshot=await readAcceptanceSnapshot(db,workflowId,workflow.input_revision,config);
  const digest=acceptanceSourceDigest(snapshot),q=snapshot.question?.result;
  if(accepted.input?.source_digest!==digest||decideAcceptance(buildAcceptanceInput(snapshot)).decision!=='accepted')throw new HTTPException(409,{message:'达标依据已变化，请重新执行第七步'});
  if(!q||!validateQuality(q.quality_check).valid||!q.question?.trim()||!q.question_version||!q.rubric_version||!Array.isArray(q.rubric)||!q.rubric.length)throw new HTTPException(409,{message:'题目包或独立质检不完整'});
  const models=config.required_models.map(model=>{
   const answer=snapshot.answers.find(item=>item.model===model)!;
   const score=snapshot.scores.find(item=>item.answer_attempt_id===answer.id)!;
   if(typeof answer.result?.text!=='string'||hash(answer.result.text)!==answer.result.answer_sha256||score.result?.binding?.answer_sha256!==answer.result.answer_sha256||!score.id)throw new HTTPException(409,{message:'答案或评分指纹不一致'});
   return {model,answer_attempt_id:answer.id,answer_sha256:answer.result.answer_sha256,score_attempt_id:score.id};
  });
  const attemptIds=[snapshot.question!.id,...models.flatMap(item=>[item.answer_attempt_id,item.score_attempt_id])];
  const artifacts=(await db.query("SELECT id,attempt_id,kind,storage_path,sha256 FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=ANY($2::uuid[]) AND kind IN ('authored_question','model_answer','score_report')",[workflowId,attemptIds])).rows as Artifact[];
  const required=[{attempt_id:snapshot.question!.id,kind:'authored_question'},...models.flatMap(item=>[{attempt_id:item.answer_attempt_id,kind:'model_answer'},{attempt_id:item.score_attempt_id,kind:'score_report'}])];
  const files:Artifact[]=[];for(const item of required){const matching=artifacts.filter(file=>file.attempt_id===item.attempt_id&&file.kind===item.kind);if(matching.length!==1)throw new HTTPException(409,{message:'当前题目、答案或评分缺少唯一产物'});await verifyArtifact(root,matching[0]!);files.push(matching[0]!);}
  const frozen=snapshot.question!.input;
  if(!Array.isArray(q.attachment_ids)||!q.attachment_ids.length||!Array.isArray(frozen?.materials))throw new HTTPException(409,{message:'出题附件快照不完整'});
  const attachments=(await db.query("SELECT ar.id,ar.attempt_id,ar.kind,ar.storage_path,ar.sha256,ar.content FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id JOIN ai_distill.steps s ON s.workflow_id=ar.workflow_id AND s.ordinal=9 WHERE ar.workflow_id=$1 AND ar.id=ANY($2::uuid[]) AND ar.kind='redacted_markdown' AND a.ordinal=9 AND a.status='succeeded' AND a.input_revision=$3 AND s.status='succeeded'",[workflowId,q.attachment_ids,workflow.input_revision])).rows as Artifact[];
  for(const id of q.attachment_ids){const matching=attachments.filter(file=>file.id===id);if(matching.length!==1||!frozen.materials.some((item:any)=>item.id===id&&item.sha256===matching[0]!.sha256)||matching[0]!.attempt_id!==frozen.redaction_attempt_id)throw new HTTPException(409,{message:'当前脱敏附件与出题快照不一致'});await verifyArtifact(root,matching[0]!);files.push(matching[0]!);}
  const previous=(await db.query("SELECT id,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 AND input_revision=$2 AND status='succeeded' AND input->>'source_digest'=$3 AND input->>'acceptance_attempt_id'=$4 ORDER BY attempt DESC LIMIT 1",[workflowId,workflow.input_revision,digest,accepted.id])).rows[0];
  if(previous){
   const indexed=(await db.query("SELECT id,attempt_id,kind,storage_path,sha256 FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind='published_result'",[workflowId,previous.id])).rows as Artifact[];
   if(indexed.length!==1)throw new HTTPException(409,{message:'已发布成果文件索引缺失'});await verifyArtifact(root,indexed[0]!);
   await db.query('COMMIT');return {id:previous.id,reused:true,completed:true};
  }
  attemptId=crypto.randomUUID();const artifactId=crypto.randomUUID();
  const result={input_revision:workflow.input_revision,question_version:q.question_version,rubric_version:q.rubric_version,source_digest:digest,acceptance_attempt_id:accepted.id,question:q.question,attachment_ids:q.attachment_ids,rubric:q.rubric,quality_check:validateQuality(q.quality_check).report,models,artifacts:files.map(file=>({id:file.id,kind:file.kind,sha256:file.sha256})),published_at:new Date().toISOString()};
  const directory=join(resolve(root),workflowId,attemptId);await mkdir(directory,{recursive:true,mode:0o700});output=join(directory,'published.json');
  const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');await writeFile(output,bytes,{mode:0o600,flag:'wx'});
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,input_revision,finished_at) SELECT $2,$1::uuid,8,COALESCE(max(attempt),0)+1,'succeeded',$3,$4,$5,now() FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=8",[workflowId,attemptId,JSON.stringify({source_digest:digest,acceptance_attempt_id:accepted.id}),JSON.stringify({...result,artifact_id:artifactId}),workflow.input_revision]);
  await db.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[artifactId,workflowId,attemptId,'published_result',relative(resolve(root),output),hash(bytes),bytes.length]);
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='succeeded',result=$2,error=NULL,started_at=now(),finished_at=now() WHERE workflow_id=$1 AND ordinal=8",[workflowId,JSON.stringify({...result,artifact_id:artifactId})]);
  await db.query("UPDATE ai_distill.workflows SET status='succeeded' WHERE id=$1",[workflowId]);
  await db.query('COMMIT');return {id:attemptId,reused:false,completed:true};
 }catch(error){
  try{await db.query('ROLLBACK');}catch{console.error('成果发布事务回滚失败，等待核对');}
  // An uncertain COMMIT must not delete a file already referenced by the database.
  if(output&&attemptId)try{const committed=await pool.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='succeeded'",[attemptId]);if(!committed.rowCount)await rm(output,{force:true});}catch{console.error('无法确认成果发布状态，保留文件等待核对');}
  throw error;
 }finally{db.release();}
}
