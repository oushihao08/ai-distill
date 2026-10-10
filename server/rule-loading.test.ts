/** 题目规则绑定流程：验证事务内绑定冻结版本、脱敏前置条件、草稿变化后的绑定选择、材料更新后的历史绑定保留及快照篡改拒绝。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {scanRuleWorkspace,freezeRuleWorkspace} from './rule-files';
import {loadWorkflowRules} from './rule-loading';
import {configureLogger} from './logging';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'load-rules-'));roots.push(root);await mkdir(join(root,'materials'));await mkdir(join(root,'skill'));await writeFile(join(root,'materials','rules.md'),'标准');await writeFile(join(root,'skill','SKILL.md'),'---\nname: test\ndescription: Test\n---\n规则');
 const view=await scanRuleWorkspace(root,join(root,'skill'));const snapshot=await freezeRuleWorkspace(view,'test');
 const workflow:any={id:'workflow',project_id:'project',rule_version_id:null};
 const versions:any[]=[{id:'v1',project_id:'project',version:1,status:'published',manifest:{...view,snapshot_path:snapshot}}];
 const attempts:any[]=[];let redaction='succeeded';let step='waiting';const calls:string[]=[];
 const query=async(sql:string,values:any[]=[])=>{
  calls.push(sql);
  if(sql.startsWith('SELECT w.'))return{rows:[workflow],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return{rows:[{ordinal:1,status:'succeeded'},{ordinal:3,status:step},{ordinal:9,status:redaction}],rowCount:3};
  if(sql.startsWith('SELECT * FROM ai_distill.rule_versions'))return{rows:workflow.rule_version_id?versions.filter(v=>v.id===workflow.rule_version_id):[...versions].reverse().slice(0,1),rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:attempts.slice(-1),rowCount:attempts.length};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts')){attempts.push({id:values[0],result:JSON.parse(values[2])});return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.workflows'))workflow.rule_version_id=values[1];
  if(sql.startsWith('UPDATE ai_distill.steps'))step='succeeded';
  return{rows:[],rowCount:0};
 };
 return{root,workflow,versions,attempts,calls,pool:{connect:async()=>({query,release(){}})}as unknown as Pool,setRedaction:(s:string)=>redaction=s,resetStep:()=>step='waiting'};
}
test('loading rules atomically binds a frozen version and records a reusable attempt',async()=>{const f=await fixture();const result=await loadWorkflowRules(f.pool,'workflow');expect(result.completed).toBe(true);expect(f.workflow.rule_version_id).toBe('v1');expect(f.attempts[0].result.source_digest).toBe(f.versions[0].manifest.source_digest);const again=await loadWorkflowRules(f.pool,'workflow');expect(again.id).toBe(result.id);expect(again.reused).toBe(true);expect(f.attempts).toHaveLength(1);});
test('rule binding writes correlated lifecycle events for the hidden workflow step',async()=>{
 const f=await fixture(),root=await mkdtemp(join(tmpdir(),'rule-binding-logs-'));roots.push(root);const logger=configureLogger({root,service:'worker'});
 try{
  await loadWorkflowRules(f.pool,'workflow');await logger.flush();const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({event:'attempt.started',component:'rules',operation:'rule_binding',workflow_id:'workflow',project_id:'project',ordinal:3,state:'running'}));
  expect(records).toContainEqual(expect.objectContaining({event:'attempt.completed',component:'rules',operation:'rule_binding',workflow_id:'workflow',project_id:'project',ordinal:3,state:'succeeded'}));
 }finally{await logger.close();}
});
test('rule binding requires completed redaction',async()=>{const f=await fixture();f.setRedaction('failed');await expect(loadWorkflowRules(f.pool,'workflow')).rejects.toThrow('脱敏');expect(f.calls).toContain('ROLLBACK');expect(f.attempts).toHaveLength(0);});
test('a newer draft blocks first binding instead of selecting obsolete published rules',async()=>{const f=await fixture();f.versions.push({...f.versions[0],id:'v2',version:2,status:'draft'});await expect(loadWorkflowRules(f.pool,'workflow')).rejects.toThrow('冻结');expect(f.workflow.rule_version_id).toBeNull();});
test('bound question keeps its rule version across rule updates and material revisions',async()=>{const f=await fixture();await loadWorkflowRules(f.pool,'workflow');f.versions.push({...f.versions[0],id:'v2',version:2,status:'published'});f.resetStep();await loadWorkflowRules(f.pool,'workflow');expect(f.workflow.rule_version_id).toBe('v1');expect(f.attempts[1].result.rule_version_id).toBe('v1');});
test('tampered frozen rules cannot be reused even for an already loaded question',async()=>{const f=await fixture();await loadWorkflowRules(f.pool,'workflow');await writeFile(join(f.versions[0].manifest.snapshot_path,'skill','SKILL.md'),'tampered');await expect(loadWorkflowRules(f.pool,'workflow')).rejects.toThrow('快照');expect(f.attempts).toHaveLength(1);});
