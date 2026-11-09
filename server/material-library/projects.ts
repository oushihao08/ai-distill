/**
 * 文件职责：管理项目对全局材料包的加载引用，不复制材料库原件或运行材料处理。
 * 关键入口：readLoadedLibraryPackages/loadLibraryPackage/updateLoadedLibraryPackage 管理来源选版与顺序；remove/restoreLoadedLibraryPackage 软移除和恢复原引用。加载核对所选提取或脱敏来源及完整材料DOCX的10页门槛，材料整理可跳过。
 * 事务边界：写入按 package → project_group → project → link 的统一锁顺序执行；题目创建在独立模块处理。
 */
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {redactionJobCurrentValidationSql} from './processing-policy';
import {randomUUID} from 'node:crypto';
import {assertMaterialUse,claimMaterialUse,indexLegacyMaterialUse,readPackageSignature} from './uses';
import {assertLibraryLoadEligible,ensureLibraryLoadEligibility} from './load-eligibility';

type Db=Pool|PoolClient;
type LoadedLink={selected_version_usable?:boolean;id:string;project_id:string;package_id:string;package_name:string;selected_revision_id:string|null;selected_redaction_id:string|null;current_revision_id:string|null;position:number;lock_version:number;removed_at:string|null;created_at:string;updated_at:string;material_use_id?:string|null;usage_status?:'in_use'|'submitted';use_lock_version?:number;reuse_source_workflow_id?:string|null;reuse_direction?:string|null};
const conflict=(message:string)=>new HTTPException(409,{message});
const notFound=(message:string)=>new HTTPException(404,{message});

function validateSelection(value:unknown):string|null{
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new HTTPException(400,{message:'脱敏结果标识无效'});
 return value;
}

async function selectedRedaction(db:Db,packageId:string,redactionId:string|null){
 if(!redactionId)throw conflict('请先完成脱敏并选择可用脱敏结果，再加载到项目');
 const row=(await db.query(`SELECT r.id,r.package_id,r.revision_id,r.extraction_job_id,r.validation_report->>'usable_for_question' AS usable
  FROM ai_distill.library_redactions r
  JOIN ai_distill.library_revisions rev ON rev.id=r.revision_id AND rev.package_id=r.package_id AND rev.state='ready'
  JOIN ai_distill.library_jobs e ON e.id=r.extraction_job_id AND e.revision_id=r.revision_id AND e.kind='extract' AND e.status='succeeded'
  JOIN ai_distill.library_jobs j ON j.id=r.redaction_job_id AND j.revision_id=r.revision_id AND j.kind='redact' AND j.status='succeeded'
  WHERE r.id=$1 AND ${redactionJobCurrentValidationSql('j')}`,[redactionId])).rows[0];
 if(!row||row.package_id!==packageId||row.usable!=='true')throw conflict('所选脱敏结果不存在、已失效或不属于该材料包');
 return{revision_id:String(row.revision_id),redaction_id:String(row.id),extraction_job_id:String(row.extraction_job_id)};
}

async function selectedExtraction(db:Db,packageId:string,revisionId:string|null){
 if(!revisionId)throw conflict('请选择已经完成提取的材料版本');
 const row=(await db.query(`SELECT r.id,r.package_id,e.id AS extraction_job_id,r.file_count,
   (SELECT count(*)::int FROM ai_distill.library_documents d WHERE d.revision_id=r.id AND d.extraction_job_id=e.id) AS document_count
  FROM ai_distill.library_revisions r JOIN ai_distill.library_jobs e ON e.revision_id=r.id AND e.kind='extract' AND e.status='succeeded'
  WHERE r.id=$1 AND r.package_id=$2 AND r.state='ready' AND (SELECT count(*) FROM ai_distill.library_documents d WHERE d.revision_id=r.id AND d.extraction_job_id=e.id)=r.file_count
  ORDER BY e.finished_at DESC,e.id DESC LIMIT 1`,[revisionId,packageId])).rows[0];
 if(!row)throw conflict('所选材料版本没有完整成功的文本提取结果');
 return{revision_id:String(row.id),redaction_id:null as null,extraction_job_id:String(row.extraction_job_id)};
}

