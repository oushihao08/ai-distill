import { test, expect, afterEach } from 'bun:test';
import type { Pool } from 'pg';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';
import { validateFile } from './validation';
import { createHash } from 'node:crypto';
const directories: string[] = [];
afterEach(async () => { try { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); } catch (error) { throw error; } });
function fakePool(options: { failMaterial?: boolean; previous?: string; source?: { id: string; input_revision: number; materials: { original_name: string; sha256: string }[] } } = {}) {
 const calls: { sql: string; values?: unknown[] }[] = [];
 const client = { query: async (sql: string, values?: unknown[]) => {
  try {
   calls.push({ sql, values });
   if (sql.startsWith('SELECT id,input_revision FROM ai_distill.workflows')) return { rows: options.source ? [options.source] : [], rowCount: options.source ? 1 : 0 };
   if (sql.startsWith('SELECT original_name,sha256 FROM ai_distill.materials')) return { rows: options.source?.materials ?? [], rowCount: options.source?.materials.length ?? 0 };
   if (sql.startsWith('SELECT id FROM ai_distill.workflows')) return { rows: options.previous ? [{ id: options.previous }] : [], rowCount: options.previous ? 1 : 0 };
   if (sql.startsWith('SELECT id FROM ai_distill.projects')) return { rows: [{ id: 'project' }], rowCount: 1 };
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
test('reject disguised non-PDF instead of publishing intake success', () => {
 expect(() => validateFile(new File(['not pdf'], 'fake.pdf'), new TextEncoder().encode('not pdf'))).toThrow('PDF标识');
});
test('reject empty and oversized PDFs', () => {
 expect(() => validateFile(new File([], 'empty.pdf'), new Uint8Array())).toThrow('PDF标识');
 expect(() => validateFile(new File([new Uint8Array(30*1024*1024+1)], 'large.pdf'), new TextEncoder().encode('%PDF-'))).toThrow('30MB');
});
test('save multiple PDFs with unique storage names and stage one successful and extraction/answer executors available', async () => {
 try {
  const { app, dir, calls } = await setup();
  const response = await app.fetch(upload([valid(), valid()])); expect(response.status).toBe(201);
  const { id } = await response.json() as { id: string };
  expect((await readdir(join(dir, id))).length).toBe(2);
  const steps = calls.filter(c => c.sql.startsWith('INSERT INTO ai_distill.steps'));
  expect(steps).toHaveLength(8); expect(steps[0]?.values?.[3]).toBe('succeeded');
  expect(steps.slice(1).every((s,i) => s.values?.[3] === 'waiting' && s.values?.[4] === (i<=1 || i===3 || i===4) && s.values?.[5] === null)).toBe(true);
  expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
 } catch (error) { throw error; }
});
test('invalid second PDF rolls back all metadata and removes first saved file', async () => {
 try {
  const { app, dir, calls } = await setup(); const response = await app.fetch(upload([valid(), new File(['bad'], 'fake.pdf')]));
  expect(response.status).toBe(400); expect(await readdir(dir)).toHaveLength(0);
  expect(calls.some(c => c.sql === 'ROLLBACK')).toBe(true); expect(calls.some(c => c.sql === 'COMMIT')).toBe(false);
 } catch (error) { throw error; }
});
test('database failure removes unpublished file and gives a bounded error', async () => {
 try {
  const { app, dir, calls } = await setup({ failMaterial: true }); const response = await app.fetch(upload([valid()]));
  expect(response.status).toBe(500); expect(await readdir(dir)).toHaveLength(0); expect(calls.some(c => c.sql === 'ROLLBACK')).toBe(true);
  expect(await response.text()).not.toContain('simulated failure');
 } catch (error) { throw error; }
});
test('identical request returns prior workflow without writing more files', async () => {
 try {
  const { app, dir, calls } = await setup({ previous: projectId }); const response = await app.fetch(upload([valid()]));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ id: projectId, reused: true }); expect(await readdir(dir)).toHaveLength(0);
  expect(calls.some(c => c.sql.startsWith('INSERT'))).toBe(false);
 } catch (error) { throw error; }
});
test('unchanged question folder reuses its workflow across different upload requests', async () => {
 const hash = createHash('sha256').update('%PDF-1.7\nintake fixture').digest('hex');
 const { app, dir, calls } = await setup({ source: { id: projectId, input_revision: 2, materials: [{ original_name: '卷宗.pdf', sha256: hash }] } });
 const response = await app.fetch(upload([valid()], '题目 4'));
 expect(response.status).toBe(200);
 expect(await response.json()).toEqual({ id: projectId, reused: true, input_revision: 2 });
 expect(await readdir(dir)).toHaveLength(0);
 expect(calls.some(c => c.sql.startsWith('INSERT'))).toBe(false);
});
test('changed question folder keeps the workflow identity and preserves old input history', async () => {
 const { app, dir, calls } = await setup({ source: { id: projectId, input_revision: 2, materials: [{ original_name: '卷宗.pdf', sha256: 'old-hash' }] } });
 const response = await app.fetch(upload([valid()], '题目 4'));
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({ id: projectId, updated: true, input_revision: 3 });
 expect(calls.some(c => c.sql.startsWith('INSERT INTO ai_distill.workflows'))).toBe(false);
 expect(calls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
 expect(calls.some(c => c.sql.startsWith('UPDATE ai_distill.steps') && c.sql.includes('ordinal>1'))).toBe(true);
 const material = calls.find(c => c.sql.startsWith('INSERT INTO ai_distill.materials'));
 expect(material?.values?.at(-1)).toBe(3);
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

test('Codex settings API exposes local model options and rejects unsupported reasoning effort',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-settings-api-'));directories.push(root);
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
  expect(loaded.status).toBe(200);expect(await loaded.json()).toMatchObject({model:'gpt-test',reasoning_effort:'low',model_options:[{slug:'gpt-test',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}]});
  const invalid=await app.request('/api/codex/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential_home:null,model:'gpt-test',reasoning_effort:'max'})});
  expect(invalid.status).toBe(400);expect(config.reasoning_effort).toBe('low');
  const saved=await app.request('/api/codex/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential_home:null,model:'gpt-test',reasoning_effort:'high'})});
  expect(saved.status).toBe(200);expect(await saved.json()).toMatchObject({model:'gpt-test',reasoning_effort:'high'});expect(config.reasoning_effort).toBe('high');
 }finally{if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
});
test('project Codex settings inherit system defaults and can be overridden or reset',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-codex-settings-api-'));directories.push(root);
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
  const saved=await app.request('/api/projects/11111111-1111-4111-8111-111111111111/codex-settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-project',reasoning_effort:'high'})});
  expect(saved.status).toBe(200);expect(await saved.json()).toEqual({model:'gpt-project',reasoning_effort:'high',source:'project'});
  const reset=await app.request('/api/projects/11111111-1111-4111-8111-111111111111/codex-settings',{method:'DELETE'});
  expect(reset.status).toBe(200);expect(await reset.json()).toEqual({model:'gpt-system',reasoning_effort:'low',source:'system'});
 }finally{if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
});
