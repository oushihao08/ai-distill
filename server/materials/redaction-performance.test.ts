/** 验证脱敏按输入输出预算打包、有界并发补位、局部修复、断点一致性和时限收尾；使用合成字段和 API 替身，不访问业务数据库或真实模型。 */
import {expect,test,spyOn} from 'bun:test';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {redactExtractedMaterials} from './redaction';
import {mergeRedactionDefaults} from './redaction-config';
const config={provider:'api' as const,api:{provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model:'fixture'},prompt:'姓名脱敏'};
const material=(n:number)=>({material_id:'material-a',source_sha256:'sha',pages:[{page:1,text:'',method:'text' as const,structure:Array.from({length:n},(_,i)=>({id:`b${i}`,kind:'paragraph' as const,text:`联系人张三${i}`}))}]});
const targets=(r:any)=>JSON.parse(r.messages.at(-1).content).targets as {target_id:string;text:string}[];
const response=(r:any)=>({text:JSON.stringify({fields:targets(r).map(t=>({target_id:t.target_id,redactions:[]}))}),duration_ms:1,usage:null,completion_id:null,call_id:r.call_id});
const options=(n:number,execution:Record<string,number>={})=>({directory:'unused',materials:[material(n)],config,execution} as any);
test('脱敏默认路由只约束指定Flash模型，显式路由和其他模型保留',()=>{
 const defaults={model:'fixture',reasoning_effort:'low'};
 const api={provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'deepseek/deepseek-v4.1-flash'};
 expect((mergeRedactionDefaults({provider:'api',api},defaults) as any).api.provider_options).toEqual({only:['coreweave'],allow_fallbacks:false});
 expect((mergeRedactionDefaults({provider:'api',api:{...api,model:'other/model'}},defaults) as any).api.provider_options).toBeUndefined();
 const explicit={only:['parasail'],allow_fallbacks:false};
 expect((mergeRedactionDefaults({provider:'api',api:{...api,provider_options:explicit}},defaults) as any).api.provider_options).toEqual(explicit);
});

test('API使用完整字段字典Schema，返回字典仍按原文字段校验和生成遮罩',async()=>{
 let request:any;
 const result=await redactExtractedMaterials({...options(2),executeApi:async(r:any)=>{request=r;return {...response(r),text:JSON.stringify({fields:Object.fromEntries(targets(r).map(t=>[t.target_id,[{source_text:'张三',kind:'name'}]]))})};}});
 expect(request.response_format.type).toBe('json_schema');
 expect(request.response_format.json_schema.schema.properties.fields.required).toEqual(['f1','f2']);
 expect(request.response_format.json_schema.schema.properties.fields.additionalProperties).toBe(false);
 expect(result.materials[0]!.pages[0]!.text).toContain('联系人张**0');
});
test('表格发送原行上下文一次，各单元格绑定行列且不假造表头',async()=>{
 const rows=[{cells:[{text:'项目'},{text:'金额'}]},{cells:[{text:'鲜货'},{text:'22'}]}];let input:any;
 const result=await redactExtractedMaterials({...options(1),materials:[{material_id:'material-a',source_sha256:'sha',pages:[{page:75,text:'',structure:[{id:'table-a',kind:'table',rows}]}]}],executeApi:async(r:any)=>{input=JSON.parse(r.messages.at(-1).content);return response(r);}});
 expect(input.contexts).toHaveLength(2);expect(input.contexts[1].cells).toEqual([{target_id:'f3'},{target_id:'f4'}]);
 expect(input.targets.find((t:any)=>t.target_id===input.contexts[1].cells[0].target_id).text).toBe('鲜货');
 expect(input.targets[3].context_id).toBe(input.contexts[1].context_id);expect(input.targets[3].column).toBe(1);
 expect(input.targets[3].page).toBe(75);expect(input.contexts[0]).not.toHaveProperty('headers');
 expect(result.materials[0]!.pages[0]!.structure![0]).toEqual({id:'table-a',kind:'table',rows});
});
test('长表格正文不会因上下文重复原文而超预算，目标文本始终完整',async()=>{
 const text='正文'.repeat(2300);let calls=0,input:any;
 const materials=[{material_id:'material-a',source_sha256:'sha',pages:[{page:1,text:'',structure:[{id:'t',kind:'table',rows:[{cells:[{text:'事项'},{text:'说明'}]},{cells:[{text:'事实'},{text}]}]}]}]}];
 const result=await redactExtractedMaterials({...options(1),materials,executeApi:async(r:any)=>{calls++;input=JSON.parse(r.messages.at(-1).content);return response(r);}});
 expect(calls).toBeGreaterThan(0);expect(input.targets.some((t:any)=>t.text===text)).toBe(true);
 expect(JSON.stringify(input).split(text).length-1).toBe(1);expect(result.materials[0]!.pages[0]!.text).toContain(text);
});

