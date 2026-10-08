import {createPool} from '../server/db';
import {createApp} from '../server/app';
import {enqueueScore,runNextScore} from '../server/scoring/jobs';
import {enqueueAnswer,runNextAnswer} from '../server/answer-models/jobs';
import {createWorkerMonitor} from '../server/monitoring/worker-monitor';
import type {ResourceSnapshot} from '../server/monitoring/resources';
import {createHash} from 'node:crypto';
import {mkdtemp,readdir,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
const pool=createPool();const schema=`test_answer_${crypto.randomUUID().replaceAll('-','')}`;const root=await mkdtemp(join(tmpdir(),'answer-flow-'));
const rewrite=(query:string)=>query.replaceAll('ai_distill',schema);
const testPool={query:async(query:string,values?:unknown[])=>{try{return await pool.query(rewrite(query),values);}catch(error){throw error;}},connect:async()=>{try{const db=await pool.connect();return {query:async(query:string,values?:unknown[])=>{try{return await db.query(rewrite(query),values);}catch(error){throw error;}},release:()=>db.release()};}catch(error){throw error;}}} as unknown as Pool;
const checks:{name:string;passed:boolean}[]=[];
function check(name:string,passed:boolean){checks.push({name,passed});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
try{
 for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await testPool.query(await Bun.file(new URL(`../migrations/${file}`,import.meta.url)).text());
 const project=crypto.randomUUID(),workflow=crypto.randomUUID(),extract=crypto.randomUUID(),author=crypto.randomUUID(),attachment=crypto.randomUUID();
 await testPool.query('INSERT INTO ai_distill.projects(id,name) VALUES($1,$2)',[project,'isolated answer fixture']);
 await testPool.query('INSERT INTO ai_distill.workflows(id,project_id,request_id,title) VALUES($1,$2,$3,$4)',[workflow,project,crypto.randomUUID(),'fixture']);
 await testPool.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented) SELECT $1,n,'fixture',CASE WHEN n<=4 THEN 'succeeded' ELSE 'waiting' END,n=5 FROM generate_series(1,8) n",[workflow]);
 await writeFile(join(root,'redacted.md'),'甲公司欠款100元');
 await testPool.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision) VALUES($1,$2,2,1,'succeeded',1)",[extract,workflow]);
 await testPool.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[attachment,workflow,extract,'redacted_markdown','redacted.md',hash('甲公司欠款100元'),Buffer.byteLength('甲公司欠款100元')]);
 const question={question_version:'v1',input_revision:1,question:'应付多少？',attachment_ids:[attachment],quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:'r1',rubric:[{id:'amount',criterion:'回答100元',max_score:1}],reference_answer:'不得发送的标答'};
 await testPool.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,result) VALUES($1,$2,4,1,'succeeded',1,$3)",[author,workflow,JSON.stringify(question)]);
 const app=createApp(testPool,root);
 const put=await app.request(`/api/projects/${project}/steps/5/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'})});
 check('step 5 configuration saved via API',put.status===200);
 const [first,duplicate]=await Promise.all([enqueueAnswer(testPool,workflow,root),enqueueAnswer(testPool,workflow,root)]);
 check('concurrent enqueue creates exactly one attempt',first.id===duplicate.id&&first.reused!==duplicate.reused);
 const successful=async(input:any)=>{check('provider receives only exact question and redacted attachments',input.question==='应付多少？'&&JSON.stringify(input.materials)==='[{"name":"附件1","text":"甲公司欠款100元"}]'&&!JSON.stringify(input).includes('不得发送'));return {text:'应付100元。',requested_model:input.config.model,model:'fixture-provider',request_id:null,completion_id:'fixture',usage:{total_tokens:10},started_at:new Date().toISOString(),finished_at:new Date().toISOString(),duration_ms:1};};
 check('worker consumes queued answer',await runNextAnswer(testPool,root,successful));
 const row=(await testPool.query('SELECT status,input,result FROM ai_distill.step_attempts WHERE id=$1',[first.id])).rows[0];
 check('answer and usage persisted',row.status==='succeeded'&&row.result.text==='应付100元。'&&row.result.usage.total_tokens===10);
 const artifacts=(await testPool.query("SELECT id,storage_path FROM ai_distill.artifacts WHERE attempt_id=$1 AND kind='model_answer'",[first.id])).rows;
 check('download returns saved answer',artifacts.length===1&&(await (await app.request(`/api/artifacts/${artifacts[0].id}/download`)).text())==='应付100元。');
 const binding={question_version:'v1',input_revision:1,input_digest:row.input.input_digest,rubric_version:'r1',rubric_digest:hash(JSON.stringify(question.rubric)),answer_attempt_id:first.id,answer_sha256:row.result.answer_sha256};
 const score={binding,assessment_valid:true,items:[{id:'amount',score:1,reason:'金额正确',evidence:[{source:'answer',quote:'100元'}]}],total:1,max_score:1,disputes:[]};
 const scoreResponse=await app.request(`/api/workflows/${workflow}/answers/${first.id}/validate-score`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(score)});
 check('score checks bind persisted answer and rubric',scoreResponse.status===200&&(await scoreResponse.json() as any).valid===true);
 const bad=await app.request(`/api/workflows/${workflow}/answers/${first.id}/validate-score`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...score,total:0})});check('incorrect score total is rejected',(await bad.json() as any).valid===false);
 const gradeConfig=await app.request(`/api/projects/${project}/steps/6/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-6-astra',reasoning_effort:'low'})});
 check('stage six explicit Codex config saved',gradeConfig.status===200);
 const scoreEnqueue=await app.request(`/api/workflows/${workflow}/score`,{method:'POST'});
 const gradeAttempt=await scoreEnqueue.json() as any;
 check('stage six API queues persistent grade',scoreEnqueue.status===202&&typeof gradeAttempt.id==='string');
 const gradeDuplicate=await enqueueScore(testPool,workflow);check('duplicate grading enqueue is reused',gradeDuplicate.id===gradeAttempt.id&&gradeDuplicate.reused);
 const grader=async(context:any)=>({report:{...score,binding:context.binding},session_id:'fixture-independent-grader',usage:{input_tokens:7},duration_ms:1});
 check('grading worker consumes queued attempt',await runNextScore(testPool,root,process.argv.includes('--real-score')?undefined:grader));
 const graded=(await testPool.query('SELECT status,session_id,result FROM ai_distill.step_attempts WHERE id=$1',[gradeAttempt.id])).rows[0];
 check('grade report and validation persisted',graded.status==='succeeded'&&graded.result.validation.valid&&typeof graded.session_id==='string'&&graded.session_id.length>0&&graded.result.binding.answer_attempt_id===first.id);
 const gradeArtifact=(await testPool.query("SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 AND kind='score_report'",[gradeAttempt.id])).rows[0];
 check('grade download contains exact binding',(await (await app.request(`/api/artifacts/${gradeArtifact.id}/download`)).json() as any).report.binding.answer_attempt_id===first.id);
 await testPool.query('UPDATE ai_distill.step_attempts SET result=$2 WHERE id=$1',[author,JSON.stringify({...question,rubric_version:'r2'})]);
 const regrade=await enqueueScore(testPool,workflow);check('rubric only change schedules regrade on same answer',regrade.id!==gradeAttempt.id);
 await runNextScore(testPool,root,async context=>{await testPool.query('UPDATE ai_distill.step_attempts SET result=$2 WHERE id=$1',[author,JSON.stringify({...question,rubric_version:'r3'})]);return grader(context);});
 const staleGrade=(await testPool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[regrade.id])).rows[0];
 check('late grade cannot publish changed rubric',staleGrade.status==='failed'&&!(await testPool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1',[regrade.id])).rowCount);
 // A new question version must create a new attempt; in-flight publication is discarded after another change.
 await testPool.query('UPDATE ai_distill.step_attempts SET result=$2 WHERE id=$1',[author,JSON.stringify({...question,question_version:'v2'})]);
 const second=await enqueueAnswer(testPool,workflow,root);check('new question does not reuse old answer',second.id!==first.id);
 await runNextAnswer(testPool,root,async input=>{await testPool.query('UPDATE ai_distill.step_attempts SET result=$2 WHERE id=$1',[author,JSON.stringify({...question,question_version:'v3'})]);return successful(input);});
 const late=(await testPool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[second.id])).rows[0];
 check('changed question blocks late answer publication',late.status==='failed'&&!(await testPool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1',[second.id])).rowCount);
 check('unpublished answer files removed',!await Bun.file(join(root,workflow,second.id,'answer.txt')).exists());
 const lateScore=await app.request(`/api/workflows/${workflow}/answers/${first.id}/validate-score`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(score)});check('old-version score cannot validate as current',lateScore.status===409);
 for(const provider of ['kimi','deepseek','doubao']){
  const response=await app.request(`/api/projects/${project}/steps/5/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,model:'fixture-model'})});
  check(`${provider} configuration API accepted`,response.status===200);
  await testPool.query('UPDATE ai_distill.step_attempts SET result=$2 WHERE id=$1',[author,JSON.stringify({...question,question_version:provider})]);
  const attempt=await enqueueAnswer(testPool,workflow,root);
  await runNextAnswer(testPool,root,successful);
  const saved=(await testPool.query('SELECT config,status,result FROM ai_distill.step_attempts WHERE id=$1',[attempt.id])).rows[0];
  check(`${provider} immutable provider and default mode persisted`,saved.config.provider===provider&&saved.status==='succeeded'&&saved.result.provider===provider&&saved.result.mode==='provider_default');
 }
 check('missing monitor returns unavailable and no-store',(await (await app.request('/api/monitor')).json() as any).status==='unavailable'&&(await app.request('/api/monitor')).headers.get('Cache-Control')==='no-store');
 let percent=5;
 const sample=async():Promise<ResourceSnapshot>=>({sampled_at:new Date().toISOString(),system:{status:'known',value:{total_bytes:10000,available_bytes_estimate:percent*100,available_percent:percent,method:'macos_memory_pressure_percentage'}},processes:[],tasks:{status:'unknown'}});
 const monitor=createWorkerMonitor(testPool,root,{min_available_percent:10,sample_interval_ms:1,sample});
 try{
  await monitor.start();check('low memory blocks new dispatch',!await monitor.beforeDispatch());
  check('monitor API publishes paused state',(await (await app.request('/api/monitor')).json() as any).status==='paused');
  percent=50;await new Promise(resolve=>setTimeout(resolve,10));
  check('memory recovery resumes dispatch',await monitor.beforeDispatch());
 }finally{await monitor.stop();}
 check('monitor API publishes stopped state',(await (await app.request('/api/monitor')).json() as any).status==='stopped');
}catch{console.error('作答集成验证失败；未输出凭证或材料内容');process.exitCode=1;}
finally{
 try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{console.error('临时验证schema清理失败');process.exitCode=1;}
 await pool.end();await rm(root,{recursive:true,force:true});
 await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/answer-flow-results.json',JSON.stringify({checked_at:new Date().toISOString(),scope:process.argv.includes('--real-score')?'isolated PostgreSQL schema; synthetic authoring and injected answer provider; one real Codex grading call':'isolated PostgreSQL schema; synthetic authoring result and injected answer/grading providers; no real model call',checks},null,2)+'\n');
}
