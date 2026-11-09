/** 验证JSON/SSE纯文字响应拒绝规则一致及流读取清理；注入合成HTTP响应，不调用模型或真实槽位。 */
import {expect,test} from 'bun:test';
import {inspect} from 'node:util';
import {createModelApiClient} from './client';

const config={provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model:'fixture/model'};
const input={config,messages:[{role:'user' as const,content:'合成输入'}]};
const event=(delta:Record<string,unknown>,finish_reason:string|null=null)=>`data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\n`;

test('NVIDIA完整端点归一化并从服务环境读取凭证',async()=>{
 let url='',authorization='',body:any;
 const client=createModelApiClient({NVIDIA_API_KEY:'fixture-key'},async(input,init)=>{
  url=input;authorization=new Headers(init?.headers).get('Authorization')??'';body=JSON.parse(String(init?.body));
  return Response.json({model:'minimaxai/minimax-m3.1-flash',choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"ok":true}'}}]});
 });
 const result=await client.complete({config:{provider:'nvidia',base_url:'https://integrate.api.nvidia.com/v1/chat/completions',model:'minimaxai/minimax-m3.1-flash'},messages:[{role:'user',content:'合成输入'}],response_format:{type:'json_object'}});
 expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');expect(authorization).toBe('Bearer fixture-key');expect(body.response_format).toEqual({type:'json_object'});expect(body.stream).toBe(false);expect(result.text).toBe('{"ok":true}');
});

test.each([
 {fields:{tool_calls:[{id:'PRIVATE_TOOL',function:{name:'PRIVATE_NAME'}}]},reason:'unexpected_tool_call'},
 {fields:{tool_calls:{}},reason:'unexpected_tool_call'},
 {fields:{tool_calls:'PRIVATE_TOOL'},reason:'unexpected_tool_call'},
 {fields:{function_call:{name:'PRIVATE_FUNCTION'}},reason:'unexpected_tool_call'},
 {fields:{function_call:{}},reason:'unexpected_tool_call'},
 {fields:{refusal:'PRIVATE_REFUSAL'},reason:'refusal_response'},
 {fields:{refusal:''},reason:'refusal_response'},
])('JSON/SSE对相同异常字段返回相同安全原因：%o',async({fields,reason})=>{
 for(const stream of [false,true]){
  let cancelled=false;
  const body=event({role:'assistant',content:'PRIVATE_PARTIAL'})+event(fields)+event({content:'PRIVATE_FINAL'},'stop')+'data: [DONE]\n\n';
  const source=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(body));},cancel(){cancelled=true;}});
  const client=createModelApiClient({OPEN_ROUTER_KEY:'fixture'},async()=>stream
   ?new Response(source,{headers:{'Content-Type':'text/event-stream'}})
   :Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'PRIVATE_FINAL',...fields}}]}));
  let failure:any;
  try{await client.complete({...input,observe_reasoning:stream});}catch(error){failure=error;}
  expect(failure?.kind).toBe('invalid_response');expect(failure?.reason_code).toBe(reason);
  expect(inspect(failure)).not.toContain('PRIVATE_');
  if(stream){expect(cancelled).toBe(true);expect(source.locked).toBe(false);expect(failure.stream_events).toBe(2);}
 }
});

test.each([{}, {tool_calls:null,function_call:null,refusal:null}, {tool_calls:[]}])('缺省、null和空工具列表保留正常正文：%o',async fields=>{
 for(const stream of [false,true]){
  const client=createModelApiClient({OPEN_ROUTER_KEY:'fixture'},async()=>stream
   ?new Response(event({role:'assistant',...fields})+event({content:'完整'})+event({content:'正文'},'stop')+'data: [DONE]\n\n')
   :Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'完整正文',...fields}}]}));
  const result=await client.complete({...input,observe_reasoning:stream});
  expect(result.text).toBe('完整正文');expect(result.requested_model).toBe(config.model);
 }
});

test('结束事件同时包含异常字段时也不能接收为成功正文',async()=>{
 const body=event({content:'完整正文'})+event({tool_calls:[{index:0}]},'stop')+'data: [DONE]\n\n';
 const client=createModelApiClient({OPEN_ROUTER_KEY:'fixture'},async()=>new Response(body));
 await expect(client.complete({...input,observe_reasoning:true})).rejects.toMatchObject({reason_code:'unexpected_tool_call'});
});

