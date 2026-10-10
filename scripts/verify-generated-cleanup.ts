/** 文件职责：在临时 PostgreSQL schema 和本地夹具验证工作流重置及生成文件清理。
 * 执行入口与用途：`bun scripts/verify-generated-cleanup.ts`；在临时 schema 和临时存储目录创建产物，调用重置／清理路径并检查残留。
 */
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {createPool} from '../server/db';
import {createApp} from '../server/app';

const pool=createPool(),schema=`test_generated_clear_${crypto.randomUUID().replaceAll('-','')}`;
const root=await mkdtemp(join(tmpdir(),'distill-generated-clear-'));const checks:{name:string;passed:boolean}[]=[];
const sql=(text:string)=>text.replaceAll('ai_distill',schema);
const testPool={query:async(text:string,values?:unknown[])=>{try{return await pool.query(sql(text),values);}catch(error){throw error;}},connect:async()=>{try{const db=await pool.connect();return{query:async(text:string,values?:unknown[])=>{try{return await db.query(sql(text),values);}catch(error){throw error;}},release:()=>db.release()};}catch(error){throw error;}}}as unknown as Pool;
function check(name:string,passed:boolean){checks.push({name,passed});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
try{
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await pool.query(sql(await Bun.file(new URL(`../migrations/${name}`,import.meta.url)).text()));
 const project=crypto.randomUUID();await testPool.query('INSERT INTO ai_distill.projects(id,name) VALUES($1,$2)',[project,'synthetic deletion verification']);
 const ids=[crypto.randomUUID(),crypto.randomUUID()],attempts=[crypto.randomUUID(),crypto.randomUUID()];
 for(const [i,id] of ids.entries()){
  await testPool.query('INSERT INTO ai_distill.workflows(id,project_id,request_id,title) VALUES($1,$2,$3,$4)',[id,project,crypto.randomUUID(),'synthetic question']);
  await testPool.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status) SELECT $1,n,'synthetic',CASE WHEN n=1 THEN 'succeeded' WHEN n=2 THEN 'failed' ELSE 'waiting' END FROM generate_series(1,8) n",[id]);
  await mkdir(join(root,id,attempts[i]!),{recursive:true});await writeFile(join(root,id,'source.pdf'),'%PDF-1.4\nsynthetic original');await writeFile(join(root,id,attempts[i]!,'materials.md'),'synthetic generated');
  await testPool.query("INSERT INTO ai_distill.materials(id,workflow_id,original_name,storage_path,sha256,size_bytes) VALUES($1,$2,'source.pdf',$3,$4,25)",[crypto.randomUUID(),id,`${id}/source.pdf`,'a'.repeat(64)]);
  await testPool.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status) VALUES($1,$2,2,1,'failed')",[attempts[i],id]);
  await testPool.query("INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,'redacted_markdown',$4,$5,19)",[crypto.randomUUID(),id,attempts[i],`${id}/${attempts[i]}/materials.md`,'b'.repeat(64)]);
 }
 const app=createApp(testPool,root);let response=await app.request(`/api/workflows/${ids[0]}/generated`,{method:'DELETE'});check('generated deletion API succeeds',response.status===200);
 check('original PDF file retained',await Bun.file(join(root,ids[0]!,'source.pdf')).exists());
 check('generated file removed',!await Bun.file(join(root,ids[0]!,attempts[0]!,'materials.md')).exists());
 check('other question output preserved',await Bun.file(join(root,ids[1]!,attempts[1]!,'materials.md')).exists());
 check('generated database rows removed',(await testPool.query('SELECT count(*)::int n FROM ai_distill.artifacts WHERE workflow_id=$1',[ids[0]])).rows[0].n===0&&(await testPool.query('SELECT count(*)::int n FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal>=2',[ids[0]])).rows[0].n===0);
 check('original material row retained',(await testPool.query('SELECT count(*)::int n FROM ai_distill.materials WHERE workflow_id=$1',[ids[0]])).rows[0].n===1);
 const steps=(await testPool.query('SELECT ordinal,status,result FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY ordinal',[ids[0]])).rows;
 check('generated stages reset and intake retained',steps[0].status==='succeeded'&&steps.slice(1).every(s=>s.status==='waiting'&&s.result===null));
 await testPool.query("UPDATE ai_distill.step_attempts SET status='running' WHERE id=$1",[attempts[1]]);response=await app.request(`/api/workflows/${ids[1]}/generated`,{method:'DELETE'});check('running task cannot be cleared',response.status===409);
 check('blocked cleanup retains generated files',await Bun.file(join(root,ids[1]!,attempts[1]!,'materials.md')).exists());
}catch(error){console.error(error instanceof Error&&checks.some(c=>c.name===error.message)?error.message:'generated cleanup verification failed');process.exitCode=1;}
finally{try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{console.error('temporary schema cleanup failed');process.exitCode=1;}await rm(root,{recursive:true,force:true});await pool.end();await writeFile(new URL('../docs/evidence/generated-cleanup-results.json',import.meta.url),JSON.stringify({checked_at:new Date().toISOString(),scope:'real PostgreSQL HTTP local files; synthetic question data',checks},null,2));}
