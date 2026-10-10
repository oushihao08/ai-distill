/** 验证出题队列拒绝过期材料版本，并稳定核验返修快照指纹。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';

import {enqueueAuthoring,hydrateRevisionEvaluationEvidence,runNextAuthoring,inputDigest} from './jobs';
import {scanProjectPrompt} from '../rule-files';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const empty={rows:[],rowCount:0};

test('revision history hydrates only the referenced answer and matching score record',async()=>{
 const answerText='模型完整答案',scoreText='考点1：1/2分，理由：答案没有写明条件。';
 const db={async query(sql:string){
  if(sql.includes('ordinal=5'))return{rows:[{id:'answer-1',status:'succeeded',result:{text:answerText,question_version:'qv1',answer_sha256:hash(answerText)}}]};
  if(sql.includes('ordinal=6'))return{rows:[{id:'score-1',status:'succeeded',input:{context:{binding:{answer_attempt_id:'answer-1',question_version:'qv1',rubric_version:'rv1'}}},result:{validation:{valid:true},raw_text:scoreText,report:{total:1,max_score:2}}}]};
  return empty;
 }} as any;
 const evidence={evaluation_records:[{attempt:1,models:[{model_id:'model-a',status:'not_passed',answer_attempt_id:'answer-1',score_attempt_id:'score-1',question_version:'qv1',rubric_version:'rv1',answer_sha256:hash(answerText),score_sha256:hash(scoreText)},{model_id:'legacy',status:'passed'}]}]};
 await expect(hydrateRevisionEvaluationEvidence(db,'workflow',evidence)).resolves.toEqual({evaluation_records:[{attempt:1,models:[{...evidence.evaluation_records[0]!.models[0],details_available:true,answer_text:answerText,score_text:scoreText,score_text_source:'raw_text',score_report:{total:1,max_score:2}},{model_id:'legacy',status:'passed',details_available:false}]}]});
});

async function projectFixture(){
 const root=await mkdtemp(join(tmpdir(),'fresh-author-jobs-')),skill=join(root,'skill');await mkdir(skill);
 await writeFile(join(skill,'SKILL.md'),'---\nname: fixture\ndescription: author\n---\n当前方法');
 await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',supported_reasoning_levels:[{effort:'low'}]},{slug:'project-model',supported_reasoning_levels:[{effort:'high'}]},{slug:'system-model',supported_reasoning_levels:[{effort:'medium'}]}]}));
 const state:any={title:'题目1',text:'脱敏材料100元',projectConfig:{provider:'codex',model:'fixture-model',reasoning_effort:'low'},projectDefault:null,job:null,reuse:null,active:false};
 const calls:{sql:string;values:any[]}[]=[];let saved:any;
 const query=async(sql:string,values:any[]=[]):Promise<any>=>{
  calls.push({sql,values});
  if(sql.includes("a.status='running' AND COALESCE(a.heartbeat_at"))return empty;
  if(sql.startsWith('SELECT a.*'))return{rows:state.job?[state.job]:[],rowCount:state.job?1:0};
  if(sql.startsWith('SELECT w.project_id'))return{rows:[{project_id:'project',project_name:'项目名称',title:state.title,source_key:'题目1',source_manifest:[],local_skill_path:skill,material_root:join(root,'questions'),ingestion_status:'succeeded',redaction_status:'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=9'))return{rows:[{id:'redaction'}],rowCount:1};
  if(sql.startsWith('SELECT ar.id'))return{rows:[{id:'attachment',sha256:hash(state.text)}],rowCount:1};
  if(sql.startsWith('SELECT sha256,content'))return{rows:[{sha256:hash(state.text),content:state.text}],rowCount:1};
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:state.projectConfig?[{config:state.projectConfig}]:[]};
  if(sql.startsWith('SELECT codex_model'))return{rows:[{codex_model:state.projectDefault?.model??null,codex_reasoning_effort:state.projectDefault?.reasoning_effort??null}]};
  if(sql.startsWith('SELECT credential_home,model'))return{rows:[{credential_home:root,model:'system-model',reasoning_effort:'medium'}]};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes("status IN ('waiting','running')"))return{rows:state.reuse?[{id:state.reuse}]:state.active?[{id:'active'}]:[],rowCount:state.reuse||state.active?1:0};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts'))saved={id:values[1],workflow_id:'workflow',input:JSON.parse(values[2]),config:JSON.parse(values[3])};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts WHERE id=$1'))return{rows:[{id:state.job?.id}],rowCount:1};
  if(sql.startsWith('SELECT status FROM ai_distill.step_attempts'))return{rows:[{status:'running'}],rowCount:1};
  return{rows:[],rowCount:sql.startsWith('SELECT')?0:1};
 };
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 return{root,skill,pool,state,calls,get saved(){return saved;}};
}
const authored={question_id:'题目1',draft:{task_name:'金额核算',task_type:'计算',header:{industry_l1:'行业',industry_l2:'细分',task_form:'single_round' as const,occupation_l1:'法律',occupation_l2:'法务'},question:'金额是多少？',attachment_ids:['attachment'],answer_approach:'核对材料',reference_answer:'100元',answer_requirements:{input_mode:'text' as const,output_mode:'text' as const,tools:[]},rubric:[{id:'R1',criterion:'准确写明金额',max_score:1}]},question_version:'qv1',rubric_version:'rv1',package_text:'题面',codex:{session_id:'new-session',usage:null,duration_ms:1}};

test.each([
 {label:'step',config:{provider:'codex',model:'fixture-model',reasoning_effort:'low'},defaults:null,expected:'fixture-model'},
 {label:'project',config:null,defaults:{model:'project-model',reasoning_effort:'high'},expected:'project-model'},
 {label:'system',config:null,defaults:null,expected:'system-model'},
])('fresh author enqueue freezes $label settings without querying question or score history',async({config,defaults,expected})=>{
 const f=await projectFixture();try{
  f.state.projectConfig=config;f.state.projectDefault=defaults;await enqueueAuthoring(f.pool,'workflow');
  expect(f.saved.config.model).toBe(expected);expect(f.saved.input.authoring_contract).toBe('fresh-desktop-v1');
  expect(f.saved.input.project_prompt.workspace_path).toBe(await realpath(f.root));expect(f.saved.input).not.toHaveProperty('evaluation_feedback');
  expect(f.calls.some(c=>c.sql.includes('SELECT id,result')&&c.sql.includes('ordinal=4'))).toBe(false);
  expect(f.calls.some(c=>c.sql.includes('ordinal=7')&&c.sql.startsWith('SELECT'))).toBe(false);
  const {digest,...input}=f.saved.input;expect(inputDigest(input)).toBe(digest);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('active attempts are reused while terminal reauthoring creates a new attempt',async()=>{
 const f=await projectFixture();try{
  const first=await enqueueAuthoring(f.pool,'workflow');f.state.reuse=first.id;
  expect(await enqueueAuthoring(f.pool,'workflow')).toEqual({id:first.id,reused:true});
  f.state.reuse=null;const next=await enqueueAuthoring(f.pool,'workflow');expect(next.id).not.toBe(first.id);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test.each(['none','attachments','title','skill'])('fresh author worker preserves current bindings and rejects late %s changes',async(change)=>{
 const f=await projectFixture();let received:any;try{
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  await runNextAuthoring(f.pool,join(f.root,'storage'),async options=>{received=options;if(change==='attachments')f.state.text='changed';if(change==='title')f.state.title='新题';if(change==='skill')await writeFile(join(f.skill,'SKILL.md'),'changed');return authored;});
  expect(received.workspace_path).toBe(await realpath(f.root));expect(received).not.toHaveProperty('evaluation_feedback');
  expect(received.materials).toEqual([{id:'attachment',sha256:hash('脱敏材料100元'),text:'脱敏材料100元'}]);
  const completed=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"));
  if(change==='none'){
   expect(completed).toBeDefined();const stored=JSON.parse(completed!.values[1]);expect(stored.reference_answer).toBe('100元');
   const artifact=f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'));expect(artifact?.values[3]).toBe('authored_question');expect(String(artifact?.values[7])).not.toContain('标准答案-文本');
  }else{expect(completed).toBeUndefined();expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))).toBe(true);}
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test.each([false,true])('old ordinary queued inputs never dispatch even with feedback=%s',async(feedback)=>{
 const f=await projectFixture();let called=false;try{
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;delete f.state.job.input.authoring_contract;
  if(feedback)f.state.job.input.evaluation_feedback={previous_question:{question:'旧题'}};
  const {digest,...input}=f.state.job.input;f.state.job.input.digest=inputDigest(input);
  await runNextAuthoring(f.pool,join(f.root,'storage'),async()=>{called=true;return authored;});
  expect(called).toBe(false);expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

 test('revision snapshot digest survives JSONB object key ordering without hiding evidence changes',()=>{
 const frozen:any={title:'题目',rule_version_id:'rule',rule_attempt_id:'rules',rule_source_digest:'digest',rule_snapshot_path:'path',rule_files:[],redaction_attempt_id:'redaction',materials:[],revision:{mode:'rubric',source_attempt_id:'source',chain_id:'chain',round_id:'round',evidence:{quality_check:{checks:{rubric_consistent:false,material_grounding:true},issues:[]}}}};
 const reordered=JSON.parse(JSON.stringify(frozen,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,value[key]])):value));
 expect(inputDigest(frozen)).toBe(inputDigest(reordered));
 reordered.revision.evidence.quality_check.checks.material_grounding=false;
 expect(inputDigest(frozen)).not.toBe(inputDigest(reordered));
 });


test('project identity participates in author input digest without changing legacy digests',()=>{
 const input:any={title:'题目1',project_prompt:{workspace_path:'/fixture',skill_path:'/fixture/skill',source_digest:'digest',files:[]},redaction_attempt_id:'redact',materials:[]};
 const legacy=hash(JSON.stringify(input));
 expect(inputDigest(input)).toBe(legacy);
 expect(inputDigest({...input,project_name:'项目A'})).not.toBe(inputDigest({...input,project_name:'项目B'}));
});


test('project author enqueue freezes the database project name and current file inputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-author-enqueue-'));
 try{
  const skill=join(root,'skill');await mkdir(skill);await writeFile(join(skill,'SKILL.md'),'---\nname: fixture\ndescription: author\n---\n项目方法');
  await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',supported_reasoning_levels:[{effort:'low'}]}]}));
  const project_prompt=await scanProjectPrompt(root,skill);let saved:any;
  const query=async(sql:string,values:any[]=[]):Promise<any>=>{
   if(sql.startsWith('SELECT w.project_id'))return{rows:[{project_id:'project',project_name:'数据库项目名称',title:'题目1',source_key:'题目1',source_manifest:[],local_skill_path:skill,material_root:join(root,'questions'),ingestion_status:'succeeded',redaction_status:'succeeded'}]};
   if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=9'))return{rows:[{id:'redaction'}]};
   if(sql.startsWith('SELECT ar.id'))return{rows:[{id:'attachment',sha256:'a'.repeat(64)}],rowCount:1};
   if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:[{config:{provider:'codex',model:'fixture-model',reasoning_effort:'low',prompt:'本次出题设置'}}]};
   if(sql.startsWith('SELECT codex_model'))return{rows:[{codex_model:null,codex_reasoning_effort:null}]};
   if(sql.startsWith('SELECT credential_home,model'))return{rows:[{credential_home:root,model:'fixture-model',reasoning_effort:'low'}]};
   if(sql.startsWith('INSERT INTO ai_distill.step_attempts'))saved=JSON.parse(values[2]);
   return{rows:[],rowCount:0};
  };
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
  await enqueueAuthoring(pool,'workflow');
  expect(saved).toMatchObject({project_name:'数据库项目名称',question_id:'题目1',project_prompt,materials:[{id:'attachment',sha256:'a'.repeat(64)}]});
  const {digest,...input}=saved;expect(digest).toBe(inputDigest(input));
 }finally{await rm(root,{recursive:true,force:true});}
});
