/** 项目目录与步骤配置：覆盖目录校验、题目清单稳定性、批量注册唯一性、步骤就绪与达标后发布门槛、供应商参数及 Codex 设置继承。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {validateCodexModel} from './codex/models';
import type { Pool,PoolClient } from 'pg';
import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProjectFolder, validateFolder, validateStepConfig, validateStepConfigForExecution, registerQuestionFolders,projectStepSummary,isWorkflowStepReady,splitIntoBatches,readBatchChunkSize } from './project-folders';
const roots: string[] = [];
afterEach(async () => { try { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); } catch (error) { throw error; } });
test('folder is required, absolute and readable', async () => {
 for (const value of ['', 'relative', '/missing-ai-distill-fixture']) await expect(validateFolder(value)).rejects.toThrow();
 const root = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(root);
 expect(await validateFolder(root)).toBe(await realpath(root));
});
test('each direct question directory gets a stable manifest; nested PDFs stay in their question', async () => {
 const root = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(root);
 await mkdir(join(root, '题目 1', '补充'), { recursive: true }); await mkdir(join(root, '题目 2'));
 await writeFile(join(root, '题目 1', 'a.pdf'), '%PDF-a'); await writeFile(join(root, '题目 1', '补充', 'a.pdf'), '%PDF-b');
 await writeFile(join(root, '题目 2', 'bad.pdf'), 'broken'); await writeFile(join(root, '说明.md'), 'ignored');
 const result = await scanProjectFolder(root);
 expect(result.map(q => q.key)).toEqual(['题目 1', '题目 2']);
 expect(result[0]?.files.map(f => f.name)).toEqual(['a.pdf', '补充/a.pdf']);
 expect(result[0]?.files.every(f => f.sha256.length === 64)).toBe(true);
 expect(result[1]?.files).toHaveLength(1); // invalid PDF belongs to its own failing intake, not a failed project
 await symlink('/tmp', join(root, '题目 1', 'outside'));
 expect((await scanProjectFolder(root))[0]?.files).toHaveLength(2);
});
test('step configuration accepts the correct provider and rejects unsupported parameters', () => {
 expect(validateStepConfig(2, { model: 'glm-5.3-flash', reasoning_effort: 'low' })).toEqual({ provider: 'zhipu', model: 'glm-5.3-flash', reasoning_effort: 'low' });
 expect(() => validateStepConfig(2, { provider: 'codex', model: 'x' })).toThrow();
 expect(() => validateStepConfig(4, { model: 'gpt-6.1-sol', reasoning_effort: 'invalid' })).toThrow();
 expect(() => validateStepConfig(1, { model: 'x' })).toThrow();
});

test('saved Codex step settings are not blocked by a stale advertised model catalog at dispatch',()=>{
 expect(validateStepConfigForExecution(4,{provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low'})).toMatchObject({provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low'});
});

test('registering 100 new question folders uses bulk writes and keeps unique identities',async()=>{
 const calls:{sql:string;values?:unknown[]}[]=[];
 const db={query:async(sql:string,values?:unknown[])=>{try{calls.push({sql,values});return {rows:[],rowCount:0};}catch(error){throw error;}}} as unknown as PoolClient;
 const result=await registerQuestionFolders(db,'11111111-1111-4111-8111-111111111111','project',Array.from({length:100},(_,i)=>({key:`题目 ${i+1}`,files:[]})));
 expect(result).toEqual({discovered:100,added:100,changed:0});expect(calls).toHaveLength(3);
 const inserted=JSON.parse(String(calls[1]?.values?.[1]));expect(new Set(inserted.map((row:any)=>row.id)).size).toBe(100);
});
test('Qwen step config validates endpoint-specific model and rejects secrets',()=>{
 expect(validateStepConfig(5,{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',max_tokens:100})).toEqual({provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',max_tokens:100});
 expect(()=>validateStepConfig(5,{base_url:'https://openrouter.ai/api/v1',model:'other/model'})).toThrow();
 expect(()=>validateStepConfig(5,{base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',api_key:'secret'})).toThrow();
});

test('Codex settings use actual advertised model efforts rather than a global effort list',()=>{
 const catalog=[{slug:'gpt-6-luna',supported_reasoning_levels:[{effort:'low'},{effort:'max'}]}];
 expect(()=>validateCodexModel('gpt-6-luna','max',catalog)).not.toThrow();
 expect(()=>validateCodexModel('gpt-6-luna','ultra',catalog)).toThrow('推理强度');
 expect(()=>validateCodexModel('unknown-model','low',catalog)).toThrow('模型');
 expect(()=>validateCodexModel('gpt-6-luna','low',[])).toThrow('模型清单');
});
test('unsaved Codex project steps inherit the system model and reasoning defaults',async()=>{
 const pool={query:async(sql:string)=>{
  if(sql.startsWith('SELECT w.id AS workflow_id'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT ordinal,config FROM ai_distill.project_step_configs'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{codex_model:null,codex_reasoning_effort:null}],rowCount:1};
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'gpt-system',reasoning_effort:'high'}],rowCount:1};
  throw new Error(`Unexpected query: ${sql}`);
 }} as unknown as Pool;
 const steps=await projectStepSummary(pool,'project');
 expect(steps.find(step=>step.ordinal===4)).toMatchObject({config:{provider:'codex',model:'gpt-system',reasoning_effort:'high'},config_source:'system'});
 expect(steps.find(step=>step.ordinal===6)).toMatchObject({config:{provider:'codex',model:'gpt-system',reasoning_effort:'high'},config_source:'system'});
 expect(steps.find(step=>step.ordinal===9)?.config).toMatchObject({provider:'codex',model:'gpt-system',reasoning_effort:'high',prompt:expect.any(String)});
});
test('project Codex defaults feed steps while an explicit step config remains highest priority',async()=>{
 const pool={query:async(sql:string)=>{
  if(sql.startsWith('SELECT w.id AS workflow_id'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT ordinal,config FROM ai_distill.project_step_configs'))return{rows:[{ordinal:4,config:{provider:'codex',model:'gpt-6-astra',reasoning_effort:'ultra'}}],rowCount:1};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{codex_model:'gpt-6-astra',codex_reasoning_effort:'ultra'}],rowCount:1};
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'gpt-system',reasoning_effort:'medium'}],rowCount:1};
  throw new Error(`Unexpected query: ${sql}`);
 }} as unknown as Pool;
 const steps=await projectStepSummary(pool,'project');
 expect(steps.find(step=>step.ordinal===4)).toMatchObject({config:{model:'gpt-6-luna',reasoning_effort:'max'},config_source:'step'});
 expect(steps.find(step=>step.ordinal===6)).toMatchObject({config:{model:'gpt-6-luna',reasoning_effort:'max'},config_source:'project'});
 expect(steps.find(step=>step.ordinal===9)).toMatchObject({config:{model:'gpt-6-luna',reasoning_effort:'max'},config_source:'project'});
});
test('PDF model settings reject unverified model protocols',()=>{
 expect(()=>validateStepConfig(2,{model:'unknown-vision-model',reasoning_effort:'low'})).toThrow('模型');
});
test('step 5 accepts native providers without accepting arbitrary keys',()=>{
 expect(validateStepConfig(5,{provider:'deepseek',model:'explicit-model'})).toMatchObject({provider:'deepseek',base_url:'https://api.deepseek.com',model:'explicit-model'});
 expect(()=>validateStepConfig(5,{provider:'deepseek',model:'explicit-model',enable_thinking:true})).toThrow();
 expect(()=>validateStepConfig(5,{provider:'kimi',model:'explicit-model',api_key:'secret'})).toThrow();
});

test('batch eligibility uses visible workflow order and ignores historical review ordinal 10',()=>{
 const steps=new Map<number,any>([
  [1,{ordinal:1,status:'succeeded',enabled:true,active:false,has_pdf:false}],
  [9,{ordinal:9,status:'succeeded',enabled:true,active:false}],
  [4,{ordinal:4,status:'succeeded',enabled:true,active:false}],
  [10,{ordinal:10,status:'waiting',enabled:true,active:false}],
  [5,{ordinal:5,status:'waiting',enabled:true,active:false}],
 ]);
 expect(isWorkflowStepReady(5,steps)).toBe(true);
});

test('batch eligibility and page summaries allow scoring after all model answers settle with at least one success',()=>{
 const steps=new Map<number,any>([
  [4,{ordinal:4,status:'succeeded',enabled:true,active:false}],
  [5,{ordinal:5,status:'failed',enabled:true,active:false,result:{models:[{status:'succeeded',attempt_id:'a'},{status:'failed'}]}}],
  [6,{ordinal:6,status:'waiting',enabled:true,active:false}],
 ]);
 expect(isWorkflowStepReady(6,steps)).toBe(true);
 steps.set(5,{...steps.get(5),result:{models:[{status:'succeeded',attempt_id:'a'},{status:'running'}]}});
 expect(isWorkflowStepReady(6,steps)).toBe(false);
});

test('publishing is ready only after the acceptance step has an accepted decision',()=>{
 const steps=new Map<number,any>([
  [7,{ordinal:7,status:'succeeded',enabled:true,active:false,result:{decision:'repair'}}],
  [8,{ordinal:8,status:'waiting',enabled:true,active:false}],
 ]);
 expect(isWorkflowStepReady(8,steps)).toBe(false);
 steps.set(7,{...steps.get(7),result:{decision:'accepted'}});
 expect(isWorkflowStepReady(8,steps)).toBe(true);
});

test('project batch work is split into the configured chunk size without dropping workflows',()=>{
 expect(splitIntoBatches([1,2,3,4,5],2)).toEqual([[1,2],[3,4],[5]]);
 expect(splitIntoBatches([],2)).toEqual([]);
 expect(()=>splitIntoBatches([1],0)).toThrow('批次大小');
 expect(readBatchChunkSize('')).toBe(100);
 expect(readBatchChunkSize('37')).toBe(37);
 for(const value of ['0','1001','1.5','invalid'])expect(()=>readBatchChunkSize(value)).toThrow('BATCH_DISPATCH_CHUNK_SIZE');
});