/** 页数判定在写事务外完成；事务内再核对确切选版和提取任务，避免耗时渲染占住项目锁。 */
async function preflightSelection(pool:Pool,packageId:string,redactionId:string|null,revisionId?:string|null){
 const selected=revisionId!==undefined?await selectedExtraction(pool,packageId,revisionId):await selectedRedaction(pool,packageId,redactionId);
 await ensureLibraryLoadEligibility(pool,selected.revision_id,selected.extraction_job_id);
 return selected;
}

async function lockPackageProject(db:PoolClient,projectId:string,packageId:string){
 const pkg=(await db.query('SELECT id,deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',[packageId])).rows[0];
 if(!pkg||pkg.deleted_at)throw notFound('材料包不存在或已归档');
 // 按包→主项目→期次锁定，与历史导入/状态写入保持相同顺序。
 await db.query('SELECT g.id FROM ai_distill.project_groups g JOIN ai_distill.projects p ON p.project_group_id=g.id WHERE p.id=$1 FOR UPDATE OF g',[projectId]);
 const project=(await db.query('SELECT id,material_backend,deleted_at,project_group_id,phase_name,phase_no FROM ai_distill.projects WHERE id=$1 FOR UPDATE',[projectId])).rows[0];
 if(!project||project.deleted_at)throw notFound('项目不存在');
 return{pkg,project};
}

async function withTransaction<T>(pool:Pool,operation:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect();
 try{await db.query('BEGIN');const result=await operation(db);await db.query('COMMIT');return result;}
 catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'项目材料关联事务失败且回滚状态不确定');}throw error;}
 finally{db.release();}
}

export async function readLoadedLibraryPackages(pool:Pool,projectId:string,options:{includeRemoved?:boolean}={}):Promise<LoadedLink[]>{
 const result=await pool.query(`SELECT l.id,l.project_id,l.package_id,p.name AS package_name,l.selected_revision_id,l.selected_redaction_id,l.reuse_source_workflow_id,l.reuse_direction,
   p.current_revision_id,l.position,l.lock_version,l.removed_at,l.created_at,l.updated_at,l.material_use_id,u.status AS usage_status,u.lock_version AS use_lock_version,
   CASE WHEN l.selected_redaction_id IS NULL THEN 'original'
    WHEN red_job.config_snapshot->'redaction_template'->>'workflow'='codex_plan' OR red.validation_report->>'redaction_template_id'='aliases' THEN 'aliases'
    ELSE 'mask' END AS selected_processing_mode,
   CASE WHEN l.selected_redaction_id IS NULL THEN EXISTS(
    SELECT 1 FROM ai_distill.library_revisions selected_rev
    JOIN ai_distill.library_jobs extraction ON extraction.revision_id=selected_rev.id AND extraction.kind='extract' AND extraction.status='succeeded'
    WHERE selected_rev.id=l.selected_revision_id AND selected_rev.package_id=l.package_id AND selected_rev.state='ready' AND selected_rev.file_count>0
     AND (SELECT count(*) FROM ai_distill.library_documents documents WHERE documents.extraction_job_id=extraction.id AND documents.revision_id=selected_rev.id)=selected_rev.file_count)
   ELSE red.revision_id=l.selected_revision_id AND red_job.status='succeeded' AND red.validation_report->>'usable_for_question'='true'
    AND ${redactionJobCurrentValidationSql('red_job')}
    AND EXISTS(SELECT 1 FROM ai_distill.library_jobs extraction WHERE extraction.id=red.extraction_job_id AND extraction.status='succeeded')
    AND EXISTS(SELECT 1 FROM ai_distill.library_revisions selected_rev WHERE selected_rev.id=red.revision_id AND selected_rev.state='ready')
   END AS selected_version_usable
  FROM ai_distill.project_library_packages l
  JOIN ai_distill.library_packages p ON p.id=l.package_id
  JOIN ai_distill.projects pr ON pr.id=l.project_id AND pr.deleted_at IS NULL
  LEFT JOIN ai_distill.project_material_uses u ON u.id=l.material_use_id
  LEFT JOIN ai_distill.library_redactions red ON red.id=l.selected_redaction_id
  LEFT JOIN ai_distill.library_jobs red_job ON red_job.id=red.redaction_job_id
  WHERE l.project_id=$1 AND ($2::boolean OR l.removed_at IS NULL) AND p.deleted_at IS NULL
  ORDER BY l.position,l.id`,[projectId,options.includeRemoved===true]);
 return result.rows.map(row=>({...row,lock_version:Number(row.lock_version),...(row.use_lock_version==null?{}:{use_lock_version:Number(row.use_lock_version)})})) as LoadedLink[];
}

