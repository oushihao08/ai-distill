import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {scanRuleWorkspace,freezeRuleWorkspace} from './rule-files';
import {loadWorkflowRules} from './rule-loading';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'load-rules-'));roots.push(root);await mkdir(join(root,'materials'));await mkdir(join(root,'skill'));await writeFile(join(root,'materials','rules.md'),'标准');await writeFile(join(root,'skill','SKILL.md'),'---\nname: test\ndescription: Test\n---\n规则');
 const view=await scanRuleWorkspace(root,join(root,'skill'));const snapshot=await freezeRuleWorkspace(view,'test');
 const workflow:any={id:'workflow',project_id:'project',input_revision:1,rule_version_id:null};
 const versions:any[]=[{id:'v1',project_id:'project',version:1,status:'published',manifest:{...view,snapshot_path:snapshot}}];
 const attempts:any[]=[];let upstream='succeeded';let step='waiting';const calls:string[]=[];
 const query=async(sql:string,values:any[]=[])=>{
  calls.push(sql);
  if(sql.startsWith('SELECT w.'))return{rows:[workflow],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return{rows:[{ordinal:2,status:upstream},{ordinal:3,status:step}],rowCount:2};
  if(sql.startsWith('SELECT * FROM ai_distill.rule_versions'))return{rows:workflow.rule_version_id?versions.filter(v=>v.id===workflow.rule_version_id):[...versions].reverse().slice(0,1),rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:attempts.filter(a=>a.revision===workflow.input_revision).slice(-1),rowCount:attempts.length};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts')){attempts.push({id:values[0],revision:values[2],result:JSON.parse(values[3])});return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.workflows'))workflow.rule_version_id=values[1];
  if(sql.startsWith('UPDATE ai_distill.steps'))step='succeeded';
  return{rows:[],rowCount:0};
 };
 return{root,workflow,versions,attempts,calls,pool:{connect:async()=>({query,release(){}})}as unknown as Pool,setUpstream:(s:string)=>upstream=s,resetStep:()=>step='waiting'};
}
test('loading rules atomically binds a frozen version and records a reusable attempt',async()=>{const f=await fixture();const result=await loadWorkflowRules(f.pool,'workflow');expect(result.completed).toBe(true);expect(f.workflow.rule_version_id).toBe('v1');expect(f.attempts[0].result.source_digest).toBe(f.versions[0].manifest.source_digest);const again=await loadWorkflowRules(f.pool,'workflow');expect(again.id).toBe(result.id);expect(again.reused).toBe(true);expect(f.attempts).toHaveLength(1);});
test('rule loading requires completed extraction',async()=>{const f=await fixture();f.setUpstream('failed');await expect(loadWorkflowRules(f.pool,'workflow')).rejects.toThrow('提取');expect(f.calls).toContain('ROLLBACK');expect(f.attempts).toHaveLength(0);});
test('a newer draft blocks first binding instead of selecting obsolete published rules',async()=>{const f=await fixture();f.versions.push({...f.versions[0],id:'v2',version:2,status:'draft'});await expect(loadWorkflowRules(f.pool,'workflow')).rejects.toThrow('冻结');expect(f.workflow.rule_version_id).toBeNull();});
test('bound question keeps its rule version across rule updates and material revisions',async()=>{const f=await fixture();await loadWorkflowRules(f.pool,'workflow');f.versions.push({...f.versions[0],id:'v2',version:2,status:'published'});f.workflow.input_revision=2;f.resetStep();await loadWorkflowRules(f.pool,'workflow');expect(f.workflow.rule_version_id).toBe('v1');expect(f.attempts[1].result.rule_version_id).toBe('v1');});
test('tampered frozen rules cannot be reused even for an already loaded question',async()=>{const f=await fixture();await loadWorkflowRules(f.pool,'workflow');await writeFile(join(f.versions[0].manifest.snapshot_path,'skill','SKILL.md'),'tampered');await expect(loadWorkflowRules(f.pool,'workflow')).rejects.toThrow('快照');expect(f.attempts).toHaveLength(1);});
