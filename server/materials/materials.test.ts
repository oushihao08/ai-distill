/**
 * 验证旧 OCR/实体路径、格式脱敏辅助、页码和私有提取产物契约。
 * HTTP、PDF 命令和提取器均由替身或临时文件提供，不访问真实识别服务/业务数据库。
 */
import { test, expect, spyOn } from 'bun:test';
import { createVisionClient } from './vision';
import { extractPdf, type Page } from './pdf';
import { processMaterials } from './process';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import { loadExtractionConfig } from './config';
import {renderRedactedMaterials} from './redaction';
import {sameRedactionConfig} from './redaction-config';
const strictConfig=()=>({...loadExtractionConfig(),continueOnError:false,entityReview:true});
const fixturePdfExtractor=(extract:(path:string)=>Promise<Page[]>)=>({extract:async(path:string)=>({format:'pdf' as const,provider:'local' as const,sha256:createHash('sha256').update(await readFile(path)).digest('hex'),pages:await extract(path)})});

test('redaction settings compare effective defaults rather than JSON key order',()=>{
 const defaults={model:'gpt-default',reasoning_effort:'medium'};
 expect(sameRedactionConfig({provider:'codex',model:'gpt-default',reasoning_effort:'medium'},{reasoning_effort:'medium',provider:'codex',model:'gpt-default'},defaults)).toBe(true);
 expect(sameRedactionConfig({provider:'codex',model:'gpt-default',reasoning_effort:'medium'},{provider:'codex',model:'gpt-default',reasoning_effort:'medium',prompt:'不同设置'},defaults)).toBe(false);
});

test('JSON prompt is sent verbatim and partial masks contain no subject placeholders',async()=>{
 const config=loadExtractionConfig();
 let prompt='';
 const client=createVisionClient({ZHIPU_API_KEY:'secret'},async(_url,init)=>{
  prompt=JSON.parse(init!.body as string).messages[0].content[1].text;
  return Response.json({choices:[{message:{content:'脱敏文字'}}]});
 },config);
 await client.recognize(new Uint8Array());
 expect(prompt).toBe(config.extractionPrompt);
 expect(config.includePageHeadings).toBe(false);
});
test('recognition passes configured reasoning effort rather than provider default',async()=>{
 let body:any;
 const client=createVisionClient({ZHIPU_API_KEY:'test'},async(_url,init)=>{
  body=JSON.parse(init!.body as string);return Response.json({choices:[{message:{content:'fixture'}}]});
 },{...loadExtractionConfig(),reasoningEffort:'low',ocrReasoningEffort:'low'});
 await client.recognize(new Uint8Array());expect(body.reasoning_effort).toBe('low');
});
test('OCR max effort is configured independently of entity checks',async()=>{
 const config=loadExtractionConfig();const bodies:any[]=[];
 const client=createVisionClient({ZHIPU_API_KEY:'test',ZHIPU_MODEL:'glm-5.3-flash'},async(_url,init)=>{bodies.push(JSON.parse(init!.body as string));return Response.json({choices:[{message:{content:bodies.at(-1).response_format?' {"entities":[]} ':'fixture'}}]});},config);
 await client.recognize(new Uint8Array());await client.entities('普通原文');
 expect(config.ocrReasoningEffort).toBe('max');expect(config.reasoningEffort).toBe('high');expect(bodies[0].reasoning_effort).toBe('max');expect(bodies[1].reasoning_effort).toBe('high');
});

