/**
 * 职责：验证材料库批次清单固定范围、AND筛选、身份漂移跳过及未知写入恢复。
 * 入口：`bun test cli/library-batch.test.ts`；仅使用临时清单和HTTP替身，不连接业务服务。
 * 边界：不派发真实任务；单包任务规则由服务端测试负责。
 */
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiClient,CliError} from './client';
import {planLibraryBatch,runLibraryBatch} from './library-batch';

const packageA='11111111-1111-4111-8111-111111111111';
const packageB='22222222-2222-4222-8222-222222222222';
const revisionA='33333333-3333-4333-8333-333333333333';
const revisionB='44444444-4444-4444-8444-444444444444';
const project='55555555-5555-4555-8555-555555555555';

test('批次计划完整翻页并以且关系冻结命中，不产生写请求',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-batch-plan-')),out=join(root,'plan.json');
 const calls:{url:URL;method:string}[]=[];
 const client=new ApiClient(undefined,async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';calls.push({url,method});
  if(url.pathname==='/api/projects')return Response.json({items:[{id:project,name:'豆包高经济价值新第七期'}]});
  const page=Number(url.searchParams.get('page'));
  if(page===1)return Response.json({items:[{id:packageA,name:'豆包高经济价值新第七期 民间借贷',current_revision_id:revisionA,extraction_status:'failed'}],total_count:101});
  return Response.json({items:[{id:packageB,name:'豆包高经济价值新第七期 劳务合同',current_revision_id:revisionB,extraction_status:'succeeded'}],total_count:101});
 });
 try{
  const flags=new Map<string,string|boolean>([['kind','extract'],['project-query','新第七期'],['q','民间 借贷'],['extraction-state','failed']]);
  const result=await planLibraryBatch(client,flags,out);
  expect(result.count).toBe(1);expect(result.items[0]!.package_id).toBe(packageA);
  expect(calls.every(call=>call.method==='GET')).toBe(true);expect(calls.filter(call=>call.url.pathname==='/api/material-library/packages')).toHaveLength(2);
  const saved=JSON.parse(await readFile(out,'utf8'));expect(saved.items[0].request_key).toMatch(/^[0-9a-f-]{36}$/);expect(saved.items[0].state).toBe('planned');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('revision变化只跳过该项，网络未知保留同一请求体并停止后续写入',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-batch-run-')),file=join(root,'plan.json');
 const requestA='66666666-6666-4666-8666-666666666666',requestB='77777777-7777-4777-8777-777777777777';
 await writeFile(file,JSON.stringify({version:1,kind:'extract',filters:{},created_at:new Date().toISOString(),items:[
  {package_id:packageA,name:'A',revision_id:revisionA,request_key:requestA,state:'planned'},
  {package_id:packageB,name:'B',revision_id:revisionB,request_key:requestB,state:'planned'},
 ]}));
 const posts:any[]=[];
 const client=new ApiClient(undefined,async(input,init)=>{
  const url=new URL(String(input));
  if(init?.method==='POST'){posts.push(JSON.parse(String(init.body)));throw new TypeError('connection reset');}
  if(url.pathname===`/api/material-library/packages/${packageA}`)return Response.json({current_revision_id:'88888888-8888-4888-8888-888888888888'});
  if(url.pathname===`/api/material-library/packages/${packageB}`)return Response.json({current_revision_id:revisionB});
  if(url.pathname.endsWith('/revisions'))return Response.json({items:[{id:revisionB,state:'ready',jobs:[],redactions:[]}]});
  return Response.json({material_processing_mode:'aliases'});
 });
 try{
  const result=await runLibraryBatch(client,file);
  expect(result.counts).toEqual({skipped:1,unknown:1});expect(posts).toEqual([{request_key:requestB,kind:'extract',execution_target:'local'}]);
  const saved=JSON.parse(await readFile(file,'utf8'));
  expect(saved.items[0]).toMatchObject({state:'skipped',reason:'当前revision ID已变化'});
  expect(saved.items[1]).toMatchObject({state:'unknown',request_key:requestB,body:{request_key:requestB,kind:'extract',execution_target:'local'}});
  expect(saved.items[1].reason).toContain('先查状态再决定是否重发');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('损坏或重复运行中的清单在任何HTTP前失败',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-batch-invalid-')),file=join(root,'plan.json');let calls=0;
 await writeFile(file,JSON.stringify({version:1,kind:'extract',items:[{package_id:'bad'}]}));
 const client=new ApiClient(undefined,async()=>{calls++;return Response.json({});});
 try{
  await expect(runLibraryBatch(client,file)).rejects.toBeInstanceOf(CliError);expect(calls).toBe(0);
  await writeFile(file+'.lock','occupied');
  await expect(runLibraryBatch(client,file)).rejects.toThrow();expect(calls).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
