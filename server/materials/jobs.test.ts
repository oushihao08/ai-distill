/** 验证提取队列并发、附件绑定、重试去重、迟到结果隔离及文件清理。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import { test,expect } from 'bun:test';
import type {Pool} from 'pg';
import {enqueueExtraction,resolvePdfProvider} from './jobs';
import {MineruApiFirstPdfExtractor} from './pdf-extraction/mineru-api';
import type {PdfExtractionProvider} from './pdf-extraction/types';
test('new extraction defaults to MinerU and rejects GLM OCR',()=>{
 expect(resolvePdfProvider({MINERU_KEY:'token'})).toBe('mineru-api');
 expect(resolvePdfProvider({MINERU_KEY:'token',PDF_EXTRACTION_PROVIDER:'mineru-cli'})).toBe('mineru-cli');
 expect(()=>resolvePdfProvider({MINERU_KEY:'token',PDF_EXTRACTION_PROVIDER:'glm-ocr'})).toThrow('仅支持MinerU');
 expect(()=>resolvePdfProvider({})).toThrow('MINERU_KEY');
});
test('MinerU API success does not call CLI fallback',async()=>{
 let apiCalls=0,cliCalls=0;const result={provider:'mineru-api',sha256:'sha',pages:[]} as any;
 const api={id:'mineru-api',extract:async()=>{apiCalls++;return result;}} as PdfExtractionProvider;
 const cli={id:'mineru-cli',extract:async()=>{cliCalls++;return result;}} as PdfExtractionProvider;
 expect(await new MineruApiFirstPdfExtractor(api,cli).extract('file.pdf')).toBe(result);
 expect(apiCalls).toBe(1);expect(cliCalls).toBe(0);
});
test('MinerU API failure falls back to CLI and preserves CLI provider identity',async()=>{
 let cliCalls=0;const result={provider:'mineru-cli',sha256:'sha',pages:[]} as any;
 const api={id:'mineru-api',extract:async()=>{throw new TypeError('network unavailable');}} as PdfExtractionProvider;
 const cli={id:'mineru-cli',extract:async()=>{cliCalls++;return result;}} as PdfExtractionProvider;
 expect(await new MineruApiFirstPdfExtractor(api,cli).extract('file.pdf')).toBe(result);expect(cliCalls).toBe(1);
});
test('MinerU API cancellation does not start CLI fallback',async()=>{
 const controller=new AbortController();controller.abort();let cliCalls=0;
 const api={id:'mineru-api',extract:async()=>{throw new Error('cancelled');}} as PdfExtractionProvider;
 const cli={id:'mineru-cli',extract:async()=>{cliCalls++;throw new Error('must not run');}} as PdfExtractionProvider;
 await expect(new MineruApiFirstPdfExtractor(api,cli).extract('file.pdf',controller.signal)).rejects.toThrow('cancelled');expect(cliCalls).toBe(0);
});
function fake(previous=false,received=true,docx=false){const calls:string[]=[];const client={release(){},async query(sql:string){calls.push(sql);if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return {rowCount:1,rows:[{}]};if(sql.startsWith('SELECT id,sha256'))return {rowCount:1,rows:[{id:'material',sha256:'source-hash'}]};if(sql.startsWith('SELECT count(*)::int AS total'))return {rowCount:1,rows:[{total:1,pdfs:docx?0:1,docxs:docx?1:0}]};if(sql.startsWith('SELECT ordinal'))return {rowCount:8,rows:[{status:received?'succeeded':'skipped'}]};if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return {rowCount:previous?1:0,rows:previous?[{id:'existing'}]:[]};return {rowCount:1,rows:[]};}};return {pool:{connect:async()=>client} as unknown as Pool,calls};}
test('DOCX creates an extraction attempt with its own converter version',async()=>{
 const {pool,calls}=fake(false,true,true);
 expect((await enqueueExtraction(pool,'workflow')).reused).toBe(false);
 expect(calls.some(sql=>sql.includes("LIKE '%.docx'"))).toBe(true);
});
test('queue serializes workflows and reuses pending attempt',async()=>{const {pool,calls}=fake(true);expect(await enqueueExtraction(pool,'workflow')).toEqual({id:'existing',reused:true});expect(calls.some(c=>c.includes('FOR UPDATE'))).toBe(true);expect(calls.some(c=>c.startsWith('INSERT'))).toBe(false);});
test('queue records attempt and rejects missing upstream success',async()=>{const ready=fake();expect((await enqueueExtraction(ready.pool,'workflow')).reused).toBe(false);expect(ready.calls.some(c=>c.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(true);const failed=fake(false,false);await expect(enqueueExtraction(failed.pool,'workflow')).rejects.toThrow('入库尚未完成');expect(failed.calls).toContain('ROLLBACK');});
test('queue locks the workflow and only reuses attempts for the current attachment set',async()=>{
 const {pool,calls}=fake();await enqueueExtraction(pool,'workflow');
 expect(calls.some(sql=>sql.startsWith('SELECT id')&&sql.includes('FOR UPDATE'))).toBe(true);
 expect(calls.find(sql=>sql.startsWith('SELECT id FROM ai_distill.step_attempts'))).toContain("input->'materials'=$2::jsonb");
 expect(calls.find(sql=>sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toContain("'materials',$4::jsonb");
});
import { runNextExtraction } from './jobs';
import type {processMaterials}from'./process';
import{loadExtractionConfig}from'./config';
function executionFake(options:{empty?:boolean;invalidated?:boolean;publishError?:boolean;published?:boolean;cached?:boolean}={}){
 const calls:{sql:string;values?:unknown[]}[]=[];
 const job={id:'attempt',workflow_id:'workflow',input:{materials:[{id:'material',sha256:'source-hash'}]},config:{pdf_provider:'mineru-api',model:'mineru-vlm',base_url:'https://mineru.net',extraction:loadExtractionConfig()}};
 let failed=false;
 const query=async(sql:string,values?:unknown[])=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT id FROM ai_distill.artifacts'))return {rows:options.published?[{id:'published'}]:[],rowCount:options.published?1:0};
  if(sql.startsWith('SELECT DISTINCT ON (m.sha256)'))return {rows:options.cached?[{source_sha256:'source-hash',storage_path:'workflow/old/material-extracted.json',sha256:'cache-hash',attempt_id:'old-attempt',material_id:'material'}]:[],rowCount:options.cached?1:0};
  if(sql.startsWith('SELECT id,storage_path,sha256 FROM ai_distill.materials'))return {rows:[{id:'material',storage_path:'source.pdf',sha256:'source-hash'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return {rows:[{}],rowCount:1};
  if(sql.startsWith('SELECT a.*')&&sql.includes('FROM ai_distill.step_attempts'))return {rows:options.empty?[]:[job],rowCount:options.empty?0:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return {rows:options.invalidated?[]:[{id:job.id}],rowCount:options.invalidated?0:1};
  if(sql.startsWith('UPDATE ai_distill.step_attempts SET status=')&&values?.[1]==='succeeded'&&options.publishError&&!failed){failed=true;throw new Error('db unavailable');}
  if(sql.startsWith('UPDATE ai_distill.step_attempts SET status=')&&sql.includes("status='running'")&&options.invalidated)return {rows:[],rowCount:0};
  return {rows:[],rowCount:1};
 };
 const client={query,release(){}};return {pool:{query,connect:async()=>client}as unknown as Pool,calls};
}
const publication=(blocked=false):Awaited<ReturnType<typeof processMaterials>>=>({artifacts:[],blocked,result:{materials:[],pages:[],issues:blocked?[{page_index:0,material_id:'material',page:1,kind:'unreadable'}]:[],persistence:'test'}});
test('idle executor does not call material processor',async()=>{
 const {pool,calls}=executionFake({empty:true});let invoked=false;
 expect(await runNextExtraction(pool,'unused',async()=>{invoked=true;return publication();})).toBe(false);expect(invoked).toBe(false);expect(calls.at(-1)?.sql).toBe('COMMIT');
});
test('pre-stopped worker does not claim an extraction attempt',async()=>{
 const {pool,calls}=executionFake(),controller=new AbortController();controller.abort();
 expect(await runNextExtraction(pool,'unused',undefined,undefined,controller.signal)).toBe(false);
 expect(calls).toHaveLength(0);
});
test('worker stop prevents late extraction publication and requeues the claimed attempt',async()=>{
 const {pool,calls}=executionFake(),controller=new AbortController();
 expect(await runNextExtraction(pool,'unused',async()=>{controller.abort();return publication();},undefined,controller.signal)).toBe(true);
 expect(calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.artifacts'))).toBe(false);
 const requeue=calls.find(call=>call.sql.includes("SET status='waiting'")&&call.values?.[0]==='attempt');
 expect(requeue).toBeDefined();
 expect(requeue?.sql).toContain('started_at=now()');
 expect(requeue?.sql).not.toContain('started_at=NULL');
 expect(calls.some(call=>call.sql.includes('ordinal IN (1,2)'))).toBe(true);
});
test.each([false,true])('executor publishes %s blocked result atomically',async blocked=>{
 const {pool,calls}=executionFake();expect(await runNextExtraction(pool,'unused',async()=>publication(blocked))).toBe(true);
 const result=calls.find(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'));expect(result?.values?.[1]).toBe(blocked?'failed':'succeeded');expect(result?.values?.[3]).toBe(blocked?'识别或脱敏检查存在待核项，暂不可用于出题':null);expect(calls.at(-1)?.sql).toBe('COMMIT');
});
test('processor failure records a bounded error and never publishes success',async()=>{
 const {pool,calls}=executionFake();await runNextExtraction(pool,'unused',async()=>{throw new Error('secret response from provider');});
 const failed=calls.find(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed',error") && c.values?.[0]==='attempt');expect(failed?.values?.[1]).toBe('材料处理失败，请检查运行依赖和识别配置');expect(calls.some(c=>c.values?.[1]==='succeeded')).toBe(false);
});
test('failed transaction rolls back before recording attempt failure',async()=>{
 const {pool,calls}=executionFake({publishError:true});await runNextExtraction(pool,'unused',async()=>publication());expect(calls.some(c=>c.sql==='ROLLBACK')).toBe(true);expect(calls.some(c=>c.sql.startsWith("UPDATE ai_distill.step_attempts SET status='failed',error"))).toBe(true);
});
test('late result from invalidated attempt cannot overwrite replacement attempt',async()=>{
 const {pool,calls}=executionFake({invalidated:true});await runNextExtraction(pool,'unused',async()=>publication());expect(calls.some(c=>c.sql.startsWith('UPDATE ai_distill.steps SET status=$2'))).toBe(false);expect(calls.some(c=>c.sql.startsWith("UPDATE ai_distill.steps SET status='failed',error=$2"))).toBe(false);
});
test('executor checks current attachments against the claimed snapshot',async()=>{
 const {pool,calls}=executionFake();await runNextExtraction(pool,'unused',async()=>publication());
 const sources=calls.find(c=>c.sql.startsWith('SELECT id,storage_path,sha256 FROM ai_distill.materials'));
 expect(sources?.sql).toContain('deleted_at IS NULL');expect(sources?.values).toEqual(['workflow']);
});
test('executor caches MinerU independently of legacy entity-check settings',async()=>{
 const {pool,calls}=executionFake({cached:true});let inputs:any;
 await runNextExtraction(pool,'unused',async(_root,_workflow,_attempt,materials)=>{inputs=materials;return publication();});
 const cacheQuery=calls.find(c=>c.sql.startsWith('SELECT DISTINCT ON (m.sha256)'))?.sql??'';
 expect(cacheQuery).not.toContain("'{extraction,extractionPrompt}'");
 expect(cacheQuery).not.toContain("'{extraction,ocrReasoningEffort}'");
 expect(cacheQuery).not.toContain('a.config=$2::jsonb');
 expect(inputs[0].extraction_cache).toMatchObject({attempt_id:'old-attempt',material_id:'material',sha256:'cache-hash'});
});
import{mkdtemp,mkdir,writeFile,readdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
test('rolled-back publication removes only unpublished attempt files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-cleanup-'));
 try{
  const {pool}=executionFake({publishError:true});
  await runNextExtraction(pool,root,async()=>{
   await mkdir(join(root,'workflow','attempt'),{recursive:true});await writeFile(join(root,'workflow','attempt','materials.md'),'test output');
   return publication();
  });
  expect(await readdir(join(root,'workflow'))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('uncertain commit retains files already referenced by artifacts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'worker-commit-'));
 try{
  const {pool}=executionFake({publishError:true,published:true});
  await runNextExtraction(pool,root,async()=>{
   await mkdir(join(root,'workflow','attempt'),{recursive:true});await writeFile(join(root,'workflow','attempt','materials.md'),'published output');return publication();
  });
  expect(await readdir(join(root,'workflow'))).toEqual(['attempt']);
 }finally{await rm(root,{recursive:true,force:true});}
});

// Authentication and local response defects must not repeat a long upload.
test.each(['MinerU API 上传地址申请返回HTTP 401','MinerU API content_list.json无效','未配置 MINERU_KEY'])('MinerU does not fall back for %s',async(message)=>{
 let calls=0;
 const api={id:'mineru-api',extract:async()=>{throw new Error(message);}} as PdfExtractionProvider;
 const cli={id:'mineru-cli',extract:async()=>{calls++;return {} as any;}} as PdfExtractionProvider;
 await expect(new MineruApiFirstPdfExtractor(api,cli).extract('file.pdf')).rejects.toThrow(message);
 expect(calls).toBe(0);
});