test('provider rejects truncated OCR and does not expose service error body',async()=>{
 const truncated=createVisionClient({ZHIPU_API_KEY:'secret'},async()=>Response.json({choices:[{finish_reason:'length',message:{content:'partial'}}]}),strictConfig());
 await expect(truncated.recognize(new Uint8Array())).rejects.toThrow('截断');
 const failed=createVisionClient({ZHIPU_API_KEY:'secret'},async()=>new Response('secret response',{status:401}));
 await expect(failed.recognize(new Uint8Array())).rejects.toThrow('HTTP 401');
});
test('entity response cannot invent source strings',async()=>{
 const client=createVisionClient({ZHIPU_API_KEY:'secret'},async()=>Response.json({choices:[{message:{content:'["不存在的人"]'}}]}));await expect(client.entities('原文')).rejects.toThrow('原文依据');
});
test('entity requests use JSON mode and parse the declared object contract',async()=>{
 const bodies:any[]=[];
 const client=createVisionClient({ZHIPU_API_KEY:'test'},async(_url,init)=>{
  bodies.push(JSON.parse(init!.body as string));
  return Response.json({choices:[{message:{content:'{"entities":["张三"]}'}}]});
 });
 expect(await client.entities('张三付款')).toEqual(['张三']);
 expect(bodies[0].response_format).toEqual({type:'json_object'});
 await client.recognize(new Uint8Array());
 expect(bodies[1].response_format).toBeUndefined();
});
test('already masked source-backed values are not redacted again',async()=>{
 const client=createVisionClient({ZHIPU_API_KEY:'test'},async()=>Response.json({choices:[{message:{content:'{"entities":["*","张**三","李四"]}'}}]}));
 expect(await client.entities('* 张**三 李四')).toEqual(['李四']);
});
test.each(['{"entities":["无原文**"]}','{"entities":["张"]}','{"entities":[123]}'])('invalid entity objects still fail closed: %s',async content=>{
 const client=createVisionClient({ZHIPU_API_KEY:'test'},async()=>Response.json({choices:[{message:{content}}]}));
 await expect(client.entities('张三 **')).rejects.toThrow('原文依据');
});
test('legacy arrays inside whitespace-surrounded JSON fences remain readable',async()=>{
 const client=createVisionClient({ZHIPU_API_KEY:'test'},async()=>Response.json({choices:[{message:{content:'  \n```json\n["张三"]\n```\n '}}]}));
 expect(await client.entities('张三')).toEqual(['张三']);
});
test('invalid entity output gets one bounded retry against the same source',async()=>{
 let calls=0;const client=createVisionClient({ZHIPU_API_KEY:'test'},async()=>Response.json({choices:[{message:{content:++calls===1?'{"entities":["虚构值"]}':'{"entities":["张三"]}'}}]}));
 expect(await client.entities('张三付款')).toEqual(['张三']);expect(calls).toBe(2);
 let invalidCalls=0;const invalid=createVisionClient({ZHIPU_API_KEY:'test'},async()=>{invalidCalls++;return Response.json({choices:[{message:{content:'not JSON'}}]});});
 await expect(invalid.entities('张三')).rejects.toThrow('格式无效');expect(invalidCalls).toBe(2);
});
test('text pages retain PDF page numbers without calling OCR',async()=>{
 let calls=0;
 const pages=await extractPdf('unused',{recognize:async()=>{calls++;throw new Error('not expected');},entities:async()=>[]},async args=>args[0]==='pdfinfo'?'Pages: 2\nEncrypted: no':'有效文本'.repeat(30));
 expect(pages.map(p=>p.page)).toEqual([1,2]);expect(calls).toBe(0);
});
test('encrypted marker and page counts above 500 do not preempt readable text',async()=>{
 const vision={recognize:async()=>{throw new Error('unused');},entities:async()=>[]};
 const pages=await extractPdf('unused',vision,async args=>args[0]==='pdfinfo'?'Pages: 501\nEncrypted: yes':args[0]==='pdfimages'?'':'text'.repeat(80));
 expect(pages.length).toBe(501);expect(pages[500]!.page).toBe(501);
});
test('PDF extraction stores source text only in the private page artifact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-test-'));
 try{
  const bytes='%PDF-fixture';await writeFile(join(root,'source.pdf'),bytes);
  let checks=0;
  const result=await processMaterials(root,'workflow','attempt',[{id:'material',storage_path:'source.pdf',sha256:createHash('sha256').update(bytes).digest('hex')}],{recognize:async()=>{throw new Error('unused');},entities:async()=>++checks===1?['张三']:[]},fixturePdfExtractor(async()=>[{page:1,text:'张三支付100元',method:'text'}]));
  expect(result.blocked).toBe(false);expect(result.artifacts.map(artifact=>artifact.kind)).toEqual(['private_extracted_pages']);
  const extracted=JSON.parse(await readFile(join(root,result.artifacts[0]!.storage_path),'utf8'));
  expect(extracted.pages[0].text).toBe('张三支付100元');expect(result.result.pages[0]?.page).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('PDF extraction leaves entity checks to the separate redaction step',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-diagnostic-'));
 try{
  const bytes='%PDF-private-fixture';await writeFile(join(root,'source.pdf'),bytes);
  let calls=0;
  const result=await processMaterials(root,'workflow','attempt',[{id:'material',storage_path:'source.pdf',sha256:createHash('sha256').update(bytes).digest('hex')}],{recognize:async()=>{throw new Error('unused');},entities:async()=>{calls++;throw new Error('脱敏实体返回格式无效 secret response');}},fixturePdfExtractor(async()=>[{page:26,text:'private source content '.repeat(300),method:'text'}]));
  expect(result.blocked).toBe(false);expect(calls).toBe(0);expect(result.result.issues).toEqual([]);
  expect(result.artifacts.map(artifact=>artifact.kind)).toEqual(['private_extracted_pages']);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('image page uses OCR even with a substantial text layer',async()=>{
 let calls=0;
 const pages=await extractPdf('unused',{recognize:async()=>{calls++;return {text:'扫描内容',model:'test',usage:null};},entities:async()=>[]},async args=>{
  if(args[0]==='pdfinfo')return 'Pages: 1\nEncrypted: no';
  if(args[0]==='pdfimages')return '1 0 image 100 100';
  if(args[0]==='pdftotext')return 'existing layer '.repeat(30);
  expect(args).toContain('1600');
  await writeFile(`${args.at(-1)}.png`,'fixture');return '';
 });
 expect(calls).toBe(1);expect(pages[0]!.method).toBe('ocr');
});
test('PDF extraction resumes from private per-page checkpoints after an OCR interruption',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdf-page-checkpoints-'));
 const cache={directory:join(root,'cache'),source_sha256:'a'.repeat(64),config_fingerprint:'b'.repeat(64)};
 try{
  let calls=0;
  const run=async(args:string[])=>{
   if(args[0]==='pdfinfo')return 'Pages: 2\nEncrypted: no';
   if(args[0]==='pdfimages')return '1 0 image 100 100\n2 0 image 100 100';
   if(args[0]==='pdftotext')return 'scan';
   const page=args.at(-1)!.match(/page-(\d+)$/)![1];await writeFile(`${args.at(-1)}.png`,page);return '';
  };
  let pageTwoCalls=0;const vision={recognize:async(image:Uint8Array)=>{calls++;const page=Buffer.from(image).toString();if(page==='2'&&++pageTwoCalls<=3)throw new Error('temporary provider timeout');return{text:`page ${page}`,model:'fixture',usage:null};},entities:async()=>[]};
  await expect(extractPdf('unused',vision,run,cache)).rejects.toThrow('temporary provider timeout');
  const pages=await extractPdf('unused',vision,run,cache);
  expect(calls).toBe(5);expect(pages.map(page=>page.text)).toEqual(['page 1','page 2']);expect(pages[0]!.reused).toBe(true);expect(pages[1]!.reused).not.toBe(true);
  const changedConfig=await extractPdf('unused',vision,run,{...cache,config_fingerprint:'c'.repeat(64)});expect(calls).toBe(7);expect(changedConfig.every(page=>!page.reused)).toBe(true);
  await extractPdf('unused',vision,run,{...cache,source_sha256:'d'.repeat(64),config_fingerprint:'c'.repeat(64)});expect(calls).toBe(9);
 }finally{await rm(root,{recursive:true,force:true});}
});
import{readdir,stat}from'node:fs/promises';
import{command}from'./pdf';
import{tmpdir as temporaryRoot}from'node:os';
test('command failure never includes subprocess stderr in error',async()=>{await expect(command(['/bin/sh','-c','echo sensitive-content >&2; exit 1'])).rejects.toThrow('PDF 工具');});
test.each(['Pages: 0','Pages: missing','No page metadata'])('invalid page count fails early: %s',async info=>{
 await expect(extractPdf('unused',{recognize:async()=>{throw new Error('not called');},entities:async()=>[]},async()=>info)).rejects.toThrow('页数');
});
test('provider validates credentials, empty output and entity JSON',async()=>{
 await expect(createVisionClient({}).recognize(new Uint8Array())).rejects.toThrow('ZHIPU_API_KEY');
 await expect(createVisionClient({ZHIPU_API_KEY:'test'},async()=>Response.json({choices:[]})).recognize(new Uint8Array())).rejects.toThrow('空内容');
 await expect(createVisionClient({ZHIPU_API_KEY:'test'},async()=>Response.json({choices:[{message:{content:'invalid'}}]})).entities('资料')).rejects.toThrow('格式无效');
 await expect(createVisionClient({ZHIPU_API_KEY:'test'},async()=>{throw new Error('secret network error');}).recognize(new Uint8Array())).rejects.toThrow('请求失败或超时');
});
test('invalid JSON configuration fails without fallback to another prompt',async()=>{
 const dir=await mkdtemp(join(temporaryRoot(),'config-test-'));const previous=process.env.EXTRACTION_CONFIG_PATH;
 try{
  const path=join(dir,'invalid.json');process.env.EXTRACTION_CONFIG_PATH=path;
  expect(()=>loadExtractionConfig()).toThrow('配置');
  await writeFile(path,'{');expect(()=>loadExtractionConfig()).toThrow('配置');
  await writeFile(path,JSON.stringify({extractionPrompt:'test',entityPrompt:'test',includePageHeadings:false,maskStyle:'invalid'}));expect(()=>loadExtractionConfig()).toThrow('字段无效');
 }finally{if(previous===undefined)delete process.env.EXTRACTION_CONFIG_PATH;else process.env.EXTRACTION_CONFIG_PATH=previous;await rm(dir,{recursive:true,force:true});}
});
test('fingerprint mismatch clears unpublished files before calling extraction',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fingerprint-test-'));let called=false;
 try{
  await writeFile(join(root,'source.pdf'),'%PDF-changed');
  await expect(processMaterials(root,'workflow','attempt',[{id:'material',storage_path:'source.pdf',sha256:'wrong'}],{recognize:async()=>{throw new Error('unused');},entities:async()=>[]},fixturePdfExtractor(async()=>{called=true;return[];}))).rejects.toThrow('指纹变化');
  expect(called).toBe(false);expect(await readdir(join(root,'workflow'))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('unchanged PDF reuses private page extraction while a changed attachment is parsed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'material-cache-'));
 try{
  const source='%PDF-unchanged',changed='%PDF-changed';
  await writeFile(join(root,'one.pdf'),source);await writeFile(join(root,'two.pdf'),changed);
  const sourceHash=createHash('sha256').update(source).digest('hex');
  const content=JSON.stringify({source_sha256:sourceHash,structure_version:'document-structure-v1',pages:[{page:1,text:'张三支付100元',method:'text',usage:{total_tokens:100},structure:[{id:'p1-b1',kind:'paragraph',text:'张三支付100元'}]}]});
  await writeFile(join(root,'cache.json'),content);let extractions=0;
  const result=await processMaterials(root,'workflow','attempt',[
   {id:'one',storage_path:'one.pdf',sha256:sourceHash,extraction_cache:{storage_path:'cache.json',sha256:createHash('sha256').update(content).digest('hex'),attempt_id:'old-attempt',material_id:'old-material'}},
   {id:'two',storage_path:'two.pdf',sha256:createHash('sha256').update(changed).digest('hex')},
  ],{recognize:async()=>{throw new Error('unused');},entities:async text=>text.includes('张三')?['张三']:[]},fixturePdfExtractor(async path=>{
   extractions++;expect(path).toEndWith('two.pdf');return[{page:1,text:'张三支付200元',method:'text'}];
  }),strictConfig());
  expect(extractions).toBe(1);expect(result.blocked).toBe(false);
  expect(result.result.materials[0]?.extraction.mode).toBe('cached');
  expect(result.result.materials[1]?.extraction.mode).toBe('fresh');
  expect(result.result.pages[0]?.usage).toBeNull();
  expect(result.artifacts.map(artifact=>artifact.kind)).toEqual(['private_extracted_pages','private_extracted_pages']);
  const fresh=JSON.parse(await readFile(join(root,result.artifacts[1]!.storage_path),'utf8'));
  expect(fresh.pages[0].text).toBe('张三支付200元');
  const cached=result.artifacts.filter(artifact=>artifact.kind==='private_extracted_pages');
  expect(cached).toHaveLength(2);expect(cached[0]?.material_id).toBe('one');
  expect((await stat(join(root,cached[0]!.storage_path))).mode&0o777).toBe(0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('missing or corrupted extraction cache triggers fresh parsing rather than false reuse',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cache-missing-'));
 try{
  const source='%PDF-source';await writeFile(join(root,'source.pdf'),source);let extractions=0;
  const result=await processMaterials(root,'workflow','attempt',[{id:'one',storage_path:'source.pdf',sha256:createHash('sha256').update(source).digest('hex'),extraction_cache:{storage_path:'missing.json',sha256:'wrong',attempt_id:'old',material_id:'old'}}],{recognize:async()=>{throw new Error('unused');},entities:async()=>[]},fixturePdfExtractor(async()=>{extractions++;return[{page:1,text:'公开资料',method:'text'}];}),strictConfig());
  expect(extractions).toBe(1);expect(result.result.materials[0]?.extraction.mode).toBe('fresh');
  expect(result.result.materials[0]?.extraction.cache_error).toBe('missing_or_invalid');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('legacy text-only extraction cache is rejected for a structured extraction attempt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'legacy-cache-'));
 try{
  const source='%PDF-legacy-cache';await writeFile(join(root,'source.pdf'),source);
  const sourceHash=createHash('sha256').update(source).digest('hex');
  const oldCache=JSON.stringify({source_sha256:sourceHash,pages:[{page:1,text:'旧版纯文本',method:'text'}]});
  await writeFile(join(root,'legacy.json'),oldCache);let extractions=0;
  const result=await processMaterials(root,'workflow','attempt',[{id:'one',storage_path:'source.pdf',sha256:sourceHash,extraction_cache:{storage_path:'legacy.json',sha256:createHash('sha256').update(oldCache).digest('hex'),attempt_id:'old',material_id:'old'}}],{recognize:async()=>{throw new Error('unused');},entities:async()=>[]},fixturePdfExtractor(async()=>{extractions++;return[{page:1,text:'新版结构化正文',method:'ocr',structure:[{id:'p1-b1',kind:'paragraph',text:'新版结构化正文'}]}];}),strictConfig());
  expect(extractions).toBe(1);expect(result.result.materials[0]?.extraction).toMatchObject({mode:'fresh',cache_error:'missing_or_invalid'});
  expect(result.artifacts[0]?.content).toContain('新版结构化正文');expect(result.artifacts[0]?.content).not.toContain('旧版纯文本');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('new extraction artifacts persist a structured text projection with exact source content',async()=>{
 const root=await mkdtemp(join(tmpdir(),'structured-extraction-'));
 try{
  const source='%PDF-structured';await writeFile(join(root,'source.pdf'),source);
  const pageText=' 标题\n正文  ';
  const result=await processMaterials(root,'workflow','attempt',[{id:'material',storage_path:'source.pdf',sha256:createHash('sha256').update(source).digest('hex')}],{recognize:async()=>{throw new Error('unused');},entities:async()=>[]},fixturePdfExtractor(async()=>[{page:1,text:pageText,method:'ocr'}]),strictConfig());
  const artifact=JSON.parse(await readFile(join(root,result.artifacts[0]!.storage_path),'utf8'));
  expect(artifact.structure_version).toBe('document-structure-v1');
  expect(artifact.pages[0].structure).toEqual([{id:'p1-b1',kind:'paragraph',text:pageText}]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('extraction preserves raw page text and defers masking to redaction',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-test-'));
 try{
  const bytes='%PDF-test';await writeFile(join(root,'source.pdf'),bytes);let calls=0;
  const processed=await processMaterials(root,'workflow','attempt',[{id:'material',storage_path:'source.pdf',sha256:createHash('sha256').update(bytes).digest('hex')}],{recognize:async()=>{throw new Error('unused');},entities:async()=>++calls===1?['张三']:['李四']},fixturePdfExtractor(async()=>[{page:1,text:'张三与李四',method:'text'}]),strictConfig());
  const extracted=JSON.parse(await readFile(join(root,processed.artifacts[0]!.storage_path),'utf8'));
  expect(extracted.pages[0].text).toBe('张三与李四');expect(processed.blocked).toBe(false);expect(processed.result.issues).toEqual([]);
  expect((await stat(join(root,processed.artifacts[0]!.storage_path))).mode&0o777).toBe(0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('extraction does not run entity correction passes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'redaction-correction-'));
 try{
  const source='%PDF-test';await writeFile(join(root,'source.pdf'),source);let checks=0;
  const result=await processMaterials(root,'workflow','attempt',[{id:'material',storage_path:'source.pdf',sha256:createHash('sha256').update(source).digest('hex')}],{recognize:async()=>{throw new Error('unused');},entities:async()=>{checks++;return checks===1?['张三']:checks===2?['李四']:[];}},fixturePdfExtractor(async()=>[{page:1,text:'张三与李四',method:'text'}]),strictConfig());
  expect(result.blocked).toBe(false);expect(checks).toBe(0);
  const extracted=JSON.parse(await readFile(join(root,result.artifacts[0]!.storage_path),'utf8'));
  expect(extracted.pages[0].text).toBe('张三与李四');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('entity validation errors are not part of the extraction step',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-extraction-failure-'));
 try{
  const source='%PDF-test';await writeFile(join(root,'source.pdf'),source);
  const result=await processMaterials(root,'workflow','attempt',[{id:'material',storage_path:'source.pdf',sha256:createHash('sha256').update(source).digest('hex')}],{recognize:async()=>{throw new Error('unused');},entities:async()=>{throw new Error('脱敏实体无有效原文依据');}},fixturePdfExtractor(async()=>[{page:1,text:'张三13812345678',method:'ocr'}]),strictConfig());
  expect(result.blocked).toBe(false);expect(result.artifacts.map(a=>a.kind)).toEqual(['private_extracted_pages']);
  expect(result.result.materials[0]?.pages).toBe(1);expect(result.result.issues).toEqual([]);
  const cache=JSON.parse(await readFile(join(root,result.artifacts[0]!.storage_path),'utf8'));
  expect(cache.pages[0].text).toBe('张三13812345678');expect((await stat(join(root,result.artifacts[0]!.storage_path))).mode&0o777).toBe(0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Zhipu OCR and entity requests allow thirty minutes and report that limit safely',async()=>{
 const timeout=spyOn(AbortSignal,'timeout');
 try {
  const client=createVisionClient({ZHIPU_API_KEY:'secret'},async(_url,init)=>Response.json({choices:[{message:{content:JSON.parse(init!.body as string).response_format?'{"entities":[]}':'文字'}}]}));
  await client.recognize(new Uint8Array());await client.entities('普通文字');
  expect(timeout.mock.calls.map(call=>call[0])).toEqual([1800000,1800000]);
  const expired=createVisionClient({ZHIPU_API_KEY:'secret'},async()=>{throw new DOMException('private details','TimeoutError');});
  await expect(expired.recognize(new Uint8Array())).rejects.toThrow('30分钟');
 } finally {timeout.mockRestore();}
});

test('entity retry receives the rejected output as data and must return source-backed replacements',async()=>{
 const bodies:any[]=[];
 const client=createVisionClient({ZHIPU_API_KEY:'test'},async(_url,init)=>{
  bodies.push(JSON.parse(init!.body as string));
  return Response.json({choices:[{message:{content:bodies.length===1?'{"entities":["不在原文的姓名"]}':'{"entities":["张三"]}'}}]});
 });
 expect(await client.entities('张三付款')).toEqual(['张三']);
 expect(bodies[1].messages.find((message:any)=>message.role==='user').content).toContain('上一轮返回未通过校验');
 expect(bodies[1].messages.find((message:any)=>message.role==='user').content).toContain('不在原文的姓名');
});

test('single-character entity retry explains the unsafe replacement granularity',async()=>{
 const requests:any[]=[];
 const client=createVisionClient({ZHIPU_API_KEY:'test'},async(_url,init)=>{
  const body=JSON.parse(init!.body as string);requests.push(body);
  return Response.json({choices:[{message:{content:requests.length===1?'{"entities":["张"]}':'{"entities":["张三"]}'}}]});
 });
 expect(await client.entities('张三付款。张贴公告。')).toEqual(['张三']);
 expect(requests[1].messages.find((message:any)=>message.role==='user').content).toContain('至少两个字符');
 expect(requests[1].messages.find((message:any)=>message.role==='user').content).toContain('单字');
});

test('共用渲染器保留附件页序与结构，拒绝正文结构不一致',()=>{
 const materials=[{material_id:'a',pages:[{page:1,text:'化名正文',structure:[{id:'p1',kind:'paragraph' as const,text:'化名正文'}]}]}];
 const rendered=renderRedactedMaterials(materials),index=JSON.parse(rendered.index);
 expect(index.materials[0].markdown).toBe('化名正文');
 expect(index.materials[0].document.pages[0].blocks).toEqual(materials[0]!.pages[0]!.structure);
 expect(index.redacted_sha256).toBe(createHash('sha256').update(rendered.markdown).digest('hex'));
 expect(()=>renderRedactedMaterials([{material_id:'a',pages:[{...materials[0]!.pages[0]!,text:'不一致'}]}])).toThrow('结构与正文不一致');
});
