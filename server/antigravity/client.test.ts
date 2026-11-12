/**
 * 职责：验证 Antigravity CLI (agy) 客户端的参数构造、NDJSON 事件流解析、普通出题文件交付、受限目录隔离、超时强杀与环境变量净化。
 * 验证边界：使用临时目录中的替身 CLI 脚本验证客户端契约，不调用真实远端模型。
 */
import {describe,expect,it} from 'bun:test';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agyLoginStatus,assembleAgyChunkedOutput,createAgyStreamSessionState,ingestAgyStreamLine,runAgy,type AgyOptions} from './client';
import {readAgyModelCatalog,resolveAgyModelAndEffort} from './models';

async function createAgyFixture(mode:'normal'|'fresh'|'recovered_fresh'|'recovered_structured_file'|'unrecovered_error'|'slow'|'error'|'missing_result'='normal'){
 const root=await mkdtemp(join(tmpdir(),'agy-client-test-'));
 const directory=join(root,'role');
 await mkdir(join(directory,'input'),{recursive:true});
 await writeFile(join(directory,'input','material.md'),'public input');
 await writeFile(join(root,'AGENTS.md'),'host workspace instructions');
 const binary=join(root,'fake-agy');
 const script=`#!${process.execPath}
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('Usage of agy:\\n  --print Run a single prompt');
 process.exit(0);
}
const mode=${JSON.stringify(mode)};
if(mode==='slow'){
 console.log(JSON.stringify({event:'init',conversation_id:'slow-conv',init:{model:'gemini-4-argon-low'}}));
 await Bun.sleep(10000);
 process.exit(0);
}
const stdinText=await Bun.stdin.text();
const modelIdx=args.indexOf('--model');
const model=modelIdx>=0?args[modelIdx+1]:'unknown';
const effortIdx=args.indexOf('--effort');
const effort=effortIdx>=0?args[effortIdx+1]:'unknown';
const ancestorAgents=existsSync(join(process.cwd(),'..','AGENTS.md'))||existsSync(join(process.cwd(),'AGENTS.md'));
mkdirSync(join(process.cwd(),'output'),{recursive:true});
writeFileSync(join(process.cwd(),'output','probe.json'),JSON.stringify({
 args,
 stdinText,
 cwd:process.cwd(),
 model,
 effort,
 ancestorAgents,
 leakedSecrets:['DATABASE_URL','OPENAI_API_KEY','ZHIPU_API_KEY'].filter(k=>process.env[k]),
}));
if(mode==='error'){
 console.error('fatal error from fake-agy');
 process.exit(2);
}
if(mode==='fresh'||mode==='recovered_fresh'){
 writeFileSync(join(${JSON.stringify(directory)},'output','result.json'),JSON.stringify({ok:true,mode}));
}
if(mode==='recovered_structured_file'){
 writeFileSync(join(process.cwd(),'output','result.json'),JSON.stringify({ok:true}));
}
console.log(JSON.stringify({event:'init',conversation_id:'agy-session-1',init:{model}}));
if(mode==='recovered_fresh'||mode==='recovered_structured_file'){
 console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:'agy-session-1',step_index:22,state:'DONE',step_type:'agent_response',duration_seconds:473.8}}));
 console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:'agy-session-1',step_index:23,state:'DONE',step_type:'error_message',duration_seconds:0}}));
 console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:'agy-session-1',step_index:29,state:'DONE',step_type:'tool',tool_name:'write_file',duration_seconds:2.1}}));
 console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:'agy-session-1',step_index:32,state:'DONE',step_type:'agent_response',text_delta:'已完成交付'}}));
 console.log(JSON.stringify({
  event:'result',
  result:{
   conversation_id:'agy-session-1',
   status:'ERROR',
   response:'已完成本题完整题目包的设计与落盘交付。',
   error:'The stream was interrupted. Please continue the task you were working on.',
   finished_reason:'error',
   usage:{input_tokens:377763,output_tokens:85017,total_tokens:462780},
  },
 }));
 process.exit(0);
}
if(mode==='unrecovered_error'){
 console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:'agy-session-1',step_index:5,state:'DONE',step_type:'agent_response',duration_seconds:12.0}}));
 console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:'agy-session-1',step_index:6,state:'DONE',step_type:'error_message',duration_seconds:0}}));
 console.log(JSON.stringify({
  event:'result',
  result:{
   conversation_id:'agy-session-1',
   status:'ERROR',
   response:'partial response before crash',
   error:'The stream was interrupted. Please continue the task you were working on.',
   finished_reason:'error',
  },
 }));
 process.exit(0);
}
console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:'agy-session-1',step_index:1,state:'DONE',step_type:'agent_response',text_delta:'{\"ok\":true}'}}));
if(mode!=='missing_result'){
 console.log(JSON.stringify({
  event:'result',
  result:{
   conversation_id:'agy-session-1',
   status:'SUCCESS',
   response:'{\"ok\":true}',
   structured_output:{ok:true},
   usage:{input_tokens:120,output_tokens:15,total_tokens:135},
  },
 }));
}
`;
 await writeFile(binary,script);
 await chmod(binary,0o755);
 const options:AgyOptions<{ok:boolean}>={
  binary,
  directory,
  prompt:'读取材料并返回 ok=true',
  model:'agy:gemini-4-argon',
  reasoning_effort:'medium',
  schema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']},
  validate(value){
   if(!value||typeof value!=='object'||(value as {ok?:unknown}).ok!==true)throw new Error('invalid');
   return value as {ok:boolean};
  },
 };
 return{root,directory,binary,options};
}

