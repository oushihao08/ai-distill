/**
 * 职责：验证结构化脱敏的映射协议、字段完整性、确定性替换与断点恢复。
 * 使用场景：修改 `redaction.ts` 的字段映射契约或原文合并时运行。
 */
import {expect,test} from 'bun:test';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {redactExtractedMaterials,filterRedactionFormatting,applyStructuredRedactions,countStructuredRedactionFields} from './redaction';

const config={provider:'api' as const,api:{provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model:'fixture-model'},prompt:'<任务>只输出纯文本并跳过无可转写页面。</任务><脱敏规则>姓名脱敏。</脱敏规则>'};
const material=(text:string)=>({material_id:'material-a',source_sha256:'source-sha',pages:[{page:1,text,method:'ocr' as const,structure:[{id:'b1',kind:'paragraph' as const,text}]}]});
const response=(request:any,redactionsFor:(target:{target_id:string;text:string})=>unknown[]=()=>[])=>{
 const input=JSON.parse(request.messages.at(-1).content),fields=input.targets.map((target:any)=>({target_id:target.target_id,redactions:redactionsFor(target)}));
 return{text:JSON.stringify({fields}),usage:null,duration_ms:1,call_id:request.call_id,completion_id:null};
};

test('大题预算字段计数与结构化脱敏实际目标一致',()=>{
 const mixed={material_id:'material-b',source_sha256:'source-sha',pages:[{page:1,text:'正文',method:'ocr' as const,structure:[
  {id:'p',kind:'paragraph' as const,text:'正文'},
  {id:'list',kind:'list' as const,items:['列表一','列表二']},
  {id:'empty',kind:'paragraph' as const,text:''},
 ]}]};
 expect(countStructuredRedactionFields([mixed])).toBe(3);
});

