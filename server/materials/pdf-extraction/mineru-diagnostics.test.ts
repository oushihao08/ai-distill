/** 验证MinerU失败阶段、私有批次记录及成功后清理失败的隔离；只用临时文件、合成ZIP和HTTP/文件操作替身，不访问数据库或真实供应商。 */
import {expect,test,spyOn} from 'bun:test';
import * as fs from 'node:fs/promises';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureLogger} from '../../logging';
import {MineruApiDocxExtractor,MineruApiFirstPdfExtractor,MineruApiImageExtractor} from './mineru-api';

test('terminal provider failure creates one fresh upload while pending stays on its batch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mineru-reupload-')),path=join(root,'input.docx');
 const uploads:string[]=[],polls:string[]=[];
 try{
  await writeFile(path,'synthetic docx');
  const contentPath=join(root,'content_list.json'),zipPath=join(root,'result.zip');
  await writeFile(contentPath,JSON.stringify([{type:'text',text:'重传后的正文'}]));
  expect(await Bun.spawn(['zip','-qj',zipPath,contentPath],{stdout:'ignore',stderr:'ignore'}).exited).toBe(0);
  const zip=await readFile(zipPath);
  const fetcher=(async(input:unknown,options:any)=>{
   const url=String(input);
   if(options?.method==='POST')return Response.json({code:0,data:{batch_id:`batch-${uploads.length+1}`,file_urls:[`https://upload.example/${uploads.length+1}`]}});
   if(options?.method==='PUT'){uploads.push(url);return new Response(null,{status:200});}
   if(url.includes('/extract-results/batch/')){
    polls.push(url);
    const state=url.endsWith('batch-1')?(polls.length===1?'pending':'failed'):'done';
    return Response.json({code:0,data:{extract_result:[{file_name:'input.docx',state,...(state==='done'?{full_zip_url:'https://download.example/result.zip'}:{})}]}});
   }
   return new Response(zip);
  }) as typeof fetch;
  const result=await new MineruApiDocxExtractor({MINERU_KEY:'synthetic',STORAGE_DIR:root},{fetcher,sleep:async()=>{}}).extract(path);
  expect(result.pages[0]?.text).toBe('重传后的正文');
  expect(uploads).toEqual(['https://upload.example/1','https://upload.example/2']);
  expect(polls.map(url=>url.split('/').at(-1))).toEqual(['batch-1','batch-1','batch-2']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('retains private batch identity and durable failure phase without logging unchanged polls or secrets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mineru-diagnostics-')),path=join(root,'input.docx');
 const logger=configureLogger({root,service:'worker'});let polls=0;
 const uploadUrl='https://upload.example/file?signature=PRIVATE_SIGNATURE';
 const fetcher=(async(input:unknown,options:any)=>{
  const url=String(input);
  if(options?.method==='POST')return Response.json({code:0,data:{batch_id:'private-batch-id',file_urls:[uploadUrl]}});
  if(options?.method==='PUT')return new Response(null,{status:200});
  polls++;return Response.json({code:0,data:{extract_result:[{file_name:'input.docx',state:polls<3?'pending':'failed',err_msg:'PRIVATE_PROVIDER_BODY'}]}});
 }) as typeof fetch;
 try{
  await writeFile(path,'PRIVATE_SOURCE_BODY');
  await expect(new MineruApiDocxExtractor({MINERU_KEY:'PRIVATE_TOKEN',STORAGE_DIR:root},{fetcher,sleep:async()=>{}}).extract(path)).rejects.toThrow('解析任务失败');
  const directories=await readdir(join(root,'.mineru-diagnostics'));
  expect(directories).toHaveLength(1);
  const metadata=JSON.parse(await readFile(join(root,'.mineru-diagnostics',directories[0]!,'metadata.json'),'utf8'));
  expect(metadata).toMatchObject({batch_id:'private-batch-id',phase:'poll_result',provider_state:'failed',input_format:'docx'});
  await logger.flush();
  const logRoot=join(root,'logs',new Date().toISOString().slice(0,10));
  const records=(await Promise.all((await readdir(logRoot)).map(file=>readFile(join(logRoot,file),'utf8')))).join('').trim().split('\n').map(line=>JSON.parse(line));
  expect(records.filter(row=>row.event==='extraction.api.phase'&&row.state==='pending')).toHaveLength(1);
  expect(records.find(row=>row.event==='extraction.api.failed')).toMatchObject({failure_phase:'poll_result',state:'failed',reason_code:'task_failed',diagnostic_id:directories[0]});
  const content=JSON.stringify(records);
  expect(content).not.toContain('PRIVATE');expect(content).not.toContain('private-batch-id');expect(JSON.stringify(metadata)).not.toContain('PRIVATE');
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('successful extraction survives diagnostic cleanup failure without another provider request',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mineru-cleanup-')),path=join(root,'input.docx');
 let cleanup:ReturnType<typeof spyOn>|undefined,calls=0;
 try{
  await writeFile(path,'synthetic docx');
  const contentPath=join(root,'content_list.json'),zipPath=join(root,'result.zip');
  await writeFile(contentPath,JSON.stringify([{type:'text',text:'合成正文'}]));
  expect(await Bun.spawn(['zip','-qj',zipPath,contentPath],{stdout:'ignore',stderr:'ignore'}).exited).toBe(0);
  const zip=await readFile(zipPath),originalRm=fs.rm;
  cleanup=spyOn(fs,'rm').mockImplementation(async(path,options)=>{
   if(String(path).includes('.mineru-diagnostics'))throw Object.assign(new Error('synthetic cleanup failure'),{code:'EACCES'});
   return originalRm(path,options);
  });
  const fetcher=(async(_input:unknown,options:any)=>{
   calls++;
   if(options?.method==='POST')return Response.json({code:0,data:{batch_id:'synthetic',file_urls:['https://upload.example/file']}});
   if(options?.method==='PUT')return new Response(null,{status:200});
   if(calls===3)return Response.json({code:0,data:{extract_result:[{file_name:'input.docx',state:'done',full_zip_url:'https://download.example/result.zip'}]}});
   return new Response(zip);
  }) as typeof fetch;
  const result=await new MineruApiDocxExtractor({MINERU_KEY:'synthetic',STORAGE_DIR:root},{fetcher}).extract(path);
  expect(result.pages[0]?.text).toBe('合成正文');
  expect(calls).toBe(4);
  expect(await readdir(join(root,'.mineru-diagnostics'))).toHaveLength(1);
 }finally{cleanup?.mockRestore();await rm(root,{recursive:true,force:true});}
});

test('download failures distinguish request transport errors from missing result bodies without logging messages or signed URLs',async()=>{
 for(const scenario of ['request','http','body'] as const){
  const root=await mkdtemp(join(tmpdir(),`mineru-download-${scenario}-`)),path=join(root,'input.docx'),logger=configureLogger({root,service:'worker'});
  let calls=0;
  const fetcher=(async(_input:unknown,options:any)=>{
   calls++;
   if(options?.method==='POST')return Response.json({code:0,data:{batch_id:'private-batch',file_urls:['https://upload.example/file?signature=PRIVATE']} });
   if(options?.method==='PUT')return new Response(null,{status:200});
   if(calls===3)return Response.json({code:0,data:{extract_result:[{file_name:'input.docx',state:'done',full_zip_url:'https://private.example/result?signature=PRIVATE'}]}});
   if(scenario==='request')throw Object.assign(new TypeError('PRIVATE transport message'),{cause:Object.assign(new Error('PRIVATE cause'),{code:'ECONNRESET'})});
   if(scenario==='http')return new Response('PRIVATE response body',{status:502});
   return new Response(null,{status:200});
  }) as typeof fetch;
  try{
   await writeFile(path,'synthetic source');
   await expect(new MineruApiDocxExtractor({MINERU_KEY:'PRIVATE_TOKEN',STORAGE_DIR:root},{fetcher}).extract(path)).rejects.toBeTruthy();
   await logger.flush();
   const logRoot=join(root,'logs',new Date().toISOString().slice(0,10));
   const records=(await Promise.all((await readdir(logRoot)).map(file=>readFile(join(logRoot,file),'utf8')))).join('').trim().split('\n').map(line=>JSON.parse(line));
   const failure=records.find(row=>row.event==='extraction.api.failed');
   expect(failure).toMatchObject({failure_phase:'download_result',state:'done'});
   if(scenario==='request')expect(failure).toMatchObject({reason_code:'download_request_failed',failure_stage:'download_request',network_error_code:'ECONNRESET'});
   else if(scenario==='http')expect(failure).toMatchObject({reason_code:'download_http_error',failure_stage:'download_http_response',response_status:502});
   else expect(failure).toMatchObject({reason_code:'download_body_missing',failure_stage:'response_body'});
   const output=JSON.stringify(records);
   for(const secret of ['PRIVATE','PRIVATE_TOKEN','PRIVATE transport message','PRIVATE cause','private-batch','private.example'])expect(output).not.toContain(secret);
  }finally{await logger.close();await rm(root,{recursive:true,force:true});}
 }
});

test('a timed-out submitted MinerU task preserves the pending phase and is not retried by CLI',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mineru-submitted-timeout-')),path=join(root,'input.docx'),logger=configureLogger({root,service:'worker'});
 let now=0,polls=0,cliCalls=0;
 const fetcher=(async(_input:unknown,options:any)=>{
  if(options?.method==='POST')return Response.json({code:0,data:{batch_id:'synthetic-batch',file_urls:['https://upload.example/file']}});
  if(options?.method==='PUT')return new Response(null,{status:200});
  polls++;return Response.json({code:0,data:{extract_result:[{file_name:'input.docx',state:'pending'}]}});
 }) as typeof fetch;
 try{
  await writeFile(path,'synthetic source');
  const api=new MineruApiDocxExtractor({MINERU_KEY:'synthetic',STORAGE_DIR:root},{fetcher,now:()=>now,sleep:async ms=>{now+=ms;}});
  const extractor=new MineruApiFirstPdfExtractor(api,{id:'mineru-cli',extract:async()=>{cliCalls++;return{pages:[],sha256:'cli',provider:'mineru-cli'};}});
  await expect(extractor.extract(path)).rejects.toMatchObject({reason_code:'provider_timeout',failure_phase:'poll_result',provider_state:'pending',provider_task_submitted:true});
  expect(now).toBe(30*60*1000);expect(polls).toBeGreaterThan(0);expect(cliCalls).toBe(0);
  await logger.flush();
  const logRoot=join(root,'logs',new Date().toISOString().slice(0,10));
  const records=(await Promise.all((await readdir(logRoot)).map(file=>readFile(join(logRoot,file),'utf8')))).join('').trim().split('\n').map(line=>JSON.parse(line));
  expect(records.find(row=>row.event==='extraction.api.failed')).toMatchObject({failure_phase:'poll_result',state:'pending',reason_code:'provider_timeout',page_count:1,attempt_count:600,timeout_ms:30*60*1000,provider_task_submitted:true,local_aborted:false,parent_aborted:false});
  expect(records.find(row=>row.event==='extraction.cli.fallback.skipped')).toMatchObject({reason_code:'provider_task_submitted_timeout',failure_phase:'poll_result',state:'pending'});
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});

test('transient 429 on upload URL request and network disconnect on PUT upload recover via bounded retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mineru-transfer-retry-')),path=join(root,'input.docx');
 let postCalls=0,putCalls=0;
 try{
  await writeFile(path,'synthetic docx');
  const contentPath=join(root,'content_list.json'),zipPath=join(root,'result.zip');
  await writeFile(contentPath,JSON.stringify([{type:'text',text:'限流恢复后的正文'}]));
  expect(await Bun.spawn(['zip','-qj',zipPath,contentPath],{stdout:'ignore',stderr:'ignore'}).exited).toBe(0);
  const zip=await readFile(zipPath);
  const fetcher=(async(input:unknown,options:any)=>{
   const url=String(input);
   if(options?.method==='POST'){
    postCalls++;
    if(postCalls===1)return new Response('rate limited',{status:429,headers:{'Retry-After':'1'}});
    return Response.json({code:0,data:{batch_id:'batch-ok',file_urls:['https://upload.example/put']}});
   }
   if(options?.method==='PUT'){
    putCalls++;
    if(putCalls===1)throw new TypeError('transient socket reset');
    return new Response(null,{status:200});
   }
   if(url.includes('/extract-results/batch/'))return Response.json({code:0,data:{extract_result:[{file_name:'input.docx',state:'done',full_zip_url:'https://download.example/result.zip'}]}});
   return new Response(zip);
  }) as typeof fetch;
  const result=await new MineruApiDocxExtractor({MINERU_KEY:'synthetic',STORAGE_DIR:root},{fetcher,sleep:async()=>{}}).extract(path);
  expect(result.pages[0]?.text).toBe('限流恢复后的正文');
  expect(postCalls).toBe(2);expect(putCalls).toBe(2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('DOCX with decorative empty embedded image keeps sibling OCR text, and standalone textless image returns empty_page',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mineru-empty-image-')),docxPath=join(root,'case.docx'),imgPath=join(root,'photo.png');
 try{
  await writeFile(docxPath,'synthetic docx');
  await writeFile(imgPath,new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const zipWork=join(root,'docx-zip');await fs.mkdir(join(zipWork,'images'),{recursive:true});
  await writeFile(join(zipWork,'content_list.json'),JSON.stringify([
   {type:'paragraph',text:'   '},
   {type:'image',img_path:'images/logo.png'},
   {type:'image',img_path:'images/contract.jpg'},
  ]));
  await writeFile(join(zipWork,'images','logo.png'),new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]));
  await writeFile(join(zipWork,'images','contract.jpg'),new Uint8Array([0xff,0xd8,0xff,0xd9]));
  const docxZipPath=join(root,'docx-result.zip');
  expect(await Bun.spawn(['zip','-qr',docxZipPath,'content_list.json','images'],{cwd:zipWork,stdout:'ignore',stderr:'ignore'}).exited).toBe(0);
  const emptyZipWork=join(root,'empty-zip');await fs.mkdir(emptyZipWork,{recursive:true});
  await writeFile(join(emptyZipWork,'content_list.json'),JSON.stringify([{type:'image',img_path:'images/none.png'}]));
  const emptyZipPath=join(root,'empty.zip');
  expect(await Bun.spawn(['zip','-qj',emptyZipPath,join(emptyZipWork,'content_list.json')],{stdout:'ignore',stderr:'ignore'}).exited).toBe(0);
  const textZipWork=join(root,'text-zip');await fs.mkdir(textZipWork,{recursive:true});
  await writeFile(join(textZipWork,'content_list.json'),JSON.stringify([{type:'paragraph',text:'合同扫描件正文100万元'}]));
  const textZipPath=join(root,'text.zip');
  expect(await Bun.spawn(['zip','-qj',textZipPath,join(textZipWork,'content_list.json')],{stdout:'ignore',stderr:'ignore'}).exited).toBe(0);

  const [docxZip,emptyZip,textZip]=await Promise.all([readFile(docxZipPath),readFile(emptyZipPath),readFile(textZipPath)]);
  const batches=new Map<string,{name:string;zip:Uint8Array}>();
  let seq=0;
  const fetcher=(async(input:unknown,options:any)=>{
   const url=String(input);
   if(options?.method==='POST'){
    const body=JSON.parse(String(options.body));
    const name=String(body.files[0].name);
    const batch=`b-${++seq}`;
    batches.set(batch,{name,zip:name==='case.docx'?docxZip:name.endsWith('.jpg')?textZip:emptyZip});
    return Response.json({code:0,data:{batch_id:batch,file_urls:[`https://upload.example/${batch}`]}});
   }
   if(options?.method==='PUT')return new Response(null,{status:200});
   if(url.includes('/extract-results/batch/')){
    const batch=url.split('/').at(-1)!;
    const item=batches.get(batch)!;
    return Response.json({code:0,data:{extract_result:[{file_name:item.name,state:'done',full_zip_url:`https://download.example/${batch}.zip`}]}});
   }
   const batch=url.split('/').at(-1)!.replace(/\.zip$/,'');
   return new Response(batches.get(batch)!.zip);
  }) as typeof fetch;

  const docxResult=await new MineruApiDocxExtractor({MINERU_KEY:'synthetic',STORAGE_DIR:root},{fetcher,sleep:async()=>{}}).extract(docxPath);
  expect(docxResult.pages).toHaveLength(1);
  expect(docxResult.pages[0]?.text).toBe('合同扫描件正文100万元');
  expect(docxResult.pages[0]?.issues).toBeUndefined();

  const photoResult=await new MineruApiImageExtractor({MINERU_KEY:'synthetic',STORAGE_DIR:root},{fetcher,sleep:async()=>{}}).extract(imgPath);
  expect(photoResult.pages).toEqual([{page:1,text:'',structure:[],method:'ocr',model:'mineru-vlm',issues:['empty_page']}]);
 }finally{await rm(root,{recursive:true,force:true});}
});
