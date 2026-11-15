/** GLM-OCR 请求、取消、解析及安全日志回归：合成PDF与页数预检替身，HTTP全部注入替身；不调用模型、不连接业务数据库。 */
import {afterAll,beforeAll,expect,spyOn,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyLogError,configureLogger} from '../../logging';
import {runExternalCall} from '../../external-call';
import * as pdfTools from '../pdf';
import {extractGlmOcrImageRegions,GlmOcrPdfExtractor,parseGlmOcrResponse} from './glm-ocr';

let root:string,path:string,pdf:string;
let preflight:ReturnType<typeof spyOn<typeof pdfTools,'command'>>;
const secret='PRIVATE_TEST_TOKEN',env={ZHIPU_API_KEY:secret,ZHIPU_BASE_URL:'https://example.invalid/v4'};
const valid=()=>({model:'glm-ocr',data_info:{num_pages:1},layout_details:[[{content:'正文',label:'text'}]]});
const fetchStub=(fn:()=>Promise<Response>)=>(async (_input:Parameters<typeof fetch>[0],_init?:Parameters<typeof fetch>[1])=>fn()) as typeof fetch;
async function rejected(promise:Promise<unknown>):Promise<unknown>{
 try{await promise;}catch(error){return error;}
 throw new Error('expected rejection');
}

