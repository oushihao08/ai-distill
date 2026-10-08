import {test,expect} from 'bun:test';
import {enqueueScore,runNextScore,scoreContextDigest} from './jobs';
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {inputDigest} from '../answer-models/input';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const rubric=[{id:'amount',criterion:'指出100元',max_score:1}];
const input={question_version:'v1',input_revision:1,question:'多少',materials:[{name:'附件1',text:'欠款100元'}],attachments:[{id:'attachment',sha256:hash('欠款100元')}]};
const context={question:input.question,materials:input.materials,answer:'100元',rubric,binding:{question_version:'v1',input_revision:1,input_digest:inputDigest(input),rubric_version:'r1',rubric_digest:hash(JSON.stringify(rubric)),answer_attempt_id:'answer',answer_sha256:hash('100元')}};
function fake(options:{reuse?:boolean;empty?:boolean;late?:boolean;unready?:boolean;inactive?:boolean;stale?:boolean;answers?:{id:string;text:string}[];bundle?:any[];scoreRows?:any[]}={}){
 const calls:{sql:string;values:any[]}[]=[];let claim=false;
 const job={id:'grade',workflow_id:'workflow',input_revision:1,input:{context:structuredClone(context),digest:scoreContextDigest(context)},config:{provider:'codex',model:'gpt-6-astra',reasoning_effort:'medium'}};
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT w.input_revision'))return {rowCount:1,rows:[{input_revision:1,project_id:'project'}]};
  if(sql.startsWith('SELECT a.input,a.result')){const answerId=values[0]??'answer',text=options.answers?.find(answer=>answer.id===answerId)?.text??'100元';return {rowCount:1,rows:[{input:{...input,question_attempt_id:'author',input_digest:inputDigest(input)},result:{text,input_digest:inputDigest(input),answer_sha256:hash(text)}}]};}
  if(sql.startsWith('SELECT a.id,a.result'))return {rowCount:1,rows:[{id:'author',result:{...input,attachment_ids:['attachment'],quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:options.late&&claim?'r2':'r1',rubric}}]};
  if(sql.includes('a.id=ANY($3::uuid[])'))return {rowCount:options.unready?0:(options.answers?.length??0),rows:options.unready?[]:(options.answers??[]).map(answer=>({id:answer.id}))};
  if(sql.startsWith('SELECT a.id FROM'))return {rowCount:options.unready?0:1,rows:options.unready?[]:[{id:'answer'}]};
  if(sql.startsWith('SELECT status,result FROM ai_distill.steps'))return {rowCount:1,rows:[{status:'succeeded',result:options.bundle?{models:options.bundle}:null}]};
  if(sql.startsWith('SELECT result FROM ai_distill.steps'))return {rowCount:1,rows:[{result:options.bundle?{models:options.bundle}:null}]};
  if(sql.startsWith('SELECT id,input,result,status FROM ai_distill.step_attempts'))return {rowCount:options.scoreRows?.length??0,rows:options.scoreRows??[]};
  if(sql.startsWith('SELECT config'))return {rowCount:1,rows:[{config:job.config}]};
  if(sql.startsWith('SELECT id FROM')&&sql.includes('config='))return {rowCount:options.reuse?1:0,rows:options.reuse?[{id:'existing'}]:[]};
  if(sql.startsWith('SELECT id FROM')&&sql.includes("status IN ('waiting','running')"))return {rowCount:0,rows:[]};
  if(sql.startsWith('SELECT a.id,a.workflow_id'))return {rowCount:options.stale?1:0,rows:options.stale?[{id:'lost',workflow_id:'workflow',input_revision:1}]:[]};
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
 await runNextScore(a.pool,root,grade);
 const summary=a.calls.find(call=>call.sql.startsWith('UPDATE ai_distill.steps SET status=$3,result=$4'));
 expect(summary?.values[2]).toBe('waiting');
 expect(JSON.parse(summary?.values[3]).models.map((item:any)=>item.score_status)).toEqual(['succeeded','waiting']);
}));
test('disputed grade is retained with invalid report and does not publish success',async()=>fixture(async root=>{const a=fake();await runNextScore(a.pool,root,async c=>({...await grade(c),report:{...await grade(c).then(r=>r.report),assessment_valid:false,disputes:['冲突']}}));const saved=a.calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));expect(saved?.values[1]).toBe('failed');expect(JSON.parse(saved!.values[2]).report.disputes).toEqual(['冲突']);}));
test.each([{late:true},{inactive:true}])('late or invalidated grading cannot publish current score',async options=>fixture(async root=>{const a=fake(options);await runNextScore(a.pool,root,grade);expect(a.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);expect(a.calls.some(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'))).toBe(false);}));
test('snapshot tampering stops the model request',async()=>fixture(async root=>{const a=fake();a.job.input.context.answer='tampered';let called=false;await runNextScore(a.pool,root,async c=>{called=true;return grade(c);});expect(called).toBe(false);}));
test('provider errors never put raw messages in public history',async()=>fixture(async root=>{const a=fake();await runNextScore(a.pool,root,async()=>{throw new Error('secret-provider-body');});expect(JSON.stringify(a.calls)).not.toContain('secret-provider-body');expect(a.calls.some(c=>c.sql.includes("status='failed'"))).toBe(true);}));
test('heartbeat expiry is failed before looking for new tasks',async()=>{const a=fake({empty:true,stale:true});await runNextScore(a.pool,'unused',grade);expect(a.calls.some(c=>c.sql.includes("status='failed'")&&c.values[0]==='lost')).toBe(true);});
test('pre-cancelled worker cannot claim a grading attempt',async()=>{const a=fake();const controller=new AbortController();controller.abort();expect(await runNextScore(a.pool,'unused',grade,controller.signal)).toBe(false);expect(a.calls).toEqual([]);});
test('cancellation after model response cannot publish successful grading',async()=>fixture(async root=>{const a=fake();const controller=new AbortController();await runNextScore(a.pool,root,async c=>{const result=await grade(c);controller.abort();return result;},controller.signal);expect(a.calls.some(c=>c.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);}));
