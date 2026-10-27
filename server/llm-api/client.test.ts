/** 验证JSON/SSE纯文字响应拒绝规则一致及流读取清理；注入合成HTTP响应，不调用模型或真实槽位。 */
import {expect,test} from 'bun:test';
import {inspect} from 'node:util';
import {createModelApiClient} from './client';

const config={provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model:'fixture/model'};
const input={config,messages:[{role:'user' as const,content:'合成输入'}]};
const event=(delta:Record<string,unknown>,finish_reason:string|null=null)=>`data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\n`;

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
