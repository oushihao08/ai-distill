/** 测试远程材料 CLI 的令牌请求、断线幂等键和本机文件核对；仅用注入 HTTP 响应与临时目录。 */
import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runRemoteMaterialCommand} from './remote-materials';
import {CliError} from './client';

const workflow='12345678-1234-4234-8234-123456789abc';
const operation='22345678-1234-4234-8234-123456789abc';
const request='32345678-1234-4234-8234-123456789abc';
const material='42345678-1234-4234-8234-123456789abc';

test('CLI 只向指定本机隧道发送令牌和幂等键',async()=>{
 const oldFetch=globalThis.fetch,oldUrl=process.env.REMOTE_MATERIAL_API_URL,oldToken=process.env.REMOTE_MATERIAL_TOKEN;
 process.env.REMOTE_MATERIAL_API_URL='http://127.0.0.1:37900';process.env.REMOTE_MATERIAL_TOKEN='t'.repeat(32);
 let calls=0;
 globalThis.fetch=(async(input,init)=>{
  calls++;
  expect(String(input)).toBe('http://127.0.0.1:37900/api/remote-material-operations');
  expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${'t'.repeat(32)}`);
  expect(JSON.parse(String(init?.body))).toEqual({workflow_id:workflow,mode:'intake-redact',request_key:request});
  return Response.json({id:operation,workflow_id:workflow,mode:'intake-redact',status:'waiting',stage:'intake'},{status:202});
 }) as typeof fetch;
 try{
  const result=await runRemoteMaterialCommand(['remote','material','start','--workflow',workflow,'--mode','intake-redact','--request-key',request]);
  expect(result.data.id).toBe(operation);expect(calls).toBe(1);
 }finally{globalThis.fetch=oldFetch;oldUrl===undefined?delete process.env.REMOTE_MATERIAL_API_URL:process.env.REMOTE_MATERIAL_API_URL=oldUrl;oldToken===undefined?delete process.env.REMOTE_MATERIAL_TOKEN:process.env.REMOTE_MATERIAL_TOKEN=oldToken;}
});

test('CLI 可按原请求标识找回响应丢失的操作',async()=>{
 const oldFetch=globalThis.fetch,oldUrl=process.env.REMOTE_MATERIAL_API_URL,oldToken=process.env.REMOTE_MATERIAL_TOKEN;
 process.env.REMOTE_MATERIAL_API_URL='http://127.0.0.1:37900';process.env.REMOTE_MATERIAL_TOKEN='t'.repeat(32);
 let requested='';
 globalThis.fetch=(async input=>{
  requested=String(input);
  return Response.json({id:operation,workflow_id:workflow,mode:'intake-redact',status:'running',stage:'redact'});
 }) as typeof fetch;
 try{
  const result=await runRemoteMaterialCommand(['remote','material','status','--workflow',workflow,'--request-key',request]);
  expect(requested).toBe(`http://127.0.0.1:37900/api/remote-material-operations/by-request?workflow_id=${workflow}&request_key=${request}`);
  expect(result.outcome).toBe('waiting');expect(result.data.id).toBe(operation);
 }finally{globalThis.fetch=oldFetch;oldUrl===undefined?delete process.env.REMOTE_MATERIAL_API_URL:process.env.REMOTE_MATERIAL_API_URL=oldUrl;oldToken===undefined?delete process.env.REMOTE_MATERIAL_TOKEN:process.env.REMOTE_MATERIAL_TOKEN=oldToken;}
});

test('CLI 下载后核对哈希并写入本机管理目录',async()=>{
 const oldFetch=globalThis.fetch,oldUrl=process.env.REMOTE_MATERIAL_API_URL,oldToken=process.env.REMOTE_MATERIAL_TOKEN,oldStorage=process.env.STORAGE_DIR;
 const root=await mkdtemp(join(tmpdir(),'remote-material-cli-'));
 process.env.REMOTE_MATERIAL_API_URL='http://localhost:37900';process.env.REMOTE_MATERIAL_TOKEN='t'.repeat(32);process.env.STORAGE_DIR=root;
 const bytes=new TextEncoder().encode('redacted source');const sha=createHash('sha256').update(bytes).digest('hex');
 globalThis.fetch=(async input=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/files'))return Response.json({operation_id:operation,workflow_id:workflow,source_digest:'digest',materials:[{id:material,storage_path:'question/input.txt',sha256:sha,size_bytes:bytes.length}],artifacts:[]});
  if(path.endsWith('/download'))return new Response(bytes);
  return Response.json({id:operation,workflow_id:workflow,mode:'intake-redact',status:'succeeded',stage:'complete'});
 }) as typeof fetch;
 try{
  const result=await runRemoteMaterialCommand(['remote','material','sync','--operation',operation]);
  expect(result.ready_for_local_authoring).toBe(true);
  expect(await readFile(join(root,'question/input.txt'),'utf8')).toBe('redacted source');
 }finally{globalThis.fetch=oldFetch;oldUrl===undefined?delete process.env.REMOTE_MATERIAL_API_URL:process.env.REMOTE_MATERIAL_API_URL=oldUrl;oldToken===undefined?delete process.env.REMOTE_MATERIAL_TOKEN:process.env.REMOTE_MATERIAL_TOKEN=oldToken;oldStorage===undefined?delete process.env.STORAGE_DIR:process.env.STORAGE_DIR=oldStorage;await rm(root,{recursive:true,force:true});}
});

