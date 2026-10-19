/**
 * 文件职责：稳定主项目身份与期次查询；保持既有projects.id及题目外键作为期次容器。
 * 公开入口：resolveProjectGroup()供期次创建事务使用；registerProjectGroupRoutes()提供主项目与期次导航。
 * 边界：主项目改名只更新展示归组，不重命名题目或失效成果；期号由操作者明确给出。
 */
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {text,uuid} from './validation';

export function validatePhaseNumber(value:unknown):number{
 if(!Number.isSafeInteger(value)||Number(value)<1)throw new HTTPException(400,{message:'期号必须是正整数'});
 return Number(value);
}

/** 只由期次写入事务调用；唯一名称包含已归档主项目，避免同名重建清除材料占用。 */
export async function resolveProjectGroup(db:PoolClient,name:string,groupId?:string){
 if(groupId){
  const group=(await db.query('SELECT id,name,deleted_at FROM ai_distill.project_groups WHERE id=$1 FOR UPDATE',[uuid(groupId)])).rows[0];
  if(!group||group.deleted_at)throw new HTTPException(409,{message:'主项目不存在或已归档'});
  if(group.name!==name)throw new HTTPException(409,{message:'主项目名称已变化，请刷新后重试'});
  return group;
 }
 const group=(await db.query(`INSERT INTO ai_distill.project_groups(id,name) VALUES($1,$2)
  ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,deleted_at`,[randomUUID(),name])).rows[0];
 if(group.deleted_at)throw new HTTPException(409,{message:'该主项目已归档，请恢复原项目，不可重建以清除使用记录'});
 return group;
}

/** 只用于期次身份切换前后核对，不返回或记录题面/答案正文。 */
export async function phaseBusinessDigest(db:PoolClient,phaseId:string){
 const rows=await db.query(`SELECT kind,identity,encode(sha256(convert_to(data::text,'UTF8')),'hex') AS data_sha256 FROM (
  SELECT 'workflow' AS kind,w.id::text AS identity,to_jsonb(w) AS data FROM ai_distill.workflows w WHERE w.project_id=$1
  UNION ALL SELECT 'step',s.workflow_id::text||':'||s.ordinal,to_jsonb(s) FROM ai_distill.steps s JOIN ai_distill.workflows w ON w.id=s.workflow_id WHERE w.project_id=$1
  UNION ALL SELECT 'attempt',a.id::text,to_jsonb(a) FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE w.project_id=$1
  UNION ALL SELECT 'material',m.id::text,to_jsonb(m) FROM ai_distill.materials m JOIN ai_distill.workflows w ON w.id=m.workflow_id WHERE w.project_id=$1
  UNION ALL SELECT 'artifact',a.id::text,to_jsonb(a) FROM ai_distill.artifacts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE w.project_id=$1
  ) business_records ORDER BY kind,identity`,[phaseId]);
 return{sha256:createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex'),record_count:rows.rows.length};
}

export async function updatePhaseIdentity(pool:Pool,phaseId:string,value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HTTPException(400,{message:'期次身份参数无效'});
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(key=>!['phase_no','phase_name','expected_name'].includes(key)))throw new HTTPException(400,{message:'不能通过期次身份接口修改业务配置'});
 const no=validatePhaseNumber(input.phase_no),label=text(input.phase_name,'期次名称',120),expected=text(input.expected_name,'原期次名称',120),db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT g.id FROM ai_distill.project_groups g JOIN ai_distill.projects p ON p.project_group_id=g.id WHERE p.id=$1 FOR UPDATE OF g',[phaseId]);
  const phase=(await db.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[phaseId])).rows[0];
  if(!phase)throw new HTTPException(404,{message:'原期次不存在'});
  if(phase.name!==expected)throw new HTTPException(409,{message:'期次名称已变化，请重新核对'});
  const active=(await db.query(`SELECT 1 FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id
   WHERE w.project_id=$1 AND a.status IN ('waiting','running') LIMIT 1`,[phaseId])).rowCount;
  if(active)throw new HTTPException(409,{message:'本期仍有排队或运行任务，结束后才能切换期次身份'});
  const before=await phaseBusinessDigest(db,phaseId);
  const name=`${phase.parent_name} - ${label}`;
  const saved=(await db.query('UPDATE ai_distill.projects SET phase_no=$2,phase_name=$3,name=$4 WHERE id=$1 RETURNING *',[phaseId,no,label,name])).rows[0];
  const after=await phaseBusinessDigest(db,phaseId);
  if(before.sha256!==after.sha256)throw new HTTPException(409,{message:'期次归组期间业务结果发生变化，切换已取消'});
  await db.query('COMMIT');return{project:saved,business_before:before,business_after:after};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

