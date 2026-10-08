import type {Pool,PoolClient} from 'pg';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {rm,realpath} from 'node:fs/promises';
import {HTTPException} from 'hono/http-exception';
import {scanRuleWorkspace,freezeRuleWorkspace,verifyRuleSnapshot,changeRuleFile,type RuleWorkspace} from './rule-files';
interface RuleManifest extends RuleWorkspace {snapshot_path?:string;execution_scope?:string;official_eligibility?:string;generation?:{attempt_id:string;source_digest:string;template_path:string;session_id:string;unresolved:{id:string;detail:string;blocking:boolean}[]}}
interface RuleVersion {id:string;project_id:string;version:number;status:string;manifest:RuleManifest;created_at?:string}
type Queryable=Pick<Pool,'query'>;
async function context(db:Queryable,id:string,locked=false,root?:string){
 try{
  const project=(await db.query(`SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL${locked?' FOR UPDATE':''}`,[id])).rows[0];
  if(!project)throw new HTTPException(404,{message:'项目不存在'});
  if(!project.local_skill_path)throw new HTTPException(409,{message:'请先设置本地skill目录'});
  const versions=(await db.query('SELECT * FROM ai_distill.rule_versions WHERE project_id=$1 ORDER BY version DESC',[id])).rows as RuleVersion[];
  const workspace=await scanRuleWorkspace(root??versions.find(row=>row.manifest.workspace_path)?.manifest.workspace_path??dirname(project.material_root??project.local_skill_path),project.local_skill_path);
  return{project,versions,workspace};
 }catch(error){throw error;}
}
async function draft(db:PoolClient,id:string,view:RuleWorkspace,versions:RuleVersion[]):Promise<RuleVersion>{
 try{
  const latest=versions[0];if(latest?.manifest.source_digest===view.source_digest)return latest;
  if(latest?.status==='draft')return (await db.query("UPDATE ai_distill.rule_versions SET manifest=$2 WHERE id=$1 AND status='draft' RETURNING *",[latest.id,JSON.stringify(view)])).rows[0];
  return (await db.query("INSERT INTO ai_distill.rule_versions(id,project_id,version,manifest) VALUES($1,$2,$3,$4) RETURNING *",[crypto.randomUUID(),id,(latest?.version??0)+1,JSON.stringify(view)])).rows[0];
 }catch(error){throw error;}
}
export async function readProjectRules(pool:Pool,id:string){
 try{
  const {workspace,versions}=await context(pool,id);const published=versions.find(row=>row.status==='published');
  return{workspace,versions,source_changed:!!published&&published.manifest.source_digest!==workspace.source_digest,draft_is_stale:versions[0]?.status==='draft'&&versions[0].manifest.source_digest!==workspace.source_digest};
 }catch(error){throw error;}
}
export async function registerProjectRules(pool:Pool,id:string,root:string){
 const db=await pool.connect();
 try{await db.query('BEGIN');const view=await context(db,id,true,root);const saved=await draft(db,id,view.workspace,view.versions);await db.query('COMMIT');return saved;}
 catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function publishProjectRules(pool:Pool,id:string,digest:string){
 const db=await pool.connect();let snapshot:string|undefined;let version:RuleVersion|undefined;
 try{
  await db.query('BEGIN');const {workspace,versions}=await context(db,id,true);
  if(workspace.source_digest!==digest)throw new HTTPException(409,{message:'规则资料已变化，请刷新后发布'});
  const latest=versions[0];
  if(latest?.status==='published'&&latest.manifest.source_digest===digest){
   if(!latest.manifest.snapshot_path)throw new HTTPException(409,{message:'规则版本缺少快照'});
   await verifyRuleSnapshot(latest.manifest.snapshot_path,latest.manifest.files);await db.query('COMMIT');return latest;
  }
  if(workspace.issues.length)throw new HTTPException(409,{message:`规则入口或引用不完整：${workspace.issues.join('；')}`});
  version=await draft(db,id,workspace,versions);
  snapshot=await freezeRuleWorkspace(workspace,`v${version.version}-${version.id}-${crypto.randomUUID().slice(0,8)}`);
  const manifest:RuleManifest={...workspace,...(version.manifest.generation?{generation:version.manifest.generation}:{}),snapshot_path:snapshot,execution_scope:'internal_preparation',official_eligibility:'unverified'};
  const saved=(await db.query("UPDATE ai_distill.rule_versions SET manifest=$2,status='published' WHERE id=$1 AND status='draft' RETURNING *",[version.id,JSON.stringify(manifest)])).rows[0] as RuleVersion;
  await db.query('COMMIT');return saved;
 }catch(error){
  try{await db.query('ROLLBACK');}catch{console.error('规则发布事务连接已中断');}
  if(snapshot&&version){
   try{const committed=await pool.query("SELECT id FROM ai_distill.rule_versions WHERE id=$1 AND status='published' AND manifest->>'snapshot_path'=$2",[version.id,snapshot]);if(!committed.rowCount)await rm(snapshot,{recursive:true,force:true});}
   catch{console.error('无法确认规则快照是否已发布，保留文件等待核对');}
  }
  throw error;
 }finally{db.release();}
}
export async function editProjectRuleFile(pool:Pool,id:string,path:string,bytes:Uint8Array|null,expected:string|null){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');const {workspace,versions}=await context(db,id,true);
  await changeRuleFile(workspace.workspace_path,path,bytes,expected);
  const updated=await scanRuleWorkspace(workspace.workspace_path,workspace.skill_path);
  const saved=await draft(db,id,updated,versions);await db.query('COMMIT');return saved;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

// Adoption registers a new draft; freezing uses the existing publication transaction.
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
  const versions=(await db.query('SELECT * FROM ai_distill.rule_versions WHERE project_id=$1 ORDER BY version DESC',[id])).rows as RuleVersion[];
  const workspace=versions.find(v=>v.manifest.workspace_path)?.manifest.workspace_path??dirname(project.material_root??project.local_skill_path??'');
  const source=await scanRuleWorkspace(workspace,task.input.template_path);
  if(source.source_digest!==task.input.source_digest)throw new HTTPException(409,{message:'生成来源已变化，请重新生成候选'});
  const view=await scanRuleWorkspace(workspace,candidate);
  if(view.issues.length)throw new HTTPException(409,{message:'候选入口或引用检查未通过'});
  const generation={attempt_id:attemptId,source_digest:task.input.source_digest,template_path:task.input.template_path,session_id:result.session_id,unresolved:result.unresolved};
  await db.query('UPDATE ai_distill.projects SET local_skill_path=$2 WHERE id=$1',[id,candidate]);
  const saved=await draft(db,id,{...view,generation} as RuleManifest,versions);
  await verifyRuleSnapshot(candidate,files);
  await db.query('COMMIT');return saved;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
