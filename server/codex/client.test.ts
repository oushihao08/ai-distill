import {test,expect,setDefaultTimeout} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {codexLoginStatus,runCodex,type CodexOptions} from './client';
import {registeredProcesses} from '../monitoring/runtime';

// These tests spawn a fresh CLI process; allow for contention when the full backend suite runs in parallel.
setDefaultTimeout(15000);

async function fixture(mode='success'){
 const root=await mkdtemp(join(tmpdir(),'codex-client-'));const directory=join(root,'role');await mkdir(join(directory,'input'),{recursive:true});await writeFile(join(directory,'input','material.md'),'public input');const binary=join(root,'cli');
 const code=`#!${process.execPath}\nconst args=process.argv.slice(2);const mode=${JSON.stringify(mode)};
if(args[0]==='login'){console.error(mode==='api_key'?'Logged in using an API key':'Logged in using ChatGPT');process.exit(0);}
const out=args[args.indexOf('--output-last-message')+1];await Bun.write(out+'.request.json',JSON.stringify({args,prompt:await Bun.stdin.text(),secrets:['DATABASE_URL','ZHIPU_API_KEY','OPENAI_API_KEY'].filter(key=>process.env[key]),proxy:process.env.HTTPS_PROXY==='http://127.0.0.1:12345'}));
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
emit({type:'thread.started',thread_id:'fixture-session'});emit({type:'turn.started'});if(mode==='reconnect')emit({type:'error',message:'Reconnecting... 1/5 (request timed out)'});
if(mode==='wait'){setInterval(()=>{},1000);await new Promise(()=>{});}
const text=mode==='malformed'?'invalid json':JSON.stringify({ok:true});
if(mode!=='missing')await Bun.write(out,text);
emit({type:'item.completed',item:{id:'message',type:'agent_message',text}});
if(mode!=='incomplete')emit({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:4}});
if(mode==='exit_failure')process.exit(1);
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
  expect(request.secrets).toEqual([]);expect(request.args).toContain('--ignore-user-config');expect(request.args).toContain('--ephemeral');expect(request.args).not.toContain('--sandbox');
  expect(request.args).toContain('default_permissions="distill_role"');expect(request.args).toContain('model_reasoning_effort="high"');expect(request.prompt).toBe(f.options.prompt);
  expect(await readFile(join(f.options.directory,'input','material.md'),'utf8')).toBe('public input');
 }finally{if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;await rm(f.root,{recursive:true,force:true});}
});
for(const mode of['missing','malformed','incomplete','exit_failure'])test(`Codex cannot publish success for ${mode}`,async()=>{
 const f=await fixture(mode);try{await expect(runCodex(f.options)).rejects.toThrow(/结果|执行/);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('Codex timeout stops its own process and records failure rather than completion',async()=>{
 const f=await fixture('wait');try{await expect(runCodex({...f.options,timeout_ms:80})).rejects.toThrow('超时');expect(await readFile(join(f.options.directory,'output','events.jsonl'),'utf8')).toContain('turn.started');}finally{await rm(f.root,{recursive:true,force:true});}
});
test('already cancelled Codex work never starts a model invocation',async()=>{
 const f=await fixture();try{await expect(runCodex({...f.options,signal:AbortSignal.abort()})).rejects.toThrow('取消');}finally{await rm(f.root,{recursive:true,force:true});}
});
test('in-flight cancellation kills the registered CLI process and removes its monitor entry',async()=>{
 const f=await fixture('wait'),controller=new AbortController();
 const running=runCodex({...f.options,timeout_ms:10000,signal:controller.signal}).then(()=>null,error=>error);
 try{
  const events=join(f.options.directory,'output','events.jsonl');let started=false;
  for(let i=0;i<500&&!started;i++){try{started=(await readFile(events,'utf8')).includes('turn.started');}catch{started=false;}if(!started)await Bun.sleep(10);}
  expect(started).toBe(true);
  const pids=registeredProcesses();expect(pids.length).toBeGreaterThan(0);
  for(const pid of pids)expect(()=>process.kill(pid,0)).not.toThrow();
  controller.abort();expect((await running)?.message).toContain('取消');
  for(const pid of pids){expect(registeredProcesses()).not.toContain(pid);expect(()=>process.kill(pid,0)).toThrow();}
 }finally{controller.abort();await running;await rm(f.root,{recursive:true,force:true});}
});
test('Codex result must also pass the role-specific independent validator',async()=>{
 const f=await fixture();try{await expect(runCodex({...f.options,validate:()=>{throw new Error('reject this role result');}})).rejects.toThrow('结果');}finally{await rm(f.root,{recursive:true,force:true});}
});

test('Codex preserves configured transport proxy without forwarding provider or database keys',async()=>{
 const f=await fixture();const old=process.env.HTTPS_PROXY;process.env.HTTPS_PROXY='http://127.0.0.1:12345';
 try{await runCodex(f.options);const request=JSON.parse(await readFile(join(f.options.directory,'output','result.json.request.json'),'utf8'));expect(request.proxy).toBe(true);expect(request.secrets).toEqual([]);}
 finally{if(old===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=old;await rm(f.root,{recursive:true,force:true});}
});
test('transient reconnect events do not override a completed validated Codex result',async()=>{
 const f=await fixture('reconnect');try{expect((await runCodex(f.options)).result).toEqual({ok:true});}finally{await rm(f.root,{recursive:true,force:true});}
});