beforeAll(async()=>{
 root=await mkdtemp(join(tmpdir(),'glm-errors-'));path=join(root,'synthetic.pdf');
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>'];
 pdf='%PDF-1.4\n';const offsets:number[]=[];
 for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;}
 const start=Buffer.byteLength(pdf);pdf+='xref\n0 4\n0000000000 65535 f \n'+offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
 pdf+=`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 await writeFile(path,pdf);
 preflight=spyOn(pdfTools,'command').mockImplementation(async args=>{expect(args).toEqual(['pdfinfo',path]);return 'Pages: 1';});
});
afterAll(async()=>{preflight.mockRestore();await rm(root,{recursive:true,force:true});});

for(const [status,kind] of [[400,'provider'],[401,'authentication'],[403,'authentication'],[408,'timeout'],[429,'rate_limit'],[500,'provider'],[503,'provider'],[504,'timeout']] as const){
 test(`HTTP ${status} retains status and classification without retry or private response`,async()=>{
  let calls=0,cancelled=false;
  const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  const extractor=new GlmOcrPdfExtractor(env,fetchStub(async()=>{calls++;return new Response(body,{status});}));
  const error=await rejected(extractor.extract(path));
  expect(classifyLogError(error)).toEqual({error_kind:kind,http_status:status,reason_code:`glm_ocr_http_${status}`});
  expect(calls).toBe(1);expect(cancelled).toBe(true);expect(JSON.stringify(error)).not.toContain(secret);
 });
}

test('HTTP response cleanup failure preserves the primary status',async()=>{
 const body=new ReadableStream<Uint8Array>({cancel(){throw new Error(secret);}});
 const error=await rejected(new GlmOcrPdfExtractor(env,fetchStub(async()=>new Response(body,{status:429}))).extract(path));
 expect(classifyLogError(error)).toMatchObject({error_kind:'rate_limit',http_status:429});
 expect(JSON.stringify(error)).not.toContain(secret);
});

test('network rejection is classified without carrying unsafe message or cause',async()=>{
 const error=await rejected(new GlmOcrPdfExtractor(env,fetchStub(async()=>{throw new TypeError(`fetch failed ${secret}`,{cause:new Error('PRIVATE_URL')});})).extract(path));
 expect(classifyLogError(error)).toEqual({error_kind:'network',reason_code:'glm_ocr_request_failed'});
 expect(error).not.toHaveProperty('cause');expect(String(error)).not.toContain(secret);
});

test('response stream failure is distinct from malformed JSON',async()=>{
 const body=new ReadableStream<Uint8Array>({start(controller){controller.error(new Error(secret));}});
 const error=await rejected(new GlmOcrPdfExtractor(env,fetchStub(async()=>new Response(body))).extract(path));
 expect(classifyLogError(error)).toEqual({error_kind:'network',reason_code:'glm_ocr_response_read_failed',http_status:200});
 const invalid=await rejected(new GlmOcrPdfExtractor(env,fetchStub(async()=>new Response(`not-json ${secret}`))).extract(path));
 expect(classifyLogError(invalid)).toEqual({error_kind:'invalid_response',reason_code:'glm_ocr_invalid_json',http_status:200});
 expect(String(invalid)).not.toContain(secret);
});

test('timeout during request or response reading is never invalid JSON',async()=>{
 for(const phase of ['request','body']){
  const error=await rejected(new GlmOcrPdfExtractor(env,fetchStub(async()=>{
   if(phase==='request')throw new DOMException(secret,'TimeoutError');
   return new Response(new ReadableStream({start(controller){controller.error(new DOMException(secret,'TimeoutError'));}}));
  })).extract(path));
  expect(classifyLogError(error)).toMatchObject({error_kind:'timeout',reason_code:'glm_ocr_timeout'});
 }
});

test('actual deadline signal remains a timeout even when body reader throws AbortError',async()=>{
 const deadline=new AbortController(),timeout=spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal);
 try{
  const error=await rejected(new GlmOcrPdfExtractor(env,fetchStub(async()=>{
   const response=Response.json(valid());
   response.json=async()=>{deadline.abort(new DOMException('deadline','TimeoutError'));throw new DOMException(secret,'AbortError');};
   return response;
  })).extract(path));
  expect(timeout).toHaveBeenCalledWith(30*60*1000);
  expect(classifyLogError(error)).toMatchObject({error_kind:'timeout',reason_code:'glm_ocr_timeout'});
 }finally{timeout.mockRestore();}
});

test('pre-cancelled tasks do not even read a file or submit a request',async()=>{
 const controller=new AbortController(),reason=Object.assign(new Error('stop'),{reason_code:'user_cancelled'});controller.abort(reason);
 let calls=0;const extractor=new GlmOcrPdfExtractor(env,fetchStub(async()=>{calls++;return Response.json(valid());}));
 expect(await rejected(extractor.extract('nonexistent.pdf',controller.signal))).toBe(reason);expect(calls).toBe(0);
});

test('outer cancellation during request and body reading preserves exact task reason',async()=>{
 for(const phase of ['request','body']){
  const controller=new AbortController(),reason=Object.assign(new Error('stop'),{reason_code:'worker_shutdown'});
  const extractor=new GlmOcrPdfExtractor(env,fetchStub(async()=>{
   if(phase==='request'){controller.abort(reason);throw new DOMException(secret,'AbortError');}
   const response=Response.json(valid());
   response.json=async()=>{controller.abort(reason);throw new DOMException(secret,'AbortError');};return response;
  }));
  expect(await rejected(extractor.extract(path,controller.signal))).toBe(reason);
 }
});

test('configuration failures are safe and occur before HTTP submission',async()=>{
 for(const [settings,code] of [[{},'glm_ocr_missing_key'],[{...env,ZHIPU_BASE_URL:`invalid-${secret}`},'glm_ocr_invalid_endpoint']] as const){
  let calls=0;
  const error=await rejected(new GlmOcrPdfExtractor(settings,fetchStub(async()=>{calls++;return Response.json(valid());})).extract(path));
  expect(classifyLogError(error)).toEqual({error_kind:'configuration',reason_code:code});expect(calls).toBe(0);expect(String(error)).not.toContain(secret);
 }
});

test('invalid provider structures retain distinct fixed reason codes',()=>{
 const cases:[unknown,string][]=[
  [{model:secret},'glm_ocr_invalid_structure'],
  [{...valid(),data_info:{num_pages:2}},'glm_ocr_page_mismatch'],
  [{...valid(),layout_details:[]},'glm_ocr_page_mismatch'],
  [{...valid(),layout_details:[{}]},'glm_ocr_invalid_layout'],
  [{...valid(),layout_details:[[null]]},'glm_ocr_invalid_block'],
  [{...valid(),layout_details:[[{content:{private:secret}}]]},'glm_ocr_invalid_content'],
 ];
 for(const [value,code] of cases){
  let error:unknown;try{parseGlmOcrResponse(value,1);}catch(caught){error=caught;}
  expect(classifyLogError(error)).toEqual({error_kind:'invalid_response',reason_code:code});expect(String(error)).not.toContain(secret);
 }
});

test('successful extraction preserves SHA, all text, structure and request contract',async()=>{
 let calls=0;
 const payload={...valid(),layout_details:[[{native_label:'doc_title',content:'标题'},{label:'table',content:'<table><tr><td>A</td><td>B</td></tr></table>'},{content:'段落'}]]};
 const fetcher=(async(input:URL|RequestInfo,init?:RequestInit)=>{
  calls++;expect(String(input)).toBe('https://example.invalid/v4/layout_parsing');
  expect(init?.method).toBe('POST');const request=JSON.parse(String(init?.body));
  expect(request.model).toBe('glm-ocr');expect(request.file).toBe(`data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`);
  expect(request.return_crop_images).toBeUndefined();expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);
  return Response.json(payload);
 }) as typeof fetch;
 const result=await new GlmOcrPdfExtractor(env,fetcher).extract(path);
 expect(result.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));expect(result.provider).toBe('glm-ocr');expect(calls).toBe(1);
 expect(result.pages[0]?.structure?.map(block=>block.kind)).toEqual(['heading','table','paragraph']);
 for(const text of ['标题','A','B','段落'])expect(result.pages[0]?.text).toContain(text);
 expect(parseGlmOcrResponse({...valid(),layout_details:[[]]},1)[0]?.issues).toEqual(['empty_page']);
});

test('crop layout requests share HTTP diagnostics and retain the crop flag',async()=>{
 let calls=0;
 const fetcher=(async(_input:URL|RequestInfo,init?:RequestInit)=>{calls++;expect(JSON.parse(String(init?.body)).return_crop_images).toBe(true);return new Response(secret,{status:503});}) as typeof fetch;
 const error=await rejected(extractGlmOcrImageRegions(path,undefined,env,fetcher));
 expect(classifyLogError(error)).toMatchObject({error_kind:'provider',http_status:503,reason_code:'glm_ocr_http_503'});expect(calls).toBe(1);
});

test('real external-call logger persists the HTTP diagnosis under job/file IDs without secrets',async()=>{
 const logRoot=join(root,'log-check'),logger=configureLogger({root:logRoot,service:'worker'});
 try{
  const extractor=new GlmOcrPdfExtractor(env,fetchStub(async()=>new Response(`PRIVATE_BODY ${secret}`,{status:429})));
  await rejected(runExternalCall({library_job_id:'job-test',library_file_id:'file-test',operation:'library_document_extract'},async()=>extractor.extract(path)));
  await logger.flush();
  const directory=join(logRoot,'logs',new Date().toISOString().slice(0,10));
  const text=(await Promise.all((await readdir(directory)).map((file:string)=>readFile(join(directory,file),'utf8')))).join('');
  const records:Record<string,unknown>[]=text.trim().split('\n').map((line:string)=>JSON.parse(line));
  expect(records.find(record=>record.event==='call.failed')).toMatchObject({library_job_id:'job-test',library_file_id:'file-test',error_kind:'rate_limit',http_status:429,reason_code:'glm_ocr_http_429'});
  for(const privateValue of [secret,'PRIVATE_BODY','example.invalid',path,Buffer.from(pdf).toString('base64')])expect(text).not.toContain(privateValue);
 }finally{await logger.close();}
});
