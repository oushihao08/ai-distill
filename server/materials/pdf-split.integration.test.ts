/**
 * 职责：用真实 qpdf/pdfinfo 回归带警告PDF的连续分片，验证状态3不会掩盖可校验产物。
 * 入口：`bun test server/materials/pdf-split.integration.test.ts`；只在临时存储生成分片。
 * 边界：依赖项目运行所需的 qpdf 与 pdfinfo，不修改来源PDF，不连接数据库。
 */
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('qpdf警告状态仍以页数、大小和来源摘要验证分片',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdf-split-warning-'));
 const script=`
  import {readFile} from 'node:fs/promises';
  import {createHash} from 'node:crypto';
  const path='tmp/pdfs/pdf-redaction-20/first-20.pdf';
  const before=await readFile(path),sha=createHash('sha256').update(before).digest('hex');
  const {splitLargePdf}=await import('./server/materials/pdf-split.ts');
  const parts=await splitLargePdf(path,before),checks=[];
  for(const part of parts){
   const bytes=await readFile(part.path),proc=Bun.spawn(['pdfinfo',part.path],{stdout:'pipe',stderr:'pipe'});
   const info=await new Response(proc.stdout).text();await proc.exited;
   checks.push({name:part.name,size:bytes.length,pages:Number(info.match(/^Pages:\\s+(\\d+)$/m)?.[1])});
  }
  const after=await readFile(path);
  console.log(JSON.stringify({source_sha_unchanged:sha===createHash('sha256').update(after).digest('hex'),checks}));
 `;
 try{
  const child=Bun.spawn(['bun','-e',script],{cwd:process.cwd(),env:{...process.env,PDF_MAX_SIZE_MB:'1',STORAGE_DIR:join(root,'storage')},stdout:'pipe',stderr:'pipe'});
  const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text(),code=await child.exited;
  expect(code,stderr).toBe(0);
  const result=JSON.parse(stdout.trim());
  expect(result.source_sha_unchanged).toBe(true);
  expect(result.checks.map((part:any)=>part.pages).reduce((a:number,b:number)=>a+b,0)).toBe(20);
  expect(result.checks.length).toBeGreaterThan(1);
  expect(result.checks.every((part:any)=>part.size<=1024*1024&&/页\d{4}-\d{4}\.pdf$/.test(part.name))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
