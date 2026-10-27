/** 验证供应商配置解析、冻结凭证选择及 OpenRouter 请求路由。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {resolveAnswerConfig,createAnswerClient} from './dispatch';
import {configureAgentAdapter} from '../agent/runner';
const router={provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'} as const;
function streamResponse(content='答案'){
 const chunks=[{choices:[{delta:{content},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}];
 return new Response(chunks.map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
test('legacy Qwen and three native provider configurations resolve without credentials',()=>{
 expect(resolveAnswerConfig(router,{})).toEqual(router);
 expect(resolveAnswerConfig({...router,provider:undefined},{}).provider).toBe('qwen');
 for(const provider of ['kimi','deepseek','doubao'] as const)expect(resolveAnswerConfig({provider,model:'explicit-model'},{}).provider).toBe(provider);
});
test('SiliconFlow freezes its OpenAI-compatible endpoint and uses its own credential',async()=>{
 const requests:{url:string;authorization:string|null;model:string}[]=[];
 const client=createAnswerClient({SILICONFLOW_API_KEY:'siliconflow-fixture',OPEN_ROUTER_KEY:'router-fixture'},async(url,init)=>{requests.push({url,authorization:new Headers(init?.headers).get('Authorization'),model:JSON.parse(init!.body as string).model});return streamResponse();});
 const config=resolveAnswerConfig({provider:'siliconflow',model:'Qwen/Qwen3.8-2.4T-A95B'},{});
 await client.answer({config,question:'题面',materials:[]});
 expect(requests).toEqual([{url:'https://api.siliconflow.com/v1/chat/completions',authorization:'Bearer siliconflow-fixture',model:'Qwen/Qwen3.8-2.4T-A95B'}]);
});
test('invalid provider and private config fields cannot reach a client',()=>{
 expect(()=>resolveAnswerConfig({provider:'unknown',model:'x'},{})).toThrow();
 expect(()=>resolveAnswerConfig({...router,api_key:'secret'},{})).toThrow();
});
test('dispatcher selects credential and endpoint from the frozen provider',async()=>{
 const requests:{url:string;authorization:string|null}[]=[];
 const client=createAnswerClient({DEEPSEEK_API_KEY:'deepseek-fixture',OPEN_ROUTER_KEY:'router-fixture'},async(url,init)=>{requests.push({url,authorization:new Headers(init?.headers).get('Authorization')});return Response.json({model:'actual',choices:[{finish_reason:'stop',message:{role:'assistant',content:'答案'}}]});});
 await client.answer({config:resolveAnswerConfig({provider:'deepseek',model:'explicit-model'},{}),question:'题面',materials:[{name:'附件1',text:'脱敏材料'}]});
 await client.answer({config:resolveAnswerConfig(router,{}),question:'题面',materials:[]});
 expect(requests).toEqual([{url:'https://api.deepseek.com/chat/completions',authorization:'Bearer deepseek-fixture'},{url:'https://openrouter.ai/api/v1/chat/completions',authorization:'Bearer router-fixture'}]);
});
test('call correlation ID is forwarded internally without entering model messages',async()=>{
 const requests:Record<string,unknown>[]=[];
 const client=createAnswerClient({OPEN_ROUTER_KEY:'router-fixture'},async(_url,init)=>{requests.push(JSON.parse(init!.body as string));return Response.json({model:'actual',choices:[{finish_reason:'stop',message:{role:'assistant',content:'答案'}}]});});
 await client.answer({config:resolveAnswerConfig(router,{}),question:'题面',materials:[{name:'附件1',text:'脱敏材料'}],call_id:'call-fixture'});
 expect(requests).toHaveLength(1);
 expect(JSON.stringify(requests[0]!.messages)).not.toContain('call-fixture');
 expect(JSON.stringify(requests[0]!.messages)).toContain('题面');
});
test('dispatcher sends each OpenRouter model through its single gateway key',async()=>{
 const requests:{url:string;authorization:string|null;model:string}[]=[];
 const client=createAnswerClient({OPEN_ROUTER_KEY:'router-only'},async(url,init)=>{requests.push({url,authorization:new Headers(init?.headers).get('Authorization'),model:JSON.parse(init!.body as string).model});return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'答案'}}]});});
 for(const model of ['z-ai/glm-5.3-flash','qwen/qwen-plus','moonshotai/kimi-k2.5'])await client.answer({config:resolveAnswerConfig({provider:'openrouter',model},{}),question:'题面',materials:[]});
 expect(requests).toEqual(['z-ai/glm-5.3-flash','qwen/qwen-plus','moonshotai/kimi-k2.5'].map(model=>({url:'https://openrouter.ai/api/v1/chat/completions',authorization:'Bearer router-only',model})));
});

test('Codex Agent answer receives only the frozen question and redacted materials with selected effort',async()=>{
 let received:any;
 configureAgentAdapter(async task=>{received=task;return{result:'候选答案',session_id:'agent-session',usage:null,diagnostic_path:'private/events.jsonl',duration_ms:12,provider:'codex',model:task.model};});
 try{
  const config=resolveAnswerConfig({provider:'codex',model:'gpt-6-astra',reasoning_effort:'ultra'},{});
  const client=createAnswerClient({});
  const result=await client.answer({config,directory:'/tmp/answer-agent',question:'题面',materials:[{name:'附件1',text:'已脱敏材料'}],system_prompt:'作答系统指令'});
  expect(received).toMatchObject({task_type:'model_answer',model:'gpt-6-astra',reasoning_effort:'ultra',output_format:'text'});
  expect(received.prompt).toContain('题面');expect(received.prompt).toContain('已脱敏材料');expect(received.prompt).toContain('作答系统指令');
  expect(received.prompt).not.toMatch(/reference_answer|answer_approach|rubric|score|历史答案|标准答案/);
  expect(result).toMatchObject({text:'候选答案',execution_mode:'agent',reasoning_effort:'ultra',requested_model:'gpt-6-astra',model:null});
 }finally{configureAgentAdapter(null);}
});

test('Agent作答只将显式returned_model写入实际模型字段',async()=>{
 configureAgentAdapter(async task=>({result:'合成答案',session_id:'session',usage:null,diagnostic_path:'private',duration_ms:1,provider:'fixture',model:task.model,returned_model:'actual-model'}));
 try{
  const result=await createAnswerClient({}).answer({config:{provider:'codex',model:'requested-model',reasoning_effort:'low'},directory:'/tmp/answer-agent-identity',question:'题面',materials:[]});
  expect(result.requested_model).toBe('requested-model');expect(result.model).toBe('actual-model');expect(result.text).toBe('合成答案');
 }finally{configureAgentAdapter(null);}
});
