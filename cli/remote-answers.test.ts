/** 验证远程作答 CLI 的精确身份、幂等请求、断连恢复和中断语义；仅使用注入 HTTP 回执，不访问真实服务。 */
import {expect,test} from 'bun:test';
import {CliError,type Fetcher} from './client';
import {runRemoteAnswerCommand} from './remote-answers';

const workflow='12345678-1234-4234-8234-123456789abc';
const requestKey='22345678-1234-4234-8234-123456789abc';
const attempt='32345678-1234-4234-8234-123456789abc';
const state=(status='waiting')=>({workflow_id:workflow,request_key:requestKey,status,attempts:[{id:attempt,status}]});

async function withRemote(fetcher:Fetcher,run:()=>Promise<void>){
 const oldFetch=globalThis.fetch,oldUrl=process.env.REMOTE_MATERIAL_API_URL,oldToken=process.env.REMOTE_MATERIAL_TOKEN;
 globalThis.fetch=fetcher as unknown as typeof fetch;process.env.REMOTE_MATERIAL_API_URL='http://127.0.0.1:37900';process.env.REMOTE_MATERIAL_TOKEN='t'.repeat(32);
 try{await run();}finally{globalThis.fetch=oldFetch;oldUrl===undefined?delete process.env.REMOTE_MATERIAL_API_URL:process.env.REMOTE_MATERIAL_API_URL=oldUrl;oldToken===undefined?delete process.env.REMOTE_MATERIAL_TOKEN:process.env.REMOTE_MATERIAL_TOKEN=oldToken;}
}

test('start 只提交一次原 workflow/request key 并携带令牌',async()=>{
 let calls=0;
 await withRemote(async(input,init)=>{calls++;expect(String(input)).toBe('http://127.0.0.1:37900/api/remote-answer-operations');expect(init?.method).toBe('POST');expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${'t'.repeat(32)}`);expect(JSON.parse(String(init?.body))).toEqual({workflow_id:workflow,request_key:requestKey});return Response.json({...state(),attempt_ids:[attempt],reused:false},{status:202});},async()=>{
  const result=await runRemoteAnswerCommand(['remote','answer','start','--workflow',workflow,'--request-key',requestKey]);expect(result.outcome).toBe('complete');expect(calls).toBe(1);
 });
});

test('status 只按原身份查询并区分等待、成功和部分终态',async()=>{
 for(const [status,outcome] of [['running','waiting'],['succeeded','complete'],['failed','partial'],['skipped','partial']] as const){
  let calls=0;
  await withRemote(async(input,init)=>{calls++;expect(init?.method).toBe('GET');expect(String(input)).toBe(`http://127.0.0.1:37900/api/remote-answer-operations/by-request?workflow_id=${workflow}&request_key=${requestKey}`);return Response.json(state(status));},async()=>{expect((await runRemoteAnswerCommand(['remote','answer','status','--workflow',workflow,'--request-key',requestKey])).outcome).toBe(outcome);expect(calls).toBe(1);});
 }
});

test('POST 断连仅提交一次并在未知回执中保留原身份',async()=>{
 let calls=0;
 await withRemote(async()=>{calls++;throw new Error('private network detail');},async()=>{
  try{await runRemoteAnswerCommand(['remote','answer','start','--workflow',workflow,'--request-key',requestKey]);throw new Error('expected failure');}
  catch(error){expect(error).toBeInstanceOf(CliError);expect((error as CliError).detail).toMatchObject({kind:'network_error',outcome_unknown:true,workflow_id:workflow,request_key:requestKey});expect((error as Error).message).not.toContain('private network detail');}
  expect(calls).toBe(1);
 });
});

test('status/start/run 拒绝与请求身份不一致或损坏的回执',async()=>{
 const invalid=[{...state(),workflow_id:'42345678-1234-4234-8234-123456789abc'},{...state(),request_key:'52345678-1234-4234-8234-123456789abc'},{...state(),status:'unknown'},{...state(),attempts:[{id:'not-uuid',status:'waiting'}]}];
 for(const response of invalid)await withRemote(async()=>Response.json(response),async()=>{await expect(runRemoteAnswerCommand(['remote','answer','status','--workflow',workflow,'--request-key',requestKey])).rejects.toMatchObject({detail:{kind:'invalid_response'}});});
});

test('run 中断保留服务器任务与原请求键，不重复POST',async()=>{
 const controller=new AbortController();let posts=0,gets=0;
 await withRemote(async(_input,init)=>{if(init?.method==='POST'){posts++;return Response.json({...state(),attempt_ids:[attempt]},{status:202});}gets++;controller.abort();return Response.json(state('running'));},async()=>{
  try{await runRemoteAnswerCommand(['remote','answer','run','--workflow',workflow,'--request-key',requestKey],controller.signal);throw new Error('expected interruption');}
  catch(error){expect(error).toBeInstanceOf(CliError);expect((error as CliError).detail).toMatchObject({kind:'interrupted',workflow_id:workflow,request_key:requestKey});}
  expect(posts).toBe(1);expect(gets).toBe(1);
 });
});

test('参数误用在发出HTTP前拒绝',async()=>{
 let calls=0;
 await withRemote(async()=>{calls++;return Response.json(state());},async()=>{
  for(const args of [
   ['remote','answer','unknown','--workflow',workflow,'--request-key',requestKey],
   ['remote','answer','status','--workflow','bad','--request-key',requestKey],
   ['remote','answer','status','--workflow',workflow,'--request-key',requestKey,'--extra','x'],
   ['remote','answer','status','--workflow',workflow,'--workflow',workflow,'--request-key',requestKey],
  ])await expect(runRemoteAnswerCommand(args)).rejects.toBeInstanceOf(CliError);
  expect(calls).toBe(0);
 });
});