export async function loadLibraryPackage(pool:Pool,projectId:string,packageId:string,redactionValue?:string|null,revisionValue?:string|null,reuse?:{source_workflow_id:string;direction:string}){
 const redactionId=validateSelection(redactionValue);
 await preflightSelection(pool,packageId,redactionId,revisionValue);
 const result=await withTransaction(pool,async db=>{
  const {project}=await lockPackageProject(db,projectId,packageId);
  const selection=revisionValue!==undefined?await selectedExtraction(db,packageId,revisionValue):await selectedRedaction(db,packageId,redactionId);
  await assertLibraryLoadEligible(db,selection.revision_id,selection.extraction_job_id);
  const signature=project.project_group_id?await readPackageSignature(db,packageId,selection.revision_id):null;
  const historical=signature?await indexLegacyMaterialUse(db,project,packageId,signature):null;
  if(historical&&!reuse)return{blocked_reason:`该材料已在${historical.phase_name||'历史期次'}使用，已登记原期占用，不能在本项目其他期次重复加载`};
  // 显式复用只借用原期的永久占用，不新建或转移使用账；来源题和新方向随加载关系冻结。
  const source=reuse?(await db.query(`SELECT w.id,w.authoring_direction,w.project_id,u.id AS use_id,u.owner_phase_id
   FROM ai_distill.workflows w JOIN ai_distill.question_library_sources q ON q.workflow_id=w.id
   JOIN ai_distill.projects p ON p.id=w.project_id JOIN ai_distill.project_material_uses u ON u.package_id=q.package_id AND u.project_group_id=p.project_group_id
   JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=4 AND s.status='succeeded'
   WHERE w.id=$1 AND q.package_id=$2 AND p.project_group_id=$3 AND w.project_id<>$4 AND w.deleted_at IS NULL`,[reuse.source_workflow_id,packageId,project.project_group_id,projectId])).rows[0]:null;
  if(reuse&&(!source||source.owner_phase_id!==source.project_id||reuse.direction.trim()===String(source.authoring_direction??'').trim()))throw conflict('跨期复用须指定同主项目原期成功题目和不同的新出题方向');
  const use=reuse?{id:source.use_id}:signature?await claimMaterialUse(db,project,packageId,signature):null;
  const current=(await db.query(`SELECT id,project_id,package_id,selected_revision_id,selected_redaction_id,position,lock_version,removed_at,material_use_id,reuse_source_workflow_id,reuse_direction
    FROM ai_distill.project_library_packages WHERE project_id=$1 AND package_id=$2 AND removed_at IS NULL FOR UPDATE`,[projectId,packageId])).rows[0];
  if(current){
   if(reuse&&(current.reuse_source_workflow_id!==reuse.source_workflow_id||current.reuse_direction!==reuse.direction))throw conflict('本期已加载该材料，跨期复用来源或方向不可改写');
   if(use&&!current.material_use_id){await db.query('UPDATE ai_distill.project_library_packages SET material_use_id=$2 WHERE id=$1',[current.id,use.id]);current.material_use_id=use.id;}
   if(current.selected_revision_id!==selection.revision_id||current.selected_redaction_id!==selection.redaction_id){
    if(use)await assertMaterialUse(db,projectId,packageId,use.id,current.id);
    const updated=(await db.query(`UPDATE ai_distill.project_library_packages SET selected_revision_id=$4,selected_redaction_id=$5,
      lock_version=lock_version+1,updated_at=now() WHERE id=$1 AND project_id=$2 AND package_id=$3 RETURNING *`,
      [current.id,projectId,packageId,selection.revision_id,selection.redaction_id])).rows[0];
    return{...updated,reused:true};
   }
   return{...current,reused:true};
  }
  if(use){
   const removed=(await db.query('SELECT id FROM ai_distill.project_library_packages WHERE project_id=$1 AND package_id=$2 AND removed_at IS NOT NULL',[projectId,packageId])).rows[0];
   if(removed)throw conflict('本项目已经使用过该材料，请在原期次恢复原引用，不可重复加载');
  }
  const nextPosition=Number((await db.query('SELECT COALESCE(max(position),0)+1 AS next_position FROM ai_distill.project_library_packages WHERE project_id=$1 AND removed_at IS NULL',[projectId])).rows[0]?.next_position??1);
  const result=await db.query(`INSERT INTO ai_distill.project_library_packages(id,project_id,package_id,selected_revision_id,selected_redaction_id,position,material_use_id,reuse_source_workflow_id,reuse_direction)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id,project_id,package_id,selected_revision_id,selected_redaction_id,position,lock_version,removed_at`,
    [randomUUID(),projectId,packageId,selection.revision_id,selection.redaction_id,nextPosition,use?.id??null,reuse?.source_workflow_id??null,reuse?.direction??null]);
  return{...result.rows[0],reused:false} as LoadedLink&{reused:boolean};
 });
 // 旧期占用是新发现的真实历史，应持久保存；409只表示本次加载未成功，不回滚旧期索引。
 if('blocked_reason'in result)throw conflict(result.blocked_reason);
 return result;
}