test('精确编号匹配不扩大到删除标点后相同的其他编号或小数',async()=>{
 const result=await redactExtractedMaterials({directory:'unused',materials:[material('编号12-34，其他1234，金额12.34元')],config,executeApi:async request=>response(request,()=>[{source_text:'12-34',mask_text:'12-34',kind:'identifier'}])});
 expect(result.materials[0]!.pages[0]!.text).toBe('编号12*34，其他1234，金额12.34元');
});
test('模型未给编号遮盖子串时仍按默认首2末2规则生成遮罩',async()=>{
 const result=await redactExtractedMaterials({directory:'unused',materials:[material('编号12345678')],config,executeApi:async request=>response(request,()=>[{source_text:'12345678',kind:'identifier'}])});
 expect(result.materials[0]!.pages[0]!.text).toBe('编号12****78');
});
test('编号遮罩由程序执行首2末2规则，模型整段或局部遮罩都不能覆盖该规则',async()=>{
 for(const mask_text of ['12345678','234','4567']){
  const result=await redactExtractedMaterials({directory:'unused',materials:[material('编号12345678')],config,executeApi:async request=>response(request,()=>[{source_text:'12345678',mask_text,kind:'identifier'}])});
  expect(result.materials[0]!.pages[0]!.text).toBe('编号12****78');
 }
});
test('没有精确编号时禁止通过删除横线匹配另一个数字',async()=>{
 await expect(redactExtractedMaterials({directory:'unused',materials:[material('编号1234，金额12.34元')],config,executeApi:async request=>response(request,()=>[{source_text:'12-34',kind:'identifier'}])})).rejects.toMatchObject({reason_code:'redaction_source_not_found'});
});
test('OCR已遮罩编号的星号转义可以定位，仍按原文位置遮盖且保留数字标点',async()=>{
 for(const slash of ['\\','\\\\']){
  const code='622845'+(slash+'*').repeat(8)+'8593573';
  const result=await redactExtractedMaterials({directory:'unused',materials:[material(`编号${code}，金额12.34元`)],config,executeApi:async request=>response(request,()=>[{source_text:'622845********8593573',kind:'identifier'}])});
  expect(result.materials[0]!.pages[0]!.text).toBe('编号62'+'*'.repeat([...filterRedactionFormatting(code)].length-4)+'73，金额12.34元');
 }
});
test('汉字姓名中夹入OCR反斜线和波浪号时可定位，数字标点仍保持区别',async()=>{
 const result=await redactExtractedMaterials({directory:'unused',materials:[material('联系人：肖\\~玲，编号12-34，金额12.34元')],config,executeApi:async request=>response(request,()=>[{source_text:'肖玲',kind:'name'}])});
 expect(result.materials[0]!.pages[0]!.text).toBe('联系人：肖**，编号12-34，金额12.34元');
});
test('金额不得脱敏时程序保留原金额，不因模型误标失败',async()=>{
 const result=await redactExtractedMaterials({directory:'unused',materials:[material('金额12345元')],config:{...config,prompt:'金额不得脱敏，保持原文。'},executeApi:async request=>response(request,()=>[{source_text:'12345',kind:'amount'}])});
 expect(result.materials[0]!.pages[0]!.text).toBe('金额12345元');
});
test('固定格式过滤清除扫描水印并保留剩余主体脱敏',()=>{
 expect(filterRedactionFormatting('甲\\_乙 [Barcode] $50\\%$')).toBe('甲_乙  50%');
 const source=filterRedactionFormatting('12345_2024-06-01 12:00:00 甲公司');
 expect(applyStructuredRedactions(source,[{source_text:'甲公司',kind:'organization'}],'m','t',undefined,true,true)).toBe(' *公司');
});
test('固定过滤编号前缀扫描水印并保留正文日期',()=>{
 expect(filterRedactionFormatting('57660\\_2025-03-26 15:20:36 正文日期2025-03-26；18836 2025.03.26 15:20；8836.2025-03-26')).toBe(' 正文日期2025-03-26；；');
});
test('金额日期误标敏感类别仍原样保留，重复垃圾逐处清除',()=>{
 expect(applyStructuredRedactions('金额100元，2024年6月1日',[{source_text:'100元',kind:'identifier'},{source_text:'2024年6月1日',kind:'identifier'}],'m','t',undefined,true,true)).toBe('金额100元，2024年6月1日');
 expect(applyStructuredRedactions('□电话人 □电话人',[{source_text:'□电话人',kind:'cleanup'}],'m','t')).toBe(' ');
});
test('金额由程序只遮数字，模型整段遮罩或省略遮罩都不能吞掉币种单位',async()=>{
 for(const mask_text of [undefined,'人民币5344.4元']){
  const result=await redactExtractedMaterials({directory:'unused',materials:[material('应付人民币5344.4元')],config,executeApi:async request=>response(request,()=>[{source_text:'人民币5344.4元',kind:'amount',...(mask_text?{mask_text}:{})}])});
  expect(result.materials[0]!.pages[0]!.text).toBe('应付人民币****.*元');
 }
});
test('主体名称整段遮罩仍保留明确的组织形式与法院通称',async()=>{
 for(const name of ['某地甲有限公司','某地乙人民法院']){
  const result=await redactExtractedMaterials({directory:'unused',materials:[material(name)],config,executeApi:async request=>response(request,()=>[{source_text:name,mask_text:name,kind:'organization'}])});
  expect(result.materials[0]!.pages[0]!.text).toBe(name.endsWith('有限公司')?'***有限公司':'***人民法院');
 }
});
test('重复商户统一映射保留明确行业通称，混合姓名不被整段组织遮罩覆盖',async()=>{
 const source={material_id:'m',source_sha256:'sha',pages:[{page:1,text:'',method:'text' as const,structure:[{id:'a',kind:'paragraph' as const,text:'甲牌便利(张三)'},{id:'b',kind:'paragraph' as const,text:'甲牌便利(张三)'},{id:'c',kind:'paragraph' as const,text:'负责人张三'},{id:'d',kind:'paragraph' as const,text:'甲牌便利'}]}]};
 const result=await redactExtractedMaterials({directory:'unused',materials:[source],config,executeApi:async(request:any)=>{
  const targets=JSON.parse(request.messages.at(-1).content).targets;
  return{...response(request),text:JSON.stringify({fields:targets.map((t:any,index:number)=>({target_id:t.target_id,redactions:index===0?[{source_text:'甲牌便利(张三)',kind:'organization'}]:index===1?[{source_text:'甲牌便利(张三)',kind:'name'}]:index===3?[{source_text:'甲牌便利',kind:'organization'}]:[{source_text:'张三',kind:'name'}]}))})};
 }});
 expect(result.materials[0]!.pages[0]!.text).toBe('**便利(张**)\n**便利(张**)\n负责人张**\n**便利');
});

