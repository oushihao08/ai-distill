import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {verifyRuleSnapshot,type RuleWorkspace} from './rule-files';
// Loading a local frozen snapshot finishes in one transaction; it does not invoke Codex.
export async function loadWorkflowRules(pool:Pool,workflowId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query('SELECT w.* FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE OF w',[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'题目不存在'});
  const steps=(await db.query('SELECT ordinal,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal IN (1,3,9)',[workflowId])).rows;
  if(steps.find(s=>s.ordinal===1)?.status!=='succeeded')throw new HTTPException(409,{message:'请先完成材料入库'});
  if(steps.find(s=>s.ordinal===9)?.status!=='succeeded')throw new HTTPException(409,{message:'请先完成独立脱敏与检查'});
  const version=(await db.query(workflow.rule_version_id?'SELECT * FROM ai_distill.rule_versions WHERE id=$1 AND project_id=$2': 'SELECT * FROM ai_distill.rule_versions WHERE project_id=$1 ORDER BY version DESC LIMIT 1',workflow.rule_version_id?[workflow.rule_version_id,workflow.project_id]:[workflow.project_id])).rows[0];
  if(!version||version.status!=='published')throw new HTTPException(409,{message:'请先冻结当前项目资料与skill版本'});
  const manifest=version.manifest as RuleWorkspace&{snapshot_path?:string;execution_scope?:string;official_eligibility?:string};
  if(!manifest.snapshot_path||!manifest.source_digest||!Array.isArray(manifest.files)||!manifest.files.some(f=>f.path==='skill/SKILL.md')||manifest.issues?.length)throw new HTTPException(409,{message:'规则版本缺少完整skill快照'});
  await verifyRuleSnapshot(manifest.snapshot_path,manifest.files);
  const existing=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=3 AND input_revision=$2 AND status='succeeded' AND result->>'rule_version_id'=$3 ORDER BY attempt DESC LIMIT 1",[workflowId,workflow.input_revision,version.id])).rows[0];
  if(existing&&steps.find(s=>s.ordinal===3)?.status==='succeeded'){await db.query('COMMIT');return{id:existing.id,reused:true,completed:true,status:'succeeded' as const};}
  const id=crypto.randomUUID();
  const result={rule_version_id:version.id,version:version.version,source_digest:manifest.source_digest,snapshot_path:manifest.snapshot_path,skill_entry:'skill/SKILL.md',files:manifest.files,assessment:manifest.assessment,unresolved:manifest.unresolved,execution_scope:manifest.execution_scope??'internal_preparation',official_eligibility:manifest.official_eligibility??'unverified',input_revision:workflow.input_revision};
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,result,input,finished_at) SELECT $1,$2::uuid,3,COALESCE(max(attempt),0)+1,'succeeded',$3,$4,$5,now() FROM ai_distill.step_attempts WHERE workflow_id=$2::uuid AND ordinal=3",[id,workflowId,workflow.input_revision,JSON.stringify(result),JSON.stringify({input_revision:workflow.input_revision,rule_version_id:version.id})]);
  await db.query('UPDATE ai_distill.workflows SET rule_version_id=$2 WHERE id=$1',[workflowId,version.id]);
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='succeeded',result=$2,error=NULL,started_at=now(),finished_at=now() WHERE workflow_id=$1 AND ordinal=3",[workflowId,JSON.stringify(result)]);
  await db.query('COMMIT');return{id,reused:false,completed:true,status:'succeeded' as const};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
