/**
 * 职责：验证结构化脱敏的映射协议、字段完整性、确定性替换与断点恢复。
 * 使用场景：修改 `redaction.ts` 的字段映射契约或原文合并时运行。
 */
import {expect,test} from 'bun:test';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {redactExtractedMaterials} from './redaction';

const config={provider:'api' as const,api:{provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model:'fixture-model'},prompt:'<任务>只输出纯文本并跳过无可转写页面。</任务><脱敏规则>姓名脱敏。</脱敏规则>'};
const material=(text:string)=>({material_id:'material-a',source_sha256:'source-sha',pages:[{page:1,text,method:'ocr' as const,structure:[{id:'b1',kind:'paragraph' as const,text}]}]});
const response=(request:any,redactionsFor:(target:{target_id:string;text:string})=>unknown[]=()=>[])=>{
 const input=JSON.parse(request.messages.at(-1).content),fields=input.targets.map((target:any)=>({target_id:target.target_id,redactions:redactionsFor(target)}));
 return{text:JSON.stringify({fields}),usage:null,duration_ms:1,call_id:request.call_id,completion_id:null};
};

test('project prompt rules cannot override the structured mapping contract',async()=>{
 let system='';
 await redactExtractedMaterials({directory:'unused',materials:[material('原文')],config,executeApi:async(request:any)=>{
  system=request.messages[0].content;
  return response(request);
 }});
 expect(system).toContain('姓名脱敏');
 expect(system).not.toContain('只输出纯文本并跳过无可转写页面');
 expect(system).toContain('source_text');
 expect(system).toContain('kind');
 expect(system).not.toContain('"replacement_text"');
});

test('no sensitive mapping preserves every source character exactly',async()=>{
 const source='保留  空格\n保留标点。';
 const result=await redactExtractedMaterials({directory:'unused',materials:[material(source)],config,executeApi:async(request:any)=>response(request)});
 expect(result.materials[0]?.pages[0]?.text).toBe(source);
});

test('a literal mapping replaces only the identified source fragment',async()=>{
 const source='重庆市大渡口区双龙路2号中交丽景7栋，其他文字不变。';
 const hidden='双龙路2号中交丽景7栋';
 const result=await redactExtractedMaterials({directory:'unused',materials:[material(source)],config,executeApi:async(request:any)=>response(request,target=>target.text===source?[{source_text:'重庆市大渡口区双龙路2号中交丽景7栋',mask_text:hidden,kind:'address'}]:[])});
 expect(result.materials[0]?.pages[0]?.text).toBe(`重庆市大渡口区${'*'.repeat([...hidden].length)}，其他文字不变。`);
});

test('the program creates the name mask instead of accepting a model-authored replacement',async()=>{
 const source='代理人：李四。';
 const result=await redactExtractedMaterials({directory:'unused',materials:[material(source)],config,executeApi:async(request:any)=>response(request,target=>target.text===source?[{source_text:'李四',mask_text:'四',kind:'name'}]:[])});
 expect(result.materials[0]?.pages[0]?.text).toBe('代理人：李**。');
});

test('repeated exact sensitive values are replaced consistently without anchor guessing',async()=>{
 const source='联系人张三；第三条约定金额30000元；借款人张三。';
 const result=await redactExtractedMaterials({directory:'unused',materials:[material(source)],config,executeApi:async(request:any)=>response(request,target=>target.text===source?[{source_text:'张三',mask_text:'三',kind:'name'}]:[])});
 expect(result.materials[0]?.pages[0]?.text).toBe('联系人张**；第三条约定金额30000元；借款人张**。');
});

