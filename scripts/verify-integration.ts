/** 文件职责：以临时 PostgreSQL schema 验证材料接收、队列和真实提取／脱敏；环境参数决定 PDF 范围。
 * 执行入口与用途：`bun scripts/verify-integration.ts`；在临时 schema 接通材料接收、提取队列和脱敏执行；按环境配置调用真实 provider 并记录证据。
 */
import { createPool } from '../server/db';
import { createApp } from '../server/app';
import { runNextExtraction } from '../server/materials/jobs';
import { loadExtractionConfig } from '../server/materials/config';
import type { Pool } from 'pg';
import { mkdtemp,rm,writeFile,readdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { command,extractPdf } from '../server/materials/pdf';
import {processMaterials} from '../server/materials/process';

const pool=createPool();
const schema=`test_ai_distill_${crypto.randomUUID().replaceAll('-','')}`;
const checks:{name:string;passed:boolean}[]=[];
const root=await mkdtemp(join(tmpdir(),'ai-distill-integration-'));
let server:ReturnType<typeof Bun.serve>|undefined;
let processorVersion:string|undefined;
let extractionSummary:unknown;
const startedAt=Date.now();
const providerMetrics:Record<string,{calls:number;elapsed_ms:number;failed:number}>={page_ocr:{calls:0,elapsed_ms:0,failed:0},entity_check:{calls:0,elapsed_ms:0,failed:0}};
const verificationCache=resolve('.storage','.verification-ocr-cache');
const fullPdf=process.env.VERIFY_FULL_PDF==='1';
function check(name:string,condition:boolean){checks.push({name,passed:condition});console.log(`${condition?'PASS':'FAIL'} ${name}`);if(!condition)throw new Error(name);}
function sql(text:string){return text.replaceAll('ai_distill',schema);}
const testPool={
 query:async(text:string,values?:unknown[])=>{try{return await pool.query(sql(text),values);}catch(error){throw error;}},
 connect:async()=>{
  try{const client=await pool.connect();return{query:async(text:string,values?:unknown[])=>{try{return await client.query(sql(text),values);}catch(error){throw error;}},release:()=>client.release()};}catch(error){throw error;}
 }
}as unknown as Pool;
try{
 check('Neon authenticated query',(await pool.query('SELECT 1 AS value')).rows[0].value===1);
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())await pool.query(sql(await Bun.file(new URL(`../migrations/${name}`,import.meta.url)).text()));
 const app=createApp(testPool,root);
 server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.fetch,maxRequestBodySize:101*1024*1024,idleTimeout:60});
 const base=`http://127.0.0.1:${server.port}/api`;
 async function request(path:string,init?:RequestInit){try{return await fetch(base+path,init);}catch(error){throw error;}}
 check('HTTP health and DB connectivity',(await request('/health')).status===200);
 const project=await request('/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'isolated integration test',description:'temporary schema',material_root:root})});check('create project',project.status===201);const p=await project.json()as any;
 const input=process.env.VERIFY_PDF_PATH??'/Users/jack/Downloads/568-房屋买卖案-一手资料包 2/(2018)渝0104民初568号.pdf';
 const bytes=await Bun.file(input).arrayBuffer();
 const hash=createHash('sha256').update(Buffer.from(bytes)).digest('hex');
 const key=crypto.randomUUID();
 async function upload(title:string,fileBytes:ArrayBuffer,requestKey=crypto.randomUUID()){
  try{const form=new FormData();form.append('title',title);form.append('files',new File([fileBytes],'source.pdf'));return await request(`/projects/${p.id}/workflows`,{method:'POST',headers:{'Idempotency-Key':requestKey},body:form});}catch(error){throw error;}
 }
 const responses=await Promise.all([upload('full PDF intake',bytes,key),upload('full PDF intake',bytes,key)]);
 const workflows=await Promise.all(responses.map(r=>r.json()))as any[];
 check('concurrent intake idempotency',responses.every(r=>[200,201].includes(r.status))&&workflows[0].id===workflows[1].id);
 const detail=await(await request(`/workflows/${workflows[0].id}`)).json()as any;
 check('saved source hash and file count',detail.materials.length===1&&detail.materials[0].sha256===hash);
 check('stage availability',detail.steps.length===8&&detail.steps[1].implemented&&detail.steps.slice(2).every((s:any)=>s.implemented===(s.ordinal===3||s.ordinal===5)&&s.status==='waiting'));
 const downloaded=await request(`/materials/${detail.materials[0].id}/download`);
 check('exact original PDF download',downloaded.status===200&&createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex')===hash);
 const listing=await(await request('/projects')).json()as any[];check('project list counts',listing[0].workflow_count===1);
 const projectDetail=await(await request(`/projects/${p.id}`)).json()as any;check('project detail workflow index',projectDetail.workflows[0].id===workflows[0].id);
 check('missing workflow error',(await request(`/workflows/${crypto.randomUUID()}`)).status===404);
 check('cross-origin write rejection',(await request('/projects',{method:'POST',headers:{Origin:'https://unrelated.example','Content-Type':'application/json'},body:'{}'})).status===403);
 let preview=workflows[0];
 if(!fullPdf){const pageOutput=join(root,'real-page-%d.pdf');await command(['pdfseparate','-f','1','-l','1',input,pageOutput]);const pagePdf=pageOutput.replace('%d','1');const subset=await upload('real PDF first page OCR',await Bun.file(pagePdf).arrayBuffer());check('upload extracted first page',subset.status===201);preview=await subset.json()as any;}
 const expectedPages=fullPdf?Number((await command(['pdfinfo',input])).match(/^Pages:\s+(\d+)/m)?.[1]):1;
 const queue=await request(`/workflows/${preview.id}/extract`,{method:'POST'});check('persistent extraction queue',queue.status===202);const task=await queue.json()as any;
 const repeated=await(await request(`/workflows/${preview.id}/extract`,{method:'POST'})).json()as any;check('extraction queue idempotency',repeated.id===task.id&&repeated.reused===true);
 const waited=await request(`/workflows/${preview.id}/extract?wait_ms=1`,{method:'POST'});const waiting=await waited.json()as any;check('synchronous timeout keeps the same pending task',waited.status===202&&waiting.id===task.id&&waiting.completed===false&&waiting.status==='waiting');
 const snapshot=(await testPool.query('SELECT config FROM ai_distill.step_attempts WHERE id=$1',[task.id])).rows[0].config;check('prompt snapshot stored',snapshot.extraction.extractionPrompt===loadExtractionConfig().extractionPrompt);
 processorVersion=snapshot.processor;
 console.log(`RUN real ${fullPdf?'complete PDF':'first-page'} OCR and redaction (provider requests)`);
 const originalFetch=globalThis.fetch;
 globalThis.fetch=Object.assign(async(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{
  const body=typeof init?.body==='string'?JSON.parse(init.body):{};
  const content=body.messages?.find((message:any)=>message.role==='user')?.content;
  const providerStep=Array.isArray(content)?'page_ocr':'entity_check';
  const started=Date.now();providerMetrics[providerStep]!.calls++;
  try{const response=await originalFetch(input,init);let entityStats:unknown;if(providerStep==='entity_check'&&response.ok){const data=await response.clone().json()as any;try{const parsed=JSON.parse(data.choices?.[0]?.message?.content?.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));const values=Array.isArray(parsed)?parsed:parsed?.entities;if(Array.isArray(values)){const source=typeof content==='string'?content.split('\n资料：\n').slice(1).join('\n资料：\n'):'';entityStats={count:values.length,items:values.map(value=>typeof value==='string'?{length:value.length,sourceBacked:source.includes(value),masked:value.includes('*'),singleCharKind:value.length===1?(/[\p{Script=Han}]/u.test(value)?'han':/\d/.test(value)?'digit':value==='*'?'mask':'other'):null}:{invalid_type:true})};}}catch{entityStats={invalid_json:true};}}providerMetrics[providerStep]!.elapsed_ms+=Date.now()-started;if(!response.ok)providerMetrics[providerStep]!.failed++;console.log(JSON.stringify({providerStep,status:response.status,elapsedMs:Date.now()-started,call:providerMetrics[providerStep]!.calls,entityStats}));return response;}
  catch(error){providerMetrics[providerStep]!.failed++;providerMetrics[providerStep]!.elapsed_ms+=Date.now()-started;console.log(JSON.stringify({providerStep,timeout:init?.signal?.aborted===true,errorName:error instanceof Error?error.name:'unknown',elapsedMs:Date.now()-started}));throw error;}
 },{preconnect:originalFetch.preconnect});
 const processor:typeof processMaterials=async(...args)=>{try{return await processMaterials(args[0],args[1],args[2],args[3],args[4],async(path,vision,run,checkpoint)=>{try{return await extractPdf(path,vision,run,checkpoint?{...checkpoint,directory:join(verificationCache,checkpoint.source_sha256,checkpoint.config_fingerprint)}:undefined);}catch(error){throw error;}},args[6]);}catch(error){throw error;}};
 try{check('targeted worker claim',await runNextExtraction(testPool,root,processor,preview.id));}
 finally{globalThis.fetch=originalFetch;}
 const processed=await(await request(`/workflows/${preview.id}`)).json()as any;
 extractionSummary={status:processed.steps[1].status,error:processed.steps[1].error,page_count:processed.steps[1].result?.pages?.length??0,expected_pages:expectedPages,issues:(processed.steps[1].result?.issues??[]).map((item:any)=>({page_index:item.page_index,kind:item.kind,phase:item.phase,chunk_index:item.chunk_index,diagnostic:item.diagnostic}))};
 if(processed.steps[1].status!=='succeeded'){
  const step=processed.steps[1];
  const issueKinds=(step.result?.issues??[]).map((item:any)=>({page:item.page_index,kind:item.kind}));
  console.error(JSON.stringify({realPdfExtraction:{status:step.status,error:step.error,pageCount:step.result?.pages?.length??0,issueKinds}},null,2));
 }
 check('extraction completed successfully',processed.steps[1].status==='succeeded');
 check('source page coverage',processed.steps[1].result.pages.length===expectedPages&&processed.steps[1].result.pages.every((page:any,index:number)=>page.page===index+1)&&processed.steps[1].result.pages.some((page:any)=>page.method==='ocr'));
 const completed=await request(`/attempts/${task.id}?wait_ms=1`);const completedTask=await completed.json()as any;check('completed attempt is readable without another execution',completed.status===200&&completedTask.id===task.id&&completedTask.completed===true&&completedTask.status==='succeeded');
 const publicArtifacts=processed.artifacts;check('public artifact list',publicArtifacts.length===2&&publicArtifacts.every((a:any)=>a.kind!=='private_redaction_map'));
 for(const artifact of publicArtifacts){const response=await request(`/artifacts/${artifact.id}/download`);check(`download ${artifact.kind}`,response.status===200);const text=await response.text();if(artifact.kind==='redacted_markdown')check('nonempty masked text without generated headers',text.trim().length>20&&!/【主体\d+】|^## 材料|\[占位\]/m.test(text)&&text.includes('*'));}
 const privateArtifact=(await testPool.query("SELECT id FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='private_redaction_map'",[preview.id])).rows[0];check('private mapping access denied',(await request(`/artifacts/${privateArtifact.id}/download`)).status===404);
 const originalState=(await testPool.query('SELECT count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=2',[preview.id])).rows[0].count;await request(`/workflows/${preview.id}/extract`,{method:'POST'});check('completed extraction not recomputed',(await testPool.query('SELECT count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=2',[preview.id])).rows[0].count===originalState);
 console.log('PASS integration complete');
}catch(error){console.error('Integration check failed:',error instanceof Error&&checks.some(c=>c.name===error.message)?error.message:'runtime failure; credentials and document content omitted');process.exitCode=1;}
finally{
 server?.stop(true);
 try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{console.error('Temporary test schema cleanup failed');process.exitCode=1;}
 await rm(root,{recursive:true,force:true});await pool.end();
 await writeFile(new URL(`../docs/evidence/${fullPdf?'full-pdf-integration-results':'integration-results'}.json`,import.meta.url),JSON.stringify({checked_at:new Date().toISOString(),scope:fullPdf?'real complete PDF':'real PDF first page; full-volume extraction not covered',processor_version:processorVersion,elapsed_ms:Date.now()-startedAt,provider_metrics:providerMetrics,verification_cache:'private .storage/.verification-ocr-cache keyed by source and OCR config; reusable across verification retries',extraction:extractionSummary,checks},null,2));
}
