import {test,expect} from 'bun:test';
import {resolveAnswerConfig,createAnswerClient} from './dispatch';
const router={provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'} as const;
test('legacy Qwen and three native provider configurations resolve without credentials',()=>{
 expect(resolveAnswerConfig(router,{})).toEqual(router);
 expect(resolveAnswerConfig({...router,provider:undefined},{}).provider).toBe('qwen');
 for(const provider of ['kimi','deepseek','doubao'] as const)expect(resolveAnswerConfig({provider,model:'explicit-model'},{}).provider).toBe(provider);
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
test('dispatcher sends each OpenRouter model through its single gateway key',async()=>{
 const requests:{url:string;authorization:string|null;model:string}[]=[];
 const client=createAnswerClient({OPEN_ROUTER_KEY:'router-only'},async(url,init)=>{requests.push({url,authorization:new Headers(init?.headers).get('Authorization'),model:JSON.parse(init!.body as string).model});return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'答案'}}]});});
 for(const model of ['z-ai/glm-5.3-flash','qwen/qwen-plus','moonshotai/kimi-k2.5'])await client.answer({config:resolveAnswerConfig({provider:'openrouter',model},{}),question:'题面',materials:[]});
 expect(requests).toEqual(['z-ai/glm-5.3-flash','qwen/qwen-plus','moonshotai/kimi-k2.5'].map(model=>({url:'https://openrouter.ai/api/v1/chat/completions',authorization:'Bearer router-only',model})));
});
