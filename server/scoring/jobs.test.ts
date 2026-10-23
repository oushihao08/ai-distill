/**
 * 验证逐答案评分队列的上下文冻结、领取恢复、状态汇总、产物发布及取消隔离。
 * 使用内存 SQL 替身、注入评分器及临时目录内的本地脚本，不连接真实数据库或模型服务。
 * 源码审阅和测试用例范围均不等于运行验收。
 */
import {test,expect,beforeAll,afterAll} from 'bun:test';
import {enqueueScore,runNextScore,scoreContextDigest} from './jobs';
import {freezeStageHooks} from '../workflow-hook-jobs';
import {canonicalJson,validateWorkflowConfig} from '../../shared/workflow-config';
import {scoreRubricBindingText} from './validate';
import {scoreExecutionInstructions} from './executor';
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {inputDigest} from '../answer-models/input';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// SQL替身不得继承工作台local模式并向真实队列登记意图。
const originalQueueMode=process.env.EXECUTION_QUEUE_MODE;
beforeAll(()=>{process.env.EXECUTION_QUEUE_MODE='legacy';});
afterAll(()=>{if(originalQueueMode===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=originalQueueMode;});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const snapshot=join(tmpdir(),`score-job-rules-${process.pid}`),modelCatalogRoot=join(tmpdir(),`score-job-models-${process.pid}`),previousCodexHome=process.env.CODEX_HOME,ruleText='---\nname: scoring-fixture\ndescription: scoring test\n---\n本期评分规则';
const projectRules={version_id:'rules-v1',source_digest:hash('project-rules'),snapshot_path:snapshot,files:[{path:'skill/SKILL.md',sha256:hash(ruleText),size_bytes:Buffer.byteLength(ruleText)}]};
beforeAll(async()=>{await mkdir(join(snapshot,'skill'),{recursive:true});await writeFile(join(snapshot,'skill','SKILL.md'),ruleText);await mkdir(modelCatalogRoot,{recursive:true});await writeFile(join(modelCatalogRoot,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-6-luna',supported_reasoning_levels:[{effort:'medium'}]}]}));process.env.CODEX_HOME=modelCatalogRoot;});
afterAll(async()=>{if(previousCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousCodexHome;await rm(snapshot,{recursive:true,force:true});await rm(modelCatalogRoot,{recursive:true,force:true});});
const rubric=[{id:'amount',criterion:'指出100元',max_score:1}];
const input={question_version:'v1',question:'多少',materials:[{name:'附件1',text:'欠款100元'}],attachments:[{id:'attachment',sha256:hash('欠款100元')}]};
const context={question:input.question,materials:input.materials,answer:'100元',rubric,answer_approach:'核对金额',reference_answer:'100元',project_rules:projectRules,binding:{question_version:'v1',input_digest:inputDigest(input),rubric_version:'r1',rubric_digest:hash(JSON.stringify(rubric)),answer_attempt_id:'answer',answer_sha256:hash('100元')}};
function fake(options:{reuse?:boolean;empty?:boolean;late?:boolean;unready?:boolean;inactive?:boolean;stale?:boolean;answerStepStatus?:string;answers?:{id:string;text:string}[];bundle?:any[];scoreRows?:any[];provider?:'codex'|'api';policy?:any;content_contract?:string}={}){
 const calls:{sql:string;values:any[]}[]=[],hookRuns=new Map<string,any>();let claim=false,activeConnections=0;
 const provider=options.provider??'codex';
 const job:any={id:'grade',workflow_id:'workflow',input:{context:structuredClone(context),digest:scoreContextDigest(context),execution_instructions:scoreExecutionInstructions(provider)},config:provider==='api'?{provider:'api',api:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen3.8-27b'},prompt:'逐项评分'}:{provider:'codex',model:'gpt-6-luna',reasoning_effort:'medium'}};
 if(options.policy){job.input.context.scoring_policy=options.policy;job.input.context.rubric=[{id:'amount',criterion:'金额错误',rule:'出现错误扣7分'}];job.input.context.binding.rubric_digest=hash(scoreRubricBindingText(job.input.context.rubric,options.policy));job.input.digest=scoreContextDigest(job.input.context);}
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT * FROM ai_distill.hook_runs')){const row=[...hookRuns.values()].find(r=>r.attempt_id===values[0]&&r.position===values[1]&&r.action_id===values[2]);return {rows:row?[structuredClone(row)]:[],rowCount:row?1:0};}
  if(sql.startsWith('INSERT INTO ai_distill.hook_runs')){const row={id:values[0],workflow_id:values[1],attempt_id:values[2],stage:values[3],position:values[4],action_id:values[5],mode:values[6],binding_digest:values[7],snapshot:JSON.parse(values[8]),idempotent:values[9],status:'waiting'};hookRuns.set(row.id,row);return {rows:[structuredClone(row)],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.hook_runs')){const row=hookRuns.get(values[0]);if(!row)return {rows:[],rowCount:0};row.status=values[1];row.result=values[2]?JSON.parse(values[2]):null;row.result_digest=values[4];return {rows:[structuredClone(row)],rowCount:1};}

  if(sql.startsWith('SELECT w.project_id'))return {rowCount:1,rows:[{project_id:'project',rule_version_id:'rules-v1'}]};
  if(sql.startsWith('SELECT w.rule_version_id'))return {rowCount:1,rows:[{rule_version_id:'rules-v1',project_name:'本期项目',title:'本期项目-题目1',source_key:'题目1',local_skill_path:join(snapshot,'skill'),material_root:join(snapshot,'questions')}]};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rowCount:1,rows:[{codex_model:null,codex_reasoning_effort:null}]};
  if(sql.startsWith('SELECT a.input,a.result')){if(options.bundle?.some(item=>item.status==='failed')){expect(sql).toContain("s.status='failed'");expect(sql).toContain("model->>'status'='succeeded'");}const answerId=values[0]??'answer',text=options.answers?.find(answer=>answer.id===answerId)?.text??'100元';return {rowCount:1,rows:[{input:{...input,question_attempt_id:'author',input_digest:inputDigest(input)},result:{text,input_digest:inputDigest(input),answer_sha256:hash(text)}}]};}
  if(sql.startsWith('SELECT a.id,a.input,a.result'))return {rowCount:1,rows:[{id:'author',input:{...(options.policy?{scoring_policy:options.policy}:{}),rule_version_id:projectRules.version_id,rule_source_digest:projectRules.source_digest,rule_snapshot_path:snapshot,rule_files:projectRules.files},result:{...(options.content_contract?{content_contract:options.content_contract,content_status:{status:'complete'},task_requirements:{input_mode:'text',output_mode:'text',tools:[]}}:{}),...input,attachment_ids:['attachment'],answer_approach:'核对金额',reference_answer:'100元',quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:options.late&&claim?'r2':'r1',rubric:job.input.context.rubric,...(options.policy?{scoring_policy:options.policy}:{})}}]};
  if(sql.includes('a.id=ANY($2::uuid[])'))return {rowCount:options.unready?0:(options.answers?.length??0),rows:options.unready?[]:(options.answers??[]).map(answer=>({id:answer.id}))};
  if(sql.startsWith('SELECT a.id FROM'))return {rowCount:options.unready?0:1,rows:options.unready?[]:[{id:'answer'}]};
  if(sql.startsWith('SELECT status,result FROM ai_distill.steps'))return {rowCount:1,rows:[{status:options.answerStepStatus??'succeeded',result:options.bundle?{models:options.bundle}:null}]};
  if(sql.startsWith('SELECT result FROM ai_distill.steps'))return {rowCount:1,rows:[{result:options.bundle?{models:options.bundle}:null}]};
  if(sql.startsWith('SELECT id,input,result,status FROM (SELECT DISTINCT ON')){expect(sql).toContain("=ANY($2::text[])");expect(sql).toContain("ORDER BY input #>> '{context,binding,answer_attempt_id}',attempt DESC");expect(sql).toContain("'binding',result->'binding'");}
  if(sql.startsWith('SELECT id,input,result,status FROM (SELECT DISTINCT ON'))return {rowCount:options.scoreRows?.length??0,rows:options.scoreRows??[]};
  if(sql.startsWith('SELECT config'))return {rowCount:1,rows:[{config:job.config}]};
  if(sql.startsWith('SELECT id FROM')&&sql.includes("status IN ('waiting','running')"))return {rowCount:options.reuse?1:0,rows:options.reuse?[{id:'existing'}]:[]};
  if(sql.startsWith('SELECT a.id,a.workflow_id'))return {rowCount:options.stale?1:0,rows:options.stale?[{id:'lost',workflow_id:'workflow'}]:[]};
  if(sql.startsWith('SELECT a.*')){claim=true;return {rowCount:options.empty?0:1,rows:options.empty?[]:[job]};}
  if(sql.startsWith('SELECT id FROM')&&sql.includes("status='running'"))return {rowCount:options.inactive?0:1,rows:options.inactive?[]:[{id:'grade'}]};
  if(sql.startsWith('UPDATE ai_distill.step_attempts SET status=\'failed\'' )&&options.inactive)return {rowCount:0,rows:[]};
  if(sql.startsWith('SELECT id FROM ai_distill.artifacts'))return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[]};
 };
 return {pool:{query,connect:async()=>{activeConnections++;return{query,release(){activeConnections--;}};}} as unknown as Pool,calls,job,hookRuns,activeConnections:()=>activeConnections};
}
async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'score-jobs-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
const grade=async(c:any)=>({report:{binding:c.binding,assessment_valid:true,items:[{id:'amount',score:1,reason:'完整',evidence:[{source:'answer',quote:'100元'}]}],total:1,max_score:1,disputes:[]},session_id:'grade-session',usage:{input_tokens:5},duration_ms:10});
test('API评分的领取与恢复同时排除本地脚本任务',async()=>{
 const f=fake({empty:true,provider:'api'});await runNextScore(f.pool,'unused',grade,undefined,async()=>{},'api','api');
 for(const call of f.calls.filter(c=>c.sql.startsWith('SELECT a.*')||c.sql.startsWith('SELECT a.id,a.workflow_id'))){expect(call.sql).toContain("NOT (a.input->'hooks'");expect(call.values[0]).toBe('api');}
});
test('enqueue pins persisted context and rejects a duplicate active score task',async()=>{const a=fake();await enqueueScore(a.pool,'workflow');expect(a.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))?.values.join(' ')).toContain('answer_sha256');const b=fake({reuse:true});await expect(enqueueScore(b.pool,'workflow')).rejects.toThrow('此答案已有评分任务');expect(b.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);});
test('scoring digest binds the authoring approach and reference answer',()=>{
 expect(scoreContextDigest({...context,answer_approach:'另一作答思路'})).not.toBe(scoreContextDigest(context));
 expect(scoreContextDigest({...context,reference_answer:'另一标准答案'})).not.toBe(scoreContextDigest(context));
});
test('enqueue scores every succeeded answer in the current model bundle',async()=>{
 const answers=[{id:'answer-qwen',text:'100元'},{id:'answer-deepseek',text:'90元'}];
 const bundle=answers.map((answer,index)=>({model_id:`model-${index}`,name:`model-${index}`,status:'succeeded',attempt_id:answer.id,answer_sha256:hash(answer.text)}));
 const a=fake({answers,bundle});
 const result=await enqueueScore(a.pool,'workflow');
 const inserts=a.calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'));
 expect((result as any).ids).toHaveLength(2);expect(inserts).toHaveLength(2);
 expect(inserts.map(call=>JSON.parse(call.values[2]).context.binding.answer_attempt_id)).toEqual(answers.map(answer=>answer.id));
});
test('enqueue allows a succeeded answer after another model fails',async()=>{
 const answer={id:'answer-qwen',text:'100元'};
 const bundle=[{model_id:'model-1',name:'模型一',status:'succeeded',attempt_id:answer.id,answer_sha256:hash(answer.text)},{model_id:'model-2',name:'模型二',status:'failed',attempt_id:'failed-answer'}];
 const a=fake({answers:[answer],bundle});
 const result=await enqueueScore(a.pool,'workflow');
 expect((result as any).ids).toHaveLength(1);
 expect(a.calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toHaveLength(1);
});
test('enqueue rejects a mixed model bundle while an answer is still running',async()=>{
 const bundle=[{model_id:'model-1',name:'模型一',status:'succeeded',attempt_id:'answer',answer_sha256:hash('100元')},{model_id:'model-2',name:'模型二',status:'running',attempt_id:'running-answer'}];
 const a=fake({answers:[{id:'answer',text:'100元'}],bundle,answerStepStatus:'running'});
 await expect(enqueueScore(a.pool,'workflow')).rejects.toThrow('请先完成当前题目作答');
 expect(a.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(false);
});
test('enqueue rejects a model bundle with no successful answer',async()=>{
 const bundle=[{model_id:'model-1',name:'模型一',status:'failed',attempt_id:'failed-answer'}];
 const a=fake({bundle,answerStepStatus:'failed'});
 await expect(enqueueScore(a.pool,'workflow')).rejects.toThrow('请先完成当前题目作答');
 expect(a.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(false);
});
test('missing answer cannot create score attempt',async()=>{const a=fake({unready:true});await expect(enqueueScore(a.pool,'workflow')).rejects.toThrow();expect(a.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);});
test('idle scoring worker does not call Codex',async()=>{const a=fake({empty:true});let called=false;expect(await runNextScore(a.pool,'unused',async c=>{called=true;return grade(c);})).toBe(false);expect(called).toBe(false);});
test('valid grade saves report, binding, usage, session and downloadable artifact',async()=>fixture(async root=>{const a=fake();await runNextScore(a.pool,root,grade);const artifact=a.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))!;const bytes=await readFile(join(root,String(artifact.values[4])));expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.values[5]);expect(JSON.parse(bytes.toString())).toMatchObject({validation:{valid:true}});expect(a.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(true);const saved=a.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));expect(saved?.values[1]).toBe('succeeded');expect(JSON.parse(saved!.values[2])).toMatchObject({validation:{valid:true},report:{binding:context.binding},session_id:'grade-session',usage:{input_tokens:5}});}));
test('API score claims only API-configured attempts and freezes provider and model in the published result',async()=>fixture(async root=>{
 const a=fake({provider:'api'});let received:any;
 const apiGrade=async(c:any,o:any)=>{received=o;return grade(c);};
 await runNextScore(a.pool,root,apiGrade,undefined,async()=>{},'api');
 expect(a.calls.find(call=>call.sql.includes("COALESCE(a.config->>'provider','codex')=$1"))?.values).toEqual(['api',null]);
 expect(received.config).toEqual(a.job.config.api);
 const saved=a.calls.find(call=>call.sql.startsWith('UPDATE ai_distill.step_attempts SET status=$2'));
 expect(JSON.parse(saved!.values[2])).toMatchObject({provider:'api',model:'qwen/qwen3.8-27b'});
}));
test('one completed grade keeps the shared score step waiting for other model answers',async()=>fixture(async root=>{
 const answers=[{id:'answer-qwen',text:'100元'},{id:'answer-deepseek',text:'90元'}];
 const bundle=answers.map((answer,index)=>({model_id:`model-${index}`,name:`model-${index}`,status:'succeeded',attempt_id:answer.id,answer_sha256:hash(answer.text)}));
 const qwenContext=structuredClone(context);qwenContext.binding.answer_attempt_id='answer-qwen';qwenContext.answer='100元';qwenContext.binding.answer_sha256=hash('100元');
 const a=fake({answers,bundle,scoreRows:[{id:'grade',input:{context:{binding:{answer_attempt_id:'answer-qwen'}}},result:{report:{total:1,max_score:1}},status:'succeeded'},{id:'pending',input:{context:{binding:{answer_attempt_id:'answer-deepseek'}}},result:null,status:'waiting'}]});
 a.job.input.context=qwenContext;a.job.input.digest=scoreContextDigest(qwenContext);
 let judged=0;await runNextScore(a.pool,root,grade,undefined,async()=>{judged++;});
 const summary=a.calls.find(call=>call.sql.startsWith('UPDATE ai_distill.steps SET status=$2,result=$3,error=$4'));
 expect(summary?.values[1]).toBe('waiting');
 expect(JSON.parse(summary?.values[2]).models.map((item:any)=>item.score_status)).toEqual(['succeeded','waiting']);
 expect(judged).toBe(0);
}));
test('ordinary scoring automatically judges once all required model scores are terminal',async()=>fixture(async root=>{
 const bundle=[{model_id:'model-1',name:'模型一',status:'succeeded',attempt_id:'answer',answer_sha256:hash('100元')}];
 const scoreRows=[{id:'grade',input:{context:{binding:{answer_attempt_id:'answer'}}},result:{report:{total:1,max_score:1},validation:{valid:true}},status:'succeeded'}];
 const a=fake({bundle,scoreRows});let judged=0;
 await runNextScore(a.pool,root,grade,undefined,async workflowId=>{expect(workflowId).toBe('workflow');judged++;});
 expect(judged).toBe(1);
}));
test('a failed model score marks the shared score step failed',async()=>fixture(async root=>{
 const bundle=[{model_id:'model-1',name:'模型一',status:'succeeded',attempt_id:'answer',answer_sha256:hash('100元')},{model_id:'model-2',name:'模型二',status:'succeeded',attempt_id:'answer-2',answer_sha256:hash('90元')}];
 const a=fake({bundle,scoreRows:[{id:'grade',input:{context:{binding:{answer_attempt_id:'answer'}}},result:null,status:'failed'},{id:'grade-2',input:{context:{binding:{answer_attempt_id:'answer-2'}}},result:{report:{total:1,max_score:1},validation:{valid:true}},status:'succeeded'}]});
 await runNextScore(a.pool,root,async c=>({...await grade(c),report:{...await grade(c).then(r=>r.report),assessment_valid:false,disputes:['冲突']}}));
 const summary=a.calls.find(call=>call.sql.startsWith('UPDATE ai_distill.steps SET status=$2,result=$3,error=$4'));
 expect(summary?.values[1]).toBe('failed');expect(summary?.values[3]).toBeTruthy();
}));
test('disputed grade is retained with invalid report and does not publish success',async()=>fixture(async root=>{const a=fake();await runNextScore(a.pool,root,async c=>({...await grade(c),report:{...await grade(c).then(r=>r.report),assessment_valid:false,disputes:['冲突']}}));const saved=a.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));expect(saved?.values[1]).toBe('failed');expect(JSON.parse(saved!.values[2]).report.disputes).toEqual(['冲突']);}));
test.each([{late:true},{inactive:true}])('late or invalidated grading cannot publish current score',async options=>fixture(async root=>{const a=fake(options);await runNextScore(a.pool,root,grade);expect(a.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);expect(a.calls.some(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'))).toBe(false);}));
test('snapshot tampering stops the model request',async()=>fixture(async root=>{const a=fake();a.job.input.context.answer='tampered';let called=false;await runNextScore(a.pool,root,async c=>{called=true;return grade(c);});expect(called).toBe(false);}));
test('provider errors never put raw messages in public history',async()=>fixture(async root=>{const a=fake();await runNextScore(a.pool,root,async()=>{throw new Error('secret-provider-body');});expect(JSON.stringify(a.calls)).not.toContain('secret-provider-body');expect(a.calls.some(c=>c.sql.includes("status='failed'"))).toBe(true);}));
test('heartbeat expiry is failed and terminal ordinary scoring still gets an automatic decision',async()=>{const a=fake({empty:true,stale:true});let judged=0;await runNextScore(a.pool,'unused',grade,undefined,async()=>{judged++;});expect(a.calls.some(c=>c.sql.includes("status='failed'")&&c.values[0]==='lost')).toBe(true);expect(judged).toBe(1);});
test('pre-cancelled worker cannot claim a grading attempt',async()=>{const a=fake();const controller=new AbortController();controller.abort();expect(await runNextScore(a.pool,'unused',grade,controller.signal)).toBe(false);expect(a.calls).toEqual([]);});
test('cancellation after model response cannot publish successful grading',async()=>fixture(async root=>{const a=fake();const controller=new AbortController();await runNextScore(a.pool,root,async c=>{const result=await grade(c);controller.abort();return result;},controller.signal);expect(a.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);}));

test('releases scoring transaction connection before automatic acceptance',async()=>fixture(async root=>{
 const bundle=[{model_id:'model-1',name:'模型一',status:'succeeded',attempt_id:'answer',answer_sha256:hash('100元')}];
 const scoreRows=[{id:'grade',input:{context:{binding:{answer_attempt_id:'answer'}}},result:{report:{total:1,max_score:1},validation:{valid:true}},status:'succeeded'}];
 const a=fake({bundle,scoreRows});let judged=0,connectionsDuringJudge=-1;
 await runNextScore(a.pool,root,grade,undefined,async()=>{connectionsDuringJudge=a.activeConnections();judged++;});
 expect(judged).toBe(1);expect(connectionsDuringJudge).toBe(0);
}));

test('releases failed scoring transaction connection before automatic acceptance',async()=>fixture(async root=>{
 const bundle=[{model_id:'model-1',name:'模型一',status:'succeeded',attempt_id:'answer',answer_sha256:hash('100元')}];
 const scoreRows=[{id:'grade',input:{context:{binding:{answer_attempt_id:'answer'}}},result:null,status:'failed'}];
 const a=fake({bundle,scoreRows});let judged=0,connectionsDuringJudge=-1;
 await runNextScore(a.pool,root,async()=>{throw new Error('private provider error');},undefined,async()=>{connectionsDuringJudge=a.activeConnections();judged++;});
 expect(judged).toBe(1);expect(connectionsDuringJudge).toBe(0);
}));

test('releases the recovery connection before automatic acceptance',async()=>{
 const bundle=[{model_id:'model-1',name:'模型一',status:'succeeded',attempt_id:'answer',answer_sha256:hash('100元')}];
 const scoreRows=[{id:'grade',input:{context:{binding:{answer_attempt_id:'answer'}}},result:{report:{total:1,max_score:1},validation:{valid:true}},status:'succeeded'}];
 const a=fake({empty:true,stale:true,bundle,scoreRows});let judged=0,connectionsDuringJudge=-1;
 await runNextScore(a.pool,'unused',grade,undefined,async()=>{connectionsDuringJudge=a.activeConnections();judged++;});
 expect(judged).toBe(1);expect(connectionsDuringJudge).toBe(0);
});

test('新评分队列按题目契约保存原文与模型指标，不再套旧正分校验',async()=>{
 await fixture(async root=>{
  const policy={contract:'model_report_v1',rules_text:'按项目评分',reference_answer:'none'};
  const f=fake({policy});
  const raw='<model_report>'+JSON.stringify({contract:'model_report_v1',items:[{id:'amount',judgment:'错误',score_delta:-7,reason:'证据'}],summary:{raw_score:-7,full_score:100,evaluation_percent:12,veto_triggered:true}})+'</model_report>';
  await runNextScore(f.pool,root,async()=>({raw_text:raw,report:{total:99},session_id:'model',usage:null,duration_ms:1}),undefined,async()=>{});
  const update=f.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=$2,result=$3'));
  expect(update).toBeDefined();expect(update!.values[1]).toBe('succeeded');
  const saved=JSON.parse(update!.values[2]);
  expect(saved.raw_text).toBe(raw);expect(saved.validation).toMatchObject({valid:true,evaluation_percent:12});
  expect(saved.report).toMatchObject({contract:'model_report_v1',summary:{raw_score:-7,evaluation_percent:12,veto_triggered:true}});
  expect(saved.report.total).toBeNull();
 });
});
test('新评分摘要兼容JSONB键顺序但绑定完整业务规则',()=>{
 const policy={contract:'model_report_v1' as const,rules_text:'扣分',reference_answer:'none' as const};
 const rubric=[{id:'x',criterion:'错误',rule:'扣7分',metadata:{z:1,a:2}}];
 const c={...context,scoring_policy:policy,rubric,binding:{...context.binding,rubric_digest:hash(scoreRubricBindingText(rubric,policy))}};
 const changed={...c,rubric:[{...rubric[0],metadata:{a:2,z:1}}],scoring_policy:{reference_answer:policy.reference_answer,rules_text:policy.rules_text,contract:policy.contract}};
 expect(scoreContextDigest(c)).toBe(scoreContextDigest(changed));
 expect(()=>scoreContextDigest({...c,rubric:[{...rubric[0],rule:'扣10分'}]})).toThrow('指纹');
});

test('评分阶段执行前后钩子且不泄漏思路或默认标答文件',async()=>{
 await fixture(async root=>{
  await mkdir(join(root,'hooks'));await writeFile(join(root,'hooks/check.ts'),"const input=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({data:{phase:input.position,approach:JSON.stringify(input.input).includes('核对金额'),reference:JSON.stringify(input.input).includes('校准参考答案.txt')}}));");
  const action={id:'check',script:'hooks/check.ts',files:['hooks/check.ts'],mode:'sync',params:{},timeout_ms:1000,idempotent:true};
  const f=fake();f.job.input.hooks=await freezeStageHooks(root,validateWorkflowConfig({hooks:{before:[action],after:[action]}}));
  f.job.input.hook_digest=hash(canonicalJson(f.job.input.hooks));
  let called=0;
  await runNextScore(f.pool,root,async c=>{called++;return grade(c);},undefined,async()=>{});
  expect(called).toBe(1);
  const records=[...f.hookRuns.values()].filter(r=>r.position!=='main');
  expect(records.map(r=>r.result?.data)).toEqual([{phase:'before',approach:false,reference:false},{phase:'after',approach:false,reference:false}]);
 });
});

test('新model_report评分入队冻结核对正文，旧报告仍不附加',async()=>{
 const policy={contract:'model_report_v1',rules_text:'按项目评分',reference_answer:'none'};
 for(const provider of ['codex','api'] as const){
  const f=fake({provider,policy});await enqueueScore(f.pool,'workflow');
  const insert=f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
  const frozen=JSON.parse(insert.values[2]);
  expect(frozen.execution_instructions.model_report_reading_instructions).toBe(scoreExecutionInstructions(provider,'model_report_v1').model_report_reading_instructions);
  expect(typeof frozen.execution_instructions.model_report_reading_instructions).toBe('string');
 }
 const legacy=fake();await enqueueScore(legacy.pool,'workflow');
 expect(JSON.parse(legacy.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!.values[2]).execution_instructions).not.toHaveProperty('model_report_reading_instructions');
});
test('新评分传递冻结核对正文，旧无字段任务传递空正文，改写快照拒绝执行',async()=>{
 const policy={contract:'model_report_v1',rules_text:'按项目评分',reference_answer:'none'};
 const root=await mkdtemp(join(tmpdir(),'score-frozen-reading-'));
 try{
  for(const provider of ['codex','api'] as const)for(const version of ['old','new','tampered']){
   const f=fake({provider,policy});
   if(version!=='old')f.job.input.execution_instructions=scoreExecutionInstructions(provider,'model_report_v1');
   if(version==='tampered')f.job.input.execution_instructions.model_report_reading_instructions+='篡改';
   let called=false,receivedGuide:unknown;
   await runNextScore(f.pool,root,(async(_context:any,options:any)=>{
    called=true;
    receivedGuide=options.model_report_reading_instructions;
    return {raw_text:'无有效结果',report:{},session_id:'fixture',usage:null,duration_ms:1};
   }) as any,undefined,async()=>{},provider);
   expect(called).toBe(version!=='tampered');
   if(called)expect(receivedGuide).toBe(version==='new'?scoreExecutionInstructions(provider,'model_report_v1').model_report_reading_instructions:'');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});


test('只有Work新评分冻结候选引文核验，不改变其他项目或旧队列摘要',async()=>{
 const policy={contract:'model_report_v1',rules_text:'模型按规则判断',reference_answer:'none'};
 for(const provider of ['codex','api'] as const)for(const content_contract of ['work_legal_v1','other',undefined]){
  const f=fake({provider,policy,content_contract});await enqueueScore(f.pool,'workflow');
  const frozen=JSON.parse(f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!.values[2]);
  expect(frozen.context.candidate_quote_check).toBe(content_contract==='work_legal_v1'?'literal_v1':undefined);
  expect(frozen.execution_instructions.candidate_quote_check).toBe(frozen.context.candidate_quote_check);
  if(content_contract==='work_legal_v1'){
   expect(frozen.execution_instructions.candidate_quote_instructions).toContain('自行更正');
   expect(frozen.execution_instructions.candidate_quote_tool_sha256).toMatch(/^[a-f0-9]{64}$/);
   expect(frozen.digest).toBe(scoreContextDigest(frozen.context));
  }
 }
 expect(scoreContextDigest({...context,content_contract:'work_legal_v1'})).toBe(scoreContextDigest(context));
});
test('Work两种worker都再次核验引文；错引保留原文但不产生有效指标，未改模型分数',async()=>fixture(async root=>{
 const policy={contract:'model_report_v1',rules_text:'模型按规则判断',reference_answer:'none'};
 for(const provider of ['codex','api'] as const)for(const quote of ['100元','仅校准中出现']){
  const f=fake({provider,policy,content_contract:'work_legal_v1'});
  f.job.input.context.candidate_quote_check='literal_v1';
  f.job.input.digest=scoreContextDigest(f.job.input.context);
  f.job.input.execution_instructions=scoreExecutionInstructions(provider,'model_report_v1','literal_v1');
  const model={contract:'model_report_v1',items:[{id:'amount',judgment:'扣分',score_delta:-7,reason:'模型判断',answer_quotes:[quote]}],summary:{raw_score:93,full_score:100,evaluation_percent:93,veto_triggered:false}};
  const raw_text='<model_report>'+JSON.stringify(model)+'</model_report>';
  await runNextScore(f.pool,root,async()=>({raw_text,report:{},session_id:'fixture',usage:null,duration_ms:1}),undefined,async()=>{},provider);
  const saved=JSON.parse(f.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=$2'))!.values[2]);
  expect(saved.raw_text).toBe(raw_text);expect(saved.validation.valid).toBe(quote==='100元');
  if(quote==='100元')expect(saved.report).toMatchObject(model);
  else {expect(saved.validation.evaluation_percent).toBeNull();expect(saved.validation.issues.join(' ')).toContain('不在候选答案原文');}
 }
}));

test('旧Work队列不补引文字段；新Work冻结工具摘要被改写时拒绝执行',async()=>fixture(async root=>{
 const policy={contract:'model_report_v1',rules_text:'模型按规则判断',reference_answer:'none'};
 for(const provider of ['codex','api'] as const)for(const version of ['old','tampered']){
  const f=fake({provider,policy,content_contract:'work_legal_v1'});
  if(version==='tampered'){
   f.job.input.context.candidate_quote_check='literal_v1';f.job.input.digest=scoreContextDigest(f.job.input.context);
   f.job.input.execution_instructions=scoreExecutionInstructions(provider,'model_report_v1','literal_v1');
   f.job.input.execution_instructions.candidate_quote_tool_sha256='0'.repeat(64);
  }
  let called=false;
  const raw='<model_report>'+JSON.stringify({contract:'model_report_v1',items:[{id:'amount',judgment:'未满足',score_delta:0,reason:'旧协议理由'}],summary:{raw_score:0,full_score:7,evaluation_percent:0,veto_triggered:false}})+'</model_report>';
  await runNextScore(f.pool,root,async()=>{called=true;return {raw_text:raw,report:{},session_id:'fixture',usage:null,duration_ms:1};},undefined,async()=>{},provider);
  expect(called).toBe(version==='old');
  if(version==='old'){
   const saved=JSON.parse(f.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET status=$2'))!.values[2]);
   expect(saved.validation.valid).toBe(true);expect(saved.report.items[0]).not.toHaveProperty('answer_quotes');
  }
 }
}));

test('local scoring failure restores without grader and without resetting current step',async()=>{
 const {LocalQueue}=await import('../execution-queue/store');const {withLocalExecution}=await import('../execution-queue/runtime');
 const root=await mkdtemp(join(tmpdir(),'score-terminal-')),queue=new LocalQueue(root,'test-device'),f=fake(),previous=process.env.EXECUTION_QUEUE_MODE;
 try{
  process.env.EXECUTION_QUEUE_MODE='local';f.job.id=crypto.randomUUID();queue.intent(f.job.id,'step','agent','score');queue.confirm(f.job.id);const job=queue.claim('agent')!;
  queue.saveStepFailure(job,{status:'failed',message:'已记录评分失败',result:{reason_code:'test_failure'}});
  let calls=0;await withLocalExecution(queue,job,()=>runNextScore(f.pool,root,async()=>{calls++;throw new Error('must not execute');},undefined,async()=>{}));
  expect(calls).toBe(0);expect(f.calls.some(c=>c.sql.startsWith("UPDATE ai_distill.steps SET status='running'"))).toBe(false);
  const write=f.calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed',result="));expect(write?.values[2]).toBe('已记录评分失败');
 }finally{queue.close();if(previous===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=previous;await rm(root,{recursive:true,force:true});}
});

test('新legacy评分不再冻结Python交卷自检',async()=>{
 for(const provider of ['codex','api'] as const){
  const f=fake({provider});await enqueueScore(f.pool,'workflow');
  const frozen=JSON.parse(f.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!.values[2]);
  expect(frozen.execution_instructions).not.toHaveProperty('legacy_text_preflight');
 }
});

test('legacy worker只核对历史摘要但不再派发自检，篡改摘要仍拒绝',async()=>{
 const root=await mkdtemp(join(tmpdir(),'legacy-preflight-worker-'));
 try{
  for(const version of ['old','new','tampered']){
   const f=fake();
   if(version!=='old')f.job.input.execution_instructions=scoreExecutionInstructions('codex',undefined,undefined,true);
   if(version==='tampered')f.job.input.execution_instructions.legacy_text_preflight_tool_sha256='invalid';
   let called=false,preflight:unknown;
   await runNextScore(f.pool,root,(async(_context:any,options:any)=>{
    called=true;preflight=options.legacy_text_preflight;
    return {raw_text:'无有效结果',report:{},session_id:'fixture',usage:null,duration_ms:1};
   }) as any,undefined,async()=>{});
   expect(called).toBe(version!=='tampered');
   if(called)expect(preflight).toBe(false);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
