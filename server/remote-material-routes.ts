/**
 * 职责：为本机CLI提供带令牌的旧材料工作流组合操作、题目作答及旧管理副本下载接口；全局库job另走material-library路由。
 * 关键入口：registerRemoteMaterialRoutes；仅服务器设置令牌时注册，不改变本机通用 API。
 */
import {createHash,timingSafeEqual} from 'node:crypto';
import {realpath,readFile} from 'node:fs/promises';
import {resolve,relative,sep} from 'node:path';
import {Hono,type Context,type Next} from 'hono';
import {HTTPException} from 'hono/http-exception';
import type {Pool} from 'pg';
import {scanQuestionFolder,validateFolder} from './project-folders';
import {createRemoteMaterialOperation,currentMaterialDigest,digestSourceManifest,readRemoteMaterialOperation,type RemoteMaterialMode} from './remote-material-operations';
import {enqueueAnswer} from './answer-models/jobs';
import {uuid} from './validation';

export function registerRemoteMaterialRoutes(app:Hono,pool:Pool,storageRoot:string,token=process.env.REMOTE_MATERIAL_TOKEN,enabled=process.env.MATERIAL_EXECUTION_TARGET==='server'){
 if(!enabled||!token)return;
 if(token.length<32)throw new Error('REMOTE_MATERIAL_TOKEN 至少需要 32 个字符');
 const prefix='/api/remote-material-operations';
 const answerPrefix='/api/remote-answer-operations';
 const authenticate=async(c:Context,next:Next)=>{
  const supplied=c.req.header('Authorization')?.match(/^Bearer (\S+)$/)?.[1]??'';
  const a=createHash('sha256').update(supplied).digest(),b=createHash('sha256').update(token).digest();
  if(!supplied||!timingSafeEqual(a,b))throw new HTTPException(401,{message:'远程操作凭证无效'});
  await next();
 };
 app.use(`${prefix}/*`,authenticate);
 app.use(`${answerPrefix}/*`,authenticate);
 app.post(prefix,async c=>{
  let body:any;try{body=await c.req.json();}catch{throw new HTTPException(400,{message:'请求必须是 JSON'});}
  if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.mode!=='string'||typeof body.request_key!=='string')throw new HTTPException(400,{message:'材料操作参数无效'});
  const operation=await createRemoteMaterialOperation(pool,uuid(body.workflow_id),body.mode as RemoteMaterialMode,body.request_key);
  return c.json({id:operation.id,workflow_id:operation.workflow_id,mode:operation.mode,status:operation.status,stage:operation.stage},202);
 });
 app.get(`${prefix}/by-request`,async c=>{
  const workflowId=uuid(c.req.query('workflow_id')??''),requestKey=uuid(c.req.query('request_key')??'');
  const row=(await pool.query('SELECT id FROM ai_distill.remote_material_operations WHERE workflow_id=$1 AND request_key=$2',[workflowId,requestKey])).rows[0];
  if(!row)throw new HTTPException(404,{message:'远程材料操作不存在'});
  return c.json(await readRemoteMaterialOperation(pool,row.id));
 });
 app.get(`${prefix}/:id`,async c=>c.json(await readRemoteMaterialOperation(pool,uuid(c.req.param('id')))));
 async function currentCompletedOperation(id:string){
  const op=await readRemoteMaterialOperation(pool,id);
  if(op.status!=='succeeded')throw new HTTPException(409,{message:'材料操作尚未完成'});
  const source=(await pool.query('SELECT w.source_manifest,w.source_key,p.material_root FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL',[op.workflow_id])).rows[0];
  const sourceHash=source?digestSourceManifest(source.source_manifest):null;
  if(sourceHash!==op.source_digest||await currentMaterialDigest(pool,op.workflow_id)!==op.material_digest)throw new HTTPException(409,{message:'材料版本已变化，不能同步旧操作的文件'});
  if(op.mode!=='redact'){
   if(!source?.source_key)throw new HTTPException(409,{message:'题目来源目录已变化，不能同步旧操作的文件'});
   const actual=await scanQuestionFolder(await validateFolder(source.material_root),source.source_key);
   if(digestSourceManifest(actual.files)!==op.source_digest)throw new HTTPException(409,{message:'来源附件已变化，不能同步旧操作的文件'});
  }
  const states=(await pool.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal IN (1,9)',[op.workflow_id])).rows;
  if(states.find((row:any)=>row.ordinal===1)?.status!=='succeeded')throw new HTTPException(409,{message:'入库状态已变化，不能同步旧操作的文件'});
  if(op.mode!=='intake'){
   const redaction=(await pool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1 AND workflow_id=$2 AND ordinal=9 AND execution_target=$3',[op.redaction_attempt_id,op.workflow_id,'server'])).rows[0];
   if(!op.redaction_attempt_id||redaction?.status!=='succeeded'||states.find((row:any)=>row.ordinal===9)?.status!=='succeeded')throw new HTTPException(409,{message:'脱敏状态已变化，不能同步旧操作的文件'});
   const outputs=Number((await pool.query("SELECT count(*)::int AS count FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind IN ('redacted_markdown','redacted_index')",[op.workflow_id,op.redaction_attempt_id])).rows[0]?.count??0);
   if(outputs<2)throw new HTTPException(409,{message:'脱敏文件不完整，不能报告本机可继续出题'});
  }
  return op;
 }
 app.get(`${prefix}/:id/files`,async c=>{
  const op=await currentCompletedOperation(uuid(c.req.param('id')));
  const materials=(await pool.query('SELECT id,original_name,storage_path,sha256,size_bytes FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id',[op.workflow_id])).rows;
  const artifacts=(await pool.query("SELECT id,kind,storage_path,sha256,size_bytes FROM ai_distill.artifacts WHERE workflow_id=$1 AND attempt_id=$2 AND kind IN ('redacted_markdown','redacted_index') ORDER BY created_at,id",[op.workflow_id,op.redaction_attempt_id])).rows;
  return c.json({operation_id:op.id,workflow_id:op.workflow_id,source_digest:op.source_digest,materials,artifacts});
 });
 async function fileForOperation(operationId:string,fileId:string,type:'material'|'artifact'){
  const op=await currentCompletedOperation(operationId);
  const row=type==='material'
   ?(await pool.query('SELECT storage_path,sha256 FROM ai_distill.materials WHERE id=$1 AND workflow_id=$2 AND deleted_at IS NULL',[fileId,op.workflow_id])).rows[0]
   :(await pool.query("SELECT storage_path,sha256 FROM ai_distill.artifacts WHERE id=$1 AND workflow_id=$2 AND attempt_id=$3 AND kind IN ('redacted_markdown','redacted_index')",[fileId,op.workflow_id,op.redaction_attempt_id])).rows[0];
  if(!row)throw new HTTPException(404,{message:'管理副本不存在'});
  const base=await realpath(resolve(storageRoot)),path=resolve(base,row.storage_path),rel=relative(base,path);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||rel.startsWith(sep))throw new HTTPException(409,{message:'管理副本路径无效'});
  let actual:string;try{actual=await realpath(path);}catch{throw new HTTPException(404,{message:'管理副本文件不存在'});}
  if(!actual.startsWith(`${base}${sep}`))throw new HTTPException(409,{message:'管理副本路径无效'});
  const bytes=await readFile(actual);
  if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new HTTPException(409,{message:'管理副本校验失败'});
  return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}});
 }
 app.get(`${prefix}/:id/materials/:fileId/download`,async c=>fileForOperation(uuid(c.req.param('id')),uuid(c.req.param('fileId')),'material'));
 app.get(`${prefix}/:id/artifacts/:fileId/download`,async c=>fileForOperation(uuid(c.req.param('id')),uuid(c.req.param('fileId')),'artifact'));

 async function readRemoteAnswerOperation(workflowId:string,requestKey:string){
  const attempts=(await pool.query("SELECT id,status,started_at,finished_at FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND execution_target='server' AND input->>'remote_request_key'=$2 ORDER BY attempt",[workflowId,requestKey])).rows as {id:string;status:string;started_at:unknown;finished_at:unknown}[];
  if(!attempts.length)throw new HTTPException(404,{message:'远程作答任务不存在'});
  const terminal=attempts.every(attempt=>['succeeded','failed','skipped','cancelled'].includes(attempt.status));
  const status=terminal?(attempts.every(attempt=>attempt.status==='succeeded')?'succeeded':attempts.every(attempt=>attempt.status==='skipped')?'skipped':'failed'):attempts.some(attempt=>attempt.status==='running')?'running':'waiting';
  return{workflow_id:workflowId,request_key:requestKey,status,attempts};
 }
 app.post(answerPrefix,async c=>{
  let body:any;try{body=await c.req.json();}catch{throw new HTTPException(400,{message:'请求必须是 JSON'});}
  if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.request_key!=='string')throw new HTTPException(400,{message:'远程作答参数无效'});
  const workflowId=uuid(body.workflow_id),requestKey=uuid(body.request_key);
  const task=await enqueueAnswer(pool,workflowId,storageRoot,'server',requestKey);
  const state=await readRemoteAnswerOperation(workflowId,requestKey);
  return c.json({...state,attempt_ids:task.ids??[task.id],reused:task.reused??false},202);
 });
 app.get(`${answerPrefix}/by-request`,async c=>{
  const workflowId=uuid(c.req.query('workflow_id')??''),requestKey=uuid(c.req.query('request_key')??'');
  return c.json(await readRemoteAnswerOperation(workflowId,requestKey));
 });
}
