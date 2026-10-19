/** 验证目录扫描/批量登记、步骤设置与就绪规则；使用临时目录和 Pool 替身，合法 PDF 样本会调用本机 pdfinfo，不访问业务数据库或模型服务。 */
import {validateCodexModel} from './codex/models';
import type { Pool,PoolClient } from 'pg';
import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProjectFolder, validateFolder, validateStepConfig, validateStepConfigForExecution, registerQuestionFolders,projectStepSummary,readProjectWorkflowStepRows,isWorkflowStepReady,splitIntoBatches,readBatchChunkSize } from './project-folders';

test('ordinal 7 accepts a project-configured aggregation policy',()=>{
 expect(validateStepConfig(7,{aggregation:{mode:'mean_at_most',model_count:2,threshold:55}})).toEqual({aggregation:{mode:'mean_at_most',model_count:2,threshold:55}});
 expect(()=>validateStepConfig(7,{aggregation:{mode:'mean_at_most',model_count:2,threshold:55},required_models:['qwen']})).toThrow();
});

test('出题超时按步骤配置并限制范围，旧配置仍保持默认',()=>{
 const base={provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low',prompt:'出题'};
 expect(validateStepConfigForExecution(4,base)).not.toHaveProperty('timeout_ms');
 expect(validateStepConfigForExecution(4,{...base,timeout_ms:3600000})).toMatchObject({timeout_ms:3600000});
 for(const timeout_ms of [0,59999,7200001,1.5,'3600000'])expect(()=>validateStepConfigForExecution(4,{...base,timeout_ms})).toThrow();
});
import {STEP_REGISTRY} from '../shared/step-registry';
const roots: string[] = [];
test('项目评分 workflow 配置往返保留且默认钩子同步',()=>{
 const workflow={contract:'model_report_v1',rules_text:'按条目加扣分；否决单列。',reference_answer:'calibration',hooks:{before:[{id:'check',script:'hooks/check.ts',files:['hooks/check.ts'],params:{strict:true}}],after:[]}};
 const result=validateStepConfigForExecution(6,{provider:'api',api:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'test/model'},prompt:'按项目规则评分',workflow});
 expect(result).toMatchObject({workflow:{...workflow,hooks:{before:[{...workflow.hooks.before[0],mode:'sync',timeout_ms:60000,idempotent:false}],after:[]}}});
 expect(result).not.toHaveProperty('api.workflow');
});
test('项目 workflow 不接受未知契约或越界钩子路径',()=>{
 for(const workflow of [{contract:'unknown'},{contract:'model_report_v1',hooks:{before:[{id:'bad',script:'../bad.ts',files:['../bad.ts']}],after:[]}}]){
  expect(()=>validateStepConfigForExecution(4,{model:'test',reasoning_effort:'low',workflow})).toThrow();
 }
});
test('作答 workflow 与供应商配置分开校验并保留',()=>{
 const result=validateStepConfig(5,{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'test/fixture',workflow:{hooks:{before:[],after:[]}}});
 expect(result).toMatchObject({provider:'openrouter',workflow:{contract:'legacy',hooks:{before:[],after:[]}}});
});
test('作答 workflow 配置错误返回客户端错误而非服务器错误',()=>{
 let error:unknown;
 try{validateStepConfig(5,{provider:'openrouter',model:'test/fixture',workflow:{contract:'unknown'}});}catch(caught){error=caught;}
 expect(error).toHaveProperty('status',400);
});
afterEach(async () => { try { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); } catch (error) { throw error; } });
test('folder is required, absolute and readable', async () => {
 for (const value of ['', 'relative', '/missing-ai-distill-fixture']) await expect(validateFolder(value)).rejects.toThrow();
 const root = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(root);
 expect(await validateFolder(root)).toBe(await realpath(root));
});
test('each direct question directory gets a stable manifest; nested PDFs stay in their question', async () => {
 const root = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(root);
 await mkdir(join(root, '题目 1', '补充'), { recursive: true }); await mkdir(join(root, '题目 2'));
 // 目录扫描现在会读取PDF页数，fixture必须是真实PDF，不能用仅有文件头的坏文件冒充。
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'];
 let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,body] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 await writeFile(join(root,'题目 1','a.pdf'),pdf);await writeFile(join(root,'题目 1','补充','a.pdf'),pdf);await writeFile(join(root,'题目 2','b.pdf'),pdf);
 const result = await scanProjectFolder(root);
 expect(result.map(q => q.key)).toEqual(['题目 1', '题目 2']);
 expect(result[0]?.files.map(f => f.name)).toEqual(['a.pdf', '补充/a.pdf']);
 expect(result[0]?.files.every(f => f.sha256.length === 64)).toBe(true);
 expect(result[1]?.files).toHaveLength(1);
 await symlink('/tmp', join(root, '题目 1', 'outside'));
 expect((await scanProjectFolder(root))[0]?.files).toHaveLength(2);
});
test('step configuration accepts the correct provider and rejects unsupported parameters', () => {
 expect(()=>validateStepConfig(2,{model:'glm-5.3-flash',reasoning_effort:'low'})).toThrow('没有模型设置');
 expect(() => validateStepConfig(2, { provider: 'codex', model: 'x' })).toThrow();
 expect(() => validateStepConfig(4, { model: 'gpt-6.1-sol', reasoning_effort: 'bad effort' })).toThrow();
 expect(() => validateStepConfig(1, { model: 'x' })).toThrow();
});

