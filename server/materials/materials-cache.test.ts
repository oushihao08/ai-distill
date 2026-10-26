/**
 * 验证材料处理复用健康提取、复查有问题缓存并绑定准确输入指纹。
 * 使用临时附件/缓存及注入提取器，不访问数据库或真实 MinerU 服务。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {processMaterials} from './process';
import {redactionInputDigest} from './redaction-jobs';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
test('material processing reuses verified healthy extraction and extracts a missing source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cached-materials-'));let calls=0;
 try{
  await mkdir(join(root,'old'));await writeFile(join(root,'healthy.pdf'),'healthy source');await writeFile(join(root,'damaged.pdf'),'damaged source');
  const content=JSON.stringify({source_sha256:hash('healthy source'),structure_version:'document-structure-v1',pages:[{page:1,text:'健康文本',method:'ocr',structure:[{id:'p1-b1',kind:'paragraph',text:'健康文本'}]}]});await writeFile(join(root,'old','healthy.json'),content);
  const result=await processMaterials(root,'workflow','attempt',[{id:'healthy',storage_path:'healthy.pdf',sha256:hash('healthy source'),extraction_cache:{storage_path:'old/healthy.json',sha256:hash(content),attempt_id:'old',material_id:'healthy'}},{id:'damaged',storage_path:'damaged.pdf',sha256:hash('damaged source')}],{} as any,{extract:async(path:string)=>{calls++;expect(path).toBe(join(root,'damaged.pdf'));return{format:'pdf',provider:'glm-ocr',sha256:hash('damaged source'),pages:[{page:1,text:'恢复原件中的金额100元',method:'ocr'}]};}});
  expect(calls).toBe(1);expect(result.result.issues).toEqual([]);expect(result.result.materials[0]?.extraction.mode).toBe('cached');expect(result.result.materials[1]?.extraction.mode).toBe('fresh');
  expect(await Bun.file(join(root,'healthy.pdf')).text()).toBe('healthy source');expect(await Bun.file(join(root,'old','healthy.json')).text()).toBe(content);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('structural OCR warnings preserve cache without repeating the whole PDF',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flagged-materials-'));let calls=0;
 try{
  const source='original source';await mkdir(join(root,'old'));await writeFile(join(root,'source.pdf'),source);
  const content=JSON.stringify({source_sha256:hash(source),structure_version:'document-structure-v1',pages:[{page:1,text:'部分原文',method:'ocr',issues:['image_without_text'],structure:[{id:'b1',kind:'paragraph',text:'部分原文'}]}]});await writeFile(join(root,'old','source.json'),content);
  const result=await processMaterials(root,'workflow','attempt',[{id:'source',storage_path:'source.pdf',sha256:hash(source),extraction_cache:{storage_path:'old/source.json',sha256:hash(content),attempt_id:'old',material_id:'source'}}],undefined,{extract:async()=>{calls++;return{format:'pdf',provider:'mineru-api',sha256:hash(source),pages:[{page:1,text:'复识别完整原文',method:'ocr'}]};}});
  expect(calls).toBe(0);expect(result.result.materials[0]?.extraction.mode).toBe('cached');expect(result.result.issues.map(issue=>issue.kind)).toEqual(['image_without_text']);
  expect(await Bun.file(join(root,'source.pdf')).text()).toBe(source);expect(await Bun.file(join(root,'old','source.json')).text()).toBe(content);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('only retryable pages are rechecked once and healthy cached pages keep their source and usage identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'subset-recheck-')),source='source',sha=hash(source);let calls=0,selected:number[]=[];
 try{
  await mkdir(join(root,'old'));await writeFile(join(root,'source.pdf'),source);
  const pages=[{page:1,text:'正常页',method:'ocr',structure:[{id:'a',kind:'paragraph',text:'正常页'}],usage:{tokens:100}},{page:2,text:'部分原文',method:'ocr',issues:['truncated_response'],structure:[{id:'b',kind:'paragraph',text:'部分原文'}]}];
  const content=JSON.stringify({source_sha256:sha,structure_version:'document-structure-v1',pages});await writeFile(join(root,'old/cache.json'),content);
  const result=await processMaterials(root,'w','a',[{id:'m',storage_path:'source.pdf',sha256:sha,extraction_cache:{storage_path:'old/cache.json',sha256:hash(content),attempt_id:'old',material_id:'m'}}],undefined,{
   async extract(){throw new Error('must not re-extract whole PDF');},
   async extractPages(_path:string,numbers:number[]){calls++;selected=numbers;return{format:'pdf',provider:'mineru-api',sha256:sha,pages:[{page:2,text:'恢复原文',method:'ocr',issues:['empty_page']}]};},
  });
  expect(calls).toBe(1);expect(selected).toEqual([2]);expect(result.result.issues).toEqual([]);
  expect(result.result.pages[0]).toMatchObject({page:1,extraction_reused:true,usage:null});
  const output=JSON.parse(result.artifacts[0]!.content!);expect(output.pages.map((p:any)=>p.text)).toEqual(['正常页','恢复原文']);
  expect(await Bun.file(join(root,'old/cache.json')).text()).toBe(content);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('wrong original-page mapping fails instead of publishing a mixed OCR result',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bad-recheck-')),sha=hash('source');
 try{
  await writeFile(join(root,'source.pdf'),'source');
  await expect(processMaterials(root,'w','a',[{id:'m',storage_path:'source.pdf',sha256:sha}],undefined,{
   async extract(){return{format:'pdf',provider:'mineru-api',sha256:sha,pages:[{page:1,text:'',method:'ocr'},{page:2,text:'正常',method:'ocr'}]};},
   async extractPages(){return{format:'pdf',provider:'mineru-api',sha256:sha,pages:[{page:2,text:'错误映射',method:'ocr'}]};},
  })).rejects.toThrow('页序不一致');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an empty recheck cannot erase already extracted source facts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'empty-recheck-')),sha=hash('source');
 try{
  await writeFile(join(root,'source.pdf'),'source');
  const result=await processMaterials(root,'w','a',[{id:'m',storage_path:'source.pdf',sha256:sha}],undefined,{
   async extract(){return{format:'pdf',provider:'mineru-api',sha256:sha,pages:[{page:1,text:'已识别的事实',method:'ocr',issues:['truncated_response']}]};},
   async extractPages(){return{format:'pdf',provider:'mineru-api',sha256:sha,pages:[{page:1,text:'',method:'ocr',issues:['empty_page']}]};},
  });
  expect(JSON.parse(result.artifacts[0]!.content!).pages[0].text).toBe('已识别的事实');
  expect(result.result.issues.map(issue=>issue.kind)).toContain('empty_after_recheck');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('redaction input digest survives JSONB field ordering and still binds exact source artifacts',()=>{
 const original={material_id:'material',source_sha256:'source',artifact_id:'artifact',artifact_sha256:'text'};
 const reordered={artifact_sha256:'text',artifact_id:'artifact',source_sha256:'source',material_id:'material'};
 expect(redactionInputDigest([original])).toBe(redactionInputDigest([reordered]));expect(redactionInputDigest([original])).not.toBe(redactionInputDigest([{...reordered,artifact_sha256:'changed'}]));
});
test('legacy digest stays stable for default mode and changes for declared DOCX',()=>{
 const source={material_id:'material',source_sha256:'source',artifact_id:'artifact',artifact_sha256:'text'};
 expect(redactionInputDigest([source])).toBe(redactionInputDigest([{...source,redaction_mode:'model'}]));
 expect(redactionInputDigest([source])).not.toBe(redactionInputDigest([{...source,redaction_mode:'declared_redacted'}]));
});
test('DOCX extraction writes one structured private page without treating it as PDF',async()=>{
 const root=await mkdtemp(join(tmpdir(),'docx-material-'));
 try{
  const source='synthetic docx fixture';await writeFile(join(root,'source.docx'),source);
  const result=await processMaterials(root,'workflow','attempt',[{id:'docx',storage_path:'source.docx',sha256:hash(source)}],undefined,{extract:async()=>({format:'docx',provider:'mineru-api',sha256:hash(source),pages:[{page:1,text:'标题\n正文',method:'text',structure:[{id:'b1',kind:'heading',text:'标题',level:1},{id:'b2',kind:'paragraph',text:'正文'}]}]})});
  expect(result.result.materials[0]).toMatchObject({material_id:'docx',format:'docx',pages:1,provider:'mineru-api'});
  expect(result.artifacts[0]).toMatchObject({kind:'private_extracted_pages',material_id:'docx'});
 }finally{await rm(root,{recursive:true,force:true});}
});