test('已遮罩编号仅含星号和标点时仍可按原文字面定位，不接受不存在的遮罩',async()=>{
 const masked='(****)************';
 const result=await redactExtractedMaterials({directory:'unused',materials:[material(`案号：${masked}`)],config,executeApi:async request=>response(request,()=>[{source_text:masked,kind:'case_number'}])});
 expect(result.materials[0]?.pages[0]?.text).toBe('案号：'+'*'.repeat(masked.length));
 await expect(redactExtractedMaterials({directory:'unused',materials:[material(`案号：${masked}`)],config,executeApi:async request=>response(request,()=>[{source_text:'***！',kind:'case_number'}])})).rejects.toMatchObject({reason_code:'redaction_source_not_found'});
});

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
 const repeated=await redactExtractedMaterials({directory:'unused',materials:[material('编号 A1A')],config,executeApi:async(request:any)=>response(request,()=>[{source_text:'A1A',mask_text:'A',kind:'sensitive'}])});
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
 const result=await redactExtractedMaterials({directory:'unused',materials:[source],config,execution:{max_fields:32},executeApi:async(request:any)=>{
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

test('an incomplete oversized batch is split immediately without restarting completed fields',async()=>{
 const blocks=Array.from({length:32},(_,index)=>({id:`b${index}`,kind:'paragraph' as const,text:`字段${index}`}));
 const source={material_id:'material-a',source_sha256:'source-sha',pages:[{page:1,text:blocks.map(block=>block.text).join('\n'),method:'ocr' as const,structure:blocks} as any]};
 const sizes:number[]=[];
 const result=await redactExtractedMaterials({directory:'unused',materials:[source],config,executeApi:async(request:any)=>{
  const size=JSON.parse(request.messages.at(-1).content).targets.length;sizes.push(size);
  if(size===32)throw Object.assign(new Error('incomplete response'),{kind:'invalid_response',reason_code:'incomplete_finish_reason'});
  return response(request);
 }});
 expect(sizes).toEqual([32,16,16]);
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
  await expect(redactExtractedMaterials({directory:'unused',checkpointDirectory,materials:[source],config,execution:{max_fields:32,concurrency:1},executeApi:async(request:any)=>{
   firstRunCalls++;
   if(firstRunCalls===2)throw new Error('simulated network interruption');
   return response(request);
  }})).rejects.toThrow('simulated network interruption');
  expect((await readdir(checkpointDirectory)).filter(name=>name.endsWith('.json')).length).toBe(1);
  let resumedTargets:string[]=[];
  const result=await redactExtractedMaterials({directory:'unused',checkpointDirectory,materials:[source],config,execution:{max_fields:32,concurrency:1},executeApi:async(request:any)=>{
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
  const path=join(checkpointDirectory,(await readdir(checkpointDirectory)).filter(name=>name.endsWith('.json'))[0]!);
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
  expect(result.materials[0]?.pages[0]?.text).toBe('证件号 12**56');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Agent脱敏输出schema满足严格结构化输出约束',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-agent-schema-'));
 try{
  let schema:any;
  await redactExtractedMaterials({directory:root,materials:[material('证件号 123456')],config:{provider:'codex',prompt:'fixture',model:'fixture',reasoning_effort:'low'},execute:(async(options:any)=>{
   schema=options.schema;
   return{result:options.validate({fields:[{target_id:'f1',redactions:[{source_text:'123456',mask_text:null,kind:'identifier'}]}]}),session_id:'session',usage:null,diagnostic_path:'private',duration_ms:1,provider:'codex',model:'fixture'};
  }) as any});
  const field=schema.properties.fields.items;
  const redaction=field.properties.redactions.items;
  expect(schema.additionalProperties).toBe(false);
  expect(field.additionalProperties).toBe(false);
  expect(redaction.additionalProperties).toBe(false);
  expect(redaction.required).toEqual(expect.arrayContaining(Object.keys(redaction.properties)));
  expect(redaction.properties.mask_text.type).toEqual(['string','null']);
 }finally{await rm(root,{recursive:true,force:true});}
});
