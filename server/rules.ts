/**
 * 职责：项目当前资料／skill 文件服务：读取工作区、编辑项目资料、采用 skill 候选并刷新项目导出。
 * 关键方法与用途：任务入队读取当前文件清单；`adoptProjectSkill()` 将已核验候选安装到稳定共享目录。
 * 使用场景：由 `app.ts` 文件管理接口调用；新出题、审查和评分直接读取当前目录。
 */
import type {Pool,PoolClient} from 'pg';
import {basename,dirname,join,relative,isAbsolute,sep} from 'node:path';
import {cp,mkdir,readdir,realpath,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {HTTPException} from 'hono/http-exception';
import {classifyLogError,logEvent} from './logging';
import {resolveRuleWorkspacePaths,scanRuleWorkspace,verifyRuleSnapshot,changeRuleFile} from './rule-files';
type Queryable=Pick<Pool,'query'>;
export async function invalidateProjectRuleOutputs(db:Queryable,id:string){
 // 已完成题目保留其出题 attempt 内冻结的 skill 来源；共享 skill 变化时，重建该主项目所有期次的工作簿。
 await db.query("UPDATE ai_distill.project_exports SET status='stale',error='项目资料或 skill 绑定已变化',finished_at=now() WHERE project_id IN (SELECT sibling.id FROM ai_distill.projects sibling JOIN ai_distill.projects current ON current.parent_name=sibling.parent_name WHERE current.id=$1 AND sibling.deleted_at IS NULL) AND status IN ('running','succeeded')",[id]);
}
async function context(db:Queryable,id:string,locked=false,root?:string){
 try{
  const project=(await db.query(`SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL${locked?' FOR UPDATE':''}`,[id])).rows[0];
  if(!project)throw new HTTPException(404,{message:'项目不存在'});
  if(!project.local_skill_path)throw new HTTPException(409,{message:'请先设置本地skill目录'});
  const paths=await resolveRuleWorkspacePaths(project);
  const workspace=await scanRuleWorkspace(root??paths.workspace_path,project.local_skill_path,'workspace',paths.materials_path);
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
  await changeRuleFile(workspace.workspace_path,path,bytes,expected,workspace.materials_path);
  const updated=await scanRuleWorkspace(workspace.workspace_path,workspace.skill_path,'workspace',workspace.materials_path);
  await db.query('COMMIT');return{workspace:updated};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

async function installSkillSnapshot(target:string,candidate:string,files:{path:string;sha256:string;size_bytes:number}[]){
 const suffix=randomUUID(),staging=join(dirname(target),`.${basename(target)}.${suffix}.staging`),backup=join(dirname(target),`.${basename(target)}.${suffix}.backup`);
 let previousMoved=false,nextInstalled=false;
 try{
  await mkdir(staging,{mode:0o700});
  for(const name of await readdir(candidate))await cp(join(candidate,name),join(staging,name),{recursive:true,errorOnExist:true,force:false});
  await verifyRuleSnapshot(staging,files);
  await rename(target,backup);previousMoved=true;
  await rename(staging,target);nextInstalled=true;
  await verifyRuleSnapshot(target,files);
  return{backup,rollback:async()=>{if(nextInstalled)await rm(target,{recursive:true,force:true});if(previousMoved)await rename(backup,target);await rm(staging,{recursive:true,force:true});}};
 }catch(error){
  if(nextInstalled)await rm(target,{recursive:true,force:true});
  if(previousMoved)await rename(backup,target);
  await rm(staging,{recursive:true,force:true});
  throw error;
 }
}

// Adopting a checked candidate updates the stable project skill directory; generated candidates remain in storage as history.
export async function adoptProjectSkill(pool:Pool,id:string,attemptId:string,storageRoot:string){
 const db=await pool.connect();
 let replacement:{backup:string;rollback:()=>Promise<void>}|undefined;
 try{
  await db.query('BEGIN');
  const project=(await db.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];if(!project)throw new HTTPException(404,{message:'项目不存在'});
  if(typeof project.local_skill_path!=='string'||!project.local_skill_path)throw new HTTPException(409,{message:'请先为本项目设置本地 skill 目录'});
  const task=(await db.query("SELECT * FROM ai_distill.project_skill_attempts WHERE id=$1 AND project_id=$2 AND status='succeeded' FOR UPDATE",[attemptId,id])).rows[0];
  const result=task?.result;
  if(!result||result.publishable!==true||!Array.isArray(result.issues)||result.issues.length||!Array.isArray(result.unresolved)||result.unresolved.some((p:any)=>!p||p.blocking!==false)||!Array.isArray(result.candidate_files)||!result.candidate_files.length)throw new HTTPException(409,{message:'候选尚未通过内部使用检查，不能采用'});
  const storage=await realpath(storageRoot),parent=await realpath(join(storage,'project-skills',id,attemptId)),candidate=await realpath(result.candidate_path),rel=relative(parent,candidate);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new HTTPException(409,{message:'候选目录越界'});
  const files=result.candidate_files.map((f:any)=>{if(typeof f.path!=='string'||!f.path.startsWith('skill/'))throw new HTTPException(409,{message:'候选指纹清单无效'});return {...f,path:f.path.slice(6)};});
  await verifyRuleSnapshot(candidate,files);
  const paths=await resolveRuleWorkspacePaths(project),workspace=paths.workspace_path;
  const source=await scanRuleWorkspace(workspace,task.input.template_path,'workspace',paths.materials_path);
  if(source.source_digest!==task.input.source_digest)throw new HTTPException(409,{message:'生成来源已变化，请重新生成候选'});
  const view=await scanRuleWorkspace(workspace,candidate,'workspace',paths.materials_path);
  if(view.issues.some(issue=>issue!=='缺少本期规则资料'))throw new HTTPException(409,{message:'候选入口或引用检查未通过'});
  const current=await scanRuleWorkspace(workspace,project.local_skill_path,'workspace',paths.materials_path),storageRelative=relative(storage,current.skill_path),usesStorage=storageRelative===''||(!storageRelative.startsWith(`..${sep}`)&&storageRelative!=='..'&&!isAbsolute(storageRelative));
  const adoptedPath=usesStorage?candidate:current.skill_path;
  if(!usesStorage)replacement=await installSkillSnapshot(current.skill_path,candidate,files);
  if(typeof project.parent_name==='string')await db.query('UPDATE ai_distill.projects SET local_skill_path=$1 WHERE parent_name=$2 AND deleted_at IS NULL',[adoptedPath,project.parent_name]);
  else await db.query('UPDATE ai_distill.projects SET local_skill_path=$2 WHERE id=$1',[id,adoptedPath]);
  await verifyRuleSnapshot(candidate,files);
  await invalidateProjectRuleOutputs(db,id);
  await db.query('COMMIT');
  if(replacement)try{await rm(replacement.backup,{recursive:true,force:true});}catch(error){logEvent('file.cleanup.failed',{level:'warn',component:'rules',file_kind:'project_skill_backup',...classifyLogError(error)});}
  return{local_skill_path:adoptedPath,workspace_path:workspace};
 }catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){logEvent('db.transaction.rollback_failed',{level:'error',component:'rules',...classifyLogError(rollbackError)});}if(replacement)await replacement.rollback();throw error;}finally{db.release();}
}