test('评分步骤可选择 API 且仅冻结经验证的 API 连接参数',()=>{
 const config=validateStepConfig(6,{provider:'api',api:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen3.8-27b'},prompt:'逐项评分'});
 expect(config).toEqual({provider:'api',api:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen3.8-27b'},prompt:'逐项评分'});
 expect(()=>validateStepConfig(6,{provider:'api',api:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen3.8-27b',api_key:'secret'},prompt:'逐项评分'})).toThrow();
 expect(validateStepConfigForExecution(6,{provider:'api',api:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen3.8-27b'},prompt:'逐项评分'})).toMatchObject({provider:'api'});
});

test('saved Codex step settings are not blocked by a stale advertised model catalog at dispatch',()=>{
 expect(validateStepConfigForExecution(4,{provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low'})).toMatchObject({provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low'});
});

test('registering 100 folders keeps unique workflow and stable step identities',async()=>{
 const calls:{sql:string;values?:unknown[]}[]=[];
 const db={query:async(sql:string,values?:unknown[])=>{try{calls.push({sql,values});return {rows:[],rowCount:0};}catch(error){throw error;}}} as unknown as PoolClient;
 const result=await registerQuestionFolders(db,'11111111-1111-4111-8111-111111111111','project',Array.from({length:100},(_,i)=>({key:`题目 ${i+1}`,files:[]})));
 expect(result).toEqual({discovered:100,added:100,changed:0});const stepWrites=calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.steps'));expect(stepWrites).toHaveLength(100*STEP_REGISTRY.length);for(const group of new Set(stepWrites.map(call=>call.values?.[0])))expect(stepWrites.filter(call=>call.values?.[0]===group).map(call=>call.values?.[1])).toEqual(STEP_REGISTRY.map(step=>step.ordinal));
 const inserted=JSON.parse(String(calls[1]?.values?.[1]));expect(new Set(inserted.map((row:any)=>row.id)).size).toBe(100);
});
test('材料包模式登记目录为材料包，派生题目不能派发入库，材料包不能派发出题',async()=>{
 const calls:{sql:string;values?:unknown[]}[]=[];
 const db={query:async(sql:string,values?:unknown[])=>{calls.push({sql,values});return{rows:[],rowCount:0};}} as unknown as PoolClient;
 await registerQuestionFolders(db,'11111111-1111-4111-8111-111111111111','项目',[{key:'材料A',files:[]}],'material_packages');
 expect(calls.find(call=>call.sql.startsWith('INSERT INTO ai_distill.workflows'))?.values?.[2]).toBe('material_package');
 const packageSteps=new Map<number,any>([[1,{ordinal:1,status:'succeeded',enabled:true,active:false,workflow_kind:'material_package'}],[9,{ordinal:9,status:'succeeded',enabled:true,active:false,workflow_kind:'material_package'}],[4,{ordinal:4,status:'waiting',enabled:true,active:false,workflow_kind:'material_package'}]]);
 expect(isWorkflowStepReady(4,packageSteps)).toBe(false);
 const questionSteps=new Map<number,any>([[1,{ordinal:1,status:'succeeded',enabled:true,active:false,source_workflow_id:'package'}],[9,{ordinal:9,status:'succeeded',enabled:true,active:false,source_workflow_id:'package'}],[4,{ordinal:4,status:'waiting',enabled:true,active:false,source_workflow_id:'package'}]]);
 expect(isWorkflowStepReady(1,questionSteps)).toBe(false);
 expect(isWorkflowStepReady(9,questionSteps)).toBe(false);
 expect(isWorkflowStepReady(4,questionSteps)).toBe(true);
});
test('legacy project shared-package questions skip legacy ingest and redaction steps',()=>{
 const steps=new Map<number,any>([
  [1,{ordinal:1,status:'waiting',enabled:true,active:false,library_source:true}],
  [2,{ordinal:2,status:'waiting',enabled:true,active:false,library_source:true}],
  [4,{ordinal:4,status:'waiting',enabled:true,active:false,library_source:true}],
  [9,{ordinal:9,status:'waiting',enabled:true,active:false,library_source:true}],
 ]);
 expect(isWorkflowStepReady(1,steps)).toBe(false);
 expect(isWorkflowStepReady(2,steps)).toBe(false);
 expect(isWorkflowStepReady(9,steps)).toBe(false);
 expect(isWorkflowStepReady(4,steps)).toBe(true);
});
test('Qwen step config validates endpoint-specific model and rejects secrets',()=>{
 expect(validateStepConfig(5,{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',max_tokens:100})).toMatchObject({provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',max_tokens:100});
 expect(()=>validateStepConfig(5,{base_url:'https://openrouter.ai/api/v1',model:'other/model'})).toThrow();
 expect(()=>validateStepConfig(5,{base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',api_key:'secret'})).toThrow();
});

test('Codex settings preserve database choices independently of the local catalog',()=>{
 const catalog=[{slug:'gpt-6-luna',supported_reasoning_levels:[{effort:'low'},{effort:'max'}]}];
 expect(()=>validateCodexModel('gpt-6-luna','max',catalog)).not.toThrow();
 expect(()=>validateCodexModel('gpt-6-luna','ultra',catalog)).not.toThrow();
 expect(()=>validateCodexModel('gpt-6-luna','bad effort',catalog)).toThrow('推理强度');
 expect(()=>validateCodexModel('unknown-model','low',catalog)).not.toThrow();
 expect(()=>validateCodexModel('bad model','low',catalog)).toThrow('模型');
 expect(()=>validateCodexModel('gpt-6-luna','low',[])).not.toThrow();
});
test('unsaved Codex project steps inherit the system model and reasoning defaults',async()=>{
 const pool={query:async(sql:string)=>{
  if(sql.startsWith('SELECT COALESCE(jsonb_agg(to_jsonb(state_rows))'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT ordinal,config FROM ai_distill.project_step_configs'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{codex_model:null,codex_reasoning_effort:null}],rowCount:1};
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'gpt-system',reasoning_effort:'high'}],rowCount:1};
  throw new Error(`Unexpected query: ${sql}`);
 }} as unknown as Pool;
 const steps=await projectStepSummary(pool,'project');
 expect(steps.find(step=>step.ordinal===4)).toMatchObject({config:{provider:'codex',model:'gpt-system',reasoning_effort:'high'},config_source:'system'});
 expect(steps.find(step=>step.ordinal===6)).toMatchObject({config:{provider:'codex',model:'gpt-system',reasoning_effort:'high'},config_source:'system'});
 expect(steps.find(step=>step.ordinal===9)?.config).toMatchObject({provider:'api',api:{model:expect.any(String)},prompt:expect.any(String)});
});
test('project Codex defaults feed steps while an explicit step config remains highest priority',async()=>{
 const pool={query:async(sql:string)=>{
  if(sql.startsWith('SELECT COALESCE(jsonb_agg(to_jsonb(state_rows))'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT ordinal,config FROM ai_distill.project_step_configs'))return{rows:[{ordinal:4,config:{provider:'codex',model:'gpt-6-astra',reasoning_effort:'ultra'}}],rowCount:1};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{codex_model:'gpt-6-astra',codex_reasoning_effort:'ultra'}],rowCount:1};
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'gpt-system',reasoning_effort:'medium'}],rowCount:1};
  throw new Error(`Unexpected query: ${sql}`);
 }} as unknown as Pool;
 const steps=await projectStepSummary(pool,'project');
 expect(steps.find(step=>step.ordinal===4)).toMatchObject({config:{model:'gpt-6-astra',reasoning_effort:'ultra'},config_source:'step'});
 expect(steps.find(step=>step.ordinal===6)).toMatchObject({config:{model:'gpt-6-astra',reasoning_effort:'ultra'},config_source:'project'});
 expect(steps.find(step=>step.ordinal===9)).toMatchObject({config:{provider:'api',api:{model:expect.any(String)}},config_source:'system'});
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

test('项目根目录的材料不被忽略，损坏PDF不能作为可解析材料同步',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-folder-'));roots.push(root);await mkdir(join(root,'题目 1'));
 await writeFile(join(root,'说明.md'),'原件');await expect(scanProjectFolder(root)).rejects.toThrow('根目录');await rm(join(root,'说明.md'));
 await writeFile(join(root,'题目 1','bad.pdf'),'broken');await expect(scanProjectFolder(root)).rejects.toThrow();
});

test('library project summary exposes only authoring through publishing even before its first question',async()=>{
 const pool={query:async(sql:string)=>{
  if(sql.startsWith('SELECT COALESCE(jsonb_agg(to_jsonb(state_rows))')||sql.startsWith('SELECT ordinal,config FROM ai_distill.project_step_configs'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{codex_model:null,codex_reasoning_effort:null}],rowCount:1};
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'gpt-6-luna',reasoning_effort:'medium'}],rowCount:1};
  throw new Error(`Unexpected query: ${sql}`);
 }} as unknown as Pool;
 expect((await projectStepSummary(pool,'project','library_v1')).map(step=>step.ordinal)).toEqual([4,5,6,7,8]);
});


test('步骤状态聚合传输后还原原rows结构并保留筛选参数',async()=>{
 const rows=[{workflow_id:'fixture',ordinal:5,status:'succeeded',enabled:true,active:false,result:{models:[{status:'succeeded',attempt_id:'answer'}]}}];
 let received:any[]=[];
 const pool={query:async(sql:string,args:unknown[])=>{expect(sql).toContain('jsonb_agg(to_jsonb(state_rows))');received=args;return{rows:[{items:rows}],rowCount:1};}} as unknown as Pool;
 const result=await readProjectWorkflowStepRows(pool,'phase',['fixture']);
 expect(result.rows).toEqual(rows);expect(result.rowCount).toBe(1);expect(received).toEqual(['phase',['fixture']]);
 const empty=await readProjectWorkflowStepRows({query:async()=>({rows:[{items:[]}],rowCount:1})} as unknown as Pool,'empty');
 expect(empty.rows).toEqual([]);expect(empty.rowCount).toBe(0);
});