test('unlocatable sources fail but repeated and overlapping masks are merged',async()=>{
 await expect(redactExtractedMaterials({directory:'unused',materials:[material('原文')],config,executeApi:async(request:any)=>response(request,()=>[{source_text:'不存在',mask_text:'不',kind:'secret'}])})).rejects.toMatchObject({reason_code:'redaction_source_not_found'});
 const repeated=await redactExtractedMaterials({directory:'unused',materials:[material('编号 A1A')],config,executeApi:async(request:any)=>response(request,()=>[{source_text:'A1A',mask_text:'A',kind:'identifier'}])});
 expect(repeated.materials[0]?.pages[0]?.text).toBe('编号 *1*');
 const merged=await redactExtractedMaterials({directory:'unused',materials:[material('敏感字段')],config,executeApi:async(request:any)=>response(request,()=>[{source_text:'敏感字段',mask_text:'敏感',kind:'secret'},{source_text:'敏感字段',mask_text:'感字段',kind:'secret'}])});
 expect(merged.materials[0]?.pages[0]?.text).toBe('****');
});

test('a source span with punctuation or spacing differences still maps to the original characters',async()=>{
 const source='地址：双龙路，2号。';
 const result=await redactExtractedMaterials({directory:'unused',materials:[material(source)],config,executeApi:async(request:any)=>response(request,()=>[{source_text:'双龙路 2号',mask_text:'双龙路 2号',kind:'address'}])});
 expect(result.materials[0]?.pages[0]?.text).toBe('地址：******。');
});

test('incomplete and malformed fields fail with safe field diagnostics',async()=>{
 const incompleteConfig={...config,prompt:'规则'};
 await expect(redactExtractedMaterials({directory:'unused',materials:[material('原文')],config:incompleteConfig,executeApi:async(request:any)=>({
  text:JSON.stringify({fields:[]}),usage:null,duration_ms:1,call_id:request.call_id,completion_id:null,
 })})).rejects.toMatchObject({reason_code:'target_coverage_mismatch',missing_target_ids:['f1']});
 const result=await redactExtractedMaterials({directory:'unused',materials:[material('原文')],config:incompleteConfig,executeApi:async(request:any)=>response(request,()=>[{source_text:'原文',mask_text:'原文',kind:'secret'}])});
 expect(result.materials[0]?.pages[0]?.text).toBe('**');
});

test('fields split across API batches are merged by target id without losing later mappings',async()=>{
 const blocks=Array.from({length:33},(_,index)=>({id:`b${index}`,kind:'paragraph' as const,text:index===32?'张三':'字段'+index}));
 const source={material_id:'material-a',source_sha256:'source-sha',pages:[{page:1,text:blocks.map(block=>block.text).join('\n'),method:'ocr' as const,structure:blocks} as any]};
 const seen:number[]=[];
 const result=await redactExtractedMaterials({directory:'unused',materials:[source],config,executeApi:async(request:any)=>{
  const targets=JSON.parse(request.messages.at(-1).content).targets;seen.push(targets.length);
  return response(request,(target:any)=>target.text==='张三'?[{source_text:'张三',mask_text:'三',kind:'name'}]:[]);
 }});
 expect(seen).toEqual([32,1]);
 expect(result.materials[0]?.pages[0]?.structure?.[32]).toMatchObject({text:'张**'});
});

test('structured API batches combine adjacent pages and preserve their original page ownership',async()=>{
 const source={material_id:'material-a',source_sha256:'source-sha',pages:[1,2].map(page=>({page,text:`第${page}页`,method:'ocr' as const,structure:[{id:`b${page}`,kind:'paragraph' as const,text:`第${page}页`}]}))};
 const seen:string[][]=[];
 await redactExtractedMaterials({directory:'unused',materials:[source],config,executeApi:async(request:any)=>{
  seen.push(JSON.parse(request.messages.at(-1).content).targets.map((target:any)=>target.text));
  return response(request);
 }});
 expect(seen).toEqual([['第1页','第2页']]);
});

test('an oversized batch that fails twice is split without restarting completed fields',async()=>{
 const blocks=Array.from({length:32},(_,index)=>({id:`b${index}`,kind:'paragraph' as const,text:`字段${index}`}));
 const source={material_id:'material-a',source_sha256:'source-sha',pages:[{page:1,text:blocks.map(block=>block.text).join('\n'),method:'ocr' as const,structure:blocks} as any]};
 const sizes:number[]=[];
 const result=await redactExtractedMaterials({directory:'unused',materials:[source],config,executeApi:async(request:any)=>{
  const size=JSON.parse(request.messages.at(-1).content).targets.length;sizes.push(size);
  if(size===32)throw Object.assign(new Error('incomplete response'),{kind:'invalid_response',reason_code:'incomplete_finish_reason'});
  return response(request);
 }});
 expect(sizes).toEqual([32,32,16,16]);
 expect(result.materials[0]?.pages[0]?.structure).toEqual(blocks);
});

