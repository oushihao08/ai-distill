/** 验证远程材料接口鉴权、操作幂等/阶段推进、来源失效与下载校验；使用 Hono 内存请求、Pool 替身和临时文件，不访问真实数据库或模型服务。 */
import {expect,test} from 'bun:test';
import {Hono} from 'hono';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {createRemoteMaterialOperation,runNextRemoteMaterialOperation} from './remote-material-operations';
import {registerRemoteMaterialRoutes} from './remote-material-routes';
import {currentRedactionExecutionConfig} from './materials/redaction-jobs';

const id='12345678-1234-4234-8234-123456789abc';

test('远程接口没有有效令牌时拒绝请求，且不查询数据库',async()=>{
 const app=new Hono();let queried=false;
 const pool={query:async()=>{queried=true;throw new Error('unexpected database access');}} as unknown as Pool;
 registerRemoteMaterialRoutes(app,pool,'/tmp','x'.repeat(32),true);
 const absent=await app.request(`/api/remote-material-operations/${id}`);
 const wrong=await app.request(`/api/remote-material-operations/${id}`,{headers:{Authorization:'Bearer invalid'}});
 const create=await app.request('/api/remote-material-operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow_id:id,mode:'redact',request_key:id})});
 expect(absent.status).toBe(401);expect(wrong.status).toBe(401);expect(create.status).toBe(401);expect(queried).toBe(false);
});

test('本机模式不注册远程材料接口',async()=>{
 const app=new Hono();
 registerRemoteMaterialRoutes(app,{} as Pool,'/tmp','x'.repeat(32),false);
 expect((await app.request('/api/remote-material-operations',{method:'POST'})).status).toBe(404);
});

test('重复请求标识复用已存在操作，不再派发新任务',async()=>{
 const existing={id,workflow_id:id,request_key:id,mode:'redact',status:'running'};
 const calls:string[]=[];
 const pool={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.startsWith('SELECT w.id,w.source_key'))return{rows:[{id,source_manifest:[]}]};
  if(sql.startsWith('SELECT * FROM ai_distill.remote_material_operations'))return{rows:[existing]};
  throw new Error('should not create another operation');
 }} as unknown as Pool;
 expect(await createRemoteMaterialOperation(pool,id,'redact',id)).toBe(existing);
 expect(calls).toHaveLength(2);
});

test('入库完成后组合操作转入脱敏，未直接标为成功',async()=>{
 const config=await currentRedactionExecutionConfig({query:async()=>({rows:[{config:{provider:'api'}}]})} as unknown as Pool,id);
 const op={id,workflow_id:id,mode:'intake-redact',stage:'intake',source_digest:'digest',redaction_config_digest:createHash('sha256').update(JSON.stringify(config)).digest('hex')};
 const calls:{sql:string;values:unknown[]}[]=[];
 const pool={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('UPDATE ai_distill.remote_material_operations SET status='))return{rows:[op]};
  if(sql.startsWith('SELECT w.source_manifest'))return{rows:[{source_manifest:[]}]};
  if(sql.startsWith('SELECT ordinal,status,error FROM ai_distill.steps'))return{rows:[{ordinal:1,status:'succeeded'},{ordinal:2,status:'succeeded'},{ordinal:9,status:'waiting'}]};
  if(sql.startsWith('SELECT id,ordinal,status,error,execution_target'))return{rows:[{id,ordinal:1,status:'succeeded',execution_target:'server'}]};
  if(sql.startsWith('SELECT project_id FROM ai_distill.workflows'))return{rows:[{project_id:id}]};
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:[{config:{provider:'api'}}]};
  return{rows:[]};
 }} as unknown as Pool;
 // The stored digest must match the frozen empty source manifest.
 op.source_digest=await Bun.CryptoHasher.hash('sha256','[]','hex');
 expect(await runNextRemoteMaterialOperation(pool)).toBe(true);
 const transition=calls.find(call=>call.sql.includes('material_digest=COALESCE'));
 expect(transition?.values[1]).toBe('running');
 expect(transition?.values[2]).toBe('redact');
});

test('材料版本变化时终止操作，不派发入库或脱敏',async()=>{
 const op={id,workflow_id:id,mode:'intake-redact',stage:'intake',source_digest:'mismatch'};
 const calls:string[]=[];
 const pool={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.startsWith('UPDATE ai_distill.remote_material_operations SET status='))return{rows:[op]};
  if(sql.startsWith('SELECT w.source_manifest'))return{rows:[{source_manifest:[]}]};
  return{rows:[]};
 }} as unknown as Pool;
 expect(await runNextRemoteMaterialOperation(pool)).toBe(true);
 expect(calls.some(sql=>sql.includes('error_code=COALESCE'))).toBe(true);
 expect(calls.some(sql=>sql.includes('INSERT INTO ai_distill.step_attempts'))).toBe(false);
});

