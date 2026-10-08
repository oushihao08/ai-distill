import { createPool } from '../server/db';
import { createApp } from '../server/app';
import { runNextExtraction } from '../server/materials/jobs';
import { processMaterials } from '../server/materials/process';
import type { Pool } from 'pg';
import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const pool = createPool();
const schema = `test_versions_${crypto.randomUUID().replaceAll('-', '')}`;
const root = await mkdtemp(join(tmpdir(), 'ai-distill-versions-'));
const checks: { name: string; passed: boolean }[] = [];
const sql = (query: string) => query.replaceAll('ai_distill', schema);
const testPool = {
 query: async (query: string, values?: unknown[]) => {
  try { return await pool.query(sql(query), values); } catch (error) { throw error; }
 },
 connect: async () => {
  try {
   const client = await pool.connect();
   return { query: async (query: string, values?: unknown[]) => {
    try { return await client.query(sql(query), values); } catch (error) { throw error; }
   }, release: () => client.release() };
  } catch (error) { throw error; }
 },
} as unknown as Pool;
function check(name: string, passed: boolean) {
 checks.push({ name, passed });
 console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
 if (!passed) throw new Error(name);
}
try {
 for (const migration of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
  await pool.query(sql(await Bun.file(new URL(`../migrations/${migration}`, import.meta.url)).text()));
 }
 const app = createApp(testPool, root);
 const projectResponse = await app.request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'version integration fixture', material_root: root }) });
 check('project creation in isolated schema', projectResponse.status === 201);
 const project = await projectResponse.json() as { id: string };
 async function upload(content = 'first') {
  try {
   const form = new FormData(); form.append('title', 'fixture-题目 4'); form.append('source_key', '题目 4');
   form.append('files', new File([`%PDF-1.7\n${content}`], 'attachment.pdf'));
   const response = await app.request(`/api/projects/${project.id}/workflows`, { method: 'POST', body: form });
   if (![200, 201].includes(response.status)) throw new Error(`intake status ${response.status}`);
   return await response.json() as { id: string; reused?: boolean; updated?: boolean; input_revision: number };
  } catch (error) { throw error; }
 }
 const [first, repeated] = await Promise.all([upload(), upload()]);
 check('concurrent folder uploads share one workflow', first.id === repeated.id && (first.reused === true || repeated.reused === true));
 const workflowId = first.id;
 const queued = await (await app.request(`/api/workflows/${workflowId}/extract`, { method: 'POST' })).json() as { id: string };
 let release!: () => void; let started!: () => void;
 const processing = new Promise<void>(resolve => { started = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 const running = runNextExtraction(testPool, root, async (storage, workflow, attempt, materials) => {
  check('claimed attempt reads its exact input revision', materials.length === 1 && materials[0]!.sha256 === createHash('sha256').update('%PDF-1.7\nfirst').digest('hex'));
  started(); await gate;
  const relative = `${workflow}/${attempt}/materials.md`;
  await mkdir(join(storage, workflow, attempt), { recursive: true }); await writeFile(join(storage, relative), 'synthetic fixture');
  return { artifacts: [{ kind: 'redacted_markdown', storage_path: relative, sha256: createHash('sha256').update('synthetic fixture').digest('hex'), size_bytes: 17 }], result: { materials: [], pages: [], issues: [], redaction: 'synthetic orchestration fixture' }, blocked: false };
 }, workflowId);
 let updated;
 try { await processing; updated = await upload('second'); }
 finally { release(); await running; }
 check('changed source updates the same workflow identity', updated?.id === workflowId && updated.input_revision === 2 && updated.updated === true);
 const detail = await (await app.request(`/api/workflows/${workflowId}`)).json() as any;
 check('only current materials appear in workflow detail', detail.materials.length === 1 && detail.materials[0].sha256 === createHash('sha256').update('%PDF-1.7\nsecond').digest('hex'));
 check('late old result cannot publish into current steps', detail.steps[1].status === 'waiting' && detail.artifacts.length === 0 && detail.attempts.find((attempt: any) => attempt.id === queued.id)?.status === 'skipped');
 check('old input records remain traceable', (await testPool.query('SELECT count(*)::int AS count FROM ai_distill.materials WHERE workflow_id=$1', [workflowId])).rows[0].count === 2 && detail.attempts.some((attempt: any) => attempt.input_revision === 1));
 const current = await (await app.request(`/api/workflows/${workflowId}/extract`, { method: 'POST' })).json() as { id: string; reused: boolean };
 check('new revision gets a new extraction attempt', current.id !== queued.id && !current.reused);
 const unchanged = await upload('second');
 check('unchanged reimport preserves current queue', unchanged.reused === true && unchanged.input_revision === 2 && (await testPool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1', [current.id])).rows[0].status === 'waiting');
 const projectDetail = await (await app.request(`/api/projects/${project.id}`)).json() as any;
 check('project current-material count excludes historical revisions', projectDetail.workflows.length === 1 && projectDetail.workflows[0].material_count === 1);
 // Verify failed redaction is persisted without publishing text, then reuse private extraction.
 let parses=0;
 const extract=async()=>{parses++;return[{page:1,text:'公开资料',method:'ocr' as const}];};
 await runNextExtraction(testPool,root,async(storage,workflow,attempt,materials,_vision,_extract,config)=>{
  try{return await processMaterials(storage,workflow,attempt,materials,{recognize:async()=>{throw new Error('fixture should not call OCR');},entities:async()=>{throw new Error('脱敏实体无有效原文依据');}},extract,config);}catch(error){throw error;}
 },workflowId);
 const failed=await(await app.request(`/api/workflows/${workflowId}`)).json() as any;
 check('failed entity check publishes no text or public artifact',failed.steps[1].status==='failed'&&failed.artifacts.length===0&&failed.steps[1].result.pages.every((page:any)=>page.text===null));
 const cache=(await testPool.query("SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 AND kind='private_extracted_pages'",[current.id])).rows[0];
 check('failed extraction persists a private cache that cannot be downloaded',!!cache&&(await app.request(`/api/artifacts/${cache.id}/download`)).status===404);
 const retry=await(await app.request(`/api/workflows/${workflowId}/extract`,{method:'POST'})).json() as {id:string};
 check('retry creates a new attempt rather than rewriting failed history',retry.id!==current.id);
 await runNextExtraction(testPool,root,async(storage,workflow,attempt,materials,_vision,_extract,config)=>{
  try{return await processMaterials(storage,workflow,attempt,materials,{recognize:async()=>{throw new Error('fixture should not call OCR');},entities:async()=>[]},extract,config);}catch(error){throw error;}
 },workflowId);
 const recovered=await(await app.request(`/api/workflows/${workflowId}`)).json() as any;
 check('retry reuses failed attempt OCR with source and config fingerprints intact',parses===1&&recovered.steps[1].status==='succeeded'&&recovered.steps[1].result.materials[0].extraction.mode==='cached'&&recovered.steps[1].result.materials[0].extraction.from_attempt_id===current.id);
 check('recovery keeps the failed attempt and publishes only checked public outputs',recovered.attempts.find((attempt:any)=>attempt.id===current.id).status==='failed'&&recovered.artifacts.length===2);
} catch (error) {
 console.error('Input revision integration failed:', error instanceof Error && checks.some(check => check.name === error.message) ? error.message : 'runtime failure; credentials omitted');
 process.exitCode = 1;
} finally {
 try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { console.error('Temporary schema cleanup failed'); process.exitCode = 1; }
 await rm(root, { recursive: true, force: true }); await pool.end();
 await writeFile(new URL('../docs/evidence/input-version-results.json', import.meta.url), JSON.stringify({ date: new Date().toISOString(), scope: 'real PostgreSQL and API orchestration with synthetic PDF fixtures; no OCR or provider call', checks }, null, 2));
}
