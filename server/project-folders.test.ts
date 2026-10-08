import {validateCodexModel} from './codex/models';
import type { PoolClient } from 'pg';
import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProjectFolder, validateFolder, validateStepConfig, registerQuestionFolders } from './project-folders';
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
test('PDF model settings reject unverified model protocols',()=>{
 expect(()=>validateStepConfig(2,{model:'unknown-vision-model',reasoning_effort:'low'})).toThrow('模型');
});
test('step 5 accepts native providers without accepting arbitrary keys',()=>{
 expect(validateStepConfig(5,{provider:'deepseek',model:'explicit-model'})).toMatchObject({provider:'deepseek',base_url:'https://api.deepseek.com',model:'explicit-model'});
 expect(()=>validateStepConfig(5,{provider:'deepseek',model:'explicit-model',enable_thinking:true})).toThrow();
 expect(()=>validateStepConfig(5,{provider:'kimi',model:'explicit-model',api_key:'secret'})).toThrow();
});
