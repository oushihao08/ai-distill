/** 验证出题队列拒绝过期材料版本并稳定核验输入指纹。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';

import {enqueueAuthoring,runNextAuthoring,inputDigest} from './jobs';
import {scanProjectPrompt} from '../rule-files';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const empty={rows:[],rowCount:0};

async function projectFixture(){
 const root=await mkdtemp(join(tmpdir(),'fresh-author-jobs-')),skill=join(root,'skill');await mkdir(skill);
 await writeFile(join(skill,'SKILL.md'),'---\nname: fixture\ndescription: author\n---\n当前方法');
 await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',supported_reasoning_levels:[{effort:'low'}]},{slug:'project-model',supported_reasoning_levels:[{effort:'high'}]},{slug:'system-model',supported_reasoning_levels:[{effort:'medium'}]}]}));
 const state:any={title:'题目1',text:'脱敏材料100元',projectConfig:{provider:'codex',model:'fixture-model',reasoning_effort:'low'},projectDefault:null,job:null,reuse:null,active:false,hookRuns:new Map()};
 const calls:{sql:string;values:any[]}[]=[];let saved:any;
 const query=async(sql:string,values:any[]=[]):Promise<any>=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT * FROM ai_distill.hook_runs')){const row=[...state.hookRuns.values()].find((r:any)=>r.attempt_id===values[0]&&r.position===values[1]&&r.action_id===values[2]);return {rows:row?[structuredClone(row)]:[],rowCount:row?1:0};}
  if(sql.startsWith('INSERT INTO ai_distill.hook_runs')){const row={id:values[0],workflow_id:values[1],attempt_id:values[2],stage:values[3],position:values[4],action_id:values[5],mode:values[6],binding_digest:values[7],snapshot:JSON.parse(values[8]),idempotent:values[9],status:'waiting'};state.hookRuns.set(row.id,row);return {rows:[structuredClone(row)],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.hook_runs')){const row=state.hookRuns.get(values[0]);if(!row)return empty;row.status=values[1];row.result=values[2]?JSON.parse(values[2]):null;row.result_digest=values[4];return {rows:[structuredClone(row)],rowCount:1};}

  if(sql.includes("a.status='running' AND COALESCE(a.heartbeat_at"))return empty;
  if(sql.startsWith('SELECT a.*'))return{rows:state.job?[state.job]:[],rowCount:state.job?1:0};
  if((sql.startsWith('SELECT w.project_id')||sql.startsWith('SELECT w.*')))return{rows:[{project_id:'project',project_name:'项目名称',title:state.title,source_key:'题目1',source_manifest:[],local_skill_path:skill,material_root:join(root,'questions'),ingestion_status:'succeeded',redaction_status:'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=9'))return{rows:[{id:'redaction'}],rowCount:1};
  if(sql.startsWith('SELECT ar.id'))return{rows:[{id:'attachment',sha256:hash(state.text)}],rowCount:1};
  if(sql.startsWith('SELECT sha256,content'))return{rows:[{sha256:hash(state.text),content:state.text,sources:state.originalNames?.map((original_name:string)=>({original_name}))}],rowCount:1};
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs')&&sql.includes('ordinal=6'))return {rows:state.scoreWorkflow?[{config:{workflow:state.scoreWorkflow}}]:[]};
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

test('上传材料原文件名从数据库传入作者并用于公开题包表头',async()=>{
 const f=await projectFixture();try{
  f.state.originalNames=['上传判决.docx','附件二.txt'];await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  await runNextAuthoring(f.pool,f.root,async options=>{expect(options.materials[0]?.source_names).toEqual(['上传判决.docx','附件二.txt']);return authored;});
  const artifact=f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'));
  expect(artifact?.values[7]).toContain('输入附件：\n上传判决.docx\n附件二.txt');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

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
test.each([
 ['result_missing','出题会话已结束，但未生成 result.json'],
 ['result_validation_failed','出题结果未通过程序校验'],
 ['codex_timeout','出题执行超过本次时限，未取得通过校验的完整题目'],
])('出题失败 %s 保存安全原因码和明确说明',async(reasonCode,message)=>{
 const f=await projectFixture();try{
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  await runNextAuthoring(f.pool,join(f.root,'storage'),async()=>{throw Object.assign(new Error('private detail'),{reason_code:reasonCode});});
  const failed=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"));
  expect(JSON.parse(failed!.values[1])).toMatchObject({error_code:reasonCode});
  expect(failed!.values[2]).toContain(message);expect(failed!.values[2]).not.toContain('private detail');
  if(reasonCode==='codex_timeout')expect(failed!.values[2]).not.toContain('已有草稿');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('出题任务冻结项目级超时并传入作者执行器',async()=>{
 const f=await projectFixture();try{
  f.state.projectConfig.timeout_ms=3600000;await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  expect(f.saved.config.timeout_ms).toBe(3600000);
  await runNextAuthoring(f.pool,join(f.root,'storage'),async options=>{expect(options.timeout_ms).toBe(3600000);return authored;});
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


test('project identity participates in author input digest without changing legacy digests',()=>{
 const input:any={title:'题目1',project_prompt:{workspace_path:'/fixture',skill_path:'/fixture/skill',source_digest:'digest',files:[]},redaction_attempt_id:'redact',materials:[]};
 const legacy=hash(JSON.stringify(input));
 expect(inputDigest(input)).toBe(legacy);
 expect(inputDigest({...input,project_name:'项目A'})).not.toBe(inputDigest({...input,project_name:'项目B'}));
});
test('派生题目的场景、角色和等级参与出题输入指纹',()=>{
 const input:any={title:'题目1',project_prompt:{workspace_path:'/fixture',skill_path:'/fixture/skill',source_digest:'digest',files:[]},redaction_attempt_id:'redact',materials:[]};
 const l2=inputDigest({...input,design_context:{scenario:'LS02',role_perspective:'代理律师',target_level:'L2'}});
 expect(l2).toBe(hash(JSON.stringify({title:'题目1',design_context:{scenario:'LS02',role_perspective:'代理律师',target_level:'L2'},project_prompt:{workspace_path:'/fixture',skill_path:'/fixture/skill',source_digest:'digest',files:[]},redaction_attempt_id:'redact',materials:[]})));
 expect(inputDigest({...input,design_context:{target_level:'L2',scenario:'LS02',role_perspective:'代理律师'}})).toBe(l2);
 expect(l2).not.toBe(inputDigest({...input,design_context:{scenario:'LS02',role_perspective:'代理律师',target_level:'L4'}}));
 expect(l2).not.toBe(inputDigest({...input,design_context:{scenario:'LS04',role_perspective:'代理律师',target_level:'L2'}}));
 expect(l2).not.toBe(inputDigest({...input,design_context:{scenario:'LS02',role_perspective:'客户',target_level:'L2'}}));
});


test('project author enqueue freezes the database project name and current file inputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-author-enqueue-'));
 try{
  const skill=join(root,'skill');await mkdir(skill);await writeFile(join(skill,'SKILL.md'),'---\nname: fixture\ndescription: author\n---\n项目方法');
  await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',supported_reasoning_levels:[{effort:'low'}]}]}));
  const project_prompt=await scanProjectPrompt(root,skill);let saved:any;
  const query=async(sql:string,values:any[]=[]):Promise<any>=>{
   if((sql.startsWith('SELECT w.project_id')||sql.startsWith('SELECT w.*')))return{rows:[{project_id:'project',project_name:'数据库项目名称',title:'题目1',source_key:'题目1',source_manifest:[],local_skill_path:skill,material_root:join(root,'questions'),ingestion_status:'succeeded',redaction_status:'succeeded'}]};
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

// 评分规则是出题时冻结的输入；当前项目配置改变不改写已排队题目的计分口径。
test('作者队列冻结同一评分规则并保存到题目，后续设置变化不替换它',async()=>{
 const f=await projectFixture();let received:any;
 try{
  f.state.scoreWorkflow={contract:'model_report_v1',rules_text:'金额错误扣7分，否决独立记录',reference_answer:'calibration'};
  await enqueueAuthoring(f.pool,'workflow');
  expect(f.saved.input.scoring_policy).toEqual(f.state.scoreWorkflow);
  const {digest,...frozen}=f.saved.input;
  expect(inputDigest({...frozen,scoring_policy:{...frozen.scoring_policy,rules_text:'另一规则'}})).not.toBe(digest);
  f.state.job=f.saved;f.state.scoreWorkflow={...f.state.scoreWorkflow,rules_text:'修改后的规则'};
  await runNextAuthoring(f.pool,join(f.root,'storage'),async options=>{received=options;return {...authored,draft:{...authored.draft,rubric:[{id:'deduct',criterion:'金额错误',rule:'金额错误扣7分'}]}};});
  expect(received.scoring_policy.rules_text).toBe('金额错误扣7分，否决独立记录');
  const saved=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"));
  expect(saved).toBeDefined();expect(JSON.parse(saved!.values[1]).scoring_policy).toEqual(f.saved.input.scoring_policy);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('作者阶段冻结并实际执行前后钩子，附加结果不修改题包',async()=>{
 const f=await projectFixture();let called=0;
 try{
  await mkdir(join(f.root,'hooks'));await writeFile(join(f.root,'hooks/check.ts'),"const input=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({notes:[input.position],data:{stage:input.stage}}));");
  const action={id:'check',script:'hooks/check.ts',files:['hooks/check.ts'],mode:'sync',params:{},timeout_ms:1000,idempotent:true};
  f.state.projectConfig.workflow={hooks:{before:[action],after:[action]}};
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  expect(f.saved.input.hooks.before[0].files[0].sha256).toHaveLength(64);
  await runNextAuthoring(f.pool,join(f.root,'storage'),async()=>{called++;return authored;});
  expect(called).toBe(1);
  expect([...f.state.hookRuns.values()].filter((r:any)=>r.position!=='main').map((r:any)=>r.result.notes)).toEqual([['before'],['after']]);
  const completed=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"));
  expect(JSON.parse(completed!.values[1]).question).toBe(authored.draft.question);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('后置钩子失败保留检查点并向续跑入口记录明确失败标记',async()=>{
 const f=await projectFixture();let called=0;
 try{
  await mkdir(join(f.root,'hooks'));await writeFile(join(f.root,'hooks/fail.ts'),"throw new Error('private failure');");
  f.state.projectConfig.workflow={hooks:{after:[{id:'check',script:'hooks/fail.ts',files:['hooks/fail.ts'],idempotent:true}]}};
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  await runNextAuthoring(f.pool,join(f.root,'storage'),async()=>{called++;return authored;});
  const failed=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"));
  expect(JSON.parse(failed!.values[1])).toMatchObject({error_code:'project_hook_failed'});
  expect([...f.state.hookRuns.values()].find((r:any)=>r.position==='main')).toMatchObject({status:'succeeded',result:authored});expect(called).toBe(1);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('续跑后的作者worker复用主检查点，实际后置脚本恢复后只调用一次主模型',async()=>{
 const f=await projectFixture();let mainCalls=0;
 try{
  await mkdir(join(f.root,'hooks'));
  await writeFile(join(f.root,'hooks/retry.ts'),"import {existsSync,writeFileSync} from 'node:fs';const p=JSON.parse(await Bun.stdin.text());if(!existsSync(p.params.marker)){writeFileSync(p.params.marker,'done');throw new Error('first try');}console.log(JSON.stringify({notes:['恢复完成']}));");
  f.state.projectConfig.workflow={hooks:{after:[{id:'retry',script:'hooks/retry.ts',files:['hooks/retry.ts'],params:{marker:join(f.root,'marker')},idempotent:true}]}};
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  const author=async()=>{mainCalls++;return authored;};
  await runNextAuthoring(f.pool,join(f.root,'storage'),author);
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(false);
  // 模拟续跑 API 已将同一失败尝试退回 waiting；SQL替身在下次领取时返回同一冻结任务。
  await runNextAuthoring(f.pool,join(f.root,'storage'),author);
  expect(mainCalls).toBe(1);expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(true);
  expect([...f.state.hookRuns.values()].find((r:any)=>r.position==='after').result.notes).toEqual(['恢复完成']);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('Work内容契约由项目配置冻结并传入作者',async()=>{
 const f=await projectFixture();try{
  f.state.projectConfig={provider:'codex',model:'fixture-model',reasoning_effort:'low',workflow:{content_contract:'work_legal_v1',contract:'legacy',rules_text:'',reference_answer:'none',hooks:{before:[],after:[]}}};
  f.state.scoreWorkflow={contract:'model_report_v1',rules_text:'Work规则',reference_answer:'none',hooks:{before:[],after:[]}};
  await enqueueAuthoring(f.pool,'workflow');expect(f.saved.input.content_contract).toBe('work_legal_v1');f.state.job=f.saved;
  let called=false;await runNextAuthoring(f.pool,f.root,async options=>{called=true;expect(options.content_contract).toBe('work_legal_v1');return authored;});expect(called).toBe(true);
  const saved=f.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=\'succeeded\''));expect(saved).toBeDefined();
 }finally{await rm(f.root,{recursive:true,force:true});}
});


test('内容契约配置变化后拒绝旧尝试发布且不调用作者',async()=>{
 const f=await projectFixture();try{
  f.state.projectConfig={provider:'codex',model:'fixture-model',reasoning_effort:'low',workflow:{content_contract:'work_legal_v1'}};
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;f.state.projectConfig={provider:'codex',model:'fixture-model',reasoning_effort:'low'};
  let called=false;await runNextAuthoring(f.pool,f.root,async()=>{called=true;return authored;});expect(called).toBe(false);
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(false);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
