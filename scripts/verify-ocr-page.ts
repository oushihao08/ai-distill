/** 文件职责：渲染指定真实 PDF 页并调用智谱识别及实体检查，记录安全摘要，不保存原文。
 * 执行入口与用途：`bun scripts/verify-ocr-page.ts`；从指定 PDF 渲染一页并调用智谱 OCR／实体检查，输出计数摘要，不保存识别原文。
 */
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {command} from '../server/materials/pdf';
import {createVisionClient} from '../server/materials/vision';
const page=Number(process.env.VERIFY_PAGE??53),root=await mkdtemp(join(tmpdir(),'distill-page-probe-'));
const checks:unknown[]=[];let phase='ocr';
try{
 await command(['pdftoppm','-f',String(page),'-l',String(page),'-singlefile','-scale-to','1600','-png','/Users/jack/Downloads/568-房屋买卖案-一手资料包 2/(2018)渝0104民初568号.pdf',join(root,'page')]);
 const request:typeof fetch=Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  try{const response=await fetch(input,init);if(phase==='entities'&&response.ok){const body=JSON.parse(init!.body as string);const source=body.messages.find((m:any)=>m.role==='user').content.split('\n资料：\n').slice(1).join('\n资料：\n');const data=await response.clone().json()as any;try{const values=JSON.parse(data.choices[0].message.content).entities;checks.push({phase,http:response.status,entities:Array.isArray(values)?values.length:null,invalid_values:Array.isArray(values)?values.filter((v:any)=>typeof v!=='string'||!source.includes(v)).map((v:any)=>({type:typeof v,length:typeof v==='string'?v.length:null,whitespace_match:typeof v==='string'&&source.replace(/\s/g,'').includes(v.replace(/\s/g,'')),masked:typeof v==='string'&&v.includes('*')})):null});}catch{checks.push({phase,invalid_json:true});}}return response;}catch(error){throw error;}
 },{preconnect:fetch.preconnect});
 const vision=createVisionClient(process.env,request);const started=Date.now();const result=await vision.recognize(await readFile(join(root,'page.png')));checks.push({phase,chars:result.text.length,elapsed_ms:Date.now()-started});phase='entities';const values=await vision.entities(result.text);checks.push({phase,passed:true,count:values.length});
}catch(error){checks.push({phase,passed:false,error:error instanceof Error?error.message:'验证失败'});process.exitCode=1;}
finally{await rm(root,{recursive:true,force:true});const evidence={checked_at:new Date().toISOString(),page,checks,raw_content_saved:false};console.log(JSON.stringify(evidence));await writeFile(new URL('../docs/evidence/ocr-page-probe.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');}
