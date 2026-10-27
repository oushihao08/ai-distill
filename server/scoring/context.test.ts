/**
 * 验证评分上下文的项目身份、历史规则兼容、答案绑定和来源快照读取。
 * 使用 SQL 替身及临时文件；源码审阅或运行本测试均不代表真实数据库或模型验收。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readScoreContext} from './context';
import {inputDigest,answerPresentation} from '../answer-models/input';
import type{PoolClient}from'pg';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
test.each([false,true])('scoring context identifies the project and supports legacy=%s',async(legacy)=>{
 const root=await mkdtemp(join(tmpdir(),'score-context-'));const snapshot=join(root,'snapshot');
 try{
  await mkdir(join(snapshot,'skill'),{recursive:true});const text='---\nname: grading\ndescription: project grading\n---\n本期评分须按项目资料';await writeFile(join(snapshot,'skill','SKILL.md'),text);
  const files=[{path:'skill/SKILL.md',sha256:hash(text),size_bytes:Buffer.byteLength(text)}];
  const answerInput={question_version:'q1',question:'题目',materials:[{name:'附件1',text:'材料'}],attachments:[{id:'attachment',sha256:hash('材料')}],question_attempt_id:'author',input_digest:''};
  answerInput.input_digest=inputDigest({question_version:answerInput.question_version,question:answerInput.question,materials:answerInput.materials,attachments:answerInput.attachments});
  const authorResult={...answerInput,attachment_ids:['attachment'],answer_approach:'先核对材料',reference_answer:'依据材料作答',quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:'rubric-v1',rubric:[{id:'fact',criterion:'依据材料',max_score:1}]};
  const answerResult={text:'答案',input_digest:answerInput.input_digest,answer_sha256:hash('答案')};
  const db={query:async(sql:string)=>{
   if(sql.startsWith('SELECT w.rule_version_id'))return{rows:[{rule_version_id:'rules-v1',project_name:'本期项目',title:'本期项目-题目1',source_key:'题目1',local_skill_path:join(snapshot,'skill'),material_root:join(snapshot,'questions')}]};
   if(sql.startsWith('SELECT a.input,a.result'))return{rows:[{input:answerInput,result:answerResult}]};
   if(sql.startsWith('SELECT a.id,a.input,a.result')){expect(sql).not.toContain('ordinal=10');return{rows:[{id:'author',input:{rule_version_id:'rules-v1',rule_source_digest:hash('rules'),rule_snapshot_path:snapshot,rule_files:files},result:authorResult}]};}
   throw new Error(`unexpected query: ${sql}`);
  }} as any;
  const context=await readScoreContext(db,'workflow','answer',legacy);
  expect(context).toMatchObject({project_name:'本期项目',question_id:'题目1',answer_approach:'先核对材料',reference_answer:'依据材料作答'});
  if(legacy)expect(context.project_rules).toEqual({version_id:'rules-v1',source_digest:hash('rules'),snapshot_path:snapshot,files});
  else{expect(context.project_rules).toBeUndefined();expect(context.project_prompt).toBeUndefined();}
 }finally{await rm(root,{recursive:true,force:true});}
});

function failedAggregateContext(options:{presentation?:any;author_overrides?:any;summary?:readonly {attempt_id:string;status:string;answer_sha256:string}[];question_attempt_id?:string;result_input_digest?:string;scoring_policy?:any;rubric?:any[];system_prompt?:string;tampered_prompt?:string}={}){
 const answerInput={question_version:'q1',question:'题目',question_attempt_id:options.question_attempt_id??'author',materials:[{name:'附件1',text:'材料'}],attachments:[{id:'attachment',sha256:hash('材料')}],...(options.system_prompt!==undefined?{system_prompt:options.system_prompt}:{}),...(options.presentation?{presentation:options.presentation}:{}),input_digest:''};
 answerInput.input_digest=inputDigest({question_version:answerInput.question_version,question:answerInput.question,materials:answerInput.materials,attachments:answerInput.attachments,...(options.system_prompt!==undefined?{system_prompt:options.system_prompt}:{}),...(options.presentation?{presentation:options.presentation}:{})});
 if(options.tampered_prompt!==undefined)answerInput.system_prompt=options.tampered_prompt;
 const answerResult={text:'答案',input_digest:options.result_input_digest??answerInput.input_digest,answer_sha256:hash('答案')};
 const authorResult={question_version:'q1',question:'题目',attachment_ids:['attachment'],answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:'r1',rubric:options.rubric??[{id:'fact',criterion:'依据材料',max_score:1}],answer_approach:'核对材料',reference_answer:'依据材料作答',...(options.scoring_policy?{scoring_policy:options.scoring_policy}:{}),...options.author_overrides};
 const summary=options.summary??[{attempt_id:'answer',status:'succeeded',answer_sha256:answerResult.answer_sha256}];
 const db={query:async(sql:string)=>{
  if(sql.startsWith('SELECT w.rule_version_id'))return{rows:[{project_name:'本期项目',title:'题目1',source_key:'题目1',local_skill_path:'/tmp/skill',material_root:'/tmp/questions'}]};
  if(sql.startsWith('SELECT a.input,a.result')){
   expect(sql).toContain("s.status='failed'");expect(sql).toContain("model->>'attempt_id'=a.id::text");expect(sql).toContain("model->>'status'='succeeded'");expect(sql).toContain("model->>'answer_sha256'=a.result->>'answer_sha256'");
   const visible=summary.some(item=>item.attempt_id==='answer'&&item.status==='succeeded'&&item.answer_sha256===answerResult.answer_sha256);
   return{rows:visible?[{input:answerInput,result:answerResult}]:[]};
  }
  if(sql.startsWith('SELECT a.id,a.input,a.result'))return{rows:[{id:'author',input:options.scoring_policy?{scoring_policy:options.scoring_policy}:{},result:authorResult}]};
  throw new Error(`unexpected query: ${sql}`);
 }} as unknown as PoolClient;
 return{db};
}

test('failed model aggregate still permits its current successful answer to be scored',async()=>{
 const {db}=failedAggregateContext();
 const context=await readScoreContext(db,'workflow','answer');
 expect(context).toMatchObject({binding:{answer_attempt_id:'answer',answer_sha256:hash('答案')},answer:'答案'});
});

test('评分接受按实际作答提示词冻结的输入指纹，提示词不成为评分依据',async()=>{
 const prompt='仅根据题面和获准附件独立作答';
 const context=await readScoreContext(failedAggregateContext({system_prompt:prompt}).db,'workflow','answer');
 expect(context.answer).toBe('答案');
 expect(context).not.toHaveProperty('system_prompt');
});

test('评分拒绝冻结后被修改的作答提示词',async()=>{
 const {db}=failedAggregateContext({system_prompt:'原作答提示词',tampered_prompt:'修改后的提示词'});
 await expect(readScoreContext(db,'workflow','answer')).rejects.toThrow('版本不一致');
});

test.each([
 {summary:[{attempt_id:'older-answer',status:'succeeded',answer_sha256:hash('答案')}]},
 {summary:[{attempt_id:'answer',status:'failed',answer_sha256:hash('答案')}]},
 {summary:[{attempt_id:'answer',status:'succeeded',answer_sha256:hash('旧答案')}]},
 {result_input_digest:'wrong-digest'},
 {question_attempt_id:'older-author'},
])('rejects a failed aggregate answer with stale or mismatched binding: %o',async options=>{
 const {db}=failedAggregateContext(options);
 await expect(readScoreContext(db,'workflow','answer')).rejects.toThrow();
});

test('评分上下文使用题目冻结的完整规则并将业务字段纳入绑定',async()=>{
 const policy={contract:'model_report_v1' as const,rules_text:'按项目扣分，否决单列',reference_answer:'calibration' as const};
 const rubric=[{id:'deduct',criterion:'错误',rule:'扣7分',metadata:{score:-7,dimension:'专业'}}];
 const context=await readScoreContext(failedAggregateContext({scoring_policy:policy,rubric}).db,'workflow','answer');
 expect(context.scoring_policy).toEqual(policy);expect(context.rubric).toEqual(rubric);
 const changed=await readScoreContext(failedAggregateContext({scoring_policy:policy,rubric:[{...rubric[0],metadata:{...rubric[0].metadata,score:-10}}]}).db,'workflow','answer');
 expect(changed.binding.rubric_digest).not.toBe(context.binding.rubric_digest);
});

test('评分回读文字成果快照并拒绝清单与当前题目不一致',async()=>{
 const author_overrides={content_contract:'work_legal_v1',content_status:{status:'complete'},task_requirements:{input_mode:'text',output_mode:'file',tools:[]},deliverables:[{id:'D1',path:'意见.md',description:'完整法律意见',required:true}]};
 const presentation=answerPresentation(author_overrides)!;
 const ctx=await readScoreContext(failedAggregateContext({presentation,author_overrides}).db,'workflow','answer');
 expect(ctx.answer_presentation).toEqual(presentation);expect(ctx.question).toBe('题目');
 await expect(readScoreContext(failedAggregateContext({presentation:{...presentation,instructions:'偷偷改变要求'},author_overrides}).db,'workflow','answer')).rejects.toThrow('版本不一致');
});

test.each([undefined,{contract:'model_report_v1',rules_text:'按判据评分',reference_answer:'none'}])('普通评分不要求未使用的思路或标答：%o',async scoring_policy=>{
 const rubric=scoring_policy?[{id:'fact',criterion:'依据材料',rule:'按事实评分'}]:undefined;
 const context=await readScoreContext(failedAggregateContext({scoring_policy,rubric,author_overrides:{answer_approach:undefined,reference_answer:undefined}}).db,'workflow','answer');
 expect(context.answer).toBe('答案');expect(context.answer_approach).toBe('');expect(context.reference_answer).toBe('');
});

test('校准评分只要求标答，不要求作答思路',async()=>{
 const scoring_policy={contract:'model_report_v1',rules_text:'按判据评分',reference_answer:'calibration'};
 const rubric=[{id:'fact',criterion:'依据材料',rule:'按事实评分'}];
 await expect(readScoreContext(failedAggregateContext({scoring_policy,rubric,author_overrides:{answer_approach:undefined,reference_answer:' '}}).db,'workflow','answer')).rejects.toThrow('缺少标准答案');
 const context=await readScoreContext(failedAggregateContext({scoring_policy,rubric,author_overrides:{answer_approach:undefined}}).db,'workflow','answer');
 expect(context.reference_answer).toBe('依据材料作答');
});