test('墙钟已超过整题期限时拒绝晚到响应，即使单调计时尚未超时',async()=>{
 let now=Date.now();const clock=spyOn(Date,'now').mockImplementation(()=>now);let last:any;
 try{
  await expect(redactExtractedMaterials({...options(1,{task_timeout_ms:1000}),onProgress:(p:any)=>{last=p;},executeApi:async(r:any)=>{now+=2000;return response(r);}})).rejects.toMatchObject({reason_code:'redaction_task_timeout'});
  expect(last.completed_fields).toBe(0);expect(last.wall_elapsed_ms).toBeGreaterThanOrEqual(2000);
 }finally{clock.mockRestore();}
});
test('暂停后单次请求已过期，即使整题未超时也不接受晚到响应',async()=>{
 let now=Date.now();const clock=spyOn(Date,'now').mockImplementation(()=>now);let last:any;
 try{
  await expect(redactExtractedMaterials({...options(1,{request_timeout_ms:1000,task_timeout_ms:10000,stall_timeout_ms:10000}),onProgress:(p:any)=>{last=p;},executeApi:async(r:any)=>{now+=2000;return response(r);}})).rejects.toMatchObject({reason_code:'redaction_request_timeout'});
  expect(last.completed_fields).toBe(0);
 }finally{clock.mockRestore();}
});
test('失败请求的排队耗时计入进度，不误算为全部模型执行耗时',async()=>{
 let last:any;
 await expect(redactExtractedMaterials({...options(1),onProgress:(p:any)=>{last=p;},executeApi:async()=>{await Bun.sleep(15);throw Object.assign(new Error('fixture'),{kind:'authentication',queue_wait_ms:12});}})).rejects.toBeDefined();
 expect(last.queue_wait_ms).toBe(12);
});
test('同页重复字段ID在调用模型前拒绝，避免断点与写回覆盖',async()=>{
 const source=material(2);source.pages[0]!.structure[1]!.id=source.pages[0]!.structure[0]!.id;let calls=0;
 await expect(redactExtractedMaterials({...options(2),materials:[source],executeApi:async(r:any)=>{calls++;return response(r);}})).rejects.toMatchObject({reason_code:'source_structure_invalid'});
 expect(calls).toBe(0);
});

