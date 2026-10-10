/**
 * 职责：项目当前资料／skill 文件服务：读取工作区、编辑项目资料并采用 skill 候选。
 * 关键方法与用途：执行任务在入队时读取当前文件清单；历史规则版本只保留在旧数据库记录中。
 * 使用场景：由 `app.ts` 文件管理接口调用；新出题、审查和评分直接读取当前目录。
 */
import type {Pool,PoolClient} from 'pg';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {realpath} from 'node:fs/promises';
import {HTTPException} from 'hono/http-exception';
import {scanRuleWorkspace,verifyRuleSnapshot,changeRuleFile} from './rule-files';
type Queryable=Pick<Pool,'query'>;
async function context(db:Queryable,id:string,locked=false,root?:string){
 try{
  const project=(await db.query(`SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL${locked?' FOR UPDATE':''}`,[id])).rows[0];
  if(!project)throw new HTTPException(404,{message:'项目不存在'});
  if(!project.local_skill_path)throw new HTTPException(409,{message:'请先设置本地skill目录'});
  const workspace=await scanRuleWorkspace(root??dirname(project.material_root??project.local_skill_path),project.local_skill_path);
  return{project,workspace};
 }catch(error){throw error;}
}
export async function readProjectRules(pool:Pool,id:string){
 try{
  const {workspace}=await context(pool,id);return{workspace};
 }catch(error){throw error;}
}
export async function editProjectRuleFile(pool:Pool,id:string,path:string,bytes:Uint8Array|null,expected:string|null){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');const {workspace}=await context(db,id,true);
  await changeRuleFile(workspace.workspace_path,path,bytes,expected);
  const updated=await scanRuleWorkspace(workspace.workspace_path,workspace.skill_path);
  await db.query('COMMIT');return{workspace:updated};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

// Adopting a checked candidate changes the project's current local skill directory.
export async function adoptProjectSkill(pool:Pool,id:string,attemptId:string,storageRoot:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const project=(await db.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];if(!project)throw new HTTPException(404,{message:'项目不存在'});
  const task=(await db.query("SELECT * FROM ai_distill.project_skill_attempts WHERE id=$1 AND project_id=$2 AND status='succeeded' FOR UPDATE",[attemptId,id])).rows[0];
  const result=task?.result;
  if(!result||result.publishable!==true||!Array.isArray(result.issues)||result.issues.length||!Array.isArray(result.unresolved)||result.unresolved.some((p:any)=>!p||p.blocking!==false)||!Array.isArray(result.candidate_files)||!result.candidate_files.length)throw new HTTPException(409,{message:'候选尚未通过内部使用检查，不能采用'});
  const parent=await realpath(join(storageRoot,'project-skills',id,attemptId)),candidate=await realpath(result.candidate_path),rel=relative(parent,candidate);
  if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new HTTPException(409,{message:'候选目录越界'});
  const files=result.candidate_files.map((f:any)=>{if(typeof f.path!=='string'||!f.path.startsWith('skill/'))throw new HTTPException(409,{message:'候选指纹清单无效'});return {...f,path:f.path.slice(6)};});
  await verifyRuleSnapshot(candidate,files);
  const workspace=dirname(project.material_root??project.local_skill_path??'');
  const source=await scanRuleWorkspace(workspace,task.input.template_path);
  if(source.source_digest!==task.input.source_digest)throw new HTTPException(409,{message:'生成来源已变化，请重新生成候选'});
  const view=await scanRuleWorkspace(workspace,candidate);
  if(view.issues.some(issue=>issue!=='缺少本期规则资料'))throw new HTTPException(409,{message:'候选入口或引用检查未通过'});
  await db.query('UPDATE ai_distill.projects SET local_skill_path=$2 WHERE id=$1',[id,candidate]);
  await verifyRuleSnapshot(candidate,files);
  await db.query('COMMIT');return{local_skill_path:candidate,workspace_path:workspace};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
