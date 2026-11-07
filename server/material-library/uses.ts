/**
 * 文件职责：主项目跨期的永久材料占用和提交/返修审计，状态不依赖题目是否存在。
 * 公开入口：claimMaterialUse()在加载事务内占用；assertMaterialUse()在建题前复核；read/update提供状态回读与人工提交登记。
 * 边界：材料签名忽略文件名和顺序；submitted退回in_use只允许原期返修，不释放主项目使用资格。
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';

export type MaterialUseStatus='in_use'|'submitted';
type Phase={id:string;project_group_id?:string;phase_name?:string;phase_no?:number|null};
type MaterialFileIdentity={sha256:string;size_bytes:number|string};
const conflict=(message:string)=>new HTTPException(409,{message});

export function materialSetSignature(files:MaterialFileIdentity[]):string{
 if(!files.length)throw conflict('材料包没有可核对的原件');
 const keys=files.map(file=>{
  const size=Number(file.size_bytes);
  if(!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(size)||size<0)throw conflict('材料原件摘要或大小无效');
  return `${file.sha256}:${size}`;
 });
 return createHash('sha256').update(JSON.stringify({format:'material-set-v1',files:[...new Set(keys)].sort()})).digest('hex');
}

export async function readPackageSignature(db:Pool|PoolClient,packageId:string,revisionId?:string):Promise<string>{
 const result=await db.query(`SELECT b.sha256,b.size_bytes FROM ai_distill.library_files f
  JOIN ai_distill.library_blobs b ON b.id=f.blob_id JOIN ai_distill.library_revisions r ON r.id=f.revision_id
  JOIN ai_distill.library_packages p ON p.id=r.package_id
  WHERE r.package_id=$1 AND f.revision_id=COALESCE($2::uuid,p.current_revision_id) ORDER BY f.position`,[packageId,revisionId??null]);
 return materialSetSignature(result.rows);
}

async function appendUseEvent(db:PoolClient,useId:string,eventType:string,previous:MaterialUseStatus|null,status:MaterialUseStatus,reason:string,evidence:Record<string,unknown>){
 await db.query(`INSERT INTO ai_distill.project_material_use_events(id,use_id,event_type,previous_status,status,reason,evidence)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[randomUUID(),useId,eventType,previous,status,reason,JSON.stringify(evidence)]);
}

async function findLegacyOwner(db:PoolClient,phase:Phase,signature:string){
 const old=await db.query(`SELECT w.id AS workflow_id,w.project_id,w.created_at,p.phase_name,
  jsonb_agg(jsonb_build_object('sha256',m.sha256,'size_bytes',m.size_bytes)) AS files
  FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id
  JOIN ai_distill.materials m ON m.workflow_id=w.id AND m.deleted_at IS NULL
  WHERE p.project_group_id=$1 AND w.project_id<>$2
   AND (w.workflow_kind='material_package' OR (w.source_workflow_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM ai_distill.question_library_sources s WHERE s.workflow_id=w.id)))
  GROUP BY w.id,p.id ORDER BY w.created_at,w.id`,[phase.project_group_id,phase.id]);
 return old.rows.find(row=>materialSetSignature(row.files)===signature);
}

/** 加载事务先登记未迁库的旧期占用，再以409结束本次加载；调用方须提交这个历史索引而不创建新期引用。 */
export async function indexLegacyMaterialUse(db:PoolClient,phase:Phase,packageId:string,signature:string){
 if(!phase.project_group_id)throw conflict('期次缺少稳定主项目身份');
 await db.query("SELECT pg_advisory_xact_lock(hashtext('material-use'),hashtext($1))",[`${phase.project_group_id}:${signature}`]);
 if((await db.query('SELECT id FROM ai_distill.project_material_uses WHERE project_group_id=$1 AND (package_id=$2 OR material_signature=$3)',[phase.project_group_id,packageId,signature])).rows.length)return null;
 const old=await findLegacyOwner(db,phase,signature);
 if(!old)return null;
 const use=(await db.query(`INSERT INTO ai_distill.project_material_uses(id,project_group_id,package_id,owner_phase_id,material_signature,first_used_at)
  VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),phase.project_group_id,packageId,old.project_id,signature,old.created_at])).rows[0];
 await appendUseEvent(db,use.id,'legacy_import',null,'in_use','由旧期原件集合确认历史占用，拒绝本次跨期加载',{
  origin:'legacy_compatibility',source_phase_id:old.project_id,source_workflow_id:old.workflow_id,material_signature:signature});
 return{...use,phase_name:old.phase_name};
}

/** 调用方已经锁包、主项目和期次；签名锁覆盖不同包ID但原件完全相同的并发请求。 */
export async function claimMaterialUse(db:PoolClient,phase:Phase,packageId:string,signature:string,options:{historical?:boolean;reason?:string}={}){
 if(!phase.project_group_id)throw conflict('期次缺少稳定主项目身份，请先完成主项目迁移');
 await db.query("SELECT pg_advisory_xact_lock(hashtext('material-use'),hashtext($1))",[`${phase.project_group_id}:${signature}`]);
 const existing=(await db.query(`SELECT u.*,p.phase_name,p.phase_no FROM ai_distill.project_material_uses u
  JOIN ai_distill.projects p ON p.id=u.owner_phase_id
  WHERE u.project_group_id=$1 AND (u.package_id=$2 OR u.material_signature=$3) FOR UPDATE OF u`,[phase.project_group_id,packageId,signature])).rows[0];
 if(existing){
  if(existing.owner_phase_id!==phase.id)throw conflict(`该材料已在${existing.phase_name||`第${existing.phase_no??'?'}期`}使用（${existing.status==='submitted'?'已提交':'使用中'}），不能在本项目其他期次重复加载`);
  if(existing.package_id!==packageId)throw conflict('本期已使用相同原件的材料包，请恢复原材料包引用，不能重复加载副本');
  return existing;
 }
 if(!options.historical){
  // 未迁入新库的旧期也参与防重；不读取正文、不复制历史题目，不以期次显示名作为身份。
  const used=await findLegacyOwner(db,phase,signature);
  if(used)throw conflict(`该材料已在${used.phase_name||'历史期次'}使用，不能重复加载；请先登记旧期材料使用关联`);
 }
 const use=(await db.query(`INSERT INTO ai_distill.project_material_uses(id,project_group_id,package_id,owner_phase_id,material_signature)
  VALUES($1,$2,$3,$4,$5) RETURNING *`,[randomUUID(),phase.project_group_id,packageId,phase.id,signature])).rows[0];
 await appendUseEvent(db,use.id,options.historical?'legacy_import':'loaded',null,'in_use',options.reason??'',{});
 return use;
}

export async function assertMaterialUse(db:PoolClient,phaseId:string,packageId:string,useId:string|null|undefined,linkId?:string){
 if(!useId)throw conflict('该材料尚未建立主项目使用关联，请先核对历史来源');
 const use=(await db.query('SELECT * FROM ai_distill.project_material_uses WHERE id=$1 FOR UPDATE',[useId])).rows[0];
 if(!use||use.package_id!==packageId)throw conflict('材料使用记录不属于本期加载关系');
 if(use.owner_phase_id!==phaseId){
  const grant=linkId?(await db.query(`SELECT l.id FROM ai_distill.project_library_packages l
   JOIN ai_distill.workflows w ON w.id=l.reuse_source_workflow_id
   JOIN ai_distill.question_library_sources q ON q.workflow_id=w.id AND q.package_id=l.package_id
   WHERE l.id=$1 AND l.project_id=$2 AND l.package_id=$3 AND l.material_use_id=$4
    AND w.project_id=$5 AND l.reuse_direction IS NOT NULL AND length(btrim(l.reuse_direction))>0`,[linkId,phaseId,packageId,useId,use.owner_phase_id])).rows[0]:null;
  if(!grant)throw conflict('材料使用记录不属于本期加载关系');
  return use;
 }
 if(use.status==='submitted')throw conflict('该材料已提交；如需返修，请先在原期次将状态退回使用中');
 return use;
}

export async function readPhaseMaterialUses(pool:Pool,phaseId:string){
 const uses=await pool.query(`SELECT u.*,p.name AS package_name,phase.phase_name,phase.phase_no
  FROM ai_distill.project_material_uses u JOIN ai_distill.library_packages p ON p.id=u.package_id
  JOIN ai_distill.projects phase ON phase.id=u.owner_phase_id WHERE u.owner_phase_id=$1 ORDER BY u.first_used_at,u.id`,[phaseId]);
 return uses.rows;
}

export async function readPhaseMaterialUseEvents(pool:Pool,phaseId:string,useId:string){
 const use=await pool.query('SELECT id FROM ai_distill.project_material_uses WHERE id=$1 AND owner_phase_id=$2',[useId,phaseId]);
 if(!use.rowCount)throw new HTTPException(404,{message:'本期材料使用记录不存在'});
 return(await pool.query('SELECT * FROM ai_distill.project_material_use_events WHERE use_id=$1 ORDER BY created_at,id',[useId])).rows;
}

export function validateUseUpdate(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HTTPException(400,{message:'使用状态参数无效'});
 const data=value as Record<string,unknown>;
 if(Object.keys(data).some(key=>!['status','reason','evidence'].includes(key))||!['in_use','submitted'].includes(String(data.status)))throw new HTTPException(400,{message:'使用状态只能是使用中或已提交'});
 if(typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>2000)throw new HTTPException(400,{message:'状态修改必须填写原因'});
 const evidence=data.evidence??{};
 if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||JSON.stringify(evidence).length>16000)throw new HTTPException(400,{message:'提交证据无效'});
 if(data.status==='submitted'){
  const e=evidence as Record<string,unknown>;
  if(!['platform','project_id','task_id','submitted_at','receipt'].every(key=>typeof e[key]==='string'&&String(e[key]).trim()))throw new HTTPException(400,{message:'已提交须提供平台、项目/任务ID、提交时间和回执'});
  if(!Number.isFinite(Date.parse(String(e.submitted_at))))throw new HTTPException(400,{message:'提交时间无效'});
 }
 return{status:data.status as MaterialUseStatus,reason:data.reason.trim(),evidence:evidence as Record<string,unknown>};
}

export async function updateMaterialUse(pool:Pool,phaseId:string,useId:string,expectedVersion:number,value:unknown){
 const update=validateUseUpdate(value);
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new HTTPException(400,{message:'使用记录版本无效'});
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const prior=(await db.query('SELECT * FROM ai_distill.project_material_uses WHERE id=$1 AND owner_phase_id=$2 FOR UPDATE',[useId,phaseId])).rows[0];
  if(!prior)throw new HTTPException(404,{message:'本期材料使用记录不存在'});
  if(prior.lock_version!==expectedVersion)throw conflict('使用状态已更新，请刷新后重试');
  const saved=(await db.query(`UPDATE ai_distill.project_material_uses SET status=$3,lock_version=lock_version+1,updated_at=now()
   WHERE id=$1 AND owner_phase_id=$2 RETURNING *`,[useId,phaseId,update.status])).rows[0];
  await appendUseEvent(db,useId,update.status==='submitted'?'submitted':'reopened',prior.status,update.status,update.reason,update.evidence);
  await db.query('COMMIT');return saved;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
