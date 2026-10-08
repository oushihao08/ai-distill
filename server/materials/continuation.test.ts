import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createVisionClient} from './vision';
import {loadExtractionConfig} from './config';
import {extractPdf} from './pdf';
import {processMaterials} from './process';
test('configured output budget accepts partial response with explicit issue',async()=>{
 let body:any;const config={...loadExtractionConfig(),ocrReasoningEffort:'max' as const};const client=createVisionClient({ZHIPU_API_KEY:'fixture'},async(_url,init)=>{body=JSON.parse(init!.body as string);return Response.json({choices:[{finish_reason:'length',message:{content:'partial'}}]});},config);
 const result=await client.recognize(new Uint8Array());expect(body.max_tokens).toBe(131072);expect(body.reasoning_effort).toBe('max');expect(result.text).toBe('partial');expect(result.issues).toEqual(['truncated_response']);
});
test('single page error does not stop later pages or pretend missing text exists',async()=>{
 let calls=0;
 const pages=await extractPdf('fixture',{continueOnError:true,entities:async()=>[],recognize:async(image)=>{calls++;if(Buffer.from(image).toString()==='1')throw new Error('识别服务返回 HTTP 500');return{text:'next page',usage:null,model:'fixture'};}},async(args)=>{
 if(args[0]==='pdfinfo')return 'Pages: 2';if(args[0]==='pdfimages')return '1 0 image\n2 0 image';if(args[0]==='pdftotext')return '';const page=args.at(-1)!.match(/page-(\d+)$/)![1];await writeFile(`${args.at(-1)}.png`,page);return '';
 });expect(calls).toBe(4);expect(pages[0]!.text).toBe('');expect(pages[0]!.issues).toEqual(['http_500']);expect(pages[1]!.text).toBe('next page');
});
test('OCR-only processing generates MD without extra entity calls and retains issues',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ocr-continue-'));
 try{const source='%PDF-fixture';await writeFile(join(root,'source.pdf'),source);
 const result=await processMaterials(root,'workflow','attempt',[{id:'material',storage_path:'source.pdf',sha256:createHash('sha256').update(source).digest('hex')}],{recognize:async()=>{throw new Error('unused');},entities:async()=>{throw new Error('must not call');}},async()=>[{page:1,text:'partial text',method:'ocr',issues:['truncated_response']},{page:2,text:'next page',method:'ocr'}],loadExtractionConfig());
 expect(result.blocked).toBe(false);expect(result.result.issues).toEqual([{page_index:0,kind:'truncated_response'}]);const md=result.artifacts.find(a=>a.kind==='redacted_markdown')!;expect(await readFile(join(root,md.storage_path),'utf8')).toBe('partial text\n\nnext page');
 }finally{await rm(root,{recursive:true,force:true});}
});
