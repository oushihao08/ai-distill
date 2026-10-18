/** 验证脱敏队列保存执行进度和失败原因，及附件变更后的晚到结果不发布；使用内存 SQL 替身和合成原文，不连接业务数据库或调用真实 API。 */
import {expect,test,spyOn} from 'bun:test';
import {mkdtemp,rm,mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {redactionInputDigest,runNextRedaction} from './redaction-jobs';
import {REDACTION_PROTOCOL_VERSION} from './redaction';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
test('派发锁争用回滚并退回轮询，不领取任务或永久占住消费者',async()=>{
 const statements:string[]=[];let released=false;
 const pool={connect:async()=>({query:async(sql:string)=>{statements.push(sql);if(sql.includes('pg_advisory_xact_lock_shared'))throw Object.assign(new Error('fixture lock wait'),{code:'55P03'});return{rows:[]};},release:()=>{released=true;}})} as any;
 expect(await runNextRedaction(pool,'unused')).toBe(false);
 expect(statements).toContain("SET LOCAL lock_timeout='5s'");expect(statements.at(-1)).toBe('ROLLBACK');expect(released).toBe(true);
});
function fixture(onReadSource=()=>{},blocks:any[]=[{id:'b1',kind:'paragraph',text:'联系人张三'}]){
 const sourceSha='a'.repeat(64),content=JSON.stringify({source_sha256:sourceSha,pages:[{page:1,text:blocks.map(block=>block.text??block.items?.join(' ')).join('\n'),method:'text',structure:blocks}]});
 const source={material_id:crypto.randomUUID(),source_sha256:sourceSha,artifact_id:crypto.randomUUID(),artifact_sha256:hash(content)};
 const sourceContents=new Map([[source.material_id,content]]);
 const job={id:crypto.randomUUID(),workflow_id:crypto.randomUUID(),project_id:crypto.randomUUID(),ordinal:9,input:{materials:[source],digest:redactionInputDigest([source]),execution:{max_fields:1,concurrency:1}},config:{provider:'api',api:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'deepseek/deepseek-v4.1-flash'},prompt:'姓名脱敏',text_layout:REDACTION_PROTOCOL_VERSION}};
 let changed=false,configChanged=false;const queries:string[]=[];const saved:any[]=[];const queryTimeouts:number[]=[];let artifacts=0;
 const query=async(statement:any,args:any[]=[])=>{
  const sql=typeof statement==='string'?statement:statement.text;
  if(typeof statement==='object'){args=statement.values??[];queryTimeouts.push(statement.query_timeout);}
  queries.push(sql.slice(0,90));let rows:any[]=[];
  if(sql.startsWith('SELECT a.*'))rows=[job];
  else if(sql.startsWith('SELECT config FROM')){const {text_layout,...config}=job.config;rows=[{config:{...config,...(configChanged?{prompt:'规则已改变'}:{})}}];}
  else if(sql.startsWith('SELECT DISTINCT ON(m.id)'))rows=job.input.materials.map((item:any)=>({...item,...(changed?{source_sha256:'b'.repeat(64)}:{})}));
  else if(sql.startsWith('SELECT count(*)'))rows=[{count:job.input.materials.length}];
  else if(sql.startsWith('SELECT source_manifest'))rows=[{source_manifest:[]}];
  else if(sql.startsWith('SELECT ar.content')){onReadSource();const found=job.input.materials.find((item:any)=>item.material_id===args[2])!;rows=[{content:sourceContents.get(found.material_id),sha256:found.artifact_sha256,source_sha256:found.source_sha256}];}
  else if(sql.startsWith('SELECT id FROM ai_distill.workflows'))rows=[{id:job.workflow_id}];
  else if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))rows=[{id:job.id}];
  else if(sql.startsWith('SELECT status FROM'))rows=[{status:'running'}];
  if(sql.startsWith('UPDATE ai_distill.step_attempts SET status=\'succeeded\''))saved.push({status:'succeeded',result:JSON.parse(args[1])});
  if(sql.startsWith('UPDATE ai_distill.step_attempts SET status=\'failed\',result='))saved.push({status:'failed',error:JSON.parse(args[2]),progress:args[3]?JSON.parse(args[3]):null});
  if(sql.startsWith('INSERT INTO ai_distill.artifacts'))artifacts++;
  return{rows,rowCount:sql.startsWith('UPDATE')?1:rows.length};
 };
 const db={query,release(){}};return{pool:{query,connect:async()=>db} as any,job,saved,queries,queryTimeouts,setChanged:()=>{changed=true;},setConfigChanged:()=>{configChanged=true;},artifacts:()=>artifacts,addDeclaredSource:()=>{
  const source_sha256='c'.repeat(64),manualContent=JSON.stringify({source_sha256,pages:[{page:1,text:'已核准正文',method:'text',structure:[{id:'b1',kind:'paragraph',text:'已核准正文'}]}]});
  const item={material_id:crypto.randomUUID(),source_sha256,artifact_id:crypto.randomUUID(),artifact_sha256:hash(manualContent),redaction_mode:'declared_redacted'};
  sourceContents.set(item.material_id,manualContent);(job.input.materials as any[]).push(item);(job.input.materials as any[]).sort((a,b)=>a.material_id.localeCompare(b.material_id));job.input.digest=redactionInputDigest(job.input.materials);return item;
 }};
}
test('declared DOCX publishes full index without model or agent call',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'redaction-manual-'));
 (f.job.input.materials[0] as any).redaction_mode='declared_redacted';
 f.job.input.digest=redactionInputDigest(f.job.input.materials);
 f.job.config={provider:'manual',text_layout:REDACTION_PROTOCOL_VERSION} as any;
 let calls=0;
 try{
  await runNextRedaction(f.pool,root,undefined,async()=>{calls++;throw new Error('agent called');},'api','local',async()=>{calls++;throw new Error('api called');});
  expect(calls).toBe(0);
  expect(f.saved[0]).toMatchObject({status:'succeeded',result:{declared_redacted_count:1,provider:'manual',material_count:1}});
  expect(f.artifacts()).toBe(2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('mixed package calls the model only for undeclared material and keeps both in the index',async()=>{
 const f=fixture(),manual=f.addDeclaredSource(),root=await mkdtemp(join(tmpdir(),'redaction-mixed-'));
 let calls=0;
 try{
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async(request:any)=>{
   calls++;
   const targets=JSON.parse(request.messages.at(-1).content).targets;
   return{text:JSON.stringify({fields:targets.map((target:any)=>({target_id:target.target_id,redactions:[]}))}),duration_ms:1,usage:null,completion_id:null} as any;
  });
  expect(calls).toBe(1);
  expect(f.saved[0]).toMatchObject({status:'succeeded',result:{material_count:2,declared_redacted_count:1}});
  const index=JSON.parse(await Bun.file(join(root,f.job.workflow_id,f.job.id,'pages.json')).text());
  expect(index.materials.map((item:any)=>item.material_id)).toEqual(f.job.input.materials.map(item=>item.material_id));
  expect(index.materials.find((item:any)=>item.material_id===manual.material_id).markdown).toBe('已核准正文');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('整题时限计入原文加载，预算耗尽后不再开始收费请求',async()=>{
 let now=Date.now();const clock=spyOn(Date,'now').mockImplementation(()=>now);
 const f=fixture(()=>{now+=2000;}),root=await mkdtemp(join(tmpdir(),'redaction-input-deadline-'));f.job.input.execution={...f.job.input.execution,task_timeout_ms:1000} as any;let calls=0;
 try{
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async(r:any)=>{calls++;return{text:JSON.stringify({fields:JSON.parse(r.messages.at(-1).content).targets.map((t:any)=>({target_id:t.target_id,redactions:[]}))}),duration_ms:1,usage:null,completion_id:null} as any;});
  expect(f.saved[0]).toMatchObject({status:'failed',error:{reason_code:'redaction_task_timeout'}});expect(calls).toBe(0);
 }finally{clock.mockRestore();await rm(root,{recursive:true,force:true});}
});
test('心跳查询有独立时限并在收尾前结束',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'redaction-heartbeat-'));
 const original=setInterval;let heartbeat:()=>void=()=>{};
 const timer=spyOn(globalThis,'setInterval').mockImplementation(((fn:any,ms:number,...args:any[])=>{if(ms===5000)heartbeat=fn;return original(fn,ms,...args);}) as any);
 try{
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async(r:any)=>{heartbeat();await Bun.sleep(1);return{text:JSON.stringify({fields:JSON.parse(r.messages.at(-1).content).targets.map((t:any)=>({target_id:t.target_id,redactions:[]}))}),duration_ms:1,usage:null,completion_id:null} as any;});
  expect(f.queryTimeouts).toContain(5000);expect(f.queryTimeouts.every(n=>n>0&&n<=180000)).toBe(true);expect(f.saved[0].status).toBe('succeeded');
 }finally{timer.mockRestore();await rm(root,{recursive:true,force:true});}
});
test('执行期间规则改变，附件未变也拒绝发布旧配置结果',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'redaction-job-config-stale-'));
 try{
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async(r:any)=>{f.setConfigChanged();return{text:JSON.stringify({fields:JSON.parse(r.messages.at(-1).content).targets.map((t:any)=>({target_id:t.target_id,redactions:[]}))}),duration_ms:1,usage:null,completion_id:null} as any;});
  expect(f.saved[0].status).toBe('failed');expect(f.artifacts()).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('API队列保存完整进度和真实模型配置',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'redaction-job-'));
 try{
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async(r:any)=>({text:JSON.stringify({fields:JSON.parse(r.messages.at(-1).content).targets.map((t:any)=>({target_id:t.target_id,redactions:[{source_text:'张三',kind:'name'}]}))}),duration_ms:2,usage:null,completion_id:null,call_id:r.call_id} as any));
  expect(f.saved[0].status,JSON.stringify(f.queries)).toBe('succeeded');expect(f.saved[0].result.progress).toMatchObject({phase:'completed',completed_fields:1,total_fields:1,request_count:1});expect(f.saved[0].result.model).toBe('deepseek/deepseek-v4.1-flash');expect(f.artifacts()).toBe(2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('低并发大包按结构化字段总量扩展任务预算',async()=>{
 const blocks=Array.from({length:1_501},(_,index)=>({id:`b${index}`,kind:'paragraph',text:`正文字段${index}`}));
 const f=fixture(()=>{},blocks),root=await mkdtemp(join(tmpdir(),'redaction-job-large-budget-'));
 Object.assign(f.job.input.execution,{max_fields:256,concurrency:1});
 try{
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async(request:any)=>({text:JSON.stringify({fields:JSON.parse(request.messages.at(-1).content).targets.map((target:any)=>({target_id:target.target_id,redactions:[]}))}),duration_ms:1,usage:null,completion_id:null} as any));
  expect(f.saved[0].status).toBe('succeeded');
  const progress=f.saved[0].result.progress;
  const budget=Date.parse(progress.deadline_at)-Date.parse(progress.started_at);
  expect(budget).toBeGreaterThanOrEqual(2_390_000);expect(budget).toBeLessThanOrEqual(2_400_000);
  expect(progress).toMatchObject({completed_fields:1_501,total_fields:1_501});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('API超时失败保存原因和已完成进度，不发布附件',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'redaction-job-timeout-'));Object.assign(f.job.input.execution,{request_timeout_ms:10,task_timeout_ms:200,stall_timeout_ms:100});
 try{
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async()=>await new Promise<any>(()=>{}));
  expect(f.saved[0]).toMatchObject({status:'failed',error:{reason_code:'redaction_request_timeout'},progress:{phase:'failed',completed_fields:0}});expect(f.artifacts()).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
},500);
test('索引写入失败时清理已写正文，不留下貌似完成的文件',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'redaction-job-partial-write-'));
 const directory=join(root,f.job.workflow_id,f.job.id);
 try{
  await mkdir(join(directory,'pages.json'),{recursive:true});
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async(r:any)=>({text:JSON.stringify({fields:JSON.parse(r.messages.at(-1).content).targets.map((t:any)=>({target_id:t.target_id,redactions:[]}))}),duration_ms:1,usage:null,completion_id:null} as any));
  expect(f.saved[0].status).toBe('failed');expect(f.artifacts()).toBe(0);
  expect(await stat(join(directory,'materials.md')).then(()=>true,()=>false)).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('执行期间附件变更，晚到结果不提交成功',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'redaction-job-stale-'));
 try{
  await runNextRedaction(f.pool,root,undefined,undefined,'api','local',async(r:any)=>{f.setChanged();return{text:JSON.stringify({fields:JSON.parse(r.messages.at(-1).content).targets.map((t:any)=>({target_id:t.target_id,redactions:[]}))}),duration_ms:1,usage:null,completion_id:null} as any;});
  expect(f.saved.some(s=>s.status==='succeeded')).toBe(false);expect(f.artifacts()).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
