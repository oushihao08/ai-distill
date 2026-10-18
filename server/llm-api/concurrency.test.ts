/** 验证普通API与钩子API共用本机槽位，取消等待不发起收费请求；使用临时SQLite和调用替身。 */
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createModelApiClient} from './client';
test('上游脱敏截止原因穿过HTTP取消层，且不携带私有错误正文',async()=>{
 const controller=new AbortController();
 const client=createModelApiClient({QWEN_API_KEY:'fixture'},async(_url,init)=>await new Promise<Response>((_resolve,reject)=>{
  init!.signal!.addEventListener('abort',()=>reject(new Error('PRIVATE')),{once:true});
  controller.abort(Object.assign(new Error('PRIVATE'),{kind:'timeout',reason_code:'redaction_task_timeout'}));
 }));
 await expect(client.complete({config:{provider:'qwen',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen-plus'},messages:[{role:'user',content:'fixture'}],signal:controller.signal})).rejects.toMatchObject({kind:'timeout',reason_code:'redaction_task_timeout'});
});
const modulePromise=import('./concurrency').catch(()=>undefined);
test('排队超时错误保留已等待毫秒，失败统计不丢排队时间',async()=>{
 const m=await modulePromise,root=await mkdtemp(join(tmpdir(),'api-slot-metrics-'));let release!:()=>void;
 try{
  const first=m!.withModelApiSlot(async()=>await new Promise<void>(resolve=>{release=resolve;}),{root,env:{LLM_API_CONCURRENCY:'1'}});
  while(!release)await Bun.sleep(1);
  let error:any;try{await m!.withModelApiSlot(async()=>{}, {root,env:{LLM_API_CONCURRENCY:'1'},queue_timeout_ms:15});}catch(e){error=e;}
  release();await first;
  expect(error).toMatchObject({reason_code:'api_queue_timeout'});expect(error.queue_wait_ms).toBeGreaterThanOrEqual(10);
 }finally{m?.closeModelApiSlots(root);await rm(root,{recursive:true,force:true});}
},500);
test('API槽位限制实际并发并在成功失败后释放',async()=>{
 const m=await modulePromise;expect(typeof m?.withModelApiSlot).toBe('function');
 const root=await mkdtemp(join(tmpdir(),'api-slot-'));let active=0,peak=0;
 try{
  const run=()=>m!.withModelApiSlot(async()=>{active++;peak=Math.max(active,peak);await Bun.sleep(20);active--;return 'ok';},{root,env:{LLM_API_CONCURRENCY:'1'}});
  expect(await Promise.all([run(),run()])).toEqual(['ok','ok']);expect(peak).toBe(1);
  await expect(m!.withModelApiSlot(async()=>{throw new Error('fixture');},{root,env:{LLM_API_CONCURRENCY:'1'}})).rejects.toThrow('fixture');
  expect(await run()).toBe('ok');
  const controller=new AbortController();controller.abort();let called=false;
  await expect(m!.withModelApiSlot(async()=>{called=true;},{root,env:{LLM_API_CONCURRENCY:'1'},signal:controller.signal})).rejects.toThrow();expect(called).toBe(false);
 }finally{m?.closeModelApiSlots(root);await rm(root,{recursive:true,force:true});}
});
test('API排队时限独立生效，排队超时不发请求且已占用请求不受排队计时影响',async()=>{
 const m=await modulePromise,root=await mkdtemp(join(tmpdir(),'api-slot-deadline-'));let release!:()=>void;
 try{
  const first=m!.withModelApiSlot(async()=>await new Promise<void>(resolve=>{release=resolve;}),{root,env:{LLM_API_CONCURRENCY:'1'},queue_timeout_ms:10} as any);
  await Bun.sleep(2);let called=false;
  await expect(m!.withModelApiSlot(async()=>{called=true;},{root,env:{LLM_API_CONCURRENCY:'1'},queue_timeout_ms:10} as any)).rejects.toMatchObject({reason_code:'api_queue_timeout'});
  expect(called).toBe(false);release();await first;
 }finally{m?.closeModelApiSlots(root);await rm(root,{recursive:true,force:true});}
},500);
test('SiliconFlow长响应使用流式完整收集，保留用量且不把推理当答案',async()=>{
 let sent:any;let options:any;
 const client=createModelApiClient({SILICONFLOW_API_KEY:'fixture'},async(_url,init)=>{
  sent=JSON.parse(init!.body as string);options=init;
  const chunks=[{choices:[{delta:{reasoning_content:'private reasoning'},finish_reason:null}]},{choices:[{delta:{content:'完整'},finish_reason:null}]},{choices:[{delta:{content:'答案'},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:2}}];
  return new Response(chunks.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n');
 });
 const result=await client.complete({config:{provider:'siliconflow',base_url:'https://api.siliconflow.com/v1',model:'Qwen/Qwen3.8-27B'},messages:[{role:'user',content:'fixture'}]});
 expect(sent.stream).toBe(true);expect(sent.stream_options).toEqual({include_usage:true});expect(options.timeout).toBe(false);expect(result.text).toBe('完整答案');expect(result.usage).toEqual({prompt_tokens:10,completion_tokens:2});
});
test('关闭传输空闲计时后业务总时限仍取消挂起请求',async()=>{
 const client=createModelApiClient({SILICONFLOW_API_KEY:'fixture'},async(_url,init)=>await new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('PRIVATE')),{once:true});}));
 await expect(client.complete({config:{provider:'siliconflow',base_url:'https://api.siliconflow.com/v1',model:'Qwen/Qwen3.8-27B'},messages:[{role:'user',content:'fixture'}],timeout_ms:20})).rejects.toMatchObject({kind:'timeout',reason_code:'local_deadline'});
});
test('Bun连接关闭和空闲超时保留安全原因码',async()=>{
 for(const [code,reason_code] of [['TimeoutError','socket_idle_timeout'],['ConnectionClosed','connection_closed']]){
  const client=createModelApiClient({QWEN_API_KEY:'fixture'},async()=>{throw Object.assign(new Error('PRIVATE'),{code});});
  await expect(client.complete({config:{provider:'qwen',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen-plus'},messages:[{role:'user',content:'fixture'}]})).rejects.toMatchObject({kind:'network',reason_code});
 }
});
test('流式截断保留安全结束原因，供脱敏立即缩批而非原样重试',async()=>{
 const client=createModelApiClient({SILICONFLOW_API_KEY:'fixture'},async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'incomplete'},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n'));
 await expect(client.complete({config:{provider:'siliconflow',base_url:'https://api.siliconflow.com/v1',model:'deepseek-ai/DeepSeek-V4.1-Flash'},messages:[{role:'user',content:'fixture'}]})).rejects.toMatchObject({reason_code:'incomplete_finish_reason',finish_reason:'length'});
});