/** 空主项目从导航归档；稳定身份与使用历史保留，恢复同一ID不会重置跨期占用。 */
export async function setProjectGroupArchived(pool:Pool,id:string,archived:boolean){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  if(!(await db.query('SELECT id FROM ai_distill.project_groups WHERE id=$1 FOR UPDATE',[id])).rowCount)throw new HTTPException(404,{message:'主项目不存在'});
  if(archived&&(await db.query('SELECT id FROM ai_distill.projects WHERE project_group_id=$1 AND deleted_at IS NULL LIMIT 1',[id])).rowCount)throw new HTTPException(409,{message:'主项目仍有期次，请先处理所属期次'});
  const saved=await db.query('UPDATE ai_distill.project_groups SET deleted_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1 RETURNING id,name,deleted_at',[id,archived]);
  await db.query('COMMIT');return saved.rows[0];
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export function registerProjectGroupRoutes(app:Hono,pool:Pool){
 app.delete('/api/project-groups/:id',async c=>c.json(await setProjectGroupArchived(pool,uuid(c.req.param('id')),true)));
 app.post('/api/project-groups/:id/restore',async c=>c.json(await setProjectGroupArchived(pool,uuid(c.req.param('id')),false)));
 app.patch('/api/projects/:id/phase-identity',async c=>c.json(await updatePhaseIdentity(pool,uuid(c.req.param('id')),await c.req.json())));
 app.get('/api/project-groups',async c=>{
  const result=await pool.query(`SELECT g.id,g.name,g.created_at,count(p.id)::int AS phase_count,
   COALESCE(max(p.phase_no),0)::int AS latest_phase_no
   FROM ai_distill.project_groups g LEFT JOIN ai_distill.projects p ON p.project_group_id=g.id AND p.deleted_at IS NULL
   WHERE g.deleted_at IS NULL GROUP BY g.id ORDER BY g.created_at DESC,g.id`);
  return c.json({items:result.rows});
 });
 app.get('/api/project-groups/:id/phases',async c=>{
  const id=uuid(c.req.param('id'));
  const [groupResult,phases]=await Promise.all([
   pool.query('SELECT id,name,created_at FROM ai_distill.project_groups WHERE id=$1 AND deleted_at IS NULL',[id]),
   pool.query(`SELECT p.*,count(w.id)::int AS workflow_count,
    count(w.id) FILTER(WHERE w.workflow_kind='question')::int AS question_count,
    count(w.id) FILTER(WHERE w.workflow_kind='material_package')::int AS material_package_count
    FROM ai_distill.projects p LEFT JOIN ai_distill.workflows w ON w.project_id=p.id AND w.deleted_at IS NULL
    WHERE p.project_group_id=$1 AND p.deleted_at IS NULL GROUP BY p.id ORDER BY p.phase_no NULLS LAST,p.created_at,p.id`,[id]),
  ]);
  const group=groupResult.rows[0];
  if(!group)throw new HTTPException(404,{message:'主项目不存在'});
  return c.json({group,items:phases.rows});
 });
 app.patch('/api/project-groups/:id',async c=>{
  const id=uuid(c.req.param('id')),body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  const name=text(body?.name,'主项目名称',120),db=await pool.connect();
  try{
   await db.query('BEGIN');
   const group=(await db.query('UPDATE ai_distill.project_groups SET name=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING *',[id,name])).rows[0];
   if(!group)throw new HTTPException(404,{message:'主项目不存在'});
   // 仅展示名称随主项目更新；题目标题、冻结配置、文件路径及步骤结果保持原值。
   await db.query('UPDATE ai_distill.projects SET parent_name=$2 WHERE project_group_id=$1',[id,name]);
   await db.query('COMMIT');return c.json(group);
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
}
