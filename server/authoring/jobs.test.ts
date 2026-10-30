/** 验证出题队列拒绝过期材料版本并稳定核验输入指纹。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {LocalQueue} from '../execution-queue/store';
import {withLocalExecution,PendingLocalCommit} from '../execution-queue/runtime';
import {test,expect,beforeAll,afterAll} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';

import {enqueueAuthoring,runNextAuthoring,inputDigest} from './jobs';
import {scanProjectPrompt} from '../rule-files';
import {canonicalJson} from '../../shared/workflow-config';
import {AUTHORING_FIXED_PROMPT} from '../../shared/step-prompts';
// SQL替身不得继承工作台local模式并向真实队列登记意图。
const originalQueueMode=process.env.EXECUTION_QUEUE_MODE;
beforeAll(()=>{process.env.EXECUTION_QUEUE_MODE='legacy';});
afterAll(()=>{if(originalQueueMode===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=originalQueueMode;});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const empty={rows:[],rowCount:0};

test('JSONB重排library material_origin字段后出题输入指纹保持一致',()=>{
 const base={title:'题目',materials:[{id:'material',sha256:hash('材料')}],material_origin:{kind:'library_v1' as const,material_mode:'original' as const,package_id:'package',revision_id:'revision',redaction_id:null,snapshot_digest:hash('snapshot')}};
 const reordered={...base,material_origin:{snapshot_digest:base.material_origin.snapshot_digest,redaction_id:null,revision_id:'revision',package_id:'package',material_mode:'original' as const,kind:'library_v1' as const}};
 expect(inputDigest(base as any)).toBe(inputDigest(reordered as any));
});

async function projectFixture(){
 const root=await mkdtemp(join(tmpdir(),'fresh-author-jobs-')),skill=join(root,'skill');await mkdir(skill);
 await writeFile(join(skill,'SKILL.md'),'---\nname: fixture\ndescription: author\n---\n当前方法');
 await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',supported_reasoning_levels:[{effort:'low'}]},{slug:'project-model',supported_reasoning_levels:[{effort:'high'}]},{slug:'system-model',supported_reasoning_levels:[{effort:'medium'}]}]}));
 const state:any={title:'题目1',text:'脱敏材料100元',projectConfig:{provider:'codex',model:'fixture-model',reasoning_effort:'low'},projectDefault:null,job:null,reuse:null,active:false,hookRuns:new Map()};
 const calls:{sql:string;values:any[]}[]=[];let saved:any;
 const library=()=>{
  const mode=state.library,sourceSha=hash('original'),text=state.text;
  const item=mode==='original'?{material_id:'source-file',markdown:text,document:{version:1,source_sha256:sourceSha,pages:[{page:1,text,structure:[{id:'p',kind:'paragraph',text}]}]}}:state.preparation?{material_id:'source-file',markdown:text,document:{format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'visible',kind:'paragraph',text:'可见证据正文'},{id:'hidden',kind:'paragraph',text:'隐藏裁判结果正文'}]}]}}:{material_id:'source-file',markdown:text};
  const markdown=mode==='original'?'# 附件.pdf\n\n'+text:text;
  const index=JSON.stringify({format:mode==='original'?'source-index-v1':'redacted-index-v2',redacted_sha256:hash(markdown),materials:[item]});
  const preparation=state.preparation?{preparation_id:'prep',result:{format:'material-preparation-v2',package_summary:'可见材料摘要',documents:[{id:'visible-doc',title:'证据材料',block_ids:['u1p1b1'],summary:'交易证据',document_type:'证据',tags:[],notes:'',unit_kind:'document',visibility:'visible',visibility_reason:''},{id:'hidden-doc',title:'判决书',block_ids:['u1p1b2'],summary:'裁判结果',document_type:'判决',tags:[],notes:'',unit_kind:'document',visibility:'hidden',visibility_reason:'材料已载明既成结论'}],combinations:[{id:'visible-scope',direction:'证据分析',party:'原告',scenes:[{scene:'诉前准备',as_of:''}],core_work:'分析交易证据',deliverables:['证据目录'],document_ids:['visible-doc'],notes:''},{id:'hidden-scope',direction:'执行异议',party:'申请执行人',scenes:[{scene:'执行阶段',as_of:''}],core_work:'援引判决结果',deliverables:['执行申请'],document_ids:['hidden-doc'],notes:''}],warnings:[],document_count:2,unassigned_group_count:0,unassigned_block_count:0}}:undefined;
  const manifest={version:2,origin:{kind:'library_v1',material_mode:mode,package_id:'pkg',revision_id:'rev',redaction_id:mode==='original'?null:'redact',source_digest:hash('source')},...(preparation?{material_scope:preparation}:{}),files:[{material_id:'source-file',original_name:'附件.pdf',source_sha256:sourceSha,document_sha256:hash(text)}],material_markdown:{artifact_id:'attachment',sha256:hash(markdown)},material_index:{artifact_id:'index',sha256:hash(index)}};
  return {row:{project_id:'project',package_id:'pkg',revision_id:'rev',redaction_id:manifest.origin.redaction_id,material_mode:mode,source_digest:hash('source'),snapshot_manifest:manifest,snapshot_digest:hash(canonicalJson(manifest)),markdown_artifact_id:'attachment',index_artifact_id:'index'},artifacts:[{id:'attachment',kind:mode==='original'?'source_markdown':'redacted_markdown',attempt_id:null,sha256:hash(markdown),content:markdown},{id:'index',kind:mode==='original'?'source_index':'redacted_index',attempt_id:null,sha256:hash(index),content:index}]};
 };

 const query=async(sql:string,values:any[]=[]):Promise<any>=>{
  calls.push({sql,values});
  // 跟随现有归档保护的行锁查询；模拟未归档/已归档状态，不能用空结果误判所有题目不存在。
  if(sql==='SELECT id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE NOWAIT')return{rows:state.deleted?[]:[{id:values[0]}],rowCount:state.deleted?0:1};
  if(sql==='SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=8')return{rows:state.archived?[{status:'succeeded'}]:[],rowCount:state.archived?1:0};
  if(state.library){
   if(sql.includes("to_regclass('ai_distill.question_material_scope_uses')"))return{rows:[{available:true}],rowCount:1};
   if(sql.startsWith('SELECT direction,scene FROM ai_distill.question_material_scope_uses'))return{rows:[],rowCount:0};
   if(sql.includes("SELECT a.result->'material_scope_selection'"))return{rows:[],rowCount:0};
   if(sql.startsWith('INSERT INTO ai_distill.question_material_scope_uses'))return{rows:[{workflow_id:values[1]}],rowCount:1};
   if(sql.startsWith('SELECT p.material_backend'))return{rows:[{material_backend:'library_v1',has_library_snapshot:true}],rowCount:1};
   if(sql.startsWith('SELECT project_id,package_id,revision_id'))return{rows:[library().row],rowCount:1};
   if(sql.startsWith('SELECT id,kind,attempt_id,sha256,storage_path,size_bytes FROM ai_distill.artifacts'))return{rows:library().artifacts,rowCount:2};
   if(sql.startsWith('SELECT id,content FROM ai_distill.artifacts'))return{rows:library().artifacts.filter(row=>values[1].includes(row.id)),rowCount:2};
  }
  if(sql.startsWith('SELECT * FROM ai_distill.hook_runs')){const row=[...state.hookRuns.values()].find((r:any)=>r.attempt_id===values[0]&&r.position===values[1]&&r.action_id===values[2]);return {rows:row?[structuredClone(row)]:[],rowCount:row?1:0};}
  if(sql.startsWith('INSERT INTO ai_distill.hook_runs')){const row={id:values[0],workflow_id:values[1],attempt_id:values[2],stage:values[3],position:values[4],action_id:values[5],mode:values[6],binding_digest:values[7],snapshot:JSON.parse(values[8]),idempotent:values[9],status:'waiting'};state.hookRuns.set(row.id,row);return {rows:[structuredClone(row)],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.hook_runs')){const row=state.hookRuns.get(values[0]);if(!row)return empty;row.status=values[1];row.result=values[2]?JSON.parse(values[2]):null;row.result_digest=values[4];return {rows:[structuredClone(row)],rowCount:1};}

  if(sql.includes("a.status='running' AND COALESCE(a.heartbeat_at"))return empty;
  if(sql.startsWith('SELECT a.*'))return{rows:state.job?[state.job]:[],rowCount:state.job?1:0};
  if((sql.startsWith('SELECT w.project_id')||sql.startsWith('SELECT w.*')))return{rows:[{project_id:'project',project_name:'项目名称',material_backend:state.library?'library_v1':'legacy',has_library_snapshot:!!state.library,title:state.title,source_key:'题目1',source_manifest:[],local_skill_path:skill,material_root:join(root,'questions'),ingestion_status:'succeeded',redaction_status:'succeeded'}],rowCount:1};
  if(sql.startsWith('SELECT id,project_id FROM ai_distill.workflows'))return{rows:state.deleted?[]:[{id:'workflow',project_id:'project'}],rowCount:state.deleted?0:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=9'))return{rows:[{id:'redaction'}],rowCount:1};
  if(sql.startsWith('SELECT ar.id'))return{rows:[{id:'attachment',sha256:hash(state.text)}],rowCount:1};
  if(sql.startsWith('SELECT sha256,content'))return{rows:[{sha256:hash(state.text),content:state.text,sources:state.originalNames?.map((original_name:string)=>({original_name}))}],rowCount:1};
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs')&&sql.includes('ordinal=6'))return {rows:state.scoreWorkflow?[{config:{workflow:state.scoreWorkflow}}]:[]};
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:state.projectConfig?[{config:state.projectConfig}]:[]};
  if(sql.startsWith('SELECT codex_model'))return{rows:[{codex_model:state.projectDefault?.model??null,codex_reasoning_effort:state.projectDefault?.reasoning_effort??null}]};
  if(sql.startsWith('SELECT credential_home,model'))return{rows:[{credential_home:root,model:'system-model',reasoning_effort:'medium'}]};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes("status IN ('waiting','running')"))return{rows:state.reuse?[{id:state.reuse}]:state.active?[{id:'active'}]:[],rowCount:state.reuse||state.active?1:0};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts'))saved={id:values[1],workflow_id:'workflow',project_id:'project',input:JSON.parse(values[2]),config:JSON.parse(values[3])};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC'))return{rows:[{id:state.latestId??state.job?.id}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts WHERE id=$1')){const active=!state.cancelled&&(!state.latestId||state.latestId===state.job?.id);return{rows:active?[{id:state.job?.id}]:[],rowCount:active?1:0};}
  if(sql.startsWith('SELECT status FROM ai_distill.step_attempts'))return{rows:[{status:'running'}],rowCount:1};
  return{rows:[],rowCount:sql.startsWith('SELECT')?0:1};
 };
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 return{root,skill,pool,state,calls,get saved(){return saved;}};
}
const authored={question_id:'题目1',draft:{task_name:'金额核算',task_type:'计算',header:{industry_l1:'行业',industry_l2:'细分',task_form:'single_round' as const,occupation_l1:'法律',occupation_l2:'法务'},question:'金额是多少？',attachment_ids:['attachment'],answer_approach:'核对材料',reference_answer:'100元',answer_requirements:{input_mode:'text' as const,output_mode:'text' as const,tools:[]},rubric:[{id:'R1',criterion:'准确写明金额',max_score:1}]},question_version:'qv1',rubric_version:'rv1',package_text:'题面',codex:{session_id:'new-session',usage:null,duration_ms:1}};

test('既有归档保护保持：已归档和已删除题目不能因Work结构升级被重出',async()=>{
 for(const flag of ['archived','deleted']){const f=await projectFixture();try{f.state[flag]=true;await expect(enqueueAuthoring(f.pool,'workflow')).rejects.toThrow(flag==='archived'?'已归档':'不存在');expect(f.saved).toBeUndefined();}finally{await rm(f.root,{recursive:true,force:true});}}
});

test('上传材料原文件名从数据库传入作者并用于公开题包表头',async()=>{
 const f=await projectFixture();try{
  f.state.originalNames=['上传判决.docx','附件二.txt'];await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  await runNextAuthoring(f.pool,f.root,async options=>{expect(options.materials[0]?.source_names).toEqual(['上传判决.docx','附件二.txt']);return authored;});
  const artifact=f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'));
  expect(artifact?.values[7]).toContain('输入附件：\n上传判决.docx\n附件二.txt');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('整理快照含隐藏文书时只把可见正文交给出题Agent并保存实际交付成果',async()=>{
 const f=await projectFixture();let received:any;try{
  f.state.library='redacted';f.state.preparation=true;f.state.text='可见证据正文\n隐藏裁判结果正文';
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  const selection={direction:'证据分析',party:'原告',scenes:['诉前准备'],deliverables:['证据目录','争点清单'],additional_combinations:[{direction:'应诉准备',party:'原告',scenes:['庭审准备'],deliverables:['庭审提纲']}]};
  await runNextAuthoring(f.pool,join(f.root,'storage'),async options=>{received=options;return{...authored,draft:{...authored.draft,material_scope_selection:selection}} as any;});
  expect(received.materials).toHaveLength(1);expect(received.materials[0].text).toContain('可见证据正文');expect(received.materials[0].text).not.toContain('隐藏裁判结果正文');
  expect(received.material_scope.result.documents.map((document:any)=>document.title)).toEqual(['证据材料']);
  const completed=f.calls.find(call=>call.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"));
  expect(JSON.parse(completed!.values[1]).material_scope_selection).toEqual(selection);
  expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.question_material_scope_uses'))).toBe(true);
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
  expect(f.saved.input.project_prompt.workspace_path).toBe(await realpath(f.root));expect(f.saved.input.system_authoring_prompt).toBe(AUTHORING_FIXED_PROMPT);expect(f.saved.input).not.toHaveProperty('evaluation_feedback');
  expect(f.calls.some(c=>c.sql.includes('SELECT id,result')&&c.sql.includes('ordinal=4'))).toBe(false);
  const decisionReads=f.calls.filter(c=>c.sql.includes('ordinal=7')&&c.sql.startsWith('SELECT'));
  expect(decisionReads).toHaveLength(1);expect(decisionReads[0]!.sql).toContain("jsonb_build_object('decision',result->>'decision') AS result");
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
 ['result_validation_failed','出题结果无法转换为可保存的JSON题包，请检查本次私有执行记录'],
 ['codex_timeout','出题执行超过本次时限，未取得可接收的完整结果'],
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
test.each(['none','attachments','title','skill'])('fresh author worker saves returned content despite late %s changes',async(change)=>{
 const f=await projectFixture();let received:any;try{
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  await runNextAuthoring(f.pool,join(f.root,'storage'),async options=>{received=options;if(change==='attachments')f.state.text='changed';if(change==='title')f.state.title='新题';if(change==='skill')await writeFile(join(f.skill,'SKILL.md'),'changed');return authored;});
  expect(received.workspace_path).toBe(await realpath(f.root));expect(received.system_authoring_prompt).toBe(AUTHORING_FIXED_PROMPT);expect(received).not.toHaveProperty('evaluation_feedback');
  expect(received.materials).toEqual([{id:'attachment',sha256:hash('脱敏材料100元'),text:'脱敏材料100元'}]);
  const completed=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"));
  if(change==='none'){
   expect(completed).toBeDefined();const stored=JSON.parse(completed!.values[1]);expect(stored.reference_answer).toBe('100元');
   const artifact=f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'));expect(artifact?.values[3]).toBe('authored_question');expect(String(artifact?.values[7])).not.toContain('标准答案-文本');
  }else{expect(completed).toBeDefined();expect(JSON.parse(completed!.values[1]).question).toBe(authored.draft.question);expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))).toBe(false);}
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
   if(sql==='SELECT id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE NOWAIT')return{rows:[{id:values[0]}],rowCount:1};
   if(sql==='SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=8')return{rows:[],rowCount:0};
   if((sql.startsWith('SELECT w.project_id')||sql.startsWith('SELECT w.*')))return{rows:[{project_id:'project',project_name:'数据库项目名称',title:'题目1',source_key:'题目1',source_manifest:[],local_skill_path:skill,material_root:join(root,'questions'),ingestion_status:'succeeded',redaction_status:'succeeded'}]};
   if(sql.startsWith('SELECT id,project_id FROM ai_distill.workflows'))return{rows:[{id:'workflow',project_id:'project'}],rowCount:1};
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

test('后置增强失败不妨碍主结果保存，失败记录独立保留',async()=>{
 const f=await projectFixture();let called=0;
 try{
  await mkdir(join(f.root,'hooks'));await writeFile(join(f.root,'hooks/fail.ts'),"throw new Error('private failure');");
  f.state.projectConfig.workflow={hooks:{after:[{id:'check',script:'hooks/fail.ts',files:['hooks/fail.ts'],idempotent:true}]}};
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  await runNextAuthoring(f.pool,join(f.root,'storage'),async()=>{called++;return authored;});
  const failed=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"));
  expect(failed).toBeUndefined();
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(true);
  expect([...f.state.hookRuns.values()].find((r:any)=>r.position==='after').status).toBe('failed');
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
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(true);
  // 模拟本地队列恢复同一次执行；主检查点必须复用，后置增强才再次执行。
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


test('内容契约配置变化不阻断已冻结任务，仍按本次冻结契约发布',async()=>{
 const f=await projectFixture();try{
  f.state.projectConfig={provider:'codex',model:'fixture-model',reasoning_effort:'low',workflow:{content_contract:'work_legal_v1'}};
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;f.state.projectConfig={provider:'codex',model:'fixture-model',reasoning_effort:'low'};
  expect(f.saved.config.workflow.content_contract).toBe('work_legal_v1');
  let called=false;await runNextAuthoring(f.pool,f.root,async()=>{called=true;return authored;});expect(called).toBe(true);
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

// 新三模式快照必须保留到出题冻结输入；旧快照无此字段继续保持原摘要。
test('出题指纹绑定三模式字段且兼容旧来源',()=>{
 const base={title:'题目',materials:[{id:'material',sha256:hash('材料')}],material_origin:{kind:'library_v1' as const,material_mode:'redacted' as const,package_id:'package',revision_id:'revision',redaction_id:'redaction',snapshot_digest:hash('snapshot')}};
 expect(inputDigest({...base,material_origin:{...base.material_origin,material_processing_mode:'aliases'}})).not.toBe(inputDigest({...base,material_origin:{...base.material_origin,material_processing_mode:'mask'}}));
 expect(inputDigest(base)).toBe(inputDigest({...base,material_origin:{...base.material_origin,material_processing_mode:undefined}}));
});


test.each(['redacted','original'])('library %s loads once at startup and saves without a second source read',async(mode)=>{
 const f=await projectFixture();try{
  f.state.library=mode;await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;f.calls.length=0;
  await runNextAuthoring(f.pool,f.root,async options=>{
   expect(options.materials[0]?.text).toContain('100元');
   expect(f.calls.filter(c=>c.sql.startsWith('SELECT id,kind,attempt_id,sha256,storage_path,size_bytes FROM ai_distill.artifacts'))).toHaveLength(1);
   return authored;
  });
  expect(f.calls.filter(c=>c.sql.startsWith('SELECT id,kind,attempt_id,sha256,storage_path,size_bytes FROM ai_distill.artifacts'))).toHaveLength(1);
  expect(f.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('returned content saves against its frozen input without rereading later library changes',async()=>{
 const f=await projectFixture();try{
  f.state.library='redacted';await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;f.calls.length=0;
  await runNextAuthoring(f.pool,f.root,async()=>{f.state.text='changed source';return authored;});
  expect(f.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(true);
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))).toBe(false);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('本地结果提交断线只恢复完整作者成果，不重复创建作者会话',async()=>{
 const f=await projectFixture();const old=process.env.EXECUTION_QUEUE_MODE;let queue:LocalQueue|undefined;
 try{
  delete process.env.EXECUTION_QUEUE_MODE;await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  process.env.EXECUTION_QUEUE_MODE='local';queue=new LocalQueue(join(f.root,'queue'),'test-device');queue.intent(f.saved.id,'step','agent','authoring');queue.confirm(f.saved.id);const job=queue.claim('agent')!;
  let attempts=0,drop=true;const pool={query:f.pool.query.bind(f.pool),connect:async()=>{const db=await f.pool.connect();return{release:()=>db.release(),query:async(sql:string,values?:unknown[])=>{if(drop&&sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'")){drop=false;throw Object.assign(new Error('Connection terminated unexpectedly'),{code:'ECONNRESET'});}return db.query(sql,values);}};}} as unknown as Pool;
  const author=async()=>{attempts++;return authored;};
  await expect(withLocalExecution(queue,job,()=>runNextAuthoring(pool,join(f.root,'storage'),author))).rejects.toBeInstanceOf(PendingLocalCommit);
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))).toBe(false);
  await withLocalExecution(queue,job,()=>runNextAuthoring(pool,join(f.root,'storage'),author));expect(attempts).toBe(1);
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(true);
 }finally{queue?.close();if(old===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=old;await rm(f.root,{recursive:true,force:true});}
});

test('local failure survives failed DB settlement and recovery never invokes author again',async()=>{
 const {LocalQueue}=await import('../execution-queue/store');
 const {withLocalExecution}=await import('../execution-queue/runtime');
 const f=await projectFixture(),q=new LocalQueue(join(f.root,'queue'),'test-device');
 const previous=process.env.EXECUTION_QUEUE_MODE;
 try{
  process.env.EXECUTION_QUEUE_MODE='legacy';await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  process.env.EXECUTION_QUEUE_MODE='local';const id=f.saved.id;q.intent(id,'step','agent','authoring');q.confirm(id);const job=q.claim('agent')!;
  let failSettlement=true,authorCalls=0;
  const pool={...f.pool,connect:async()=>{const db=await f.pool.connect();return{query:async(sql:string,values:any[])=>{
   if(failSettlement&&sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed',result="))throw Object.assign(new Error('synthetic unavailable'),{code:'ECONNRESET'});
   return db.query(sql,values);
  },release:()=>db.release()};}} as unknown as Pool;
  const author=async()=>{authorCalls++;throw Object.assign(new Error('private'),{reason_code:'result_missing'});};
  await expect(withLocalExecution(q,job,()=>runNextAuthoring(pool,join(f.root,'storage'),author))).rejects.toThrow('synthetic unavailable');
  expect(q.stepFailure(job)?.message).toContain('result.json');expect(authorCalls).toBe(1);
  failSettlement=false;
  await withLocalExecution(q,job,()=>runNextAuthoring(pool,join(f.root,'storage'),author));
  expect(authorCalls).toBe(1);
  const writes=f.calls.filter(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed',result="));
  expect(writes).toHaveLength(1);expect(writes[0]!.values[2]).toContain('result.json');
 }finally{if(previous===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previous;q.close();await rm(f.root,{recursive:true,force:true});}
});

// PostgreSQL JSONB重排建议对象键后，活动出题仍按同一冻结输入复用。
test('manual advice digest survives JSONB key ordering without changing legacy digests',()=>{
 const base={title:'合成题',materials:[],revision_advice:{id:'advice',source_digest:'source',authoring_version:'q1',text:'修正时间',digest:'digest'}};
 const reordered={...base,revision_advice:Object.fromEntries(Object.entries(base.revision_advice).reverse())};
 expect(inputDigest(base as any)).toBe(inputDigest(reordered as any));
 expect(inputDigest({title:'合成题',materials:[]})).not.toBe(inputDigest(base as any));
});

// 取消/新任务身份保护与已移除的内容指纹检查分开，不能把旧attempt写入新题。
test.each(['cancelled','superseded'])('直接接收仍不发布%s任务的迟到结果',async(reason)=>{
 const f=await projectFixture();try{
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  await runNextAuthoring(f.pool,f.root,async()=>{if(reason==='cancelled')f.state.cancelled=true;else f.state.latestId='new-attempt';return authored;});
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(false);
  expect(f.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('返回后业务写入失败且当前材料已变化，当前步骤仍结算失败而非永远running',async()=>{
 const f=await projectFixture();try{
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  const pool={...f.pool,connect:async()=>{const db=await f.pool.connect();return{release:()=>db.release(),query:async(sql:string,values:any[])=>{if(sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))throw new Error('synthetic storage failure');return db.query(sql,values);}};}} as unknown as Pool;
  await runNextAuthoring(pool,f.root,async()=>{f.state.text='changed during execution';return authored;});
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.steps SET status='failed'"))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('生命周期前置先于模型，后置在提交释放连接后同步等待，异常不回滚题目',async()=>{
 const {lifecycle}=await import('../lifecycle');
 const f=await projectFixture();const order:string[]=[];let release!:()=>void,arrive!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});const entered=new Promise<void>(resolve=>{arrive=resolve;});
 const removeBefore=lifecycle.register({id:'fixture.author.before',stage:'authoring',event:'before',run:()=>{order.push('before');}});
 const removeAfter=lifecycle.register({id:'fixture.author.after',stage:'authoring',event:'committed',run:async context=>{
  expect(context.data?.result).toMatchObject({question:authored.draft.question});
  expect(f.calls.some(call=>call.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(true);
  expect(f.calls.at(-1)?.sql).toBe('COMMIT');order.push('after');arrive();await gate;throw new Error('enhancement only');
 }});
 try{
  await enqueueAuthoring(f.pool,'workflow');f.state.job=f.saved;
  const running=runNextAuthoring(f.pool,join(f.root,'storage'),async()=>{order.push('model');return authored;}).then(()=>order.push('returned'));
  await entered;expect(order).toEqual(['before','model','after']);release();await running;
  expect(order).toEqual(['before','model','after','returned']);
  expect(f.calls.some(call=>call.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed'"))).toBe(false);
 }finally{release?.();removeBefore();removeAfter();await rm(f.root,{recursive:true,force:true});}
});

test('批次参考只查询同期当前成功投影并白名单复制设计字段',async()=>{
 const {freezeAuthoringBatch}=await import('./jobs');let sql='',params:unknown[]=[];
 const db={query:async(q:string,p:unknown[])=>{sql=q;params=p;return{rows:[{selection:{direction:'诉讼',party:'被告',scenes:['举证'],deliverables:['意见'],core_work:'审查证据',question:'禁止泄漏题面',rubric:['禁止泄漏评分'],reference_answer:'禁止泄漏标答',additional_combinations:[{direction:'调解',party:'被告',scenes:['协商'],deliverables:['协议'],business_goal:'解决争议',answer_approach:'禁止泄漏思路'}]}},{selection:null},{selection:{}}]};}};
 const batch=await freezeAuthoringBatch(db as any,'phase','self');
 expect(params).toEqual(['phase','self']);expect(sql).toContain('w.project_id=$1 AND w.id<>$2 AND w.deleted_at IS NULL');expect(sql).toContain("s.status='succeeded'");expect(sql).not.toContain('step_attempts');
 expect(batch).toMatchObject({total:3,included:1,missing:2,truncated:false});expect(JSON.stringify(batch)).not.toContain('禁止泄漏');expect(batch.selections[0]?.additional_combinations?.[0]?.business_goal).toBe('解决争议');
});
test('批次观察时间不破坏任务复用，设计变化参与摘要且无整理也传入作者',async()=>{
 const f=await projectFixture();try{
  await enqueueAuthoring(f.pool,'workflow');const input=f.saved.input;
  expect(input.material_scope).toBeUndefined();expect(input.batch_context).toMatchObject({total:0,missing:0,selections:[]});
  expect(inputDigest({...input,batch_context:{...input.batch_context,captured_at:'later'}})).toBe(input.digest);
  expect(inputDigest({...input,batch_context:{...input.batch_context,selections:[{direction:'不同',party:'被告',scenes:[],deliverables:[]}]}})).not.toBe(input.digest);
  f.state.job=f.saved;await runNextAuthoring(f.pool,join(f.root,'storage'),async options=>{expect(options.batch_context).toEqual(input.batch_context);return authored;});
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('旧冻结任务缺少批次参考仍执行，作者缺少设计摘要仍保存',async()=>{
 const f=await projectFixture();try{
  await enqueueAuthoring(f.pool,'workflow');delete f.saved.input.batch_context;f.saved.input.digest=inputDigest(f.saved.input);f.state.job=f.saved;
  await runNextAuthoring(f.pool,join(f.root,'storage'),async options=>{expect(options.batch_context).toBeUndefined();return authored;});
  expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='succeeded'"))).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