test('CLI 拒绝越界的服务端文件路径',async()=>{
 const oldFetch=globalThis.fetch,oldUrl=process.env.REMOTE_MATERIAL_API_URL,oldToken=process.env.REMOTE_MATERIAL_TOKEN,oldStorage=process.env.STORAGE_DIR;
 const root=await mkdtemp(join(tmpdir(),'remote-material-cli-'));
 process.env.REMOTE_MATERIAL_API_URL='http://localhost:37900';process.env.REMOTE_MATERIAL_TOKEN='t'.repeat(32);process.env.STORAGE_DIR=root;
 globalThis.fetch=(async input=>new URL(String(input)).pathname.endsWith('/files')
  ?Response.json({operation_id:operation,workflow_id:workflow,materials:[{id:material,storage_path:'../outside',sha256:'0'.repeat(64)}],artifacts:[]})
  :Response.json({id:operation,workflow_id:workflow,mode:'intake',status:'succeeded'})) as typeof fetch;
 try{await expect(runRemoteMaterialCommand(['remote','material','sync','--operation',operation])).rejects.toBeInstanceOf(CliError);}
 finally{globalThis.fetch=oldFetch;oldUrl===undefined?delete process.env.REMOTE_MATERIAL_API_URL:process.env.REMOTE_MATERIAL_API_URL=oldUrl;oldToken===undefined?delete process.env.REMOTE_MATERIAL_TOKEN:process.env.REMOTE_MATERIAL_TOKEN=oldToken;oldStorage===undefined?delete process.env.STORAGE_DIR:process.env.STORAGE_DIR=oldStorage;await rm(root,{recursive:true,force:true});}
});