test('OpenRouter服务端工具走Responses并按当前命名空间轨迹统计已完成有效步长',async()=>{
 let url='',body:any;
 const toolConfig={...config,server_tools:['web_search','web_fetch','shell'],max_tool_calls:12} satisfies import('./types').ModelApiConfig;
 const client=createModelApiClient({OPEN_ROUTER_KEY:'fixture'},async(input,init)=>{
  url=input;body=JSON.parse(init!.body as string);
  return Response.json({
   id:'resp_fixture',status:'completed',model:'fixture/actual',output_text:'结论[1]',
   output:[
    {id:'search-1',type:'openrouter:web_search',status:'completed'},
    {id:'fetch-1',type:'openrouter:web_fetch',status:'incomplete'},
    {id:'shell-1',type:'openrouter:shell',status:'completed'},
    {type:'message',role:'assistant',content:[{type:'output_text',text:'结论[1]',annotations:[{type:'url_citation',url:'https://example.com/source',title:'来源',start_index:2,end_index:5}]}]},
   ],
   usage:{input_tokens:10,output_tokens:4,server_tool_use_details:{tool_calls_requested:3,tool_calls_executed:2,unsafe:'x'}},
  });
 });
 const result=await client.complete({...input,config:toolConfig});
 expect(url).toBe('https://openrouter.ai/api/v1/responses');
 expect(body).toMatchObject({model:config.model,stream:false,tools:[{type:'openrouter:web_search'},{type:'openrouter:web_fetch'},{type:'openrouter:shell',parameters:{engine:'openrouter'}}],tool_choice:'auto',max_tool_calls:12});
 expect(result).toMatchObject({text:'结论[1]',execution_steps:{observed:3,completed:2,failed:1,effective_steps:2},tool_trace:{usage:{tool_calls_requested:3,tool_calls_executed:2}},source_citations:[{url:'https://example.com/source',title:'来源',start_index:2,end_index:5}]});
});

test('Responses未返回逐次工具轨迹时不用usage机械猜测有效步长',async()=>{
 const client=createModelApiClient({OPEN_ROUTER_KEY:'fixture'},async()=>Response.json({id:'resp_fixture',status:'completed',output_text:'答案',output:[],usage:{server_tool_use:{web_search_requests:3}}}));
 const result=await client.complete({...input,config:{...config,server_tools:['web_search']}});
 expect(result.tool_trace?.usage).toEqual({web_search_requests:3});
 expect(result.execution_steps).toEqual({method:'completed_tool_calls',observed:0,completed:0,failed:0,effective_steps:null});
});
test('Responses custom function tools execute locally and continue to a final answer',async()=>{
 let count=0,secondBody:any;
 const client=createModelApiClient({OPEN_ROUTER_KEY:'fixture'},async(_url,init)=>{
  count++;const body=JSON.parse(String(init?.body));
  if(count===1)return Response.json({id:'resp_1',status:'completed',model:'qwen/test',output:[{type:'function_call',id:'fc_1',call_id:'call_1',name:'attachment_read',arguments:'{"attachment_id":"attachment-1"}'}],usage:{input_tokens:10,output_tokens:2,total_tokens:12,output_tokens_details:{reasoning_tokens:1}}});
  secondBody=body;return Response.json({id:'resp_2',status:'completed',model:'qwen/test',output_text:'根据附件作答',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'根据附件作答',annotations:[]}]}],usage:{input_tokens:15,output_tokens:5,total_tokens:20,output_tokens_details:{reasoning_tokens:2}}});
 });
 const result=await client.complete({...input,config,function_tools:[{type:'function',name:'attachment_read',description:'read',strict:true,parameters:{type:'object',properties:{attachment_id:{type:'string'}},required:['attachment_id'],additionalProperties:false}}],execute_function_tool:async(name,args)=>JSON.stringify({name,args,text:'冻结材料'})});
 expect(count).toBe(2);expect(secondBody.input.at(-1)).toMatchObject({type:'function_call_output',call_id:'call_1'});expect(result.text).toBe('根据附件作答');expect(result.completed_tool_calls).toBe(1);expect(result.reasoning_tokens).toBe(3);expect(result.usage).toMatchObject({input_tokens:25,output_tokens:7,total_tokens:32});expect(result.tool_trace?.calls).toEqual([{id:'call_1',type:'attachment_read',status:'completed'}]);
});
test('failed local function calls return bounded errors and do not count as completed',async()=>{
 let count=0;
 const client=createModelApiClient({OPEN_ROUTER_KEY:'fixture'},async()=>++count===1?Response.json({id:'resp_1',status:'completed',output:[{type:'function_call',call_id:'call_1',name:'artifact_render',arguments:'{"filename":"missing.md"}'}]}):Response.json({id:'resp_2',status:'completed',output_text:'无法读取产物',output:[]}));
 const result=await client.complete({...input,config,function_tools:[{type:'function',name:'artifact_render',description:'render',strict:true,parameters:{type:'object',properties:{filename:{type:'string'}},required:['filename']}}],execute_function_tool:async()=>{throw new Error('artifact_not_found');}});
 expect(result.completed_tool_calls).toBe(0);expect(result.execution_steps).toMatchObject({observed:1,completed:0,failed:1,effective_steps:0});
});
