import {test,expect} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';

import {enqueueAuthoring,runNextAuthoring,inputDigest} from './jobs';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const empty={rows:[],rowCount:0};

test.each([
 {label:'a step override',projectConfig:{provider:'codex',model:'fixture-model',reasoning_effort:'medium'},projectDefault:null,expected:{provider:'codex',model:'fixture-model',reasoning_effort:'medium'}},
 {label:'the project default',projectConfig:null,projectDefault:{model:'project-model',reasoning_effort:'high'},expected:{provider:'codex',model:'project-model',reasoning_effort:'high'}},
 {label:'the system default when no override exists',projectConfig:null,projectDefault:null,expected:{provider:'codex',model:'system-model',reasoning_effort:'low'}},
 {label:'the project default without a manual rule-loading step',projectConfig:null,projectDefault:{model:'project-model',reasoning_effort:'high'},expected:{provider:'codex',model:'project-model',reasoning_effort:'high'},autoBind:true},
])('authoring enqueue freezes inputs and uses $label',async({projectConfig,projectDefault,expected,autoBind})=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-enqueue-'));
 const priorCodexHome=process.env.CODEX_HOME;process.env.CODEX_HOME=root;
 await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',supported_reasoning_levels:[{effort:'medium'}]},{slug:'project-model',supported_reasoning_levels:[{effort:'high'}]},{slug:'system-model',supported_reasoning_levels:[{effort:'low'}]}]}));
 const snapshot=join(root,'rules');await mkdir(join(snapshot,'skill'),{recursive:true});const ruleText='# 本期规则\n只按材料事实出题。';await writeFile(join(snapshot,'skill','SKILL.md'),ruleText);
 const ruleFile={path:'skill/SKILL.md',sha256:hash(ruleText),size_bytes:Buffer.byteLength(ruleText)};
 let ruleVersionId=autoBind?null:'rules-1';let ruleStatus=autoBind?'waiting':'succeeded';let ruleAttempt:any=autoBind?null:{id:'rules-attempt',revision:2,result:{input_revision:2,rule_version_id:'rules-1',source_digest:'c'.repeat(64),snapshot_path:snapshot,files:[ruleFile]}};
 const version={id:'rules-1',project_id:'project',version:1,status:'published',manifest:{source_digest:'c'.repeat(64),snapshot_path:snapshot,files:[ruleFile],issues:[]}};
 const saved:unknown[][]=[];
 const calls:string[]=[];
 const query=async(sql:string,values:unknown[]=[]):Promise<any>=>{
  calls.push(sql);
  if(sql.startsWith('SELECT w.*'))return{rows:[{id:'workflow',project_id:'project',input_revision:2,rule_version_id:ruleVersionId}],rowCount:1};
  if(sql.startsWith('SELECT ordinal,status'))return{rows:[{ordinal:1,status:'succeeded'},{ordinal:9,status:'succeeded'},{ordinal:3,status:ruleStatus}],rowCount:3};
  if(sql.startsWith('SELECT * FROM ai_distill.rule_versions'))return{rows:[version],rowCount:1};
  if(sql.startsWith('SELECT w.input_revision'))return{rows:[{input_revision:2,project_id:'project',title:'问题4',rule_version_id:ruleVersionId,ingestion_status:'succeeded',redaction_status:'succeeded',rules_status:ruleStatus}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=9'))return{rows:[{id:'redact-1'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=3'))return{rows:ruleAttempt?[{id:ruleAttempt.id}]:[],rowCount:ruleAttempt?1:0};
  if(sql.startsWith('SELECT id,result FROM ai_distill.step_attempts')&&sql.includes('ordinal=3'))return{rows:ruleAttempt?[ruleAttempt]:[],rowCount:ruleAttempt?1:0};
  if(sql.startsWith('SELECT ar.id'))return values[1]==='redact-1'?{rows:[{id:'attachment-1',kind:'redacted_markdown',sha256:'a'.repeat(64),storage_path:'workflow/attachment.md'}],rowCount:1}:empty;
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:projectConfig?[{config:projectConfig}]:[],rowCount:projectConfig?1:0};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{codex_model:projectDefault?.model??null,codex_reasoning_effort:projectDefault?.reasoning_effort??null}],rowCount:1};
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort FROM ai_distill.system_codex_config'))return{rows:[{credential_home:null,model:'system-model',reasoning_effort:'low'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes("status IN ('waiting','running')"))return empty;
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes("status IN ('waiting','running','succeeded')"))return empty;
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts')&&sql.includes('ordinal=3'))ruleAttempt={id:values[0],revision:values[2],result:JSON.parse(String(values[3]))};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts')&&sql.includes('ordinal=4'))saved.push(values);
  if(sql.startsWith('UPDATE ai_distill.workflows SET rule_version_id'))ruleVersionId=String(values[1]);
  if(sql.startsWith('UPDATE ai_distill.steps')&&sql.includes('ordinal=3'))ruleStatus='succeeded';
  return{...empty,rowCount:1};
 };
 const client={query,release(){}};const pool={query,connect:async()=>client} as unknown as Pool;
 try{
  const result=await enqueueAuthoring(pool,'workflow');
  expect(result).toMatchObject({reused:false,id:expect.any(String)});
  const input=JSON.parse(String(saved[0][2]));
  expect(input).toMatchObject({input_revision:2,title:'问题4',rule_version_id:'rules-1',rule_source_digest:'c'.repeat(64),rule_snapshot_path:snapshot,rule_files:[ruleFile],redaction_attempt_id:'redact-1',materials:[{id:'attachment-1',sha256:'a'.repeat(64)}]});
  expect(saved[0][0]).toBe('workflow');expect(JSON.parse(String(saved[0][3]))).toEqual(expected);expect(saved[0][4]).toBe(2);
  if(autoBind){expect(ruleStatus).toBe('succeeded');expect(ruleVersionId).toBe('rules-1');expect(calls.some(sql=>sql.startsWith('INSERT INTO ai_distill.step_attempts')&&sql.includes('ordinal=3'))).toBe(true);}
 }finally{if(priorCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=priorCodexHome;await rm(root,{recursive:true,force:true});}
});

