/** 验证MinerU失败阶段、云端排队状态和私有批次定位记录；只用临时文件及HTTP替身，不访问数据库或真实供应商。 */
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureLogger} from '../../logging';
import {MineruApiDocxExtractor} from './mineru-api';

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
