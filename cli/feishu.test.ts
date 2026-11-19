/** 验证飞书批次对已通过、明确差异和未知读取的汇总；仅模拟本机HTTP，不调用飞书或数据库。 */
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiClient} from './client';
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