test('脱敏步骤失效后旧操作不能提供文件清单',async()=>{
 const app=new Hono();
 const op={id,workflow_id:id,mode:'intake-redact',status:'succeeded',source_digest:await Bun.CryptoHasher.hash('sha256','[]','hex'),material_digest:await Bun.CryptoHasher.hash('sha256','[]','hex'),redaction_attempt_id:id};
 const pool={query:async(sql:string)=>{
  if(sql.startsWith('SELECT id,workflow_id,mode,status,stage'))return{rows:[op]};
  if(sql.startsWith('SELECT source_manifest'))return{rows:[{source_manifest:[]}]};
  if(sql.startsWith('SELECT id,sha256,storage_path'))return{rows:[]};
  if(sql.startsWith('SELECT ordinal,status FROM ai_distill.steps'))return{rows:[{ordinal:1,status:'succeeded'},{ordinal:9,status:'waiting'}]};
  return{rows:[]};
 }} as unknown as Pool;
 registerRemoteMaterialRoutes(app,pool,'/tmp','x'.repeat(32),true);
 const result=await app.request(`/api/remote-material-operations/${id}/files`,{headers:{Authorization:`Bearer ${'x'.repeat(32)}`}});
 expect(result.status).toBe(409);
});

test('远程脱敏不能把本机完成的脱敏标为自己的结果',async()=>{
 const emptyDigest=await Bun.CryptoHasher.hash('sha256','[]','hex');
 const config=await currentRedactionExecutionConfig({query:async()=>({rows:[{config:{provider:'api'}}]})} as unknown as Pool,id);
 const op={id,workflow_id:id,mode:'redact',stage:'redact',source_digest:emptyDigest,material_digest:emptyDigest,redaction_config_digest:createHash('sha256').update(JSON.stringify(config)).digest('hex')};
 const calls:{sql:string;values:unknown[]}[]=[];
 const pool={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('UPDATE ai_distill.remote_material_operations SET status='))return{rows:[op]};
  if(sql.startsWith('SELECT w.source_manifest'))return{rows:[{source_manifest:[]}]};
  if(sql.startsWith('SELECT ordinal,status,error FROM ai_distill.steps'))return{rows:[{ordinal:1,status:'succeeded'},{ordinal:9,status:'succeeded'}]};
  if(sql.startsWith('SELECT id,ordinal,status,error,execution_target'))return{rows:[{id,ordinal:9,status:'succeeded',execution_target:'local'}]};
  if(sql.startsWith('SELECT project_id FROM ai_distill.workflows'))return{rows:[{project_id:id}]};
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:[{config:{provider:'api'}}]};
  return{rows:[]};
 }} as unknown as Pool;
 expect(await runNextRemoteMaterialOperation(pool)).toBe(true);
 const transition=calls.find(call=>call.sql.includes('error_code=COALESCE'));
 expect(transition?.values[1]).toBe('failed');
 expect(transition?.values[6]).toBe('redaction_completed_elsewhere');
});

test('远程下载只返回当前成功操作的校验文件',async()=>{
 const root=await mkdtemp(join(tmpdir(),'remote-material-routes-'));
 const bytes=new TextEncoder().encode('original copy');
 const sha=createHash('sha256').update(bytes).digest('hex');
 const storagePath='materials/input.txt';
 const materialId='42345678-1234-4234-8234-123456789abc';
 const attemptId='52345678-1234-4234-8234-123456789abc';
 await mkdir(join(root,'materials'),{recursive:true});await writeFile(join(root,storagePath),bytes);
 const manifestDigest=createHash('sha256').update('[]').digest('hex');
 const materialDigest=createHash('sha256').update(JSON.stringify([[materialId,sha,storagePath]])).digest('hex');
 const op={id,workflow_id:id,mode:'redact',status:'succeeded',source_digest:manifestDigest,material_digest:materialDigest,redaction_attempt_id:attemptId};
 const pool={query:async(sql:string)=>{
  if(sql.startsWith('SELECT id,workflow_id,mode,status,stage'))return{rows:[op]};
  if(sql.startsWith('SELECT w.source_manifest'))return{rows:[{source_manifest:[]}]};
  if(sql.startsWith('SELECT id,sha256,storage_path'))return{rows:[{id:materialId,sha256:sha,storage_path:storagePath}]};
  if(sql.startsWith('SELECT ordinal,status FROM ai_distill.steps'))return{rows:[{ordinal:1,status:'succeeded'},{ordinal:9,status:'succeeded'}]};
  if(sql.startsWith('SELECT status FROM ai_distill.step_attempts'))return{rows:[{status:'succeeded',execution_target:'server'}]};
  if(sql.startsWith('SELECT count(*)::int AS count FROM ai_distill.artifacts'))return{rows:[{count:2}]};
  if(sql.startsWith('SELECT storage_path,sha256 FROM ai_distill.materials'))return{rows:[{storage_path:storagePath,sha256:sha}]};
  return{rows:[]};
 }} as unknown as Pool;
 const app=new Hono();registerRemoteMaterialRoutes(app,pool,root,'x'.repeat(32),true);
 try{
  const response=await app.request(`/api/remote-material-operations/${id}/materials/${materialId}/download`,{headers:{Authorization:`Bearer ${'x'.repeat(32)}`}});
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  await unlink(join(root,storagePath));
  const missing=await app.request(`/api/remote-material-operations/${id}/materials/${materialId}/download`,{headers:{Authorization:`Bearer ${'x'.repeat(32)}`}});
  expect(missing.status).toBe(404);
 }finally{await rm(root,{recursive:true,force:true});}
});
