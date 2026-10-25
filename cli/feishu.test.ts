/** 验证飞书批次对已通过、明确差异和未知读取的汇总；仅模拟本机HTTP，不调用飞书或数据库。 */
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiClient} from './client';
import {syncFeishuBatch} from './feishu';
test('批量汇总与每题差异回执一致，旧成功不冒记核对通过',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feishu-cli-'));const ids=['one','two','three','four'];let index=0;
 const receipts=[{status:'succeeded',verification:{status:'passed'}},{status:'failed',verification:{status:'failed',fields:['prompt']}},{status:'failed',verification:{status:'incomplete'}},{status:'succeeded'}];
 const client=new ApiClient(undefined,async(url)=>Response.json(url.endsWith('/feishu-delivery')?{capabilities:{target_override:true},default_target:{base_token:'base123456789',table_id:'tbl123456789'}}:url.endsWith('/feishu-sync')?receipts[index++]:{workflows:ids.map(id=>({id,workflow_kind:'question',current_decision:'accepted'})),workflow_status:Object.fromEntries(ids.map(id=>[id,{steps:[{ordinal:8,status:'succeeded'}]}]))}));
 try{const result=await syncFeishuBatch(client,'project',ids,join(root,'progress.json'),undefined);expect(result.data).toMatchObject({verified:1,verification_failed:1,verification_incomplete:2});expect(result.data.items[1].receipt.verification.fields).toEqual(['prompt']);}finally{await rm(root,{recursive:true,force:true});}
});

test('真实HTTP502回读本次安全差异回执，保留pending且不重发',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feishu-cli-'));let writes=0;
 const client=new ApiClient(undefined,async(url,init)=>{
  if(url.endsWith('/feishu-delivery'))return Response.json({capabilities:{target_override:true},default_target:{base_token:'base123456789',table_id:'tbl123456789'}});
  if(url.endsWith('/feishu-sync')){writes++;return Response.json({status:'failed'},{status:502});}
  if(url.includes('/workflows/'))return Response.json({steps:[{ordinal:8,result:{feishu_sync:{status:'failed',url:'https://ncn9ze979yuh.feishu.cn/base/base123456789?table=tbl123456789',verification:{status:'failed',checked_at:new Date().toISOString(),fields:['prompt']}}}}]});
  return Response.json({workflows:['one','two'].map(id=>({id,workflow_kind:'question',current_decision:'accepted'})),workflow_status:Object.fromEntries(['one','two'].map(id=>[id,{steps:[{ordinal:8,status:'succeeded'}]}]))});
 });
 try{const result=await syncFeishuBatch(client,'project',['one','two'],join(root,'progress.json'),undefined);expect(result.data.verification_failed).toBe(1);expect(result.data.items[0].receipt.verification.fields).toEqual(['prompt']);expect(result.data.items[0].status).toBe('failed');expect(result.data.items[1].status).toBe('pending');expect(writes).toBe(1);}finally{await rm(root,{recursive:true,force:true});}
});

test.each(['old_time','other_target'])('HTTP502不采用过期或其他目标回执：%s',async mode=>{const root=await mkdtemp(join(tmpdir(),'feishu-cli-'));const client=new ApiClient(undefined,async(url)=>{if(url.endsWith('/feishu-delivery'))return Response.json({capabilities:{target_override:true},default_target:{base_token:'base123456789',table_id:'tbl123456789'}});if(url.endsWith('/feishu-sync'))return Response.json({status:'failed'},{status:502});if(url.includes('/workflows/'))return Response.json({steps:[{ordinal:8,result:{feishu_sync:{status:'failed',url:`https://ncn9ze979yuh.feishu.cn/base/base123456789?table=${mode==='other_target'?'tbl999999999':'tbl123456789'}`,verification:{status:'failed',checked_at:mode==='old_time'?'2000-01-01T00:00:00Z':new Date().toISOString(),fields:['prompt']}}}}]});return Response.json({workflows:[{id:'one',workflow_kind:'question',current_decision:'accepted'}],workflow_status:{one:{steps:[{ordinal:8,status:'succeeded'}]}}});});try{const r=await syncFeishuBatch(client,'project',['one'],join(root,'progress.json'),undefined);expect(r.data.items[0].status).toBe('unknown');expect(r.data.items[0].receipt).toBeUndefined();expect(r.data.verification_failed).toBe(0);}finally{await rm(root,{recursive:true,force:true});}});