export interface UpdateLoadedLibraryPackageInput{redaction_id?:string|null;revision_id?:string|null;position?:number}
export function validateLoadedLibraryPackageUpdate(value:unknown):UpdateLoadedLibraryPackageInput{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HTTPException(400,{message:'材料加载设置无效'});
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(key=>key!=='redaction_id'&&key!=='revision_id'&&key!=='position')||(!('redaction_id'in input)&&!('revision_id'in input)&&!('position'in input))||('redaction_id'in input&&'revision_id'in input))throw new HTTPException(400,{message:'材料加载设置无效'});
 if('position'in input&&(!Number.isSafeInteger(input.position)||Number(input.position)<1))throw new HTTPException(400,{message:'项目内材料顺序无效'});
 return{...('redaction_id'in input?{redaction_id:validateSelection(input.redaction_id)}:{}),...('revision_id'in input?{revision_id:validateSelection(input.revision_id)}:{}),...('position'in input?{position:Number(input.position)}:{})};
}

async function lockLoadedLink(db:PoolClient,projectId:string,linkId:string){
 const row=(await db.query(`SELECT id,project_id,package_id,selected_revision_id,selected_redaction_id,position,lock_version,removed_at
   ,material_use_id FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2 FOR UPDATE`,[linkId,projectId])).rows[0];
 if(!row||row.removed_at)throw notFound('项目加载的材料包不存在');
 return row as LoadedLink;
}

