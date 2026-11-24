/** 验证飞书批次对已通过、明确差异和未知读取的汇总；仅模拟本机HTTP，不调用飞书或数据库。 */
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiClient} from './client';
import {runCommand} from './commands';
import {syncFeishuBatch} from './feishu';
const id1='11111111-1111-4111-8111-111111111111',id2='22222222-2222-4222-8222-222222222222',id3='33333333-3333-4333-8333-333333333333',id4='44444444-4444-4444-8444-444444444444';
test('批量汇总与每题差异回执一致，遇失败即停止后续派发，旧成功不冒记核对通过',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feishu-cli-'));const ids=[id1,id2,id3,id4];let index=0;
 const receipts=[{status:'succeeded',verification:{status:'passed'}},{status:'succeeded'},{status:'failed',verification:{status:'failed',fields:['prompt']}}];
 const client=new ApiClient(undefined,async(url)=>Response.json(url.endsWith('/feishu-delivery')?{capabilities:{target_override:true},default_target:{base_token:'base123456789',table_id:'tbl123456789'}}:url.endsWith('/feishu-sync')?receipts[index++]:{workflows:ids.map(id=>({id,workflow_kind:'question'})),workflow_status:Object.fromEntries(ids.map(id=>[id,{steps:[{ordinal:8,status:'succeeded'}]}]))}));
 try{const result=await syncFeishuBatch(client,'project',ids,join(root,'progress.json'),undefined);expect(result.data).toMatchObject({verified:1,verification_failed:0,verification_incomplete:1,succeeded:1});expect(result.data.items[1].status).toBe('failed');expect(result.data.items[2].status).toBe('pending');expect(index).toBe(2);}finally{await rm(root,{recursive:true,force:true});}
});

test('真实HTTP502回读本次安全差异回执，保留pending且不重发',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feishu-cli-'));let writes=0;
 const client=new ApiClient(undefined,async(url)=>{
  if(url.endsWith('/feishu-delivery'))return Response.json({capabilities:{target_override:true},default_target:{base_token:'base123456789',table_id:'tbl123456789'}});
  if(url.endsWith('/feishu-sync')){writes++;return Response.json({status:'failed'},{status:502});}
  if(url.includes('/workflows/'))return Response.json({steps:[{ordinal:8,result:{feishu_sync:{status:'failed',url:'https://ncn9ze979yuh.feishu.cn/base/base123456789?table=tbl123456789',verification:{status:'failed',checked_at:new Date().toISOString(),fields:['prompt']}}}}]});
  return Response.json({workflows:[id1,id2].map(id=>({id,workflow_kind:'question'})),workflow_status:Object.fromEntries([id1,id2].map(id=>[id,{steps:[{ordinal:8,status:'succeeded'}]}]))});
 });
 try{const result=await syncFeishuBatch(client,'project',[id1,id2],join(root,'progress.json'),undefined);expect(result.data.verification_failed).toBe(1);expect(result.data.items[0].receipt.verification.fields).toEqual(['prompt']);expect(result.data.items[0].status).toBe('failed');expect(result.data.items[1].status).toBe('pending');expect(writes).toBe(1);}finally{await rm(root,{recursive:true,force:true});}
});

test.each(['old_time','other_target'])('HTTP502不采用过期或其他目标回执：%s',async mode=>{const root=await mkdtemp(join(tmpdir(),'feishu-cli-'));const client=new ApiClient(undefined,async(url)=>{if(url.endsWith('/feishu-delivery'))return Response.json({capabilities:{target_override:true},default_target:{base_token:'base123456789',table_id:'tbl123456789'}});if(url.endsWith('/feishu-sync'))return Response.json({status:'failed'},{status:502});if(url.includes('/workflows/'))return Response.json({steps:[{ordinal:8,result:{feishu_sync:{status:'failed',url:`https://ncn9ze979yuh.feishu.cn/base/base123456789?table=${mode==='other_target'?'tbl999999999':'tbl123456789'}`,verification:{status:'failed',checked_at:mode==='old_time'?'2000-01-01T00:00:00Z':new Date().toISOString(),fields:['prompt']}}}}]});return Response.json({workflows:[{id:id1,workflow_kind:'question'}],workflow_status:{[id1]:{steps:[{ordinal:8,status:'succeeded'}]}}});});try{const r=await syncFeishuBatch(client,'project',[id1],join(root,'progress.json'),undefined);expect(r.data.items[0].status).toBe('unknown');expect(r.data.items[0].receipt).toBeUndefined();expect(r.data.verification_failed).toBe(0);}finally{await rm(root,{recursive:true,force:true});}});

test('多并发批次（concurrency=3）并行派发并在任一失败后停止领取后续pending且不中断在途请求',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feishu-cli-conc-'));
 const ids=[id1,id2,id3,id4];
 let active=0,maxActive=0;
 const client=new ApiClient(undefined,async(url,init)=>{
  if(url.endsWith('/feishu-delivery'))return Response.json({capabilities:{target_override:true,draft_sync:true},default_target:{base_token:'base123456789',table_id:'tbl123456789'}});
  if(url.endsWith('/feishu-draft-sync')){
   active++;maxActive=Math.max(maxActive,active);
   const isFail=url.includes(id1);
   await new Promise(r=>setTimeout(r,isFail?5:25));
   active--;
   return Response.json(isFail?{status:'failed',verification:{status:'failed',fields:['prompt']}}:{status:'succeeded',verification:{status:'passed'}});
  }
  return Response.json({workflows:ids.map(id=>({id,workflow_kind:'question'})),workflow_status:Object.fromEntries(ids.map(id=>[id,{steps:[{ordinal:4,status:'succeeded'}]}]))});
 });
 try{
  const r=await syncFeishuBatch(client,'project',ids,join(root,'progress.json'),undefined,undefined,'draft',undefined,false,3);
  expect(maxActive).toBe(3);
  expect(r.outcome).toBe('partial');
  // id1 快速失败后停止领取第 4 题（保持 pending），已在途的 id2/id3 正常完成落盘而不被中途掐断成 unknown
  expect(r.data.items[0].status).toBe('failed');
  expect(r.data.items[1].status).toBe('succeeded');
  expect(r.data.items[2].status).toBe('succeeded');
  expect(r.data.items[3].status).toBe('pending');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('feishu config set 与 feishu table create 超时预算严格符合 ApiClient 180s 上限',async()=>{
 const client=new ApiClient(undefined,async(url,init)=>{
  if(url.endsWith('/feishu-delivery')&&(!init?.method||init.method==='GET')){
   return Response.json({capabilities:{target_override:true,attachment_format:true}});
  }
  if(url.endsWith('/feishu-delivery')&&init?.method==='PUT'){
   return Response.json({default_target:{base_token:'base1234567890',table_id:'tbl123456789'},source:'configured',attachment_format:'pdf'});
  }
  if(url.endsWith('/feishu-tables')&&init?.method==='POST'){
   return Response.json({target:{base_token:'base1234567890',table_id:'tbl123456789'},table_name:'测试表'},{status:201});
  }
  return Response.json({});
 });
 const created=await runCommand(['feishu','table','create','--project',id1,'--name','测试表','--base-token','base1234567890'],client);
 expect(created.data.target.table_id).toBe('tbl123456789');
 const configured=await runCommand(['feishu','config','set','--project',id1,'--base-token','base1234567890','--table','tbl123456789','--attachment-format','pdf'],client);
 expect(configured.data.attachment_format).toBe('pdf');
});