test('预算允许时合并超过32个短字段，同时保留输出容量余量',async()=>{
 const sizes:number[]=[];await redactExtractedMaterials({...options(100),executeApi:async(r:any)=>{sizes.push(targets(r).length);return response(r);}});
 expect(sizes).toEqual([100]);
});
test('请求使用有界输出上限，估算不能充当实际输出容量',async()=>{
 let budget=0;await redactExtractedMaterials({...options(1),executeApi:async(r:any)=>{budget=r.config.max_tokens;return response(r);}});
 expect(budget).toBe(16384);
});
test('明确输出截断立即缩批，避免原样重复收费请求',async()=>{
 const sizes:number[]=[];
 await redactExtractedMaterials({...options(4),executeApi:async(r:any)=>{sizes.push(targets(r).length);if(sizes.length===1)throw Object.assign(new Error('fixture'),{kind:'invalid_response',reason_code:'incomplete_finish_reason',finish_reason:'length'});return response(r);}});
 expect(sizes).toEqual([4,2,2]);
});
test('单字段修复可直接返回映射，程序绑定唯一字段且仍校验原文',async()=>{
 let count=0;
 const out=await redactExtractedMaterials({...options(2),executeApi:async(r:any)=>{
  count++;if(count===1)return{...response(r),text:JSON.stringify({fields:[{target_id:targets(r)[0]!.target_id,redactions:[]}]})};
  expect(targets(r).length).toBe(1);expect(r.response_format.json_schema.schema.properties.fields.required).toEqual([targets(r)[0]!.target_id]);
  return{...response(r),text:JSON.stringify({redactions:[{source_text:'张三',kind:'name'}]})};
 }});
 expect(count).toBe(2);expect(out.materials[0]!.pages[0]!.text).toContain('张**');
});
test('有界并发完成一个立即补一个，乱序返回不改变字段顺序',async()=>{
 let active=0,peak=0;const starts:string[]=[];
 const out=await redactExtractedMaterials({...options(5,{max_fields:1,concurrency:2}),executeApi:async(r:any)=>{
  const id=targets(r)[0]!.target_id;starts.push(id);active++;peak=Math.max(peak,active);await Bun.sleep(id==='f1'?25:2);active--;return response(r);
 }});
 expect(peak).toBe(2);expect(starts).toEqual(['f1','f2','f3','f4','f5']);expect(out.materials[0]!.pages[0]!.structure?.map(b=>(b as any).text)).toEqual(material(5).pages[0]!.structure.map(b=>b.text));
});
test('默认脱敏并发使用全局API的8路上限并在批次完成后补位',async()=>{
 let active=0,peak=0;
 await redactExtractedMaterials({...options(16,{max_fields:1}),executeApi:async(r:any)=>{active++;peak=Math.max(peak,active);await Bun.sleep(10);active--;return response(r);}});
 expect(peak).toBe(8);
});
test('一个字段遗漏时只补该字段，已校验字段不重发',async()=>{
 const seen:string[][]=[];
 await redactExtractedMaterials({...options(3),executeApi:async(r:any)=>{
  seen.push(targets(r).map(t=>t.target_id));const v=response(r);if(seen.length===1)v.text=JSON.stringify({fields:targets(r).slice(0,2).map(t=>({target_id:t.target_id,redactions:[]}))});return v;
 }});
 expect(seen).toEqual([['f1','f2','f3'],['f3']]);
});
test('单字段补做仍缺失时保留其他字段进度并拒绝整份结果',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-partial-field-'));const seen:string[][]=[];
 try{
  await expect(redactExtractedMaterials({...options(3),checkpointDirectory:root,executeApi:async(r:any)=>{
   seen.push(targets(r).map(t=>t.target_id));if(seen.length===1)return{...response(r),text:JSON.stringify({fields:targets(r).slice(0,2).map(t=>({target_id:t.target_id,redactions:[]}))})};return{...response(r),text:JSON.stringify({fields:[]})};
  }})).rejects.toMatchObject({reason_code:'target_coverage_mismatch'});
  expect(seen).toEqual([['f1','f2','f3'],['f3'],['f3']]);
  const saved=JSON.parse(await readFile(join(root,(await readdir(root)).filter(name=>name.endsWith('.json'))[0]!),'utf8'));
  expect(Object.keys(saved.fields).sort()).toEqual(['["material-a",1,"b0"]','["material-a",1,"b1"]']);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('大批补做剩少量字段仍错位时单独隔离修复，继续复用已通过字段',async()=>{
 const sizes:number[]=[];
 await redactExtractedMaterials({...options(3),executeApi:async(r:any)=>{
  const ts=targets(r);sizes.push(ts.length);
  if(sizes.length<=2)return{...response(r),text:JSON.stringify({fields:ts.map(t=>({target_id:t.target_id,redactions:t.target_id==='f3'?[]:[{source_text:'其他字段的姓名',kind:'name'}]}))})};
  expect(ts.length).toBe(1);return{...response(r),text:JSON.stringify({redactions:[]})};
 }});
 expect(sizes).toEqual([3,2,1,1]);
});
test('剩余5至8个错误字段也能缩批修复，共享原批次请求上限',async()=>{
 const sizes:number[]=[];
 await redactExtractedMaterials({...options(6),executeApi:async(r:any)=>{
  const ts=targets(r);sizes.push(ts.length);
  if(sizes.length<=2)return{...response(r),text:JSON.stringify({fields:ts.map(t=>({target_id:t.target_id,redactions:t.target_id==='f6'?[]:[{source_text:'其他字段的姓名',kind:'name'}]}))})};
  return response(r);
 }});
 expect(sizes).toEqual([6,5,3,2]);
});
test('全量收束后少量定位失败只做一次单字段末轮修复，仍计入整题预算',async()=>{
 const seen:string[][]=[];
 const result=await redactExtractedMaterials({...options(8),executeApi:async(r:any)=>{
  const ts=targets(r);seen.push(ts.map(t=>t.target_id));
  if(r.messages.some((m:any)=>m.content.includes('末轮定位修复')))return response(r);
  return{...response(r),text:JSON.stringify({fields:ts.map(t=>({target_id:t.target_id,redactions:['f1','f2'].includes(t.target_id)?[{source_text:'相邻字段的主体',kind:'organization'}]:[]}))})};
 }});
 expect(result.progress!.completed_fields).toBe(8);expect(seen).toEqual([['f1','f2','f3','f4','f5','f6','f7','f8'],['f1','f2'],['f1'],['f2'],['f1'],['f2']]);
});
test('末轮定位仍失败不能发布，也不能突破整题请求预算',async()=>{
 for(const max_calls of [4,10]){
  let calls=0,completed=0;
  await expect(redactExtractedMaterials({...options(8,{max_calls}),onProgress:(p:any)=>completed=p.completed_fields,executeApi:async(r:any)=>{
   calls++;return{...response(r),text:JSON.stringify({fields:targets(r).map(t=>({target_id:t.target_id,redactions:['f1','f2'].includes(t.target_id)?[{source_text:'不存在的主体',kind:'organization'}]:[]}))})};
  }})).rejects.toMatchObject({reason_code:'redaction_source_not_found'});
  expect(calls).toBe(max_calls===4?4:6);expect(completed).toBe(6);
 }
});
test('失败请求记录实际耗时和调用历史',async()=>{
 let error:any;try{await redactExtractedMaterials({...options(1),executeApi:async()=>{await Bun.sleep(15);throw Object.assign(new Error('fixture'),{kind:'authentication'});}});}catch(e){error=e;}
 expect(error.duration_ms).toBeGreaterThanOrEqual(10);expect(error.call_ids).toHaveLength(1);
});
test('字段校验失败保留真正失败调用ID，不被并发取消的最后调用覆盖',async()=>{
 let badCall='';let failure:any;
 try{await redactExtractedMaterials({...options(2,{max_fields:1,concurrency:2}),executeApi:async(r:any)=>{
  if(targets(r)[0]!.target_id==='f1'){badCall=r.call_id;return{...response(r),text:JSON.stringify({fields:[{target_id:'f1',redactions:[{source_text:'不存在的姓名',kind:'name'}]}]})};}
  await Bun.sleep(30);return response(r);
 }});}catch(e){failure=e;}
 expect(failure.reason_code).toBe('redaction_source_not_found');expect(failure.call_id).toBe(badCall);
});
test('不响应取消的调用替身也会在请求时限内结束且不重试',async()=>{
 let calls=0;await expect(redactExtractedMaterials({...options(1,{request_timeout_ms:20,task_timeout_ms:200,stall_timeout_ms:100}),executeApi:async()=>{calls++;return await new Promise<any>(()=>{});}})).rejects.toMatchObject({reason_code:'redaction_request_timeout'});expect(calls).toBe(1);
},500);
test('单批请求超时后继续其他批次并保留它们的断点，整题仍明确失败',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-timeout-checkpoint-'));let completed:any,badCalls=0;
 try{
  await expect(redactExtractedMaterials({...options(3,{max_fields:1,concurrency:2,request_timeout_ms:70,task_timeout_ms:1000,stall_timeout_ms:500}),checkpointDirectory:root,onProgress:(p:any)=>{completed=p.completed_fields;},executeApi:async(r:any)=>{
   if(targets(r)[0]!.target_id==='f1'){if(badCalls++===0)return await new Promise<any>(()=>{});throw Object.assign(new Error('fixture timeout'),{kind:'timeout',reason_code:'redaction_request_timeout'});}
   await Bun.sleep(40);
   return response(r);
  }})).rejects.toMatchObject({reason_code:'redaction_request_timeout'});
  const saved=JSON.parse(await readFile(join(root,(await readdir(root)).filter(name=>name.endsWith('.json'))[0]!),'utf8'));
  expect(completed).toBe(2);expect(Object.keys(saved.fields)).toEqual(['["material-a",1,"b1"]','["material-a",1,"b2"]']);
 }finally{await rm(root,{recursive:true,force:true});}
},1000);
test('认证或配额类全局错误立即停止派发后续批次',async()=>{
 let calls=0;
 await expect(redactExtractedMaterials({...options(4,{max_fields:1,concurrency:2}),executeApi:async(r:any)=>{calls++;if(targets(r)[0]!.target_id==='f1')throw Object.assign(new Error('fixture'),{kind:'authentication'});return response(r);}})).rejects.toMatchObject({kind:'authentication'});
 expect(calls).toBeLessThanOrEqual(2);
});
test('局部失败不会丢失唯一并发位置，后续批次仍全部进入断点',async()=>{
 const seen:string[]=[];let completed=0;
 await expect(redactExtractedMaterials({...options(4,{max_fields:1,concurrency:1}),onProgress:(p:any)=>{completed=p.completed_fields;},executeApi:async(r:any)=>{
  const id=targets(r)[0]!.target_id;seen.push(id);
  if(id==='f1')throw Object.assign(new Error('fixture timeout'),{kind:'timeout',reason_code:'redaction_request_timeout'});
  return response(r);
 }})).rejects.toMatchObject({reason_code:'redaction_request_timeout'});
 expect(seen).toEqual(['f1','f2','f3','f4']);expect(completed).toBe(3);
});
test('多字段请求真实到期后缩批补做，不原样再等一次',async()=>{
 const sizes:number[]=[];
 const result=await redactExtractedMaterials({...options(4,{concurrency:1,request_timeout_ms:25,task_timeout_ms:1000}),executeApi:async(r:any)=>{
  sizes.push(targets(r).length);if(sizes.length===1)return await new Promise<any>(()=>{});return response(r);
 }});
 expect(sizes).toEqual([4,2,2]);expect(result.progress!.completed_fields).toBe(4);
},1000);
test('超时缩批中一半失败，另一半仍完成且整题不假成功',async()=>{
 const seen:string[][]=[];let completed=0;
 await expect(redactExtractedMaterials({...options(4,{concurrency:1,request_timeout_ms:20,task_timeout_ms:1000}),onProgress:(p:any)=>{completed=p.completed_fields;},executeApi:async(r:any)=>{
  const ids=targets(r).map(t=>t.target_id);seen.push(ids);
  if(ids.includes('f1'))return await new Promise<any>(()=>{});return response(r);
 }})).rejects.toMatchObject({reason_code:'redaction_request_timeout'});
 expect(seen.some(ids=>ids.includes('f3')&&ids.includes('f4'))).toBe(true);expect(completed).toBe(3);
},1000);
test('取消后不再发新请求，迟到结果不增加完成字段',async()=>{
 const controller=new AbortController();const progress:any[]=[];let calls=0;
 const promise=redactExtractedMaterials({...options(3,{max_fields:1,concurrency:1}),signal:controller.signal,onProgress:(p:any)=>{progress.push(p);},executeApi:async(r:any)=>{calls++;if(calls===1){controller.abort();await Bun.sleep(10);}return response(r);}});
 await expect(promise).rejects.toMatchObject({reason_code:'redaction_cancelled'});expect(calls).toBe(1);expect(progress.at(-1)?.completed_fields??0).toBe(0);
},500);
test('并发保存后的断点包含所有完成字段，恢复不重复调用',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-parallel-'));
 try{
  await redactExtractedMaterials({...options(8,{max_fields:1,concurrency:4}),checkpointDirectory:root,executeApi:async(r:any)=>{await Bun.sleep(Number(targets(r)[0]!.target_id.slice(1))%3);return response(r);}});
  const files=(await readdir(root)).filter(name=>name.endsWith('.json'));const saved=JSON.parse(await readFile(join(root,files[0]!),'utf8'));expect(Object.keys(saved.fields)).toHaveLength(8);
  let calls=0;await redactExtractedMaterials({...options(8),checkpointDirectory:root,executeApi:async(r:any)=>{calls++;return response(r);}});expect(calls).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('批次修复和拆分共同受整题请求预算限制',async()=>{
 let calls=0;await expect(redactExtractedMaterials({...options(32,{max_calls:3}),executeApi:async()=>{calls++;throw Object.assign(new Error('fixture'),{kind:'invalid_response',reason_code:'incomplete_finish_reason'});}})).rejects.toBeDefined();expect(calls).toBeLessThanOrEqual(3);
});
test('输出预算过小在调用前拒绝，不能靠截断输入运行',async()=>{
 let calls=0;await expect(redactExtractedMaterials({...options(1),config:{...config,api:{...config.api,max_tokens:1}},executeApi:async(r:any)=>{calls++;return response(r);}})).rejects.toMatchObject({reason_code:'redaction_output_budget_exceeded'});expect(calls).toBe(0);
});
test('单字段输出估算偏大但完整原文仍在输入预算内时尝试一次并校验完整结果',async()=>{
 const source=material(1),original='张'.repeat(1200);source.pages[0]!.structure[0]!.text=original;
 let calls=0,requestedTokens=0;
 const result=await redactExtractedMaterials({...options(1),materials:[source],config:{...config,api:{...config.api,max_tokens:1024}},executeApi:async(r:any)=>{
  calls++;requestedTokens=r.config.max_tokens;expect(targets(r)[0]!.text).toBe(original);return response(r);
 }});
 expect(calls).toBe(1);expect(requestedTokens).toBe(1024);expect(result.materials[0]!.pages[0]!.structure?.[0]).toMatchObject({text:original});
});
test('单字段响应在输出上限内仍缺失时有限补做并拒绝发布',async()=>{
 const source=material(1);source.pages[0]!.structure[0]!.text='张'.repeat(1200);
 let calls=0;
 await expect(redactExtractedMaterials({...options(1),materials:[source],config:{...config,api:{...config.api,max_tokens:1024}},executeApi:async(r:any)=>{
  calls++;return{text:JSON.stringify({fields:[]}),duration_ms:1,usage:null,completion_id:null,call_id:r.call_id};
 }})).rejects.toMatchObject({reason_code:'target_coverage_mismatch'});
 expect(calls).toBe(2);
});
test('整题时限包含所有请求，达到时限不继续补位',async()=>{
 let calls=0,now=Date.now();const clock=spyOn(Date,'now').mockImplementation(()=>now);
 // 精确推进墙钟，避免毫秒级系统定时抖动把调用次数断言变成随机结果。
 try{await expect(redactExtractedMaterials({...options(10,{max_fields:1,concurrency:1,request_timeout_ms:200,task_timeout_ms:25,stall_timeout_ms:200}),executeApi:async(r:any)=>{calls++;now+=20;return response(r);}})).rejects.toMatchObject({reason_code:'redaction_task_timeout'});expect(calls).toBe(2);}
 finally{clock.mockRestore();}
},500);
test('长时间无新增完成字段时结束等待，不把心跳当进度',async()=>{
 await expect(redactExtractedMaterials({...options(1,{request_timeout_ms:200,task_timeout_ms:300,stall_timeout_ms:20}),executeApi:async()=>await new Promise<any>(()=>{})})).rejects.toMatchObject({reason_code:'redaction_progress_stalled'});
},500);
test('中断后只恢复已落盘字段之外的内容',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-abort-'));const controller=new AbortController();
 try{
  await expect(redactExtractedMaterials({...options(3,{max_fields:1,concurrency:1}),checkpointDirectory:root,signal:controller.signal,executeApi:async(r:any)=>{if(targets(r)[0]!.target_id==='f2'){controller.abort();return await new Promise<any>(()=>{});}return response(r);}})).rejects.toMatchObject({reason_code:'redaction_cancelled'});
  const seen:string[]=[];await redactExtractedMaterials({...options(3),checkpointDirectory:root,executeApi:async(r:any)=>{seen.push(...targets(r).map(t=>t.target_id));return response(r);}});expect(seen).toEqual(['f2','f3']);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('有界并行在相同接口延迟下减少成功完成耗时',async()=>{
 const run=async(concurrency:number)=>{const at=performance.now();await redactExtractedMaterials({...options(8,{max_fields:1,concurrency}),executeApi:async(r:any)=>{await Bun.sleep(20);return response(r);}});return performance.now()-at;};
 const serial=await run(1),parallel=await run(4);expect(parallel).toBeLessThan(serial*0.6);
});
test('同一份断点只允许一个活动写入者，避免跨尝试覆盖',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-owner-'));let release!:()=>void;
 try{
  const first=redactExtractedMaterials({...options(1),checkpointDirectory:root,executeApi:async(r:any)=>{await new Promise<void>(resolve=>{release=resolve;});return response(r);}});
  while(!release)await Bun.sleep(1);
  const second=redactExtractedMaterials({...options(1),checkpointDirectory:root,executeApi:async(r:any)=>response(r)});
  try{await expect(second).rejects.toMatchObject({reason_code:'redaction_checkpoint_busy'});}finally{release();await first;}
 }finally{await rm(root,{recursive:true,force:true});}
});