test('CLI 不通过本机目录符号链接写入管理副本',async()=>{
 const oldFetch=globalThis.fetch,oldUrl=process.env.REMOTE_MATERIAL_API_URL,oldToken=process.env.REMOTE_MATERIAL_TOKEN,oldStorage=process.env.STORAGE_DIR;
 const root=await mkdtemp(join(tmpdir(),'remote-material-cli-'));
 const outside=await mkdtemp(join(tmpdir(),'remote-material-outside-'));
 await symlink(outside,join(root,'linked'));
 process.env.REMOTE_MATERIAL_API_URL='http://localhost:37900';process.env.REMOTE_MATERIAL_TOKEN='t'.repeat(32);process.env.STORAGE_DIR=root;
 let downloaded=false;
 globalThis.fetch=(async input=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/files'))return Response.json({operation_id:operation,workflow_id:workflow,materials:[{id:material,storage_path:'linked/new/secret.txt',sha256:'0'.repeat(64)}],artifacts:[]});
  if(path.endsWith('/download'))downloaded=true;
  return Response.json({id:operation,workflow_id:workflow,mode:'intake',status:'succeeded'});
 }) as typeof fetch;
 try{
  await expect(runRemoteMaterialCommand(['remote','material','sync','--operation',operation])).rejects.toBeInstanceOf(CliError);
  expect(downloaded).toBe(false);
  await expect(readFile(join(outside,'new/secret.txt'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{globalThis.fetch=oldFetch;oldUrl===undefined?delete process.env.REMOTE_MATERIAL_API_URL:process.env.REMOTE_MATERIAL_API_URL=oldUrl;oldToken===undefined?delete process.env.REMOTE_MATERIAL_TOKEN:process.env.REMOTE_MATERIAL_TOKEN=oldToken;oldStorage===undefined?delete process.env.STORAGE_DIR:process.env.STORAGE_DIR=oldStorage;await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('CLI 校验下载内容，错误文件不会落盘',async()=>{
 const oldFetch=globalThis.fetch,oldUrl=process.env.REMOTE_MATERIAL_API_URL,oldToken=process.env.REMOTE_MATERIAL_TOKEN,oldStorage=process.env.STORAGE_DIR;
 const root=await mkdtemp(join(tmpdir(),'remote-material-cli-'));
 process.env.REMOTE_MATERIAL_API_URL='http://localhost:37900';process.env.REMOTE_MATERIAL_TOKEN='t'.repeat(32);process.env.STORAGE_DIR=root;
 globalThis.fetch=(async input=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/files'))return Response.json({operation_id:operation,workflow_id:workflow,materials:[{id:material,storage_path:'question/input.txt',sha256:'0'.repeat(64)}],artifacts:[]});
  if(path.endsWith('/download'))return new Response('wrong content');
  return Response.json({id:operation,workflow_id:workflow,mode:'intake',status:'succeeded'});
 }) as typeof fetch;
 try{
  await expect(runRemoteMaterialCommand(['remote','material','sync','--operation',operation])).rejects.toMatchObject({detail:{kind:'invalid_response'}});
  await expect(readFile(join(root,'question/input.txt'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{globalThis.fetch=oldFetch;oldUrl===undefined?delete process.env.REMOTE_MATERIAL_API_URL:process.env.REMOTE_MATERIAL_API_URL=oldUrl;oldToken===undefined?delete process.env.REMOTE_MATERIAL_TOKEN:process.env.REMOTE_MATERIAL_TOKEN=oldToken;oldStorage===undefined?delete process.env.STORAGE_DIR:process.env.STORAGE_DIR=oldStorage;await rm(root,{recursive:true,force:true});}
});

test('CLI 下载中断时不留下半成品，后续可重新同步',async()=>{
 const oldFetch=globalThis.fetch,oldUrl=process.env.REMOTE_MATERIAL_API_URL,oldToken=process.env.REMOTE_MATERIAL_TOKEN,oldStorage=process.env.STORAGE_DIR;
 const root=await mkdtemp(join(tmpdir(),'remote-material-cli-'));
 process.env.REMOTE_MATERIAL_API_URL='http://localhost:37900';process.env.REMOTE_MATERIAL_TOKEN='t'.repeat(32);process.env.STORAGE_DIR=root;
 globalThis.fetch=(async input=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/files'))return Response.json({operation_id:operation,workflow_id:workflow,materials:[{id:material,storage_path:'question/input.txt',sha256:'0'.repeat(64)}],artifacts:[]});
  if(path.endsWith('/download'))return new Response(new ReadableStream({start(controller){controller.error(new Error('connection dropped'));}}));
  return Response.json({id:operation,workflow_id:workflow,mode:'intake',status:'succeeded'});
 }) as typeof fetch;
 try{
  await expect(runRemoteMaterialCommand(['remote','material','sync','--operation',operation])).rejects.toMatchObject({detail:{kind:'network_error'}});
  await expect(readFile(join(root,'question/input.txt'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{globalThis.fetch=oldFetch;oldUrl===undefined?delete process.env.REMOTE_MATERIAL_API_URL:process.env.REMOTE_MATERIAL_API_URL=oldUrl;oldToken===undefined?delete process.env.REMOTE_MATERIAL_TOKEN:process.env.REMOTE_MATERIAL_TOKEN=oldToken;oldStorage===undefined?delete process.env.STORAGE_DIR:process.env.STORAGE_DIR=oldStorage;await rm(root,{recursive:true,force:true});}
});