test('a failed split keeps its completed half for the next attempt',async()=>{
 const checkpointDirectory=await mkdtemp(join(tmpdir(),'redaction-split-checkpoint-'));
 try{
  const blocks=Array.from({length:32},(_,index)=>({id:`b${index}`,kind:'paragraph' as const,text:`字段${index}`}));
  const source={material_id:'material-a',source_sha256:'source-sha',pages:[{page:1,text:blocks.map(block=>block.text).join('\n'),method:'ocr' as const,structure:blocks} as any]};
  await expect(redactExtractedMaterials({directory:'unused',checkpointDirectory,materials:[source],config,executeApi:async(request:any)=>{
   const targets=JSON.parse(request.messages.at(-1).content).targets;
   if(targets.length===32)throw Object.assign(new Error('incomplete response'),{kind:'invalid_response',reason_code:'incomplete_finish_reason'});
   if(targets[0].target_id==='f17')throw new Error('network stopped');
   return response(request);
  }})).rejects.toThrow('network stopped');
  const resumed:string[]=[];
  await redactExtractedMaterials({directory:'unused',checkpointDirectory,materials:[source],config,executeApi:async(request:any)=>{
   resumed.push(...JSON.parse(request.messages.at(-1).content).targets.map((target:any)=>target.target_id));
   return response(request);
  }});
  expect(resumed).toEqual(Array.from({length:16},(_,index)=>`f${index+17}`));
 }finally{await rm(checkpointDirectory,{recursive:true,force:true});}
});

test('a long single target is sent intact in its own batch',async()=>{
 let calls=0;const text='x'.repeat(4001);
 const result=await redactExtractedMaterials({directory:'unused',materials:[material(text)],config,executeApi:async(request)=>{
  calls++;const input=JSON.parse(request.messages.at(-1)!.content as string);
  expect(input.targets[0].text).toBe(text);
  return response(request);
 }});
 expect(calls).toBe(1);expect(result.materials[0]!.pages[0]!.text).toBe(text);
});

test('a retry resumes from validated private batch checkpoints',async()=>{
 const checkpointDirectory=await mkdtemp(join(tmpdir(),'redaction-checkpoint-'));
 try{
  const blocks=Array.from({length:33},(_,index)=>({id:`b${index}`,kind:'paragraph' as const,text:index===32?'张三':'字段'+index}));
  const source={material_id:'material-a',source_sha256:'source-sha',pages:[{page:1,text:blocks.map(block=>block.text).join('\n'),method:'ocr' as const,structure:blocks} as any]};
  let firstRunCalls=0;
  await expect(redactExtractedMaterials({directory:'unused',checkpointDirectory,materials:[source],config,executeApi:async(request:any)=>{
   firstRunCalls++;
   if(firstRunCalls===2)throw new Error('simulated network interruption');
   return response(request);
  }})).rejects.toThrow('simulated network interruption');
  expect((await readdir(checkpointDirectory)).length).toBe(1);
  let resumedTargets:string[]=[];
  const result=await redactExtractedMaterials({directory:'unused',checkpointDirectory,materials:[source],config,executeApi:async(request:any)=>{
   const targets=JSON.parse(request.messages.at(-1).content).targets;resumedTargets.push(...targets.map((target:any)=>target.target_id));
   return response(request,(target:any)=>target.text==='张三'?[{source_text:'张三',mask_text:'三',kind:'name'}]:[]);
  }});
  expect(firstRunCalls).toBe(2);
  expect(resumedTargets).toEqual(['f33']);
  expect(result.materials[0]?.pages[0]?.structure?.[32]).toMatchObject({text:'张**'});
 }finally{await rm(checkpointDirectory,{recursive:true,force:true});}
});