describe('Antigravity models & client',()=>{
 it('resolves tiered family models and efforts accurately',()=>{
  expect(resolveAgyModelAndEffort('agy:gemini-3.8-flash','medium')).toEqual({model:'gemini-3.8-flash-medium',effort:'medium'});
  expect(resolveAgyModelAndEffort('agy:gemini-4-argon','low')).toEqual({model:'gemini-4-argon-low',effort:'low'});
  expect(resolveAgyModelAndEffort('agy:gemini-4-argon','high')).toEqual({model:'gemini-4-argon-high',effort:'high'});
  expect(resolveAgyModelAndEffort('gemini-4-argon-high','ultra')).toEqual({model:'gemini-4-argon-high',effort:'max'});
  expect(resolveAgyModelAndEffort('agy:claude-sonnet-4-6','high')).toEqual({model:'claude-sonnet-4-6',effort:'high'});
  expect(readAgyModelCatalog().some(item=>item.slug==='agy:gemini-4-argon')).toBe(true);
 });

 it('checks agy CLI status and executes isolated structured tasks without leaking secrets or host AGENTS.md',async()=>{
  const f=await createAgyFixture('normal');
  const prevSecret=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='secret-do-not-leak';
  try{
   expect(await agyLoginStatus(f.binary)).toEqual({status:'authenticated'});
   const res=await runAgy({...f.options,isolate_context:true,developer_instructions:'严格遵守任务边界'});
   expect(res.result).toEqual({ok:true});
   expect(res.session_id).toBe('agy-session-1');
   expect(res.returned_model).toBe('gemini-4-argon-medium');
   expect(res.usage).toEqual({input_tokens:120,output_tokens:15,total_tokens:135});
   const probe=JSON.parse(await readFile(join(f.directory,'output','probe.json'),'utf8'));
   expect(probe.model).toBe('gemini-4-argon-medium');
   expect(probe.effort).toBe('medium');
   expect(probe.args).toContain('--sandbox');
   expect(probe.args).toContain('--disable-slash-commands');
   expect(probe.ancestorAgents).toBe(false);
   expect(probe.leakedSecrets).toEqual([]);
   expect(probe.stdinText).toContain('严格遵守任务边界');
   const reqSnapshot=JSON.parse(await readFile(join(f.directory,'output','request.json'),'utf8'));
   expect(reqSnapshot.resolved_model).toBe('gemini-4-argon-medium');
  }finally{
   if(prevSecret===undefined)delete process.env.OPENAI_API_KEY;
   else process.env.OPENAI_API_KEY=prevSecret;
   await rm(f.root,{recursive:true,force:true});
  }
 });

 it('supports fresh_authoring in project working_directory and reads output/result.json',async()=>{
  const f=await createAgyFixture('fresh');
  try{
   const res=await runAgy({
    ...f.options,
    model:'agy:gemini-4-argon',
    reasoning_effort:'low',
    execution_profile:'fresh_authoring',
    working_directory:f.root,
   });
   expect(res.result).toEqual({ok:true,mode:'fresh'} as any);
   expect(res.returned_model).toBe('gemini-4-argon-low');
   const probe=JSON.parse(await readFile(join(f.root,'output','probe.json'),'utf8'));
   expect(probe.args).not.toContain('--sandbox');
   expect(probe.ancestorAgents).toBe(true);
  }finally{
   await rm(f.root,{recursive:true,force:true});
  }
 });

 it('enforces timeout and records incomplete turns',async()=>{
  const slow=await createAgyFixture('slow');
  try{
   await expect(runAgy({...slow.options,timeout_ms:150})).rejects.toThrow('超时');
  }finally{
   await rm(slow.root,{recursive:true,force:true});
  }
  const missing=await createAgyFixture('missing_result');
  try{
   await expect(runAgy(missing.options)).rejects.toMatchObject({reason_code:'incomplete_turn'});
  }finally{
   await rm(missing.root,{recursive:true,force:true});
  }
 });

 it('accurately models in-turn stream interruption recovery vs unrecovered terminal error in AgyStreamSessionState',async()=>{
  const recoveredState=createAgyStreamSessionState();
  for(const event of [
   {event:'init',conversation_id:'conv-recovered',init:{model:'gemini-4-argon-medium'}},
   {event:'step_update',step_update:{conversation_id:'conv-recovered',step_index:22,state:'DONE',step_type:'agent_response',duration_seconds:473.8}},
   {event:'step_update',step_update:{conversation_id:'conv-recovered',step_index:23,state:'DONE',step_type:'error_message',duration_seconds:0}},
   {event:'step_update',step_update:{conversation_id:'conv-recovered',step_index:24,state:'DONE',step_type:'agent_response',duration_seconds:488.9}},
   {event:'step_update',step_update:{conversation_id:'conv-recovered',step_index:25,state:'DONE',step_type:'error_message',duration_seconds:0}},
   {event:'step_update',step_update:{conversation_id:'conv-recovered',step_index:29,state:'DONE',step_type:'tool',tool_name:'write_file',duration_seconds:2.1}},
   {event:'step_update',step_update:{conversation_id:'conv-recovered',step_index:32,state:'DONE',step_type:'agent_response',text_delta:'交付完成'}},
   {event:'result',result:{conversation_id:'conv-recovered',status:'ERROR',response:'已完成交付。',error:'The stream was interrupted. Please continue the task you were working on.',finished_reason:'error',usage:{total_tokens:462780}}},
  ]){
   ingestAgyStreamLine(recoveredState,JSON.stringify(event));
  }
  expect(recoveredState.session_id).toBe('conv-recovered');
  expect(recoveredState.error_step_count).toBe(2);
  expect(recoveredState.recovered_completion).toBe(true);
  expect(recoveredState.failed_event).toBe(false);
  expect(recoveredState.completed_result?.response).toBe('已完成交付。');

  const unrecoveredState=createAgyStreamSessionState();
  for(const event of [
   {event:'init',conversation_id:'conv-failed',init:{model:'gemini-4-argon-medium'}},
   {event:'step_update',step_update:{conversation_id:'conv-failed',step_index:10,state:'DONE',step_type:'agent_response'}},
   {event:'step_update',step_update:{conversation_id:'conv-failed',step_index:11,state:'DONE',step_type:'error_message'}},
   {event:'result',result:{conversation_id:'conv-failed',status:'ERROR',response:'partial output',error:'The stream was interrupted.',finished_reason:'error'}},
  ]){
   ingestAgyStreamLine(unrecoveredState,JSON.stringify(event));
  }
  expect(unrecoveredState.recovered_completion).toBe(false);
  expect(unrecoveredState.failed_event).toBe(true);
  expect(unrecoveredState.completed_result).toBeUndefined();
 });

 it('completes fresh_authoring and structured file delivery when agy recovers from mid-turn stream interruption, and rejects unrecovered turns',async()=>{
  const recoveredFresh=await createAgyFixture('recovered_fresh');
  try{
   const res=await runAgy({
    ...recoveredFresh.options,
    execution_profile:'fresh_authoring',
    working_directory:recoveredFresh.root,
   });
   expect(res.result).toEqual({ok:true,mode:'recovered_fresh'} as any);
   expect(res.usage).toEqual({input_tokens:377763,output_tokens:85017,total_tokens:462780});
   const completionText=await readFile(join(recoveredFresh.directory,'output','completion.txt'),'utf8');
   expect(completionText).toContain('已完成本题完整题目包的设计与落盘交付');
  }finally{
   await rm(recoveredFresh.root,{recursive:true,force:true});
  }

  const recoveredStructured=await createAgyFixture('recovered_structured_file');
  try{
   const res=await runAgy(recoveredStructured.options);
   expect(res.result).toEqual({ok:true});
  }finally{
   await rm(recoveredStructured.root,{recursive:true,force:true});
  }

  const unrecovered=await createAgyFixture('unrecovered_error');
  try{
   await expect(runAgy(unrecovered.options)).rejects.toMatchObject({reason_code:'incomplete_turn'});
  }finally{
   await rm(unrecovered.root,{recursive:true,force:true});
  }
 });

 it('deterministically assembles chunked _part_*.json files into result.json without loss',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'agy-chunk-test-')));
  const output=join(root,'output');
  await mkdir(output,{recursive:true});
  try{
   await writeFile(join(output,'_part_rubric.json'),JSON.stringify({
    task_name:'测试题目',
    question:'完整题面',
    rubric:[{id:'R1',criterion:'考点1'}],
   }));
   await writeFile(join(output,'_part_answer_1.json'),JSON.stringify({
    answer_approach:'完整思路',
    ref_part1:'第一阶段标答\n',
   }));
   await writeFile(join(output,'_part_answer_2.json'),JSON.stringify({
    ref_part2:'第二阶段标答',
   }));
   const resultPath=join(output,'result.json');
   const assembled=await assembleAgyChunkedOutput(output,resultPath,true);
   expect(assembled).toBe(true);
   const merged=JSON.parse(await readFile(resultPath,'utf8'));
   expect(merged).toEqual({
    task_name:'测试题目',
    question:'完整题面',
    rubric:[{id:'R1',criterion:'考点1'}],
    answer_approach:'完整思路',
    reference_answer:'第一阶段标答\n第二阶段标答',
   });
   // Existing result.json is not overwritten on second call
   expect(await assembleAgyChunkedOutput(output,resultPath,true)).toBe(false);
  }finally{
   await rm(root,{recursive:true,force:true});
  }
 });
});
