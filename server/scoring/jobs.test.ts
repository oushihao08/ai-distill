/** 验证逐答案评分任务的上下文冻结、去重、执行、产物发布及取消隔离。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect,beforeAll,afterAll} from 'bun:test';
import {enqueueScore,runNextScore,scoreContextDigest} from './jobs';
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {inputDigest} from '../answer-models/input';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const snapshot=join(tmpdir(),`score-job-rules-${process.pid}`),ruleText='---\nname: scoring-fixture\ndescription: scoring test\n---\n本期评分规则';
const projectRules={version_id:'rules-v1',source_digest:hash('project-rules'),snapshot_path:snapshot,files:[{path:'skill/SKILL.md',sha256:hash(ruleText),size_bytes:Buffer.byteLength(ruleText)}]};
beforeAll(async()=>{await mkdir(join(snapshot,'skill'),{recursive:true});await writeFile(join(snapshot,'skill','SKILL.md'),ruleText);});
afterAll(async()=>{await rm(snapshot,{recursive:true,force:true});});
const rubric=[{id:'amount',criterion:'指出100元',max_score:1}];
const input={question_version:'v1',question:'多少',materials:[{name:'附件1',text:'欠款100元'}],attachments:[{id:'attachment',sha256:hash('欠款100元')}]};
const context={question:input.question,materials:input.materials,answer:'100元',rubric,answer_approach:'核对金额',reference_answer:'100元',project_rules:projectRules,binding:{question_version:'v1',input_digest:inputDigest(input),rubric_version:'r1',rubric_digest:hash(JSON.stringify(rubric)),answer_attempt_id:'answer',answer_sha256:hash('100元')}};
function fake(options:{reuse?:boolean;empty?:boolean;late?:boolean;unready?:boolean;inactive?:boolean;stale?:boolean;answers?:{id:string;text:string}[];bundle?:any[];scoreRows?:any[]}={}){
 const calls:{sql:string;values:any[]}[]=[];let claim=false;
 const job:any={id:'grade',workflow_id:'workflow',input:{context:structuredClone(context),digest:scoreContextDigest(context)},config:{provider:'codex',model:'gpt-6-luna',reasoning_effort:'medium'}};
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT w.project_id'))return {rowCount:1,rows:[{project_id:'project',rule_version_id:'rules-v1'}]};
  if(sql.startsWith('SELECT w.rule_version_id'))return {rowCount:1,rows:[{rule_version_id:'rules-v1',project_name:'本期项目',title:'本期项目-题目1',source_key:'题目1',local_skill_path:join(snapshot,'skill'),material_root:join(snapshot,'questions')}]};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rowCount:1,rows:[{codex_model:null,codex_reasoning_effort:null}]};
  if(sql.startsWith('SELECT a.input,a.result')){const answerId=values[0]??'answer',text=options.answers?.find(answer=>answer.id===answerId)?.text??'100元';return {rowCount:1,rows:[{input:{...input,question_attempt_id:'author',input_digest:inputDigest(input)},result:{text,input_digest:inputDigest(input),answer_sha256:hash(text)}}]};}
  if(sql.startsWith('SELECT a.id,a.input,a.result'))return {rowCount:1,rows:[{id:'author',input:{rule_version_id:projectRules.version_id,rule_source_digest:projectRules.source_digest,rule_snapshot_path:snapshot,rule_files:projectRules.files},result:{...input,attachment_ids:['attachment'],answer_approach:'核对金额',reference_answer:'100元',quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:options.late&&claim?'r2':'r1',rubric}}]};
  if(sql.includes('a.id=ANY($2::uuid[])'))return {rowCount:options.unready?0:(options.answers?.length??0),rows:options.unready?[]:(options.answers??[]).map(answer=>({id:answer.id}))};
  if(sql.startsWith('SELECT a.id FROM'))return {rowCount:options.unready?0:1,rows:options.unready?[]:[{id:'answer'}]};
  if(sql.startsWith('SELECT status,result FROM ai_distill.steps'))return {rowCount:1,rows:[{status:'succeeded',result:options.bundle?{models:options.bundle}:null}]};
  if(sql.startsWith('SELECT result FROM ai_distill.steps'))return {rowCount:1,rows:[{result:options.bundle?{models:options.bundle}:null}]};
  if(sql.startsWith('SELECT id,input,result,status FROM ai_distill.step_attempts'))return {rowCount:options.scoreRows?.length??0,rows:options.scoreRows??[]};
  if(sql.startsWith('SELECT config'))return {rowCount:1,rows:[{config:job.config}]};
  if(sql.startsWith('SELECT id FROM')&&sql.includes('config='))return {rowCount:options.reuse?1:0,rows:options.reuse?[{id:'existing'}]:[]};
  if(sql.startsWith('SELECT id FROM')&&sql.includes("status IN ('waiting','running')"))return {rowCount:0,rows:[]};
  if(sql.startsWith('SELECT a.id,a.workflow_id'))return {rowCount:options.stale?1:0,rows:options.stale?[{id:'lost',workflow_id:'workflow'}]:[]};
  if(sql.startsWith('SELECT a.*')){claim=true;return {rowCount:options.empty?0:1,rows:options.empty?[]:[job]};}
  if(sql.startsWith('SELECT id FROM')&&sql.includes("status='running'"))return {rowCount:options.inactive?0:1,rows:options.inactive?[]:[{id:'grade'}]};
  if(sql.startsWith('UPDATE ai_distill.step_attempts SET status=\'failed\'' )&&options.inactive)return {rowCount:0,rows:[]};
  if(sql.startsWith('SELECT id FROM ai_distill.artifacts'))return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[]};
 };
 return {pool:{query,connect:async()=>({query,release(){}})} as unknown as Pool,calls,job};
}
async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'score-jobs-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
const grade=async(c:any)=>({report:{binding:c.binding,assessment_valid:true,items:[{id:'amount',score:1,reason:'完整',evidence:[{source:'answer',quote:'100元'}]}],total:1,max_score:1,disputes:[]},session_id:'grade-session',usage:{input_tokens:5},duration_ms:10});
test('enqueue pins persisted context and deduplicates exactly the same input/config',async()=>{const a=fake();await enqueueScore(a.pool,'workflow');expect(a.calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))?.values.join(' ')).toContain('answer_sha256');const b=fake({reuse:true});expect(await enqueueScore(b.pool,'workflow')).toEqual({id:'existing',reused:true});expect(b.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);});
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
test('missing answer cannot create score attempt',async()=>{const a=fake({unready:true});await expect(enqueueScore(a.pool,'workflow')).rejects.toThrow();expect(a.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);});
test('idle scoring worker does not call Codex',async()=>{const a=fake({empty:true});let called=false;expect(await runNextScore(a.pool,'unused',async c=>{called=true;return grade(c);})).toBe(false);expect(called).toBe(false);});
test('valid grade saves report, binding, usage, session and downloadable artifact',async()=>fixture(async root=>{const a=fake();await runNextScore(a.pool,root,grade);expect(a.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(true);const saved=a.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));expect(saved?.values[1]).toBe('succeeded');expect(JSON.parse(saved!.values[2])).toMatchObject({validation:{valid:true},report:{binding:context.binding},session_id:'grade-session',usage:{input_tokens:5}});}));
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
test('revision scoring leaves its frozen acceptance decision to the revision runner',async()=>fixture(async root=>{
 const bundle=[{model_id:'model-1',name:'模型一',status:'succeeded',attempt_id:'answer',answer_sha256:hash('100元')}];
 const scoreRows=[{id:'grade',input:{context:{binding:{answer_attempt_id:'answer'}}},result:{report:{total:1,max_score:1},validation:{valid:true}},status:'succeeded'}];
 const a=fake({bundle,scoreRows});a.job.revision_round_id='revision-round';let judged=0;
 await runNextScore(a.pool,root,grade,undefined,async()=>{judged++;});
 expect(judged).toBe(0);
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