test('a corrupt checkpoint is rejected before another model call',async()=>{
 const checkpointDirectory=await mkdtemp(join(tmpdir(),'redaction-checkpoint-corrupt-'));
 try{
  await redactExtractedMaterials({directory:'unused',checkpointDirectory,materials:[material('原文')],config,executeApi:async(request:any)=>response(request)});
  const path=join(checkpointDirectory,(await readdir(checkpointDirectory))[0]!);
  await writeFile(path,'{}');let calls=0;
  await expect(redactExtractedMaterials({directory:'unused',checkpointDirectory,materials:[material('原文')],config,executeApi:async()=>{calls++;return{text:'{}',usage:null,duration_ms:1,completion_id:null};}})).rejects.toMatchObject({reason_code:'redaction_checkpoint_invalid'});
  expect(calls).toBe(0);
 }finally{await rm(checkpointDirectory,{recursive:true,force:true});}
});

test('program preserves phone prefix and suffix without relying on a unique model mask',async()=>{
 const result=await redactExtractedMaterials({directory:'unused',materials:[material('13812345678')],config,executeApi:async(request)=>{
  const input=JSON.parse(request.messages.at(-1)!.content as string);
  return response(request,()=>[{source_text:'13812345678',mask_text:'1234567',kind:'phone'}]);
 }});
 expect(result.materials[0]!.pages[0]!.text).toBe('138******78');
});


test('flat output tolerates fences, duplicate fields and optional mapping metadata',async()=>{
 const result=await redactExtractedMaterials({directory:'unused',materials:[material('甲：张三；乙：李四。')],config,executeApi:async(request:any)=>{
  const id=JSON.parse(request.messages.at(-1).content).targets[0].target_id;
  return{text:'```json\n'+JSON.stringify({fields:[null,{target_id:'unknown',redactions:[{source_text:'其他字段'}]},{target_id:' '+id+' ',redactions:[{source_text:'张三',mask_text:null}]},{target_id:id,redactions:[{source_text:'李四',kind:'NAME'}]}]})+'\n```',usage:null,duration_ms:1,call_id:request.call_id,completion_id:null};
 }});
 expect(result.materials[0]?.pages[0]?.text).toBe('甲：**；乙：李**。');
});

test('same block ids on different pages retain source page ownership',async()=>{
 const source=material('张三');
 source.pages.push({...source.pages[0]!,page:28,text:'李四',structure:[{id:'b1',kind:'paragraph',text:'李四'}]});
 const ids:string[]=[];
 const result=await redactExtractedMaterials({directory:'unused',materials:[source],config,executeApi:async(request:any)=>{
  const targets=JSON.parse(request.messages.at(-1).content).targets;ids.push(...targets.map((target:any)=>target.target_id));
  return response(request,(target:any)=>[{source_text:target.text,kind:'name'}]);
 }});
 expect(new Set(ids).size).toBe(2);
 expect(result.materials[0]?.pages.map(page=>[page.page,page.text])).toEqual([[1,'张**'],[28,'李**']]);
});


test('Agent execution uses the same flat field contract and reconstructs source metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-agent-'));
 try{
  let task:any;
  const result=await redactExtractedMaterials({directory:root,materials:[material('证件号 123456')],config:{provider:'codex',prompt:'fixture',model:'fixture',reasoning_effort:'low'},execute:(async(options:any)=>{
   task=options;
   return{result:options.validate({fields:[{target_id:'f1',redactions:[{source_text:'123456',kind:'identifier'}]}]}),session_id:'session',usage:null,diagnostic_path:'private',duration_ms:1,provider:'codex',model:'fixture'};
  }) as any});
  expect(task.schema.required).toContain('fields');
  expect(result.materials[0]?.material_id).toBe('material-a');
  expect(result.materials[0]?.pages[0]?.page).toBe(1);
  expect(result.materials[0]?.pages[0]?.text).toBe('证件号 ******');
 }finally{await rm(root,{recursive:true,force:true});}
});
