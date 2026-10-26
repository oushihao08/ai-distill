/** 验证脱敏队列保存执行进度和失败原因，及附件变更后的晚到结果不发布；使用内存 SQL 替身和合成原文，不连接业务数据库或调用真实 API。 */
import {expect,test} from 'bun:test';
import {mkdtemp,rm,mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {redactionInputDigest,runNextRedaction,enqueueRedaction} from './redaction-jobs';
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
 try{
  await runNextRedaction(f.pool,root,undefined,'api','local');
  expect(f.saved[0]).toMatchObject({status:'succeeded',result:{declared_redacted_count:1,provider:'manual',material_count:1}});
  expect(f.artifacts()).toBe(2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test.each(['api','codex'] as const)('已冻结的%s字段映射任务明确失败，不发布结果',async provider=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'removed-mapping-'));
 f.job.config.provider=provider;
 try{
  await runNextRedaction(f.pool,root,undefined,provider,'local');
  expect(f.saved[0]).toMatchObject({status:'failed',error:{reason_code:'field_mapping_removed',retryable:false}});
  expect(f.artifacts()).toBe(0);
  expect(f.queries.some(sql=>sql.startsWith('SELECT ar.content'))).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('人工声明文件发布失败时清理未发布的正文',async()=>{
 const f=fixture(),root=await mkdtemp(join(tmpdir(),'manual-publish-'));
 (f.job.input.materials[0] as any).redaction_mode='declared_redacted';f.job.input.digest=redactionInputDigest(f.job.input.materials);
 f.job.config={provider:'manual',text_layout:REDACTION_PROTOCOL_VERSION} as any;
 try{
  await mkdir(join(root,f.job.workflow_id,f.job.id,'pages.json'),{recursive:true});
  await runNextRedaction(f.pool,root,undefined,'api','local');
  expect(f.saved[0].status).toBe('failed');expect(f.artifacts()).toBe(0);
  expect(await stat(join(root,f.job.workflow_id,f.job.id,'materials.md')).then(()=>true,()=>false)).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('旧字段映射任务不能新派或重放旧请求',async()=>{
 let previous=false,writes=0;
 const query=async(sql:string)=>{
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{codex_model:'fixture',codex_reasoning_effort:'low'}]};
  if(sql.startsWith('SELECT w.project_id'))return{rows:[{project_id:'project'}]};
  if(sql.startsWith('SELECT ordinal,status'))return{rows:[{ordinal:1,status:'succeeded'},{ordinal:2,status:'succeeded'},{ordinal:9,status:'waiting',enabled:true}]};
  if(sql.startsWith('SELECT DISTINCT ON(m.id)'))return{rows:[{material_id:'material',source_sha256:'hash',artifact_id:'artifact',artifact_sha256:'text'}]};
  if(sql.startsWith('SELECT count(*)'))return{rows:[{count:1}]};
  if(sql.startsWith('SELECT config'))return{rows:[{config:{provider:'codex',model:'fixture',reasoning_effort:'low',prompt:'历史脱敏'}}]};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:previous?[{id:'old-attempt'}]:[]};
  if(sql.startsWith('INSERT')||sql.startsWith('UPDATE'))writes++;
  return{rows:[]};
 };
 const pool={query,connect:async()=>({query,release(){}})} as any;
 await expect(enqueueRedaction(pool,'workflow')).rejects.toThrow('已删除');expect(writes).toBe(0);
 previous=true;await expect(enqueueRedaction(pool,'workflow')).rejects.toThrow('已删除');expect(writes).toBe(0);
});

test('人工声明的附件变化时晚到结果不发布',async()=>{
 const f=fixture(()=>f.setChanged()),root=await mkdtemp(join(tmpdir(),'manual-stale-'));
 (f.job.input.materials[0] as any).redaction_mode='declared_redacted';f.job.input.digest=redactionInputDigest(f.job.input.materials);
 f.job.config={provider:'manual',text_layout:REDACTION_PROTOCOL_VERSION} as any;
 try{
  await runNextRedaction(f.pool,root);
  expect(f.saved[0].status).toBe('failed');expect(f.artifacts()).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
