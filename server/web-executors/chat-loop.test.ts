/** 验证网页对话回路：围栏JSON提取、校验失败反馈修正、同一无效回复停止、截断续写拼接、会话必关；不启动浏览器。 */
import {test,expect} from 'bun:test';
import {runWebJsonChat,stitchReplies,stripFences} from './chat-loop';
import {fakeTransport,fenced} from './fake-transport';

const settings={provider:'deepseek' as const};
const first={prompt:'请输出JSON'};

test('returns the single fenced JSON and always closes the session',async()=>{
  const fake=fakeTransport(['好的\n'+fenced({a:1})]);
  const result=await runWebJsonChat({transport:fake.transport,settings,first,timeout_ms:5000,check:v=>v});
  expect(result.value).toEqual({a:1});expect(fake.closed()).toBe(1);expect(fake.opened[0]!.provider).toBe('deepseek');
  expect(result.rounds.map(r=>r.kind)).toEqual(['first']);
});
test('validation failure is fed back in the same conversation with the validator details',async()=>{
  const fake=fakeTransport([fenced({n:1}),fenced({n:2})]);
  const result=await runWebJsonChat({transport:fake.transport,settings,first,timeout_ms:5000,check:(v:any)=>{if(v.n!==2)throw Object.assign(new Error('bad'),{reason_code:'plan_invalid',validation_details:[{path:'n'}]});return v;}});
  expect(result.value).toEqual({n:2});expect(fake.opened.length).toBe(1);
  expect(fake.turns[1]!.prompt).toContain('plan_invalid');expect(fake.turns[1]!.prompt).toContain('"path":"n"');
  expect(result.rounds.map(r=>r.kind)).toEqual(['first','correction']);
});
test('identical invalid reply stops instead of looping',async()=>{
  const fake=fakeTransport([fenced({n:1}),fenced({n:1}),fenced({n:1})]);
  await expect(runWebJsonChat({transport:fake.transport,settings,first,timeout_ms:5000,check:()=>{throw new Error('still bad');}})).rejects.toThrow('still bad');
  expect(fake.turns.length).toBe(2);expect(fake.closed()).toBe(1);
});
test('correction budget is bounded',async()=>{
  const fake=fakeTransport([1,2,3,4,5,6].map(n=>fenced({n})));
  await expect(runWebJsonChat({transport:fake.transport,settings,first,timeout_ms:5000,max_corrections:2,check:()=>{throw new Error('bad');}})).rejects.toThrow('bad');
  expect(fake.turns.length).toBe(3);
});
test('non-JSON reply gets one chance to be corrected, then fails with invalid_json',async()=>{
  const fake=fakeTransport(['抱歉，我无法完成','抱歉，我无法完成']);
  await expect(runWebJsonChat({transport:fake.transport,settings,first,timeout_ms:5000,check:v=>v})).rejects.toMatchObject({reason_code:expect.any(String)});
  expect(fake.turns[1]!.prompt).toContain('invalid_json');
});
test('truncated output is continued and stitched before parsing',async()=>{
  const whole=JSON.stringify({items:Array.from({length:30},(_,i)=>({id:i,text:'内容'+i}))});
  const cut=Math.floor(whole.length/2);
  const fake=fakeTransport(['```json\n'+whole.slice(0,cut),whole.slice(cut)+'\n```']);
  const result=await runWebJsonChat({transport:fake.transport,settings,first,timeout_ms:5000,check:v=>v});
  expect(result.value).toEqual(JSON.parse(whole));expect(result.rounds.map(r=>r.kind)).toEqual(['first','continue']);
  expect(fake.turns[1]!.prompt).toContain('截断');
});
test('stitchReplies drops fences only from continuation parts',()=>{
  expect(stitchReplies(['```json\n{"a":','```json\n1}\n```'])).toBe('```json\n{"a":1}\n```');
  expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
});
test('aborted signal never reaches the page and the session is closed',async()=>{
  const fake=fakeTransport([fenced({a:1})]);const controller=new AbortController();controller.abort(new Error('x'));
  await expect(runWebJsonChat({transport:fake.transport,settings,first,timeout_ms:5000,signal:controller.signal,check:v=>v})).rejects.toMatchObject({reason_code:'web_cancelled'});
  expect(fake.turns.length).toBe(0);expect(fake.closed()).toBe(1);
});
test('budget exhaustion raises web_timeout',async()=>{
  const fake=fakeTransport([async()=>{await Bun.sleep(30);return 'not json';},fenced({a:1})]);
  await expect(runWebJsonChat({transport:fake.transport,settings,first,timeout_ms:10,check:v=>v})).rejects.toMatchObject({reason_code:'web_timeout'});
});
test('model_label and thinking reach the transport open options',async()=>{
  const fake=fakeTransport([fenced({a:1})]);
  await runWebJsonChat({transport:fake.transport,settings:{provider:'gemini',thinking:true,model_label:'Code'},first,timeout_ms:5000,check:v=>v});
  expect(fake.opened[0]).toMatchObject({provider:'gemini',options:{thinking:true,model_label:'Code'}});
});
