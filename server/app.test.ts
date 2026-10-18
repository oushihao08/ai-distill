/** HTTP 应用路由集成：覆盖 PDF 接收校验、原子清理与幂等复用、题目目录版本、Codex 设置、跨域变更拒绝及错误响应；用于核对 createApp 装配的真实 HTTP 契约。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import { test, expect, afterEach, beforeEach } from 'bun:test';
import type { Pool } from 'pg';
import { mkdtemp, rm, readdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';
import {stepResultProjection,readWorkflowAttempts} from './workflow-view';
import {closeAgentConcurrencyGate,createAgentConcurrencyGate,readConcurrencySettings} from './concurrency';
import { validateFile } from './validation';
import { createHash } from 'node:crypto';
import{configureLogger}from'./logging';
import {STEP_REGISTRY} from '../shared/step-registry';
const directories: string[] = [];
let previousMineruKey:string|undefined;
beforeEach(()=>{previousMineruKey=process.env.MINERU_KEY;process.env.MINERU_KEY='fixture-only-no-network';});
afterEach(async () => { if(previousMineruKey===undefined)delete process.env.MINERU_KEY;else process.env.MINERU_KEY=previousMineruKey;try { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); } catch (error) { throw error; } });
function fakePool(options: { failMaterial?: boolean; previous?: string; materialMode?:'question_folders'|'material_packages'; source?: { id: string; deleted_at?:string|null; materials: { original_name: string; sha256: string }[] } } = {}) {
 const calls: { sql: string; values?: unknown[] }[] = [];
 let workflow=options.previous??options.source?.id;const storedMaterials:any[]=[];
 const client = { query: async (sql: string, values?: unknown[]) => {
  try {
   calls.push({ sql, values });
   if(sql.startsWith('SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND request_id'))return{rows:options.previous?[{id:options.previous}]:[],rowCount:options.previous?1:0};
   if(sql.startsWith('SELECT id,deleted_at FROM ai_distill.workflows WHERE project_id=$1 AND source_key'))return{rows:options.source?[options.source]:[],rowCount:options.source?1:0};
   if(sql.startsWith('SELECT id FROM ai_distill.workflows WHERE id='))return{rows:workflow?[{id:workflow}]:[],rowCount:workflow?1:0};
   if(sql.startsWith('SELECT original_name,sha256 FROM ai_distill.materials'))return{rows:options.source?.materials??[],rowCount:options.source?.materials.length??0};
   if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id:projectId}],rowCount:1};
   if(sql.startsWith('SELECT material_mode FROM ai_distill.projects'))return{rows:[{material_mode:options.materialMode??'question_folders'}],rowCount:1};
   if(sql.startsWith('INSERT INTO ai_distill.workflows'))workflow=values?.[0] as string;
   if(sql.startsWith('SELECT ordinal,status'))return{rows:STEP_REGISTRY.map(stage=>({ordinal:stage.ordinal,status:'waiting'})),rowCount:STEP_REGISTRY.length};
   if(sql.startsWith('SELECT count(*)::int AS total'))return{rows:[{total:storedMaterials.length||1,pdfs:storedMaterials.length||1}],rowCount:1};
   if(sql.startsWith('SELECT id,sha256 FROM ai_distill.materials'))return{rows:storedMaterials.length?storedMaterials:[{id:'material',sha256:'fixture'}],rowCount:storedMaterials.length||1};
   if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&(options.previous||options.source?.materials[0]?.sha256===createHash('sha256').update('%PDF-1.7\nintake fixture').digest('hex')))return{rows:[{id:'prior-extraction'}],rowCount:1};
   if(sql.startsWith('INSERT INTO ai_distill.materials'))storedMaterials.push({id:values?.[0],sha256:values?.[4]});
   if (options.failMaterial && sql.startsWith('INSERT INTO ai_distill.materials')) throw new Error('simulated failure');
   return { rows: [], rowCount: 0 };
  } catch (error) { throw error; }
 }, release() {} };
 return { pool: { connect: async () => { try { return client; } catch (error) { throw error; } } } as unknown as Pool, calls };
}
async function setup(options?: Parameters<typeof fakePool>[0]) {
 try { const dir = await mkdtemp(join(tmpdir(), 'ai-distill-')); directories.push(dir); const fake = fakePool(options); return { ...fake, dir, app: createApp(fake.pool, dir) }; } catch (error) { throw error; }
}
const projectId = '11111111-1111-4111-8111-111111111111';
function upload(files: File[], sourceKey?: string) {
 const form = new FormData(); form.append('title', '案件材料'); for (const file of files) form.append('files', file);
 if (sourceKey !== undefined) form.append('source_key', sourceKey);
 return new Request(`http://localhost/api/projects/${projectId}/workflows`, { method: 'POST', body: form, headers: { 'Idempotency-Key': '22222222-2222-4222-8222-222222222222' } });
}
const valid = () => new File(['%PDF-1.7\nintake fixture'], '卷宗.pdf', { type: 'application/pdf' });
test('材料包模式上传只登记材料包，不直接建立题目',async()=>{
 const {app,calls}=await setup({materialMode:'material_packages'});
 const response=await app.fetch(upload([new File(['fixture text'],'材料.txt',{type:'text/plain'})]));
 expect(response.status).toBe(201);
 const created=calls.find(call=>call.sql.startsWith('INSERT INTO ai_distill.workflows'));
 expect(created?.values?.at(-1)).toBe('material_package');
});
test('材料包有题目时拒绝删除，删除单题只更新本题',async()=>{
 const source='55555555-5555-4555-8555-555555555555';
 const question='66666666-6666-4666-8666-666666666666';
 const changes:{sql:string;values?:unknown[]}[]=[];
 const client={query:async(sql:string,values?:unknown[])=>{
  changes.push({sql,values});
  if(sql.startsWith('SELECT workflow_kind FROM ai_distill.workflows'))return{rows:[{workflow_kind:values?.[0]===source?'material_package':'question'}],rowCount:1};
  if(sql.startsWith('SELECT 1 FROM ai_distill.workflows WHERE source_workflow_id'))return{rows:[{id:question}],rowCount:1};
  return{rows:[],rowCount:1};
 },release:()=>{}};
 const app=createApp({connect:async()=>client} as unknown as Pool,'/tmp');
 expect((await app.fetch(new Request(`http://localhost/api/workflows/${source}`,{method:'DELETE'}))).status).toBe(409);
 expect(changes.some(call=>call.sql.startsWith('UPDATE ai_distill.workflows SET deleted_at'))).toBe(false);
 expect((await app.fetch(new Request(`http://localhost/api/workflows/${question}`,{method:'DELETE'}))).status).toBe(200);
 expect(changes.find(call=>call.sql.startsWith('UPDATE ai_distill.workflows SET deleted_at'))?.values).toEqual([question]);
});
test('已删除来源键不能通过再次上传把隐藏工作流当作新材料包',async()=>{
 const {app,calls}=await setup({materialMode:'material_packages',source:{id:'77777777-7777-4777-8777-777777777777',deleted_at:'2026-10-14T00:00:00Z',materials:[]}});
 const response=await app.fetch(upload([new File(['fixture text'],'材料.txt',{type:'text/plain'})],'材料A'));
 expect(response.status).toBe(409);
 expect(calls.some(call=>call.sql.startsWith('UPDATE ai_distill.workflows SET title'))).toBe(false);
});
test('reject disguised non-PDF instead of publishing intake success', () => {
 expect(() => validateFile(new File(['not pdf'], 'fake.pdf'), new TextEncoder().encode('not pdf'))).toThrow('PDF标识');
});
test('reject empty and oversized PDFs', () => {
 expect(() => validateFile(new File([], 'empty.pdf'), new Uint8Array())).toThrow('PDF标识');
 expect(() => validateFile(new File([new Uint8Array(50*1024*1024+1)], 'large.pdf'), new TextEncoder().encode('%PDF-'))).toThrow('50MB');
});
test('redacted-only attachment text response never includes extracted source text',async()=>{
 const workflowId='33333333-3333-4333-8333-333333333333',materialId='44444444-4444-4444-8444-444444444444';
 const extracted=JSON.stringify({format:'pdf',provider:'mineru',pages:[{page:1,text:'PRIVATE RAW TEXT'}]});
 const redacted=JSON.stringify({materials:[{material_id:materialId,markdown:'已脱敏正文',pages:[{page:1,text:'已脱敏正文'}]}]});
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 const pool={query:async(sql:string)=>{
  if(sql.includes('SELECT m.id,m.original_name,m.processing_status'))return{rows:[{id:materialId,original_name:'材料.pdf',processing_status:'redacted',sha256:hash('pdf')}]};
  if(sql.includes("ar.kind='private_extracted_pages'"))return{rows:[{content:extracted,sha256:hash(extracted)}]};
  if(sql.includes("idx.kind='redacted_index'"))return{rows:[{content:redacted,sha256:hash(redacted)}]};
  throw new Error(`Unexpected query: ${sql}`);
 }} as unknown as Pool;
 const dir=await mkdtemp(join(tmpdir(),'ai-distill-redacted-view-'));directories.push(dir);
 const app=createApp(pool,dir);
 const response=await app.fetch(new Request(`http://localhost/api/workflows/${workflowId}/materials/${materialId}/extracted-text?redacted_only=true`));
 expect(response.status).toBe(200);
 const body=await response.json() as Record<string,unknown>;
 expect(body).toMatchObject({redaction_status:'redacted',redacted_text:'已脱敏正文'});
 expect(JSON.stringify(body)).not.toContain('PRIVATE RAW TEXT');
 expect(body.pages).toBeUndefined();
});
test('save multiple PDFs with unique storage names and PDF intake waiting for extraction with stable stage identities', async () => {
 try {
  const { app, dir, calls } = await setup();
  const response = await app.fetch(upload([valid(), valid()])); expect(response.status).toBe(201);
  const { id } = await response.json() as { id: string };
  expect((await readdir(join(dir, id))).length).toBe(2);
  const steps = calls.filter(c => c.sql.startsWith('INSERT INTO ai_distill.steps'));
  expect(steps).toHaveLength(STEP_REGISTRY.length); expect(steps[0]?.values?.[3]).toBe('waiting');
  for(const [i,step] of steps.entries()){expect(step.values?.[1]).toBe(STEP_REGISTRY[i]!.ordinal);expect(step.values?.[4]).toBe(STEP_REGISTRY[i]!.defaultEnabled);if(i)expect(step.values?.[5]).toBeNull();}
  expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
 } catch (error) { throw error; }
});
test('invalid second PDF rolls back all metadata and removes first saved file', async () => {
 try {
  const { app, dir, calls } = await setup(); const response = await app.fetch(upload([valid(), new File(['bad'], 'fake.pdf')]));
  expect(response.status).toBe(400); expect((await readdir(dir)).filter(name=>name!=='.concurrency')).toHaveLength(0);
  expect(calls.some(c => c.sql === 'ROLLBACK')).toBe(true); expect(calls.some(c => c.sql === 'COMMIT')).toBe(false);
 } catch (error) { throw error; }
});
test('database failure removes unpublished file and gives a bounded error', async () => {
 try {
  const { app, dir, calls } = await setup({ failMaterial: true }); const response = await app.fetch(upload([valid()]));
  expect(response.status).toBe(500); expect((await readdir(dir)).filter(name=>name!=='.concurrency')).toHaveLength(0); expect(calls.some(c => c.sql === 'ROLLBACK')).toBe(true);
  expect(await response.text()).not.toContain('simulated failure');
 } catch (error) { throw error; }
});
test('identical request returns prior workflow without writing more files', async () => {
 try {
  const { app, dir, calls } = await setup({ previous: projectId }); const response = await app.fetch(upload([valid()]));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ id: projectId, reused: true }); expect((await readdir(dir)).filter(name=>name!=='.concurrency')).toHaveLength(0);
  expect(calls.some(c => c.sql.startsWith('INSERT'))).toBe(false);
 } catch (error) { throw error; }
});
test('unchanged question folder reuses its workflow across different upload requests', async () => {
 const hash = createHash('sha256').update('%PDF-1.7\nintake fixture').digest('hex');
 const { app, dir, calls } = await setup({ source: {id: projectId,materials: [{ original_name: '卷宗.pdf', sha256: hash }] } });
 const response = await app.fetch(upload([valid()], '题目 4'));
 expect(response.status).toBe(200);
 expect(await response.json()).toEqual({id: projectId,reused: true });
 expect((await readdir(dir)).filter(name=>name!=='.concurrency')).toHaveLength(0);
 expect(calls.some(c => c.sql.startsWith('INSERT'))).toBe(false);
});
test('changed question folder keeps the workflow identity and preserves old input history', async () => {
 const { app, dir, calls } = await setup({ source: {id: projectId,materials: [{ original_name: '卷宗.pdf', sha256: 'old-hash' }] } });
 const response = await app.fetch(upload([valid()], '题目 4'));
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({id: projectId,updated: true });
 expect(calls.some(c => c.sql.startsWith('INSERT INTO ai_distill.workflows'))).toBe(false);
 expect(calls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
 expect(calls.some(c => c.sql.startsWith("UPDATE ai_distill.steps SET status='waiting',result=NULL") && c.values?.[0]===projectId)).toBe(true);
 const material = calls.find(c => c.sql.startsWith('INSERT INTO ai_distill.materials'));
 expect(material?.values?.at(-1)).toBe('received');
 expect(await readdir(join(dir, projectId))).toHaveLength(1);
});
test('question folder key is validated and stored on the workflow', async () => {
 const invalid = await setup();
 expect((await invalid.app.fetch(upload([valid()], '../题目 4'))).status).toBe(400);
 expect(invalid.calls.some(c => c.sql.startsWith('INSERT'))).toBe(false);
 const validSetup = await setup();
 expect((await validSetup.app.fetch(upload([valid()], '题目 4'))).status).toBe(201);
 expect(validSetup.calls.find(c => c.sql.startsWith('INSERT INTO ai_distill.workflows'))?.values).toContain('题目 4');
});
test('malformed ID and cross-origin mutations are rejected before DB access', async () => {
 try {
  const { app, calls } = await setup();
  expect((await app.request('/api/projects/not-an-id')).status).toBe(400);
  expect((await app.request('/api/projects', { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
  expect(calls).toHaveLength(0);
 } catch (error) { throw error; }
});

test('project deletion removes library snapshot references before artifacts and retains archive audit events',async()=>{
 const statements:string[]=[];
 const client={query:async(sql:string)=>{
  statements.push(sql);
  if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id:projectId}],rowCount:1};
  if(sql.startsWith('SELECT pg_try_advisory_xact_lock'))return{rows:[{acquired:true}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return{rows:[{id:'workflow'}],rowCount:1};
  if(sql.includes('to_regclass(\'ai_distill.question_library_sources\')'))return{rows:[{available:true}],rowCount:1};
  return{rows:[],rowCount:1};
 },release(){}};
 const pool={connect:async()=>client,query:client.query} as unknown as Pool,app=createApp(pool,tmpdir());
 const response=await app.request(`/api/projects/${projectId}`,{method:'DELETE'});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({deleted:true});
 const detachSource=statements.findIndex(sql=>sql.startsWith('DELETE FROM ai_distill.question_library_sources'));
 const deleteArtifacts=statements.findIndex(sql=>sql.startsWith('DELETE FROM ai_distill.artifacts'));
 expect(detachSource).toBeGreaterThan(-1);expect(detachSource).toBeLessThan(deleteArtifacts);
 expect(statements.some(sql=>sql.startsWith('UPDATE ai_distill.project_library_packages SET removed_at'))).toBe(true);
 expect(statements.some(sql=>sql.startsWith('DELETE FROM ai_distill.workflow_publication_events'))).toBe(false);
});

test('project deletion remains compatible before the optional library schema is installed',async()=>{
 const statements:string[]=[];
 const client={query:async(sql:string)=>{
  statements.push(sql);
  if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id:projectId}],rowCount:1};
  if(sql.startsWith('SELECT pg_try_advisory_xact_lock'))return{rows:[{acquired:true}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return{rows:[],rowCount:0};
  if(sql.includes('to_regclass(\'ai_distill.question_library_sources\')'))return{rows:[{available:false}],rowCount:1};
  return{rows:[],rowCount:1};
 },release(){}};
 const pool={connect:async()=>client,query:client.query} as unknown as Pool,app=createApp(pool,tmpdir());
 const response=await app.request(`/api/projects/${projectId}`,{method:'DELETE'});
 expect(response.status).toBe(200);
 expect(statements.some(sql=>sql.startsWith('UPDATE ai_distill.project_library_packages'))).toBe(false);
 expect(statements.some(sql=>sql.startsWith('DELETE FROM ai_distill.question_library_sources'))).toBe(false);
});


test('unscored timeout projections expose only aggregate evidence, never answer or reasoning text',async()=>{
 const projection=stepResultProjection('s',false);
 expect(projection).toContain("'outcome',m->'outcome'");
 expect(projection).toContain("'reason_code',m->'reason_code'");
 expect(projection).toContain("'generation_activity',m->'generation_activity'");
 expect(projection).not.toContain("m->'answer'");
 expect(projection).not.toContain("m->'reasoning_text'");
 let sql='';
 await readWorkflowAttempts({query:async(query:string)=>{sql=query;return{rows:[],rowCount:0};}} as unknown as Pool,'workflow',false);
 expect(sql).toContain("a.result->'outcome'");
 expect(sql).toContain("a.result->'generation_activity'");
 expect(sql).not.toContain("a.result->'text'");
});

test('results library lists only current accepted workflows with safe summary fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'results-library-api-'));directories.push(root);
 const logger=configureLogger({root,service:'api'});
 const row={workflow_id:'33333333-3333-4333-8333-333333333333',project_id:projectId,project_name:'示例项目',title:'示例题目',source_key:'题目1',created_at:'2026-10-10T00:00:00.000Z',current_question_version:'q1',current_rubric_version:'r1',acceptance_result:{decision:'accepted',model_scores:{}},answer_models:[],publication_status:'succeeded',exported:true};
 try{
  const pool={query:async(sql:string)=>{expect(sql).toContain("acceptance.result->>'decision'='accepted'");return{rows:[row],rowCount:1};}} as unknown as Pool;
  const response=await createApp(pool,root).request('/api/results');
  expect(response.status).toBe(200);expect(await response.json()).toEqual([row]);
 }finally{await logger.close();}
});

test('Codex settings API exposes local suggestions and rejects malformed reasoning settings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-settings-api-'));directories.push(root);
 const logger=configureLogger({root,service:'api'});
 const previousHome=process.env.CODEX_HOME;process.env.CODEX_HOME=root;
 try{
  await Bun.write(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-test',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}]}));
  let config={credential_home:null as string|null,model:'gpt-test',reasoning_effort:'low'};
  const query=async(sql:string,values?:unknown[])=>{
   if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{...config}],rowCount:1};
   if(sql.startsWith('INSERT INTO ai_distill.system_codex_config')){config={credential_home:values?.[0] as string|null,model:values?.[1] as string,reasoning_effort:values?.[2] as string};return{rows:[{...config}],rowCount:1};}
   throw new Error(`Unexpected query: ${sql}`);
  };
  const pool={query,connect:async()=>{throw new Error('unexpected connection')}} as unknown as Pool;
  const app=createApp(pool,root);
  const loaded=await app.request('/api/codex/config');
  expect(loaded.status).toBe(200);expect(loaded.headers.get('X-Request-ID')).toBeTruthy();expect(await loaded.json()).toMatchObject({model:'gpt-test',reasoning_effort:'low',model_options:[{slug:'gpt-test',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}]});
  const invalid=await app.request('/api/codex/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential_home:null,model:'gpt-test',reasoning_effort:'bad effort'})});
  expect(invalid.status).toBe(400);expect(config.reasoning_effort).toBe('low');
  const saved=await app.request('/api/agent/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential_home:null,model:'gpt-test',reasoning_effort:'high'})});
  expect(saved.status).toBe(200);expect(await saved.json()).toMatchObject({model:'gpt-test',reasoning_effort:'high'});expect(config.reasoning_effort).toBe('high');
  await logger.flush();expect(await readdir(join(root,'logs')).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).toEqual([]);
 }finally{await logger.close();if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
});
test('Agent model catalog follows the configured credentials directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-model-catalog-api-'));directories.push(root);
 const credentialHome=await mkdtemp(join(tmpdir(),'agent-credential-home-'));directories.push(credentialHome);
 const logger=configureLogger({root,service:'api'});const previousHome=process.env.CODEX_HOME;process.env.CODEX_HOME=root;
 try{
  await Bun.write(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'default-model',supported_reasoning_levels:[{effort:'low'}]}]}));
  await Bun.write(join(credentialHome,'models_cache.json'),JSON.stringify({models:[{slug:'credential-home-model',supported_reasoning_levels:[{effort:'high'}]}]}));
  let config:{credential_home:string|null;model:string;reasoning_effort:string}={credential_home:credentialHome,model:'credential-home-model',reasoning_effort:'high'};
  const query=async(sql:string,values?:unknown[])=>{
   if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{...config}],rowCount:1};
   if(sql.startsWith('INSERT INTO ai_distill.system_codex_config')){config={credential_home:values?.[0] as string|null,model:values?.[1] as string,reasoning_effort:values?.[2] as string};return{rows:[{...config}],rowCount:1};}
   if(sql.startsWith('INSERT INTO ai_distill.project_step_configs'))return{rows:[{config:{model:'credential-home-model',reasoning_effort:'high'}}],rowCount:1};
   throw new Error(`Unexpected query: ${sql}`);
  };
  const app=createApp({query,connect:async()=>{throw new Error('unexpected connection')}} as unknown as Pool,root);
  const response=await app.request('/api/agent/config');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({credential_home:credentialHome,model_options:[{slug:'credential-home-model',supported_reasoning_levels:[{effort:'high'}]}]});
  const saved=await app.request('/api/agent/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential_home:credentialHome,model:'credential-home-model',reasoning_effort:'high'})});
  expect(saved.status).toBe(200);expect(await saved.json()).toMatchObject({model_options:[{slug:'credential-home-model'}]});
  const step=await app.request('/api/agent/projects/11111111-1111-4111-8111-111111111111/steps/4/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'credential-home-model',reasoning_effort:'high'})});
  expect(step.status).toBe(200);
 }finally{await logger.close();if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
});
test('project Codex settings inherit system defaults and can be overridden or reset',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-codex-settings-api-'));directories.push(root);
 const logger=configureLogger({root,service:'api'});
 const previousHome=process.env.CODEX_HOME;process.env.CODEX_HOME=root;
 try{
  await Bun.write(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-project',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}]}));
  let project:{codex_model:string|null;codex_reasoning_effort:string|null}={codex_model:null,codex_reasoning_effort:null};
  const query=async(sql:string,values?:unknown[])=>{
   if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{...project}],rowCount:1};
   if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'gpt-system',reasoning_effort:'low'}],rowCount:1};
   if(sql.startsWith('UPDATE ai_distill.projects SET codex_model=$2')){project={codex_model:values?.[1] as string,codex_reasoning_effort:values?.[2] as string};return{rows:[{...project}],rowCount:1};}
   if(sql.startsWith('UPDATE ai_distill.projects SET codex_model=NULL')){project={codex_model:null,codex_reasoning_effort:null};return{rows:[{id:'project'}],rowCount:1};}
   throw new Error(`Unexpected query: ${sql}`);
  };
  const app=createApp({query,connect:async()=>{throw new Error('unexpected connection')}} as unknown as Pool,root);
  const inherited=await app.request('/api/projects/11111111-1111-4111-8111-111111111111/codex-settings');
  expect(inherited.status).toBe(200);expect(await inherited.json()).toEqual({model:'gpt-system',reasoning_effort:'low',source:'system'});
  const saved=await app.request('/api/projects/11111111-1111-4111-8111-111111111111/agent-settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-project',reasoning_effort:'high'})});
  expect(saved.status).toBe(200);expect(await saved.json()).toEqual({model:'gpt-project',reasoning_effort:'high',source:'project'});
  const reset=await app.request('/api/projects/11111111-1111-4111-8111-111111111111/agent-settings',{method:'DELETE'});
  expect(reset.status).toBe(200);expect(await reset.json()).toEqual({model:'gpt-system',reasoning_effort:'low',source:'system'});
  await logger.flush();expect(await readdir(join(root,'logs')).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).toEqual([]);
 }finally{await logger.close();if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
});

test('agent step settings endpoint exposes Codex model overrides through the Agent module',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-step-settings-api-'));directories.push(root);
 const logger=configureLogger({root,service:'api'});const previousHome=process.env.CODEX_HOME;process.env.CODEX_HOME=root;
 try{
  await Bun.write(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-agent',supported_reasoning_levels:[{effort:'low'}]}]}));
  const app=createApp({query:async(sql:string)=>{
   if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'gpt-agent',reasoning_effort:'low'}],rowCount:1};
   if(sql.startsWith('INSERT INTO ai_distill.project_step_configs'))return{rows:[{config:{model:'gpt-agent',reasoning_effort:'low'}}],rowCount:1};
   throw new Error(`Unexpected query: ${sql}`);
  },connect:async()=>{throw new Error('unexpected connection')}} as unknown as Pool,root);
  const response=await app.request('/api/agent/projects/11111111-1111-4111-8111-111111111111/steps/4/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-agent',reasoning_effort:'low'})});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({config:{model:'gpt-agent',reasoning_effort:'low'}});
  const unrelated=await app.request('/api/agent/projects/11111111-1111-4111-8111-111111111111/steps/7/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  expect(unrelated.status).toBe(404);
 }finally{if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;await logger.close();}
});

test('Agent connection check respects the shared concurrency limit when all slots are occupied',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-concurrency-api-'));directories.push(root);
 const logger=configureLogger({root,service:'api'});
 const holder=createAgentConcurrencyGate(root,readConcurrencySettings().agent);
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const occupied=Array.from({length:holder.limit},()=>holder.run(()=>held));
 try{
  const pool={
   query:async(sql:string)=>{
    if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'gpt-test',reasoning_effort:'low'}],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
   },
   connect:async()=>{throw new Error('unexpected connection')},
  } as unknown as Pool;
  const app=createApp(pool,root);
  const response=await app.request('/api/agent/test',{method:'POST'});
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error:'Agent 当前并发已满，请稍后重试'});
 }finally{release();await Promise.all(occupied);closeAgentConcurrencyGate(root);holder.close();await logger.close();}
});

test('project batch dispatch accepts the decision step and chunks all project workflows by configuration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-batch-api-'));directories.push(root);
 const logger=configureLogger({root,service:'api'});
 const previousChunkSize=process.env.BATCH_DISPATCH_CHUNK_SIZE;process.env.BATCH_DISPATCH_CHUNK_SIZE='2';
 const workflowIds=['11111111-1111-4111-8111-111111111101','11111111-1111-4111-8111-111111111102','11111111-1111-4111-8111-111111111103','11111111-1111-4111-8111-111111111104','11111111-1111-4111-8111-111111111105'];
 const stateBatches:string[][]=[];
 try{
  const pool={query:async(sql:string,values?:unknown[])=>{
   if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id:projectId}],rowCount:1};
   if(sql.startsWith('SELECT id,project_id FROM ai_distill.workflows WHERE project_id=$1'))return{rows:workflowIds.map(id=>({id,project_id:projectId})),rowCount:workflowIds.length};
   if(sql.startsWith('SELECT w.id AS workflow_id')){stateBatches.push(values?.[1] as string[]);return{rows:[],rowCount:0};}
   throw new Error(`Unexpected query: ${sql}`);
  },connect:async()=>{throw new Error('unexpected connection')}} as unknown as Pool;
  const app=createApp(pool,root);
  const response=await app.request(`/api/projects/${projectId}/steps/7/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  expect(response.status).toBe(202);
  expect((await response.json()).results).toEqual(workflowIds.map(workflow_id=>({workflow_id,status:'not_ready',reason:'此题目缺少当前步骤记录'})));
  expect(stateBatches.map(batch=>batch.length)).toEqual([2,2,1]);
  expect((await app.request(`/api/projects/${projectId}/steps/10/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(400);
 }finally{if(previousChunkSize===undefined)delete process.env.BATCH_DISPATCH_CHUNK_SIZE;else process.env.BATCH_DISPATCH_CHUNK_SIZE=previousChunkSize;await logger.close();}
});

test('answer generation policy GET is read-only and PUT preserves provider settings across step config updates',async()=>{
 const root=await mkdtemp(join(tmpdir(),'answer-generation-policy-api-'));directories.push(root);
 const logger=configureLogger({root,service:'api'});
 const policy={request_timeout_ms:3_600_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:false};
 let config:Record<string,unknown>={provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',answer_generation_policy:policy};
 const calls:{sql:string;values?:unknown[]}[]=[];
 const query=async(sql:string,values?:unknown[])=>{
  calls.push({sql,values});
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id:projectId}],rowCount:1};
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:[{config}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.project_step_configs')){
   const incoming=JSON.parse(String(values?.[2])) as Record<string,unknown>;
   config=Object.hasOwn(incoming,'answer_generation_policy')?incoming:sql.includes('answer_generation_policy')?{...incoming,...(config.answer_generation_policy?{answer_generation_policy:config.answer_generation_policy}:{})}:incoming;
   return{rows:[{config}],rowCount:1};
  }
  throw new Error(`Unexpected query: ${sql}`);
 };
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 try{
  const app=createApp(pool,root);
  const initial=await app.request(`/api/projects/${projectId}/answer-generation-policy`);
  expect(initial.status).toBe(200);expect(await initial.json()).toEqual({request_timeout_minutes:60,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:false,source:'project'});
  expect(calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false);
  const unverified=await app.request(`/api/projects/${projectId}/answer-generation-policy`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_timeout_minutes:75,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:true})});
  expect(unverified.status).toBe(400);expect(await unverified.json()).toMatchObject({error:'供应商／模型的推理流连续性尚未验证，自动免评分暂不可用'});expect(config).toMatchObject({answer_generation_policy:{skip_scoring_on_qualified_timeout:false}});
  const saved=await app.request(`/api/projects/${projectId}/answer-generation-policy`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_timeout_minutes:75,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:false})});
  const savedBody=await saved.json();expect({status:saved.status,body:savedBody,queries:calls.map(call=>call.sql)}).toMatchObject({status:200,body:{request_timeout_minutes:75,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:false,source:'project'}});
  expect(config).toMatchObject({provider:'qwen',model:'qwen/qwen-plus',answer_generation_policy:{request_timeout_ms:4_500_000,reasoning_threshold_ms:2_700_000,skip_scoring_on_qualified_timeout:false}});
  const providerUpdate=await app.request(`/api/projects/${projectId}/steps/5/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-turbo'})});
  expect(providerUpdate.status).toBe(200);expect(config).toMatchObject({model:'qwen/qwen-turbo',answer_generation_policy:{request_timeout_ms:4_500_000,skip_scoring_on_qualified_timeout:false}});
  const invalid=await app.request(`/api/projects/${projectId}/answer-generation-policy`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_timeout_minutes:45,reasoning_threshold_minutes:45,skip_scoring_on_qualified_timeout:true})});
  expect(invalid.status).toBe(400);expect(config).toMatchObject({answer_generation_policy:{request_timeout_ms:4_500_000,skip_scoring_on_qualified_timeout:false}});
 }finally{await logger.close();}
});

test('DOCX redaction declaration is SHA-bound and invalidates current downstream results',async()=>{
 const root=await mkdtemp(join(tmpdir(),'docx-redaction-mode-api-'));directories.push(root);
 const workflowId='33333333-3333-4333-8333-333333333333',materialId='44444444-4444-4444-8444-444444444444',sourceSha='a'.repeat(64);
 const calls:{sql:string;values?:unknown[]}[]=[];
 let mode='model';
 const client={query:async(sql:string,values?:unknown[])=>{
  calls.push({sql,values});
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[],rowCount:1};
  if(sql.startsWith('SELECT w.id,w.project_id,w.workflow_kind,w.source_workflow_id'))return{rows:[{id:workflowId,project_id:projectId,workflow_kind:'question',source_workflow_id:null}],rowCount:1};
  if(sql.startsWith('SELECT id,original_name,sha256,redaction_mode'))return{rows:[{id:materialId,original_name:'材料.docx',sha256:sourceSha,redaction_mode:mode}],rowCount:1};
  if(sql.startsWith('UPDATE ai_distill.materials SET redaction_mode'))mode=String(values?.[1]);
  return{rows:[],rowCount:1};
 },release(){}};
 const pool={connect:async()=>client} as unknown as Pool;
 const app=createApp(pool,root);
 const response=await app.request(`/api/workflows/${workflowId}/materials/${materialId}/redaction-mode`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'declared_redacted',source_sha256:sourceSha})});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({redaction_mode:'declared_redacted',changed:true});
 expect(mode).toBe('declared_redacted');
 expect(calls.some(call=>call.sql.startsWith('UPDATE ai_distill.step_attempts')&&String(call.values?.[0])===workflowId)).toBe(true);
 expect(calls.some(call=>call.sql.startsWith('UPDATE ai_distill.steps')&&String(call.values?.[0])===workflowId)).toBe(true);
 expect(calls.some(call=>call.sql.startsWith('UPDATE ai_distill.project_exports')&&call.values?.[1]===workflowId)).toBe(true);
});

test('DOCX redaction declaration rejects stale fingerprints and non-DOCX without invalidation',async()=>{
 for(const material of [{original_name:'材料.docx',sha256:'b'.repeat(64)},{original_name:'材料.pdf',sha256:'a'.repeat(64)}]){
  const root=await mkdtemp(join(tmpdir(),'docx-redaction-mode-reject-'));directories.push(root);
  const workflowId='33333333-3333-4333-8333-333333333333',materialId='44444444-4444-4444-8444-444444444444',calls:string[]=[];
  const client={query:async(sql:string)=>{calls.push(sql);if(sql.startsWith('SELECT w.id,w.project_id,w.workflow_kind,w.source_workflow_id'))return{rows:[{id:workflowId,project_id:projectId,workflow_kind:'question',source_workflow_id:null}],rowCount:1};if(sql.startsWith('SELECT id,original_name,sha256,redaction_mode'))return{rows:[{id:materialId,...material,redaction_mode:'model'}],rowCount:1};return{rows:[],rowCount:1};},release(){}};
  const response=await createApp({connect:async()=>client} as unknown as Pool,root).request(`/api/workflows/${workflowId}/materials/${materialId}/redaction-mode`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'declared_redacted',source_sha256:'a'.repeat(64)})});
  expect(response.status).toBe(material.original_name.endsWith('.pdf')?400:409);
  expect(calls.some(sql=>sql.startsWith('UPDATE ai_distill.step_attempts')||sql.startsWith('UPDATE ai_distill.steps')||sql.startsWith('UPDATE ai_distill.materials SET redaction_mode'))).toBe(false);
 }
});
