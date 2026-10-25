/** 验证 Codex 登录类型、受限进程执行、结果校验、超时取消和安全错误记录。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect,setDefaultTimeout,beforeEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {codexLoginStatus,configureCodexCredentialsHome,runCodex,type CodexOptions} from './client';
import{configureLogger}from'../logging';

// These tests spawn a fresh CLI process; allow for contention when the full backend suite runs in parallel.
setDefaultTimeout(15000);
beforeEach(()=>configureCodexCredentialsHome(async()=>undefined));

async function fixture(mode='success'){
 const root=await mkdtemp(join(tmpdir(),'codex-client-'));const directory=join(root,'role');await mkdir(join(directory,'input'),{recursive:true});await writeFile(join(directory,'input','material.md'),'public input');await writeFile(join(root,'AGENTS.md'),'host workspace instructions');const binary=join(root,'cli');
 const code=`#!${process.execPath}\nconst args=process.argv.slice(2);const mode=${JSON.stringify(mode)};const fs=require('node:fs');const path=require('node:path');let parent=process.cwd(),ancestorAgentFile=false;while(true){if(fs.existsSync(path.join(parent,'AGENTS.md')))ancestorAgentFile=true;const next=path.dirname(parent);if(next===parent)break;parent=next;}
if(args[0]==='login'){if(mode==='slow_login')await new Promise(resolve=>setTimeout(resolve,500));console.error(mode==='api_key'?'Logged in using an API key':'Logged in using ChatGPT');process.exit(0);}
const out=args[args.indexOf('--output-last-message')+1];await Bun.write(out+'.request.json',JSON.stringify({pid:process.pid,args,prompt:await Bun.stdin.text(),secrets:['DATABASE_URL','ZHIPU_API_KEY','OPENAI_API_KEY'].filter(key=>process.env[key]),proxy:process.env.HTTPS_PROXY==='http://127.0.0.1:12345',cwd:process.cwd(),ancestorAgentFile}));
if(mode==='large_output'){process.stdout.write('x'.repeat(65*1024*1024));await new Promise(resolve=>setTimeout(resolve,1000));process.exit(0);}
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
emit({type:'thread.started',thread_id:mode==='file_result'?'fixture-session-'+process.pid:'fixture-session'});emit({type:'turn.started'});if(mode==='reconnect')emit({type:'error',message:'Reconnecting... 1/5 (request timed out)'});
if(mode==='wait'){setInterval(()=>{},1000);await new Promise(()=>{});}
const text=mode==='malformed'?'invalid json':JSON.stringify({ok:true});
if(mode!=='missing')await Bun.write(out,text);
if(mode==='file_result')await Bun.write(path.join(path.dirname(out),'result.json'),JSON.stringify({ok:true}));
if(mode==='file_malformed')await Bun.write(path.join(path.dirname(out),'result.json'),'invalid json');
if(mode==='file_large')fs.writeFileSync(path.join(path.dirname(out),'result.json'),'x'.repeat(33*1024*1024));
if(mode==='file_symlink'){const foreign=path.join(process.cwd(),'foreign.json');fs.writeFileSync(foreign,JSON.stringify({ok:true}));fs.symlinkSync(foreign,path.join(path.dirname(out),'result.json'));}
emit({type:'item.completed',item:{id:'message',type:'agent_message',text}});
if(mode!=='incomplete')emit({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:4}});
if(mode==='exit_failure'){console.error('fixture failure details');process.exit(1);}
`;
 await writeFile(binary,code);await chmod(binary,0o700);
 const options:CodexOptions<{ok:boolean}>={binary,directory,prompt:'Read input/material.md; write the requested result.',model:'fixture-model',reasoning_effort:'high',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},validate(value){if(!value||typeof value!=='object'||!('ok'in value)||value.ok!==true)throw new Error('invalid result');return{ok:true};},timeout_ms:2000};
 return{root,binary,options};
}
test('Codex status recognizes the existing ChatGPT login without exposing auth content',async()=>{
 const f=await fixture();try{expect(await codexLoginStatus(f.binary)).toEqual({status:'chatgpt'});}finally{await rm(f.root,{recursive:true,force:true});}
});
test('Codex refuses an API-key login instead of silently using API billing',async()=>{
 const f=await fixture('api_key');try{expect(await codexLoginStatus(f.binary)).toEqual({status:'api_key'});await expect(runCodex(f.options)).rejects.toThrow('套餐登录');}finally{await rm(f.root,{recursive:true,force:true});}
});
test('Codex run records events and validates a real result file under a named restrictive profile',async()=>{
 const f=await fixture();const old=process.env.DATABASE_URL;process.env.DATABASE_URL='test-only-must-not-inherit';
 try{
  const result=await runCodex(f.options);expect(result.result).toEqual({ok:true});expect(result.session_id).toBe('fixture-session');expect(result.usage).toEqual({input_tokens:10,cached_input_tokens:2,output_tokens:4});
  const events=await readFile(result.events_path,'utf8');expect(events).toContain('turn.completed');
  const request=JSON.parse(await readFile(join(f.options.directory,'output','result.json.request.json'),'utf8'));
  expect(request.secrets).toEqual([]);expect(request.args).toContain('--ignore-user-config');expect(request.args).toContain('--ephemeral');expect(request.args).toContain('features.memories=false');expect(request.args).not.toContain('--sandbox');
  expect(request.ancestorAgentFile).toBe(false);expect(request.cwd).not.toBe(f.options.directory);
  expect(request.args[request.args.indexOf('--output-last-message')+1]).toBe(join(request.cwd,'output','result.json'));
  expect(request.args).toContain('default_permissions="distill_role"');expect(request.args).toContain('model_reasoning_effort="high"');expect(request.prompt).toBe(f.options.prompt);
  expect(await readFile(join(f.options.directory,'input','material.md'),'utf8')).toBe('public input');
 }finally{if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;await rm(f.root,{recursive:true,force:true});}
});
test('Codex developer instruction is passed separately from the task prompt',async()=>{
 const f=await fixture();try{
  await runCodex({...f.options,developer_instructions:'固定执行边界'});
  const request=JSON.parse(await readFile(join(f.options.directory,'output','result.json.request.json'),'utf8'));
  expect(request.args).toContain('developer_instructions="固定执行边界"');expect(request.prompt).toBe(f.options.prompt);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('Codex total deadline also covers the login preflight',async()=>{
 const f=await fixture('slow_login');try{await expect(runCodex({...f.options,timeout_ms:40})).rejects.toThrow('Codex执行超时');}finally{await rm(f.root,{recursive:true,force:true});}
});
test('Codex stops and fails when the event stream exceeds its memory bound',async()=>{
 const f=await fixture('large_output');try{await expect(runCodex(f.options)).rejects.toThrow('Codex输出超过限制');}finally{await rm(f.root,{recursive:true,force:true});}
});
for(const [mode,reason_code] of[['missing','result_missing'],['malformed','invalid_json'],['incomplete','incomplete_turn'],['exit_failure','process_exit_nonzero']] as const)test(`Codex cannot publish success for ${mode}`,async()=>{
 const f=await fixture(mode),logger=configureLogger({root:join(f.root,'log-root'),service:'worker'});
 try{
  await expect(runCodex(f.options)).rejects.toThrow(/结果|执行/);await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(f.root,'log-root','logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({event:'call.failed',operation:'codex_exec',reason_code}));
 }finally{await logger.close();await rm(f.root,{recursive:true,force:true});}
});
test('Codex timeout stops its own process and records failure rather than completion',async()=>{
 const f=await fixture('wait'),logger=configureLogger({root:join(f.root,'log-root'),service:'worker'});
 try{
  await expect(runCodex({...f.options,timeout_ms:3000})).rejects.toThrow('超时');expect(await readFile(join(f.options.directory,'output','events.jsonl'),'utf8')).toContain('turn.started');await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(f.root,'log-root','logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({event:'timeout.fired',provider:'codex',timeout_ms:3000}));
  const request=JSON.parse(await readFile(join(f.options.directory,'output','result.json.request.json'),'utf8'));expect(()=>process.kill(request.pid,0)).toThrow();
  expect(records).toContainEqual(expect.objectContaining({event:'call.failed',error_kind:'timeout'}));
  const timeout=records.find(record=>record.event==='timeout.fired'),failed=records.find(record=>record.event==='call.failed');expect(failed?.call_id).toBe(timeout?.call_id);
 }finally{await logger.close();await rm(f.root,{recursive:true,force:true});}
});
test('already cancelled Codex work never starts a model invocation',async()=>{
 const f=await fixture();try{await expect(runCodex({...f.options,signal:AbortSignal.abort()})).rejects.toThrow('取消');}finally{await rm(f.root,{recursive:true,force:true});}
});
test('Codex result validation failure records a safe terminal call failure',async()=>{
 const f=await fixture(),logger=configureLogger({root:join(f.root,'log-root'),service:'worker'});
 try{
  await expect(runCodex({...f.options,validate:()=>{throw Object.assign(new Error('reject this role result'),{kind:'invalid_response',reason_code:'page_count_mismatch'});}})).rejects.toThrow('结果');await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(f.root,'log-root','logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const started=records.find(record=>record.event==='call.failed');
  expect(started?.call_id).toMatch(/^[0-9a-f-]{36}$/);expect(started?.level).toBe('error');
  expect(records).toContainEqual(expect.objectContaining({event:'call.started',call_id:started?.call_id}));
  expect(JSON.stringify(records)).not.toContain('reject this role result');
  expect(records).toContainEqual(expect.objectContaining({event:'call.failed',call_id:started?.call_id,operation:'codex_exec',error_kind:'invalid_response',reason_code:'page_count_mismatch'}));
 }finally{await logger.close();await rm(f.root,{recursive:true,force:true});}
});
test('Codex errors preserve a safe call id and failure reason for the owning workflow',async()=>{
 const f=await fixture('missing'),logger=configureLogger({root:join(f.root,'log-root'),service:'worker'});
 try{
  let failure:unknown;
  try{await runCodex(f.options);}catch(error){failure=error;}
  expect(failure).toMatchObject({kind:'invalid_response',reason_code:'result_missing',retryable:false});
  expect((failure as {call_id?:unknown}).call_id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect((failure as {occurred_at?:unknown}).occurred_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  await logger.flush();const day=new Date().toISOString().slice(0,10),directory=join(f.root,'log-root','logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect((failure as {call_id:string}).call_id).toBe(records.find(record=>record.event==='call.failed')?.call_id);
  expect(JSON.stringify(records)).not.toContain('Codex结果缺失、无效或执行未完整结束');
 }finally{await logger.close();await rm(f.root,{recursive:true,force:true});}
});
test('Codex workspace preparation failure records a safe terminal call failure',async()=>{
 const f=await fixture(),logger=configureLogger({root:join(f.root,'log-root'),service:'worker'});
 try{
  await expect(runCodex({...f.options,directory:join(f.root,'missing-workspace')})).rejects.toThrow('准备失败');await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(f.root,'log-root','logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const started=records.find(record=>record.event==='call.failed');
  expect(records).toContainEqual(expect.objectContaining({event:'call.failed',call_id:started?.call_id,operation:'codex_exec',reason_code:'workspace_setup_failed'}));
 }finally{await logger.close();await rm(f.root,{recursive:true,force:true});}
});

test('Codex preserves configured transport proxy without forwarding provider or database keys',async()=>{
 const f=await fixture();const old=process.env.HTTPS_PROXY;process.env.HTTPS_PROXY='http://127.0.0.1:12345';
 try{await runCodex(f.options);const request=JSON.parse(await readFile(join(f.options.directory,'output','result.json.request.json'),'utf8'));expect(request.proxy).toBe(true);expect(request.secrets).toEqual([]);}
 finally{if(old===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=old;await rm(f.root,{recursive:true,force:true});}
});
test('transient reconnect events do not override a completed validated Codex result',async()=>{
 const f=await fixture('reconnect');try{expect((await runCodex(f.options)).result).toEqual({ok:true});}finally{await rm(f.root,{recursive:true,force:true});}
});
test('fresh authoring uses the project cwd and writes a dedicated result without restricting desktop tools',async()=>{
 const f=await fixture('file_result');
 const manifest={authoring_contract:'fresh-desktop-v1',project_context:{source_digest:'a'.repeat(64),files:[{path:'skill/SKILL.md',sha256:'b'.repeat(64),size_bytes:12}]},materials:[{id:'fixture-material',sha256:'c'.repeat(64),path:'input/attachments/附件1.txt'}]};
 await writeFile(join(f.options.directory,'input/input.json'),JSON.stringify(manifest));
 try{
  const result=await runCodex({...f.options,execution_profile:'fresh_authoring',working_directory:f.root} as any);
  expect(result.result).toEqual({ok:true});
  const request=JSON.parse(await readFile(join(f.options.directory,'output','completion.txt.request.json'),'utf8'));
  expect(request.cwd).toBe(await import('node:fs/promises').then(fs=>fs.realpath(f.root)));
  expect(request.ancestorAgentFile).toBe(true);
  expect(request.args).not.toContain('--ignore-user-config');expect(request.args).not.toContain('--ignore-rules');
  expect(request.args).not.toContain('--output-schema');expect(request.args).not.toContain('permissions.distill_role.network.enabled=false');
  expect(request.args).toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(request.args).toContain('--ephemeral');expect(request.args).toContain('features.memories=false');
  expect(request.secrets).toEqual([]);
  const evidence=JSON.parse(await readFile(join(f.options.directory,'output','request.json'),'utf8'));
  expect(evidence.cwd).toBe(request.cwd);expect(evidence.execution_profile).toBe('fresh_authoring');expect(evidence.input_manifest).toEqual(manifest);expect(evidence.configuration_home).toBeTruthy();
  expect(await Bun.file(join(f.root,'AGENTS.md')).exists()).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('fresh authoring does not accept the last chat reply as the result file',async()=>{
 const f=await fixture();
 try{await mkdir(join(f.options.directory,'output'));await writeFile(join(f.options.directory,'output/result.json'),JSON.stringify({ok:true}));await expect(runCodex({...f.options,execution_profile:'fresh_authoring',working_directory:f.root})).rejects.toMatchObject({reason_code:'result_missing'});}
 finally{await rm(f.root,{recursive:true,force:true});}
});
test('nonzero Codex exit records a safe call failure after the process closes',async()=>{
 const f=await fixture('exit_failure'),logger=configureLogger({root:join(f.root,'log-root'),service:'worker'});
 try{
  await expect(runCodex(f.options)).rejects.toThrow('Codex执行失败');await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(f.root,'log-root','logs',day),files=await readdir(directory),records=(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const failed=records.find(record=>record.event==='call.failed');
  expect(failed).toMatchObject({call_id:expect.stringMatching(/^[0-9a-f-]{36}$/),provider:'codex',operation:'codex_exec',reason_code:'process_exit_nonzero',exit_code:1});
  const request=JSON.parse(await readFile(join(f.options.directory,'output','result.json.request.json'),'utf8'));expect(()=>process.kill(request.pid,0)).toThrow();
  const privateEvents=await readFile(join(f.options.directory,'output','events.jsonl'),'utf8');
  expect(privateEvents).toContain('"type":"distill.process_failed"');expect(privateEvents).toContain('fixture failure details');
 }finally{await logger.close();await rm(f.root,{recursive:true,force:true});}
});

for(const mode of ['file_malformed','file_large','file_symlink'])test(`fresh authoring rejects unsafe dedicated result ${mode}`,async()=>{
 const f=await fixture(mode);
 try{await expect(runCodex({...f.options,execution_profile:'fresh_authoring',working_directory:f.root})).rejects.toThrow('结果');expect(await Bun.file(join(f.root,'AGENTS.md')).exists()).toBe(true);}
 finally{await rm(f.root,{recursive:true,force:true});}
});
test('parallel authoring attempts share project cwd but never output files or sessions',async()=>{
 const f=await fixture('file_result'),second=join(f.root,'second-role');await mkdir(join(second,'input'),{recursive:true});
 try{
  const a={...f.options,execution_profile:'fresh_authoring' as const,working_directory:f.root};
  const results=await Promise.all([runCodex(a),runCodex({...a,directory:second})]);
  expect(results[0]!.session_id).not.toBe(results[1]!.session_id);expect(results[0]!.events_path).not.toBe(results[1]!.events_path);
  for(const directory of [f.options.directory,second]){expect(await Bun.file(join(directory,'output/result.json')).json()).toEqual({ok:true});expect(await Bun.file(join(directory,'output/completion.txt')).exists()).toBe(true);}
  expect(await Bun.file(join(f.root,'AGENTS.md')).exists()).toBe(true);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('fresh authoring timeout preserves the project directory and its inputs',async()=>{
 const f=await fixture('wait');
 try{await expect(runCodex({...f.options,execution_profile:'fresh_authoring',working_directory:f.root,timeout_ms:3000})).rejects.toThrow('超时');expect(await Bun.file(join(f.root,'AGENTS.md')).text()).toBe('host workspace instructions');expect(await Bun.file(join(f.options.directory,'input/material.md')).text()).toBe('public input');}
 finally{await rm(f.root,{recursive:true,force:true});}
});

test('repeated Agent success, failure, cancellation and timeout leave no registered live child',async()=>{
 const active=new Set<number>(),spawned:number[]=[];
 for(const mode of ['success','exit_failure','cancel','timeout']){
  const f=await fixture(mode==='cancel'||mode==='timeout'?'wait':mode),controller=new AbortController();let current:number|undefined,starts=0;
  const onProcess=(pid:number|null)=>{if(pid===null){if(current)active.delete(current);current=undefined;}else{current=pid;active.add(pid);spawned.push(pid);if(mode==='cancel'&&++starts===2)queueMicrotask(()=>controller.abort());}};
  try{
   const pending=runCodex({...f.options,onProcess,signal:controller.signal,timeout_ms:3000});
   if(mode==='success')await pending;else await expect(pending).rejects.toThrow(mode==='cancel'?'取消':mode==='timeout'?'超时':'执行');
   expect(active.size).toBe(0);
  }finally{controller.abort();await rm(f.root,{recursive:true,force:true});}
 }
 for(const pid of spawned)expect(()=>process.kill(pid,0)).toThrow();
});
