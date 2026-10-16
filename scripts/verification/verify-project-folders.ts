/** 文件职责：以临时 PostgreSQL schema 和合成材料核对项目目录发现、就绪筛选、版本与逻辑删除。
 * 执行入口与用途：`bun scripts/verification/verify-project-folders.ts`；在临时 schema 建立合成目录，调用扫描、就绪筛选、接收和逻辑删除流程并核对状态。
 */
import { createPool } from '../../server/db';
import { createApp } from '../../server/app';
import { runNextIntake } from '../../server/intake-jobs';
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
 for (const migration of (await readdir(new URL('../../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) await pool.query(sql(await Bun.file(new URL(`../../migrations/${migration}`, import.meta.url)).text()));
 const input = join(root,'input'); await mkdir(input);
 for(const [key,content] of [['题目 1','%PDF-1.7\none'],['题目 2','%PDF-1.7\ntwo'],['题目 3','broken']]) {
  await mkdir(join(input,key));await writeFile(join(input,key,'a.pdf'),content);
 }
 const app=createApp(testPool,join(root,'store'));
 async function request(path:string, method='GET', body?:unknown) {
  try { return await app.request(`/api${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}); }
  catch(error){throw error;}
 }
 const created=await request('/projects','POST',{name:'fixture',material_root:input});
 check('mandatory folder creates project and discovers question records',created.status===201);
 const project=await created.json() as any;
 const registered=await request('/answer-models','POST',{name:'fixture qwen',config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',max_tokens:128}});
 check('system model registry accepts a validated provider configuration',registered.status===201);
 const model=await registered.json() as any;
 const selectedModel=await request(`/projects/${project.id}/answer-models`,'PUT',{models:[{model_id:model.id,minimum_score:8}]});
 check('project model set stores selected model identity and threshold',selectedModel.status===200&&(await selectedModel.json() as any).models[0].minimum_score===8);
 const readModelSet=await request(`/projects/${project.id}/answer-models`);const modelSetBody=await readModelSet.json() as any;
 check('project model set reads normalized provider config without credentials',readModelSet.status===200&&modelSetBody[0].config.model==='qwen/qwen-plus'&&modelSetBody[0].config.max_tokens===128);
 const duplicateModel=await request('/answer-models','POST',{name:'duplicate qwen',config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',max_tokens:128}});
 check('same provider model cannot be registered under another identity',duplicateModel.status===409);
 let detail=await (await request(`/projects/${project.id}`)).json() as any;
 check('all eight stages exist; intake has three ready workflows',detail.workflows.length===3&&detail.steps.length===8&&detail.steps[0].ready===3&&detail.steps[1].ready===0);
 check('project has an independent local skill directory, not a fake generated skill',Boolean(project.local_skill_path)&&detail.project.skill_exists===false);
 const byKey=new Map<string,string>(detail.workflows.map((w:any)=>[w.source_key,w.id]));const one=byKey.get('题目 1')!;const two=byKey.get('题目 2')!;
 const initial=await(await request(`/workflows/${one}`)).json() as any;
 check('new workflow reports the implemented authoring step consistently with project overview',initial.steps[3].implemented===true&&detail.steps[3].implemented===true);
 check('all eight implemented stages agree between a new workflow and project overview',initial.steps.every((step:any)=>step.implemented===true)&&detail.steps.every((step:any)=>step.implemented===true));
 const first=await request(`/projects/${project.id}/steps/1/run-batch`,'POST',{});
 check('stage one batch is persisted before returning',first.status===202&&(await first.json() as any).results.filter((r:any)=>r.status==='queued').length===3);
 let processed=0;while(await runNextIntake(testPool,join(root,'store')))processed++;
 detail=await (await request(`/projects/${project.id}`)).json() as any;
 check('invalid PDF fails only its own intake while two other workflows succeed',processed===3&&detail.steps[0].succeeded===2&&detail.steps[0].failed===1&&detail.steps[1].ready===2);
 let response=await request(`/projects/${project.id}/steps/2/config`,'PUT',{model:'glm-5.3-flash',reasoning_effort:'low'});
 check('per-project model configuration persists',response.status===200);
 response=await request(`/projects/${project.id}/steps/2/run-batch`,'POST',{});
 const batch=await response.json() as any;
 check('next stage queues only successful upstream records',batch.results.filter((r:any)=>r.status==='queued').length===2&&batch.results.filter((r:any)=>r.status==='not_ready').length===1);
 const queued=await testPool.query('SELECT config FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=2',[one]);
 check('new extraction attempts capture project model settings',queued.rows[0].config.model==='glm-5.3-flash'&&queued.rows[0].config.extraction.reasoningEffort==='low');
 async function flow(id:string){try{return await(await request(`/workflows/${id}`)).json() as any;}catch(error){throw error;}}
 async function add(id:string,name:string,content:string,replaceId?:string){
  try{const form=new FormData();form.append('files',new File([content],name));if(replaceId)form.append('replace_id',replaceId);return await app.request(`/api/workflows/${id}/materials`,{method:'POST',body:form});}catch(error){throw error;}
 }
 response=await add(one,'extra.pdf','%PDF-1.7\nextra');let current=await flow(one);
 check('adding a material invalidates queued downstream work',response.status===200&&current.materials.length===2&&current.attempts.some((a:any)=>a.ordinal===2&&a.status==='skipped')&&current.steps[1].status==='waiting');
 const original=current.materials.find((m:any)=>m.original_name==='a.pdf');
 response=await add(one,'replacement.pdf','%PDF-1.7\nreplacement',original.id);current=await flow(one);
 check('replace retains other materials and old input history',response.status===200&&current.materials.length===2&&current.attempts.length>0);
 const remove=current.materials.find((m:any)=>m.original_name==='extra.pdf');
 response=await request(`/workflows/${one}/materials/${remove.id}`,'DELETE');current=await flow(one);
 check('delete removes only current material and preserves historical original',response.status===200&&current.materials.length===1&&(await request(`/materials/${original.id}/download`)).status===200);
 response=await request(`/workflows/${one}/materials/${current.materials[0].id}`,'DELETE');current=await flow(one);
 check('deleting the last material blocks later execution rather than claiming success',response.status===200&&current.materials.length===0&&current.steps[0].status==='failed');
 response=await request(`/projects/${project.id}/sync-folder`,'POST');
 check('unchanged folder sync does not overwrite database material edits',response.status===200&&(await response.json() as any).changed===0);
 await writeFile(join(input,'题目 2','a.pdf'),'%PDF-1.7\nchanged');await mkdir(join(input,'题目 4'));await writeFile(join(input,'题目 4','a.pdf'),'%PDF-1.7\nfour');
 response=await request(`/projects/${project.id}/sync-folder`,'POST');const sync=await response.json() as any;current=await flow(two);
 check('folder rescan adds new questions and resets changed inputs to intake',response.status===200&&sync.added===1&&sync.changed===1&&current.steps[0].status==='waiting');
 response=await request(`/projects/${project.id}`,'PATCH',{name:'renamed',description:'updated',material_root:input});
 check('project edit keeps workflow identities and updates project-question labels',response.status===200&&(await flow(two)).workflow.title==='renamed-题目 2');
 response=await request(`/projects/${project.id}`,'DELETE');
 check('deleted projects disappear and cannot enqueue or read workflows',response.status===200&&(await request(`/projects/${project.id}`)).status===404&&(await request(`/workflows/${two}`)).status===404&&(await request(`/projects/${project.id}/steps/1/run-batch`,'POST',{})).status===404);
 const left=await testPool.query('SELECT count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1',[one]);
 check('project deletion retains execution history',left.rows[0].count>0);
} catch(error){console.error(error instanceof Error?error.message:'integration failed');process.exitCode=1;}
finally{
 try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{console.error('temporary schema cleanup failed');process.exitCode=1;}
 try{await rm(root,{recursive:true,force:true});await Bun.write(new URL('../../docs/evidence/project-folder-results.json',import.meta.url),JSON.stringify({checked_at:new Date().toISOString(),provider_calls:0,checks},null,2)+'\n');}catch{console.error('local fixture cleanup failed');process.exitCode=1;}
 await pool.end();
}