test.each([{passed:true,tamper:false},{passed:false,tamper:false},{passed:true,tamper:true}])('authoring worker publishes only current, validated passing inputs: %j',async ({passed,tamper})=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-worker-'));const snapshot=join(root,'rules');await mkdir(join(snapshot,'skill'),{recursive:true});
 const ruleText='# 本期规则';await writeFile(join(snapshot,'skill','SKILL.md'),ruleText);const ruleFiles=[{path:'skill/SKILL.md',sha256:hash(ruleText),size_bytes:Buffer.byteLength(ruleText)}];
 const storage=join(root,'storage');await mkdir(join(storage,'workflow'),{recursive:true});const materialText='脱敏合同金额100元';await writeFile(join(storage,'workflow','attachment.md'),materialText);
 const materialHash=hash(materialText);const ruleResult={input_revision:2,rule_version_id:'rules-1',source_digest:'c'.repeat(64),snapshot_path:snapshot,files:ruleFiles};const frozen={input_revision:2,title:'问题4',rule_version_id:'rules-1',rule_attempt_id:'rules-attempt',rule_source_digest:ruleResult.source_digest,rule_snapshot_path:snapshot,rule_files:ruleFiles,redaction_attempt_id:'redact-1',materials:[{id:'attachment-1',sha256:materialHash}]};
 const job={id:'attempt-4',workflow_id:'workflow',input_revision:2,input:{...frozen,rule_files:ruleFiles.map(file=>({size_bytes:file.size_bytes,sha256:file.sha256,path:file.path})),materials:frozen.materials.map(item=>({sha256:item.sha256,id:item.id})),digest:hash(JSON.stringify(frozen))},config:{provider:'codex',model:'fixture-model',reasoning_effort:'medium'}};
 const quality={passed,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]};
 const result={input_revision:2,question_version:'qv1',question:'金额是多少？',attachment_ids:['attachment-1'],quality_check:quality,answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:'rv1',rubric:[{id:'amount',criterion:'准确写明金额',max_score:1}],codex:{author:{session_id:'author-session',usage:{input_tokens:10},duration_ms:10},review:{session_id:'review-session',usage:{input_tokens:20},duration_ms:20}}};
 const calls:{sql:string;values:unknown[]}[]=[];let authorInput:any;
 const query=async(sql:string,values:unknown[]=[]):Promise<any>=>{
  calls.push({sql,values});
  if(sql.includes("a.status='running' AND COALESCE(a.heartbeat_at"))return empty;
  if(sql.startsWith('SELECT a.*'))return{rows:[job],rowCount:1};
  if(sql.startsWith('SELECT w.input_revision'))return{rows:[{input_revision:2,project_id:'project',title:'问题4',rule_version_id:'rules-1',ingestion_status:'succeeded',redaction_status:'succeeded',rules_status:'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=9'))return{rows:[{id:'redact-1'}],rowCount:1};
  if(sql.startsWith('SELECT id,result FROM ai_distill.step_attempts')&&sql.includes('ordinal=3'))return{rows:[{id:'rules-attempt',result:ruleResult}],rowCount:1};
  if(sql.startsWith('SELECT ar.id'))return{rows:[{id:'attachment-1',sha256:materialHash}],rowCount:1};
  if(sql.startsWith('SELECT storage_path,sha256'))return{rows:[{sha256:materialHash,storage_path:'workflow/attachment.md'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status=\'running\''))return{rows:[{id:job.id}],rowCount:1};
  if(sql.startsWith('SELECT status FROM ai_distill.step_attempts'))return{rows:[{status:'running'}],rowCount:1};
  return{rows:[],rowCount:1};
 };
 const client={query,release(){}};const pool={query,connect:async()=>client} as unknown as Pool;
 try{
  const worked=await runNextAuthoring(pool,storage,async options=>{authorInput=options;if(tamper)await writeFile(join(storage,'workflow','attachment.md'),'changed bytes');return result as any;});
  expect(worked).toBe(true);expect(authorInput.input_revision).toBe(2);expect(authorInput.materials).toEqual([{id:'attachment-1',sha256:materialHash,text:materialText}]);expect(authorInput.rules.files.map((file:any)=>({path:file.path,text:new TextDecoder().decode(file.bytes)}))).toEqual([{path:'skill/SKILL.md',text:ruleText}]);
  expect(calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts')&&call.values[3]==='authored_question')).toBe(passed&&!tamper);
  if(!passed||tamper){expect(calls.some(call=>call.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(false);return;}
  const published=JSON.parse(String(calls.find(call=>call.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))?.values[1]));expect(published).not.toHaveProperty('reference_answer');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('authoring worker never dispatches an attempt from a stale material revision',async()=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-stale-'));const snapshot=join(root,'rules');await mkdir(join(snapshot,'skill'),{recursive:true});const ruleText='规则';await writeFile(join(snapshot,'skill','SKILL.md'),ruleText);const rules=[{path:'skill/SKILL.md',sha256:hash(ruleText),size_bytes:Buffer.byteLength(ruleText)}];
 const frozen={input_revision:1,title:'问题',rule_version_id:'rules-1',rule_attempt_id:'rules-attempt',rule_source_digest:'c'.repeat(64),rule_snapshot_path:snapshot,rule_files:rules,redaction_attempt_id:'redact-1',materials:[{id:'attachment-1',sha256:'a'.repeat(64)}]};const job={id:'attempt',workflow_id:'workflow',input_revision:1,input:{...frozen,digest:hash(JSON.stringify(frozen))},config:{provider:'codex',model:'fixture',reasoning_effort:'low'}};let called=false;
 const query=async(sql:string):Promise<any>=>sql.includes("a.status='running' AND COALESCE(a.heartbeat_at")?empty:sql.startsWith('SELECT a.*')?{rows:[job],rowCount:1}:sql.startsWith('SELECT w.input_revision')?{rows:[{input_revision:2,project_id:'project',title:'问题',rule_version_id:'rules-1',ingestion_status:'succeeded',redaction_status:'succeeded',rules_status:'succeeded'}],rowCount:1}:sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=9')?{rows:[{id:'redact-1'}],rowCount:1}:sql.startsWith('SELECT id,result FROM ai_distill.step_attempts')&&sql.includes('ordinal=3')?{rows:[{id:'rules-attempt',result:{input_revision:2,rule_version_id:'rules-1',source_digest:'c'.repeat(64),snapshot_path:snapshot,files:rules}}],rowCount:1}:sql.startsWith('SELECT ar.id')?{rows:[{id:'attachment-1',sha256:'a'.repeat(64)}],rowCount:1}:empty;
 const client={query,release(){}};const pool={query,connect:async()=>client} as unknown as Pool;
 try{await runNextAuthoring(pool,root,async()=>{called=true;throw new Error('should not execute');});expect(called).toBe(false);}finally{await rm(root,{recursive:true,force:true});}
});

test.each(['revision','title'])('late authoring cannot publish after its %s changes',async changed=>{
 const root=await mkdtemp(join(tmpdir(),'authoring-late-'));const snapshot=join(root,'rules');await mkdir(join(snapshot,'skill'),{recursive:true});const ruleText='冻结规则';await writeFile(join(snapshot,'skill','SKILL.md'),ruleText);const ruleFiles=[{path:'skill/SKILL.md',sha256:hash(ruleText),size_bytes:Buffer.byteLength(ruleText)}];
 const text='脱敏材料';const materialHash=hash(text);await mkdir(join(root,'storage','workflow'),{recursive:true});await writeFile(join(root,'storage','workflow','material.md'),text);
 const ruleResult={input_revision:1,rule_version_id:'rules-1',source_digest:'c'.repeat(64),snapshot_path:snapshot,files:ruleFiles};const frozen={input_revision:1,title:'问题',rule_version_id:'rules-1',rule_attempt_id:'rules-attempt',rule_source_digest:ruleResult.source_digest,rule_snapshot_path:snapshot,rule_files:ruleFiles,redaction_attempt_id:'redact-1',materials:[{id:'attachment-1',sha256:materialHash}]};const job={id:'attempt-late',workflow_id:'workflow',input_revision:1,input:{...frozen,digest:hash(JSON.stringify(frozen))},config:{provider:'codex',model:'fixture-model',reasoning_effort:'low'}};
 const quality={passed:true,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]};const authored={input_revision:1,question_version:'qv1',question:'题目',attachment_ids:['attachment-1'],quality_check:quality,answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:'rv1',rubric:[{id:'criterion',criterion:'判分条件',max_score:1}],codex:{author:{session_id:'author',usage:null,duration_ms:1},review:{session_id:'review',usage:null,duration_ms:1}}};
 let revision=1,title='问题';const calls:string[]=[];const query=async(sql:string):Promise<any>=>{calls.push(sql);if(sql.includes("a.status='running' AND COALESCE(a.heartbeat_at"))return empty;if(sql.startsWith('SELECT a.*'))return{rows:[job],rowCount:1};if(sql.startsWith('SELECT w.input_revision'))return{rows:[{input_revision:revision,project_id:'project',title,rule_version_id:'rules-1',ingestion_status:'succeeded',redaction_status:'succeeded',rules_status:'succeeded'}],rowCount:1};if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=9'))return{rows:[{id:'redact-1'}],rowCount:1};if(sql.startsWith('SELECT id,result FROM ai_distill.step_attempts')&&sql.includes('ordinal=3'))return{rows:[{id:'rules-attempt',result:ruleResult}],rowCount:1};if(sql.startsWith('SELECT ar.id'))return{rows:[{id:'attachment-1',sha256:materialHash}],rowCount:1};if(sql.startsWith('SELECT storage_path,sha256'))return{rows:[{storage_path:'workflow/material.md',sha256:materialHash}],rowCount:1};return{rows:[],rowCount:1};};
 const client={query,release(){}};const pool={query,connect:async()=>client} as unknown as Pool;
 try{await runNextAuthoring(pool,join(root,'storage'),async()=>{if(changed==='revision')revision=2;else title='新问题';return authored as any;});expect(calls.some(sql=>sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);expect(calls.some(sql=>sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(false);expect(calls.some(sql=>sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))).toBe(true);if(changed==='title')expect(calls.some(sql=>sql.startsWith("UPDATE ai_distill.steps SET status='failed'"))).toBe(true);}finally{await rm(root,{recursive:true,force:true});}
});

 test('revision snapshot digest survives JSONB object key ordering without hiding evidence changes',()=>{
 const frozen:any={input_revision:1,title:'题目',rule_version_id:'rule',rule_attempt_id:'rules',rule_source_digest:'digest',rule_snapshot_path:'path',rule_files:[],redaction_attempt_id:'redaction',materials:[],revision:{mode:'rubric',source_attempt_id:'source',chain_id:'chain',round_id:'round',evidence:{quality_check:{checks:{rubric_consistent:false,material_grounding:true},issues:[]}}}};
 const reordered=JSON.parse(JSON.stringify(frozen,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,value[key]])):value));
 expect(inputDigest(frozen)).toBe(inputDigest(reordered));
 reordered.revision.evidence.quality_check.checks.material_grounding=false;
 expect(inputDigest(frozen)).not.toBe(inputDigest(reordered));
 });
