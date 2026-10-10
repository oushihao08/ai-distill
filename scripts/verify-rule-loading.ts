/** 文件职责：在临时 PostgreSQL schema 核对规则快照绑定、重用和篡改拒绝，不调用模型。
 * 执行入口与用途：`bun scripts/verify-rule-loading.ts`；经临时 schema 与 HTTP app 调用规则注册、发布、绑定和重用接口，验证快照篡改拒绝。
 */
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {createPool} from '../server/db';
import {createApp} from '../server/app';
import {scanRuleWorkspace} from '../server/rule-files';
const pool=createPool(),schema=`test_rule_load_${crypto.randomUUID().replaceAll('-','')}`;
const root=await mkdtemp(join(tmpdir(),'distill-rule-load-'));const checks:{name:string;passed:boolean}[]=[];
const sql=(text:string)=>text.replaceAll('ai_distill',schema);
const testPool={query:async(text:string,values?:unknown[])=>{try{return await pool.query(sql(text),values);}catch(error){throw error;}},connect:async()=>{try{const db=await pool.connect();return{query:async(text:string,values?:unknown[])=>{try{return await db.query(sql(text),values);}catch(error){throw error;}},release:()=>db.release()};}catch(error){throw error;}}}as unknown as Pool;
function check(name:string,passed:boolean){checks.push({name,passed});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
try{
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await pool.query(sql(await Bun.file(new URL(`../migrations/${name}`,import.meta.url)).text()));
 await mkdir(join(root,'materials'));await mkdir(join(root,'skill'));await writeFile(join(root,'materials','rules.md'),'Synthetic rules');await writeFile(join(root,'skill','SKILL.md'),'---\nname: synthetic\ndescription: Synthetic\n---\nSynthetic skill');
 const project=crypto.randomUUID();await testPool.query('INSERT INTO ai_distill.projects(id,name,material_root,local_skill_path) VALUES($1,$2,$3,$4)',[project,'synthetic rule loading',join(root,'questions'),join(root,'skill')]);
 const app=createApp(testPool,root);const request=(url:string,body:unknown={})=>app.request('/api'+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 let response=await request(`/projects/${project}/rules/register`,{workspace_path:root});check('register rules',response.status===200||response.status===201);
 const view=await scanRuleWorkspace(root,join(root,'skill'));response=await request(`/projects/${project}/rules/publish`,{source_digest:view.source_digest});check('freeze rules',response.status===200);const v1=await response.json()as any;
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 for(const [index,id] of ids.entries()){await testPool.query('INSERT INTO ai_distill.workflows(id,project_id,request_id,title) VALUES($1,$2,$3,$4)',[id,project,crypto.randomUUID(),'synthetic question']);await testPool.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented) SELECT $1,n,'synthetic',CASE WHEN n=1 OR (n=2 AND $2::boolean) THEN 'succeeded' ELSE 'waiting' END,n<=3 OR n=5 FROM generate_series(1,8) n",[id,index===0]);}
 response=await request(`/projects/${project}/steps/3/run-batch`);const batch=await response.json()as any;check('batch loads only extraction-ready question',batch.results.filter((r:any)=>r.status==='succeeded').length===1&&batch.results.filter((r:any)=>r.status==='not_ready').length===1);
 const first=await(await request(`/workflows/${ids[0]}/load-rules`)).json()as any;check('loaded rules are reused',first.completed&&first.reused&&first.status==='succeeded');
 check('one current attempt persisted',(await testPool.query('SELECT count(*)::int n FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=3',[ids[0]])).rows[0].n===1);
 check('workflow binds the published version',(await testPool.query('SELECT rule_version_id FROM ai_distill.workflows WHERE id=$1',[ids[0]])).rows[0].rule_version_id===v1.id);
 await writeFile(join(root,'materials','rules.md'),'new synthetic rules');await request(`/projects/${project}/rules/register`,{workspace_path:root});await testPool.query("UPDATE ai_distill.steps SET status='succeeded' WHERE workflow_id=$1 AND ordinal=2",[ids[1]]);
 check('new draft blocks first-time binding',(await request(`/workflows/${ids[1]}/load-rules`)).status===409);
 await testPool.query("UPDATE ai_distill.steps SET status='waiting' WHERE workflow_id=$1 AND ordinal=3",[ids[0]]);
 response=await request(`/workflows/${ids[0]}/load-rules`);check('material revision retains originally bound rules',response.status===200&&(await testPool.query('SELECT result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=3',[ids[0]])).rows[0].result.rule_version_id===v1.id);
 await writeFile(join(v1.manifest.snapshot_path,'skill','SKILL.md'),'tampered');check('tampered snapshot prevents reuse',(await request(`/workflows/${ids[0]}/load-rules`)).status===409);
}catch(error){console.error(error instanceof Error&&checks.some(c=>c.name===error.message)?error.message:'rule loading failed; private details omitted');process.exitCode=1;}
finally{try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{console.error('temporary schema cleanup failed');process.exitCode=1;}await rm(root,{recursive:true,force:true});await pool.end();await writeFile(new URL('../docs/evidence/rule-loading-results.json',import.meta.url),JSON.stringify({checked_at:new Date().toISOString(),scope:'real PostgreSQL, HTTP and local snapshots; synthetic upstream success',provider_calls:0,checks},null,2));}