export async function updateLoadedLibraryPackage(pool:Pool,projectId:string,linkId:string,expectedVersion:number,value:unknown){
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new HTTPException(400,{message:'材料加载版本无效'});
 const input=validateLoadedLibraryPackageUpdate(value);
 const changingSource='revision_id'in input||'redaction_id'in input;
 if(changingSource){
  const previous=(await pool.query('SELECT package_id,selected_revision_id,selected_redaction_id FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2',[linkId,projectId])).rows[0];
  if(!previous)throw notFound('项目加载的材料包不存在');
  await preflightSelection(pool,previous.package_id,'revision_id'in input?null:'redaction_id'in input?input.redaction_id??null:previous.selected_redaction_id,
   'revision_id'in input?input.revision_id??null:('redaction_id'in input||previous.selected_redaction_id)?undefined:previous.selected_revision_id);
 }
 return withTransaction(pool,async db=>{
  const identity=(await db.query('SELECT package_id FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2',[linkId,projectId])).rows[0];
  if(!identity)throw notFound('项目加载的材料包不存在');
  const {project}=await lockPackageProject(db,projectId,String(identity.package_id));
  const link=await lockLoadedLink(db,projectId,linkId);
  if(project.project_group_id)await assertMaterialUse(db,projectId,link.package_id,link.material_use_id,link.id);
  if(Number(link.lock_version)!==expectedVersion)throw conflict('项目材料加载关系已更新，请刷新后重试');
  let selection:{revision_id:string|null;redaction_id:string|null}={revision_id:link.selected_revision_id,redaction_id:link.selected_redaction_id};
  if(changingSource){
   const next='revision_id'in input?await selectedExtraction(db,link.package_id,input.revision_id??null):await selectedRedaction(db,link.package_id,input.redaction_id??null);
   await assertLibraryLoadEligible(db,next.revision_id,next.extraction_job_id);
   selection=next;
  }
  const position=input.position??link.position;
  const result=await db.query(`UPDATE ai_distill.project_library_packages SET selected_revision_id=$4,selected_redaction_id=$5,position=$6,
    lock_version=lock_version+1,updated_at=now() WHERE id=$1 AND project_id=$2 AND lock_version=$3 RETURNING *`,
    [linkId,projectId,expectedVersion,selection.revision_id,selection.redaction_id,position]);
  if(!result.rowCount)throw conflict('项目材料加载关系已更新，请刷新后重试');
  return result.rows[0];
 });
}

export async function removeLoadedLibraryPackage(pool:Pool,projectId:string,linkId:string,expectedVersion:number){
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new HTTPException(400,{message:'材料加载版本无效'});
 return withTransaction(pool,async db=>{
  const identity=(await db.query('SELECT package_id FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2',[linkId,projectId])).rows[0];
  if(!identity)throw notFound('项目加载的材料包不存在');
  await lockPackageProject(db,projectId,String(identity.package_id));
  const link=await lockLoadedLink(db,projectId,linkId);
  if(Number(link.lock_version)!==expectedVersion)throw conflict('项目材料加载关系已更新，请刷新后重试');
  const result=await db.query(`UPDATE ai_distill.project_library_packages SET removed_at=now(),lock_version=lock_version+1,updated_at=now()
    WHERE id=$1 AND project_id=$2 AND lock_version=$3 AND removed_at IS NULL RETURNING id,project_id,package_id,removed_at,lock_version`,[linkId,projectId,expectedVersion]);
  if(!result.rowCount)throw conflict('项目材料加载关系已更新，请刷新后重试');
  return result.rows[0];
 });
}

/** 恢复同一期的原加载行，不创建第二次使用；已提交须先明确退回返修。 */
export async function restoreLoadedLibraryPackage(pool:Pool,projectId:string,linkId:string,expectedVersion:number){
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new HTTPException(400,{message:'材料加载版本无效'});
 const previous=(await pool.query('SELECT package_id,selected_revision_id,selected_redaction_id FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2',[linkId,projectId])).rows[0];
 if(!previous)throw notFound('原期次材料引用不存在');
 await preflightSelection(pool,previous.package_id,previous.selected_redaction_id,previous.selected_redaction_id?undefined:previous.selected_revision_id);
 return withTransaction(pool,async db=>{
  const identity=(await db.query('SELECT package_id FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2',[linkId,projectId])).rows[0];
  if(!identity)throw notFound('原期次材料引用不存在');
  await lockPackageProject(db,projectId,identity.package_id);
  const link=(await db.query('SELECT * FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2 FOR UPDATE',[linkId,projectId])).rows[0];
  if(Number(link.lock_version)!==expectedVersion)throw conflict('材料引用已更新，请刷新后重试');
  const selection=link.selected_redaction_id?await selectedRedaction(db,link.package_id,link.selected_redaction_id):await selectedExtraction(db,link.package_id,link.selected_revision_id);
  await assertLibraryLoadEligible(db,selection.revision_id,selection.extraction_job_id);
  await assertMaterialUse(db,projectId,link.package_id,link.material_use_id,link.id);
  const saved=await db.query('UPDATE ai_distill.project_library_packages SET removed_at=NULL,lock_version=lock_version+1,updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING *',[linkId,projectId]);
  return saved.rows[0];
 });
}
