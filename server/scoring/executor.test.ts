import {test,expect} from 'bun:test';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildAnonymousInput,runIndependentScore} from './executor';
import type {ScoreContext} from './validate';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const rubric=[{id:'amount',criterion:'准确指出金额',max_score:1}];
const context:ScoreContext={binding:{question_version:'v1',input_revision:1,input_digest:'a'.repeat(64),rubric_version:'r1',rubric_digest:hash(JSON.stringify(rubric)),answer_attempt_id:'private-id',answer_sha256:hash('100元')},question:'金额多少',materials:[{name:'原模型名称',text:'金额100元'}],answer:'100元',rubric};
const report={assessment_valid:true,items:[{id:'amount',score:1,reason:'金额正确',missing:false,evidence:[{source:'answer',quote:'100元',material_index:null}]}],total:1,max_score:1,disputes:[]};
test('anonymous input whitelists fields, renames attachments and preserves exact answer',()=>{
 const input=buildAnonymousInput({...context,provider:'secret-provider',reference_answer:'secret-reference',target_score:0} as ScoreContext);
 expect(input).toEqual({question:'金额多少',materials:[{name:'附件1',text:'金额100元'}],rubric,answer:'100元'});
 expect(JSON.stringify(input)).not.toContain('private-id');
});
test('invalid answer hash or rubric hash cannot be graded',()=>{
 expect(()=>buildAnonymousInput({...context,answer:'篡改'})).toThrow();
 expect(()=>buildAnonymousInput({...context,rubric:[{...rubric[0],max_score:2}]})).toThrow();
});
test('independent session sees only anonymous input and output binding is supplied by code',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-test-'));let directory='';
 try{
  const execute=async(options:any)=>{
   directory=options.directory;
   expect(await readdir(directory)).toEqual(['input.json']);
   const bytes=await readFile(join(directory,'input.json'),'utf8');expect(bytes).not.toContain('private-id');expect(bytes).not.toContain('原模型名称');
   expect(options.prompt).not.toContain(context.binding.answer_attempt_id);
   return {result:options.validate(report),session_id:'independent-session',usage:{input_tokens:12},events_path:join(directory,'output/events.jsonl'),duration_ms:10};
  };
  const result=await runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',execute:execute as any});
  expect(result.report.binding).toEqual(context.binding);expect(result.validation.valid).toBe(true);expect(result.session_id).toBe('independent-session');
  const second=await runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',execute:execute as any});expect(second.directory).not.toBe(result.directory);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('invalid semantic assessment is retained as invalid, never represented as successful grading',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-test-'));
 try{const execute=async(options:any)=>({result:options.validate({...report,assessment_valid:false,disputes:['规则冲突']}),session_id:'session',usage:null,events_path:'private',duration_ms:1});
 const result=await runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',execute:execute as any});expect(result.validation.valid).toBe(false);expect(result.report.disputes).toEqual(['规则冲突']);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('model cannot substitute version binding or leak identity into published report',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-test-'));
 try{const execute=async(options:any)=>({result:options.validate({...report,binding:{question_version:'forged'},provider:'forged',reference_answer:'forged'}),session_id:'session',usage:null,events_path:'private',duration_ms:1});
 const result=await runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',execute:execute as any});expect(result.report.binding).toEqual(context.binding);expect(result.report).not.toHaveProperty('provider');expect(result.report).not.toHaveProperty('reference_answer');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('cancelled grading does not invoke Codex or create an execution directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'grading-test-'));const controller=new AbortController();controller.abort();let called=false;
 try{await expect(runIndependentScore(context,{root,model:'fixture',reasoning_effort:'low',signal:controller.signal,execute:(async()=>{called=true;throw new Error();}) as any})).rejects.toThrow('取消');expect(called).toBe(false);expect(await readdir(root)).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
