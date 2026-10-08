import {createPool} from '../server/db';
import type {Pool} from 'pg';
import {readdir,mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startAutomation,runAutomationTick,controlAutomation,controlProjectExecution,listAutomation} from '../server/automation/jobs';
import {STEP_REGISTRY} from '../shared/step-registry';
const source=createPool();const schema=`test_automation_${crypto.randomUUID().replaceAll('-','')}`;
source.options.statement_timeout=30000;
const root=await mkdtemp(join(tmpdir(),'distill-automation-'));
const transform=(sql:string)=>sql.replaceAll('ai_distill',schema);
const pool={query:async(sql:string,values?:unknown[])=>{try{return await source.query(transform(sql),values);}catch(error){throw error;}},connect:async()=>{
 try{const db=await source.connect();return {query:async(sql:string,values?:unknown[])=>{try{return await db.query(transform(sql),values);}catch(error){throw error;}},release:()=>db.release()};}catch(error){throw error;}
}} as unknown as Pool;
const checks:{name:string;passed:boolean}[]=[];
function check(name:string,passed:boolean){checks.push({name,passed});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
async function freshScheduler(){
 try{
  const child=Bun.spawn([process.execPath,new URL('./automation-tick-fixture.ts',import.meta.url).pathname,schema,root],{stdout:'ignore',stderr:'pipe'});
  const errors=await new Response(child.stderr).text();
  if(await child.exited!==0)throw new Error(`Isolated scheduler process failed: ${errors.slice(0,300)}`);
 }catch(error){throw error;}
}
async function fixture(){
 const project=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();
 await pool.query('INSERT INTO ai_distill.projects(id,name) VALUES($1,$2)',[project,'automation fixture']);
 for(const id of [a,b]){
  await pool.query("INSERT INTO ai_distill.workflows(id,project_id,request_id,title,source_key) VALUES($1,$2,$3,'fixture',$4)",[id,project,crypto.randomUUID(),id]);
  await pool.query("INSERT INTO ai_distill.materials(id,workflow_id,original_name,storage_path,sha256,size_bytes,input_revision) VALUES($1,$2,'fixture.pdf','fixture.pdf',$3,64,1)",[crypto.randomUUID(),id,'a'.repeat(64)]);
  for(const step of STEP_REGISTRY)await pool.query('INSERT INTO ai_distill.steps(workflow_id,ordinal,name,step_key,display_position,enabled,implemented) VALUES($1,$2,$3,$4,$5,$6,true)',[id,step.ordinal,step.name,step.key,step.position,[1,9].includes(step.ordinal)]);
 }
 return {project,a,b};
}
async function complete(id:string,ordinal:number){
 await pool.query("UPDATE ai_distill.step_attempts SET status='succeeded',finished_at=now() WHERE workflow_id=$1 AND ordinal=$2 AND status IN ('waiting','running')",[id,ordinal===1?2:ordinal]);
 await pool.query("UPDATE ai_distill.steps SET status='succeeded' WHERE workflow_id=$1 AND (ordinal=$2 OR ($2=1 AND ordinal=2))",[id,ordinal]);
 if(ordinal===1){
  const material=(await pool.query('SELECT id,sha256 FROM ai_distill.materials WHERE workflow_id=$1',[id])).rows[0];
  const attempt=(await pool.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=2 ORDER BY attempt DESC LIMIT 1',[id])).rows[0];
  const content=JSON.stringify({source_sha256:material.sha256,pages:[{page:1,text:'synthetic raw text',method:'text'}]});
  await pool.query("INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,'private_extracted_pages','private.json',$5,$6,$7)",[crypto.randomUUID(),id,material.id,attempt.id,createHash('sha256').update(content).digest('hex'),Buffer.byteLength(content),content]);
 }
}
try{
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())await pool.query(await Bun.file(new URL(`../migrations/${name}`,import.meta.url)).text());
 check('all migrations including dispatch gate apply to isolated schema',true);
 const f=await fixture(),batch=await startAutomation(pool,f.project,{mode:'horizontal'});
 let duplicateRejected=false;try{await startAutomation(pool,f.project,{mode:'horizontal'});}catch{duplicateRejected=true;}
 check('same workflow cannot enter concurrent active batches',duplicateRejected);
 await runAutomationTick(pool,root);
 check('horizontal creates one ingestion extraction attempt per member',(await pool.query('SELECT id FROM ai_distill.step_attempts')).rowCount===2);
 await freshScheduler();await freshScheduler();
 check('two fresh scheduler processes reuse persisted waiting work without duplicate calls',(await pool.query('SELECT id FROM ai_distill.step_attempts')).rowCount===2);
 await complete(f.a,1);await freshScheduler();
 const advanced=(await pool.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9',[f.a])).rowCount===1;
 if(!advanced)console.log(JSON.stringify((await pool.query('SELECT ordinal,status,enabled FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY display_position',[f.a])).rows));
 check('horizontal success subset advances to redaction without waiting for another ingestion',advanced);
 await controlAutomation(pool,f.project,batch.id,'pause');
 check('paused batch blocks queued claim',(await pool.query("SELECT ai_distill.dispatch_allowed($1,'materials') AS allowed",[f.a])).rows[0].allowed===false);
 await controlAutomation(pool,f.project,batch.id,'resume');
 check('resumed batch permits remaining work',(await pool.query("SELECT ai_distill.dispatch_allowed($1,'materials') AS allowed",[f.a])).rows[0].allowed===true);
 const claimant=await pool.connect();await claimant.query('BEGIN');await claimant.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
 let paused=false;const pausing=controlAutomation(pool,f.project,batch.id,'pause').then(()=>{paused=true;});
 try{await Bun.sleep(100);check('pause waits for an already-started claim transaction',!paused);}finally{await claimant.query('COMMIT');claimant.release();}
 await pausing;check('pause completes once in-flight claim transaction exits',paused);await controlAutomation(pool,f.project,batch.id,'resume');
 await pool.query("UPDATE ai_distill.step_attempts SET status='running' WHERE workflow_id=$1 AND ordinal=9",[f.a]);
 await controlAutomation(pool,f.project,batch.id,'cancel');
 check('cancel marks in-flight attempts inactive',(await pool.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND status IN ('waiting','running')",[f.a])).rowCount===0);
 check('late publication cannot transition a cancelled attempt',(await pool.query("UPDATE ai_distill.step_attempts SET status='succeeded' WHERE workflow_id=$1 AND ordinal=9 AND status='running' RETURNING id",[f.a])).rowCount===0);
 await controlAutomation(pool,f.project,batch.id,'resume');await runAutomationTick(pool,root);
 const resumedRows=(await pool.query('SELECT ordinal,count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1 GROUP BY ordinal ORDER BY ordinal',[f.a])).rows;
 if(!resumedRows.every(row=>row.count===(row.ordinal===2?1:2)))console.log(JSON.stringify({resumed:resumedRows,member:(await pool.query('SELECT status,reason FROM ai_distill.automation_members WHERE batch_id=$1 AND workflow_id=$2',[batch.id,f.a])).rows}));
 check('resume retains completed ingestion and requeues cancelled redaction',resumedRows.every(row=>row.count===(row.ordinal===2?1:2)));
 await controlProjectExecution(pool,f.project,'pause');
 check('project pause blocks all claimable work',(await pool.query("SELECT ai_distill.dispatch_allowed($1,'materials') AS allowed",[f.b])).rows[0].allowed===false);
 await controlProjectExecution(pool,f.project,'resume');
 check('project resume does not duplicate successful work',(await pool.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=2',[f.a])).rowCount===1);
 await pool.query("INSERT INTO ai_distill.executor_blocks(executor,reason) VALUES('materials','authentication')");
 check('persisted authentication block survives new tick',(await pool.query("SELECT ai_distill.dispatch_allowed($1,'materials') AS allowed",[f.a])).rows[0].allowed===false);
 await pool.query("DELETE FROM ai_distill.executor_blocks WHERE executor='materials'");
 check('explicit executor recovery permits retry',(await pool.query("SELECT ai_distill.dispatch_allowed($1,'materials') AS allowed",[f.a])).rows[0].allowed===true);
 await controlProjectExecution(pool,f.project,'cancel');
 check('project cancel terminates its batches',(await listAutomation(pool,f.project))[0].status==='cancelled');
 await controlProjectExecution(pool,f.project,'resume');await startAutomation(pool,f.project,{mode:'horizontal'});
 check('new batch retains cancelled batch member history',(await listAutomation(pool,f.project)).every(batch=>batch.members.length===2));
 let oldRejected=false;try{await controlAutomation(pool,f.project,batch.id,'resume');}catch{oldRejected=true;}
 check('historical batch cannot take workflows from newer batch',oldRejected);
 await runAutomationTick(pool,root);
 const remaining=(await pool.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=ANY($1::uuid[]) AND status='waiting'",[[f.a,f.b]])).rowCount;
 await controlAutomation(pool,f.project,batch.id,'cancel');
 check('repeated historical cancellation cannot cancel the newer batch tasks',(await pool.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=ANY($1::uuid[]) AND status='waiting'",[[f.a,f.b]])).rowCount===remaining);
 const v=await fixture();await startAutomation(pool,v.project,{mode:'vertical'});await runAutomationTick(pool,root);await complete(v.a,1);await runAutomationTick(pool,root);
 check('vertical waits for active earlier-stage member',(await pool.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9',[v.a])).rowCount===0);
 await pool.query("UPDATE ai_distill.step_attempts SET status='failed' WHERE workflow_id=$1 AND ordinal=2",[v.b]);await pool.query("UPDATE ai_distill.steps SET status='failed' WHERE workflow_id=$1 AND ordinal IN (1,2)",[v.b]);await runAutomationTick(pool,root);
 check('failed subset does not block vertical successful member',(await pool.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9',[v.a])).rowCount===1);
 await pool.query('UPDATE ai_distill.workflows SET input_revision=input_revision+1 WHERE id=$1',[v.a]);await runAutomationTick(pool,root);
 check('input changes block stale batch membership',(await pool.query('SELECT reason FROM ai_distill.automation_members WHERE workflow_id=$1',[v.a])).rows[0].reason==='input_changed');
 const skill=await fixture();await pool.query('UPDATE ai_distill.steps SET enabled=false WHERE workflow_id=ANY($1::uuid[]) AND ordinal=9',[[skill.a,skill.b]]);
 const workspace=join(root,'skill-workspace'),template=join(root,'skill-template'),entry='---\nname: fixture\ndescription: fixture\n---';
 await mkdir(join(workspace,'materials'),{recursive:true});await mkdir(template,{recursive:true});await writeFile(join(workspace,'materials/rules.md'),'synthetic rules');await writeFile(join(template,'SKILL.md'),entry);
 process.env.SKILL_BASE_TEMPLATE_DIR=template;
 await pool.query('UPDATE ai_distill.projects SET material_root=$2,local_skill_path=$3 WHERE id=$1',[skill.project,join(workspace,'questions'),join(workspace,'imported')]);
 await pool.query('INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,3,$2)',[skill.project,JSON.stringify({model:'gpt-6.1-sol',reasoning_effort:'low'})]);
 await pool.query("UPDATE ai_distill.steps SET status='succeeded' WHERE workflow_id=ANY($1::uuid[]) AND ordinal IN (1,2,9)",[[skill.a,skill.b]]);
 await pool.query('UPDATE ai_distill.steps SET enabled=true WHERE workflow_id=ANY($1::uuid[]) AND ordinal=3',[[skill.a,skill.b]]);
 await startAutomation(pool,skill.project,{mode:'horizontal'});await runAutomationTick(pool,root);await runAutomationTick(pool,root);
 const tasks=(await pool.query('SELECT * FROM ai_distill.project_skill_attempts WHERE project_id=$1',[skill.project])).rows;
 check('missing skill queues once and both members wait on shared project generation',tasks.length===1&&tasks[0].status==='waiting');
 const candidate=join(root,'project-skills',skill.project,tasks[0].id,'candidate');await mkdir(candidate,{recursive:true});await writeFile(join(candidate,'SKILL.md'),entry);
 const result={publishable:true,issues:[],unresolved:[],candidate_path:candidate,candidate_files:[{path:'skill/SKILL.md',sha256:createHash('sha256').update(entry).digest('hex'),size_bytes:Buffer.byteLength(entry)}],session_id:'injected-fixture'};
 await pool.query("UPDATE ai_distill.project_skill_attempts SET status='succeeded',result=$2 WHERE id=$1",[tasks[0].id,JSON.stringify(result)]);await runAutomationTick(pool,root);
 check('validated injected skill candidate is adopted frozen and rules loading resumes',(await pool.query("SELECT workflow_id FROM ai_distill.steps WHERE workflow_id=ANY($1::uuid[]) AND ordinal=3 AND status='succeeded'",[[skill.a,skill.b]])).rowCount===2);
 const ingestion=await fixture(),ingestionBatch=await startAutomation(pool,ingestion.project,{mode:'horizontal',workflow_ids:[ingestion.a]});await runAutomationTick(pool,root);
 await pool.query("UPDATE ai_distill.steps SET status='running' WHERE workflow_id=$1 AND ordinal=1",[ingestion.a]);await pool.query("UPDATE ai_distill.step_attempts SET status='running' WHERE workflow_id=$1 AND ordinal=2",[ingestion.a]);
 await controlAutomation(pool,ingestion.project,ingestionBatch.id,'cancel');await controlAutomation(pool,ingestion.project,ingestionBatch.id,'resume');await runAutomationTick(pool,root);
 check('cancelled internal OCR maps to logical ingestion and can resume without a stuck running step',(await pool.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=1',[ingestion.a])).rows[0].status==='waiting'&&(await pool.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=2 AND status='waiting'",[ingestion.a])).rowCount===1);
}catch(error){console.error(error instanceof Error?error.message:'automation verification failed');process.exitCode=1;}
finally{
 try{await source.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await source.end();await rm(root,{recursive:true,force:true});await writeFile(new URL('../docs/evidence/2026-10-08-automation-control.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),scope:'isolated PostgreSQL; injected step completions; no OCR/Codex/provider invocation',checks},null,2));}
}
