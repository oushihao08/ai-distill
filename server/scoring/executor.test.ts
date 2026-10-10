/** 验证评分仅接收同版题面、rubric、附件和匿名答案；覆盖独立会话、文本总分、绑定与取消，不调用真实模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildAnonymousInput,buildScoreFiles,runIndependentScore} from './executor';
import {DEFAULT_STEP_PROMPTS,resolveScoreStepPrompt} from '@shared/step-prompts';
import type {ScoreContext} from './validate';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const rubric=[{id:'amount',criterion:'准确指出金额',max_score:1}];
const baseProjectRules={version_id:'rules-v1',source_digest:hash('rules'),snapshot_path:'/unreadable-project-snapshot',files:[{path:'skill/SKILL.md',sha256:hash('规则正文'),size_bytes:12}]};
const context:ScoreContext={binding:{question_version:'v1',input_digest:'a'.repeat(64),rubric_version:'r1',rubric_digest:hash(JSON.stringify(rubric)),answer_attempt_id:'private-id',answer_sha256:hash('100元')},question:'金额多少',materials:[{name:'原模型名称',text:'金额100元'}],answer:'100元',rubric,answer_approach:'私有作答思路',reference_answer:'私有标准答案',project_rules:baseProjectRules};
const report='amount：1 / 1分。金额正确。答案原文证据：“100元”。\n最终总分：1 / 1 分';
const reply=(call:any,text=report)=>({result:call.validate(text),session_id:'independent-session',usage:null,diagnostic_path:'private',duration_ms:1,provider:'fixture',model:'fixture'});

test('default scoring prompt asks for per-item reasoning and exact answer evidence',()=>{
 const prompt=resolveScoreStepPrompt();
 for(const part of ['逐项','判断理由','答案原文证据','不得使用作答思路或标准答案'])expect(prompt).toContain(part);
 expect(resolveScoreStepPrompt('依据本题题面、rubric、作答思路和标准答案，对匿名完整答案逐项评分，并引用答案原文证据。')).toBe(prompt);
 expect(resolveScoreStepPrompt('自定义提示词')).toBe('自定义提示词');expect(DEFAULT_STEP_PROMPTS[6]).toBe(prompt);
});
test('internal anonymous context preserves binding checks while actual files exclude private references',()=>{
 const input=buildAnonymousInput({...context,provider:'secret-provider',target_score:0} as ScoreContext);
 expect(input.answer).toBe(context.answer);expect(input.materials).toEqual([{name:'附件1',text:'金额100元'}]);
 const files=buildScoreFiles(input);expect(files.map(f=>f.name)).toEqual(['题面与评分标准.txt','附件1.txt','待评答案.txt']);
 const body=JSON.stringify(files);
 for(const secret of ['private-id','原模型名称','secret-provider','target_score','私有作答思路','私有标准答案','skill/SKILL.md'])expect(body).not.toContain(secret);
 expect(files[2]?.text).toBe(context.answer);
});
test('invalid answer hash or rubric hash cannot be graded',()=>{
 expect(()=>buildAnonymousInput({...context,answer:'篡改'})).toThrow();
 expect(()=>buildAnonymousInput({...context,rubric:[{...rubric[0]!,max_score:2}]})).toThrow();
});
test('independent sessions receive only split files and frozen output bindings supplied by code',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-test-'));
 try{
  const execute=async(call:any)=>{
   expect(await readdir(call.directory)).toEqual([]);expect(call.task_type).toBe('independent_scoring');
   expect(call.output_format).toBe('text');expect(call.schema).toBeUndefined();
   expect(call.execution_profile).toBeUndefined();expect(call.working_directory).toBeUndefined();
   expect(call.input_files).toEqual(buildScoreFiles(buildAnonymousInput(context)));
   expect(call.prompt).not.toContain(context.binding.answer_attempt_id);expect(call.prompt).toContain(DEFAULT_STEP_PROMPTS[6]);
   return reply(call);
  };
  const result=await runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',execute});
  expect(result.report).toEqual({binding:context.binding,total:1,max_score:1});expect(result.validation.valid).toBe(true);
  expect(result.raw_text).toBe(report);expect(result.session_id).toBe('independent-session');
  const second=await runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',execute});expect(second.directory).not.toBe(result.directory);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('project skill, identity and reference answers never enter the scoring request',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-private-'));
 try{
  const task={...context,project_name:'私有项目名称',question_id:'私有题目ID',model_id:'私有模型名称',target_score:99,step_prompt:'旧设置'};
  const result=await runIndependentScore(task,{root,model:'fixture',reasoning_effort:'low',step_prompt:'本次评分设置',execute:async(call:any)=>{
   const serialized=JSON.stringify({prompt:call.prompt,files:call.input_files});
   for(const secret of ['私有项目名称','私有题目ID','私有模型名称','target_score','私有作答思路','私有标准答案','skill/SKILL.md',baseProjectRules.snapshot_path,'旧设置'])expect(serialized).not.toContain(secret);
   expect(call.prompt).toContain('本次评分设置');expect(await readdir(call.directory)).toEqual([]);
   return reply(call);
  }});
  expect(result.validation.valid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('missing or impossible final totals are retained as invalid and never successful grading',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-invalid-'));
 try{
  for(const text of ['规则冲突，无法确定总分','最终总分：2 / 1 分']){
   const result=await runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',execute:async(call:any)=>reply(call,text)});
   expect(result.validation.valid).toBe(false);expect(result.raw_text).toBe(text);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('model text cannot substitute the binding or add private fields to the structured report',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-binding-'));
 try{
  const result=await runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',execute:async(call:any)=>reply(call,'binding={question_version:forged}; provider=forged; reference_answer=forged\n'+report)});
  expect(result.report.binding).toEqual(context.binding);expect(result.report).not.toHaveProperty('provider');expect(result.report).not.toHaveProperty('reference_answer');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cancelled grading never invokes Codex or creates an execution directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-cancel-'));const controller=new AbortController();controller.abort();let called=false;
 try{
  await expect(runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',signal:controller.signal,execute:async()=>{called=true;throw new Error('unexpected');}})).rejects.toThrow('取消');
  expect(called).toBe(false);expect(await readdir(root)).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
