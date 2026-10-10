/** 验证国内及 OpenRouter 供应商的模型路由、凭证隔离、配置校验与错误处理。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {describe,test,expect} from 'bun:test';
import {createDomesticClient,resolveDomesticConfig} from './domestic';
const cases=[
 {provider:'kimi',base_url:'https://api.moonshot.ai/v1',model:'kimi-k2.6',key:'KIMI_API_KEY'},
 {provider:'deepseek',base_url:'https://api.deepseek.com/v1',model:'deepseek-chat',key:'DEEPSEEK_API_KEY'},
 {provider:'doubao',base_url:'https://ark.cn-beijing.volces.com/api/v3',model:'ep-20261008-test',key:'DOUBAO_API_KEY'},
] as const;
const body={id:'completion-test',model:'actual-model',choices:[{finish_reason:'stop',message:{role:'assistant',content:' 完整答案\n '}}],usage:{total_tokens:12,custom:{cached:3}}};
test('OpenRouter routes the verified GLM, Qwen, and Kimi model IDs with only OPEN_ROUTER_KEY',async()=>{
 const models=['z-ai/glm-5.3-flash','qwen/qwen-plus','moonshotai/kimi-k2.5'];
 for(const model of models){
  const config=resolveDomesticConfig({provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model},{});
  let calls=0;
  const result=await createDomesticClient({OPEN_ROUTER_KEY:'router-secret',QWEN_API_KEY:'wrong',KIMI_API_KEY:'wrong'},async(url,init)=>{
   calls++;expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer router-secret');
   expect(JSON.parse(init!.body as string).model).toBe(model);return Response.json(body);
  }).answer({config,question:'真实题面',materials:[{name:'脱敏附件',text:'已核验文本'}]});
  expect(calls).toBe(1);expect(result.text).toBe(' 完整答案\n ');expect(result.usage).toEqual(body.usage);
 }
});
test('OpenRouter rejects non-gateway endpoints and unnamespaced model IDs',()=>{
 for(const base_url of ['https://api.moonshot.ai/v1','http://openrouter.ai/api/v1','https://openrouter.ai/api/v1?key=x','https://openrouter.ai/api/v1/chat/completions'])expect(()=>resolveDomesticConfig({provider:'openrouter',base_url,model:'z-ai/glm-5.3-flash'},{})).toThrow();
 for(const model of ['glm-5.3-flash','/qwen-plus','provider/','provider/model/extra',' bad/model'])expect(()=>resolveDomesticConfig({provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model},{})).toThrow();
});
test('OpenRouter never borrows a native provider key',async()=>{
 const config={provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'moonshotai/kimi-k2.5'} as const;
 await expect(createDomesticClient({KIMI_API_KEY:'native-key',QWEN_API_KEY:'native-key'}).answer({config,question:'题面',materials:[]})).rejects.toMatchObject({kind:'configuration'});
});
for(const config of cases) describe(config.provider,()=>{
 const valid={provider:config.provider,base_url:config.base_url,model:config.model};
 const input={config:valid,question:' 题目 ',materials:[{name:'资料',text:' 脱敏资料 '}]};
 test('explicit config and env defaults contain no credentials',()=>{
  expect(resolveDomesticConfig({provider:config.provider},{[config.provider.toUpperCase()+'_BASE_URL']:config.base_url,[config.provider.toUpperCase()+'_MODEL']:config.model,[config.key]:'secret'})).toEqual(valid);
 });
 test('isolated key and one fresh user message; complete metadata',async()=>{
  let called=0;
  const client=createDomesticClient({[config.key]:'own',OPEN_ROUTER_KEY:'other',QWEN_API_KEY:'other'},async(url,init)=>{
   called++;expect(url).toBe(config.base_url+'/chat/completions');expect(init?.redirect).toBe('error');
   expect((init?.headers as Record<string,string>).Authorization).toBe('Bearer own');
   expect(JSON.parse(init!.body as string)).toEqual({model:config.model,stream:false,messages:[{role:'user',content:JSON.stringify({question:input.question,materials:input.materials})}]});
   return Response.json(body);
  });
  const result=await client.answer(input);expect(called).toBe(1);expect(result.text).toBe(body.choices[0].message.content);expect(result.usage).toEqual(body.usage);expect(result.model).toBe(body.model);expect(result.requested_model).toBe(config.model);expect(result.completion_id).toBe(body.id);expect(result.duration_ms).toBeGreaterThanOrEqual(0);
 });
 for(const extra of [{enable_thinking:false},{thinking:{type:'disabled'}},{api_key:'secret'},{tools:[]}]) test('rejects unsupported config '+Object.keys(extra),()=>expect(()=>resolveDomesticConfig({...valid,...extra},{})).toThrow());
 for(const endpoint of ['http://api.deepseek.com/v1','https://evil.com/v1','https://api.moonshot.ai/v1?secret=x','https://user:secret@api.moonshot.ai/v1','https://openrouter.ai/api/v1',config.base_url+'/chat/completions',config.base_url+'#x']) test('rejects endpoint '+endpoint,()=>expect(()=>resolveDomesticConfig({...valid,base_url:endpoint},{})).toThrow());
 test('missing own key never falls back',async()=>expect(createDomesticClient({OPEN_ROUTER_KEY:'other',QWEN_API_KEY:'other'}).answer(input)).rejects.toMatchObject({kind:'configuration'}));
 for(const model of ['',null,'bad/model',' bad','bad\nmodel']) test('invalid model '+JSON.stringify(model),()=>expect(()=>resolveDomesticConfig({...valid,model},{})).toThrow());
 for(const max_tokens of [0,-1,1.5,null,Infinity]) test('invalid token limit '+String(max_tokens),()=>expect(()=>resolveDomesticConfig({...valid,max_tokens},{})).toThrow());
 for(const [status,kind,retryable] of [[401,'authentication',false],[403,'authentication',false],[402,'quota',false],[429,'rate_limit',true],[408,'timeout',true],[400,'configuration',false],[404,'configuration',false],[500,'provider',true]] as const) test('safe HTTP error '+status,async()=>{
  const client=createDomesticClient({[config.key]:'own'},async()=>Response.json({error:{message:'PRIVATE SECRET',code:'PRIVATE SECRET'},request_id:'PRIVATE SECRET'},{status,headers:{'x-request-id':'PRIVATE SECRET'}}));
  try {await client.answer(input);throw new Error('expected failure');}catch(error){expect(error).toMatchObject({kind,retryable,http_status:status,provider_code:null,request_id:null});expect(JSON.stringify(error)+String(error)).not.toContain('PRIVATE SECRET');expect((error as Error).cause).toBeUndefined();}
 });
 for(const finish_reason of ['length','tool_calls','content_filter',null]) test('reject partial '+finish_reason,async()=>expect(createDomesticClient({[config.key]:'own'},async()=>Response.json({...body,choices:[{...body.choices[0],finish_reason}]})).answer(input)).rejects.toMatchObject({kind:'invalid_response'}));
 test('reasoning never replaces final answer',async()=>expect(createDomesticClient({[config.key]:'own'},async()=>Response.json({...body,choices:[{finish_reason:'stop',message:{role:'assistant',content:'',reasoning_content:'SECRET'}}]})).answer(input)).rejects.toMatchObject({kind:'invalid_response'}));
 test('privacy rejects arbitrary input and material fields',async()=>{
  const client=createDomesticClient({[config.key]:'own'});
  await expect(client.answer({...input,rubric:'private'} as never)).rejects.toMatchObject({kind:'configuration'});
  await expect(client.answer({...input,materials:[{name:'n',text:'t',path:'private'}]} as never)).rejects.toMatchObject({kind:'configuration'});
 });
 test('timeout aborts during body consumption',async()=>{
  const client=createDomesticClient({[config.key]:'own'},async(_url,init)=>({ok:true,status:200,headers:new Headers(),json:()=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('private')),{once:true}))}) as Response);
  await expect(client.answer({...input,timeout_ms:5})).rejects.toMatchObject({kind:'timeout',retryable:true});
 });
 test('active cancellation and listener cleanup',async()=>{
  const cancel=new AbortController();let adds=0,removes=0;
  const add=cancel.signal.addEventListener.bind(cancel.signal),remove=cancel.signal.removeEventListener.bind(cancel.signal);
  cancel.signal.addEventListener=((...args:Parameters<typeof add>)=>{adds++;return add(...args);}) as typeof add;
  cancel.signal.removeEventListener=((...args:Parameters<typeof remove>)=>{removes++;return remove(...args);}) as typeof remove;
  const client=createDomesticClient({[config.key]:'own'},async(_url,init)=>{queueMicrotask(()=>cancel.abort());return await new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('PRIVATE')),{once:true}));});
  await expect(client.answer({...input,signal:cancel.signal})).rejects.toMatchObject({kind:'cancelled',retryable:false});expect(adds).toBe(1);expect(removes).toBe(1);
 });
});
const cfg={provider:'deepseek' as const,base_url:'https://api.deepseek.com',model:'deepseek-chat'};
const req={config:cfg,question:'q',materials:[]};
test('model is required even when credentials exist',()=>expect(()=>resolveDomesticConfig({provider:'deepseek'},{DEEPSEEK_API_KEY:'own'})).toThrow());
test('preserves missing metadata as null',async()=>{
 const minimal={choices:body.choices};
 const answer=await createDomesticClient({DEEPSEEK_API_KEY:'own'},async()=>Response.json(minimal)).answer(req);
 expect(answer.model).toBeNull();expect(answer.completion_id).toBeNull();expect(answer.request_id).toBeNull();expect(answer.usage).toBeNull();
});
for(const delta of [{usage:[]},{model:''},{id:42},{choices:[]},{error:{message:'private'}},{choices:[{finish_reason:'stop',message:{role:'user',content:'q'}}]},{choices:[{finish_reason:'stop',message:{role:'assistant',content:'q',tool_calls:[{}]}}]}]) test('malformed metadata or result '+JSON.stringify(delta),async()=>expect(createDomesticClient({DEEPSEEK_API_KEY:'own'},async()=>Response.json({...body,...delta})).answer(req)).rejects.toMatchObject({kind:'invalid_response'}));
test('network exception strips private cause',async()=>{
 try {await createDomesticClient({DEEPSEEK_API_KEY:'own'},async()=>{throw new Error('private secret');}).answer(req);throw new Error('expected error');}catch(error){expect(error).toMatchObject({kind:'network',retryable:true});expect(String(error)).not.toContain('private secret');expect((error as Error).cause).toBeUndefined();}
});
test('non-json success is invalid and non-json HTTP failure remains classified',async()=>{
 await expect(createDomesticClient({DEEPSEEK_API_KEY:'own'},async()=>new Response('private')).answer(req)).rejects.toMatchObject({kind:'invalid_response'});
 await expect(createDomesticClient({DEEPSEEK_API_KEY:'own'},async()=>new Response('private',{status:401})).answer(req)).rejects.toMatchObject({kind:'authentication'});
});
test('pre-cancel never sends a request',async()=>{
 const signal=AbortSignal.abort();let calls=0;
 await expect(createDomesticClient({DEEPSEEK_API_KEY:'own'},async()=>{calls++;return Response.json(body);}).answer({...req,signal})).rejects.toMatchObject({kind:'cancelled'});expect(calls).toBe(0);
});
test('native fetch timeout covers incomplete response body',async()=>{
 const fixture=Bun.serve({port:0,hostname:'127.0.0.1',fetch(){return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}),{headers:{'Content-Type':'application/json'}});}});
 try {
  await expect(createDomesticClient({DEEPSEEK_API_KEY:'own'},async(_url,init)=>fetch(`http://127.0.0.1:${fixture.port}`,init)).answer({...req,timeout_ms:30})).rejects.toMatchObject({kind:'timeout',retryable:true});
 } finally {fixture.stop(true);}
});
test('Kimi China and DeepSeek trailing slash normalize without changing route',()=>{
 expect(resolveDomesticConfig({provider:'kimi',base_url:'https://api.moonshot.cn/v1/',model:'kimi-k2.6'},{}).base_url).toBe('https://api.moonshot.cn/v1');
 expect(resolveDomesticConfig({...cfg,base_url:'https://api.deepseek.com/v1/'},{}).base_url).toBe('https://api.deepseek.com/v1');
});
test('explicit max_tokens is sent unchanged and key alias is supported',async()=>{
 let sent:Record<string,unknown>|undefined;
 await createDomesticClient({ARK_API_KEY:'alias'},async(_url,init)=>{sent=JSON.parse(init!.body as string);expect((init!.headers as Record<string,string>).Authorization).toBe('Bearer alias');return Response.json(body);}).answer({config:{provider:'doubao',base_url:'https://ark.cn-beijing.volces.com/api/v3',model:'ep-test',max_tokens:100},question:'q',materials:[]});expect(sent?.max_tokens).toBe(100);
});
test('explicit null timeout is invalid rather than silently defaulted',async()=>expect(createDomesticClient({DEEPSEEK_API_KEY:'own'},async()=>Response.json(body)).answer({...req,timeout_ms:null} as never)).rejects.toMatchObject({kind:'configuration'}));
