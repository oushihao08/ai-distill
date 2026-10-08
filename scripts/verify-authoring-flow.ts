import {createPool} from '../server/db';
import {createApp} from '../server/app';
import {enqueueAuthoring,runNextAuthoring} from '../server/authoring/jobs';
import {AuthoringQualityError} from '../server/authoring/executor';
import {enqueueAnswer} from '../server/answer-models/jobs';
import {createHash} from 'node:crypto';
import {mkdtemp,readdir,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
const pool=createPool(),schema=`test_authoring_${crypto.randomUUID().replaceAll('-','')}`,root=await mkdtemp(join(tmpdir(),'authoring-flow-'));
const rewrite=(query:string)=>query.replaceAll('ai_distill',schema);
const testPool={query:async(query:string,values?:unknown[])=>pool.query(rewrite(query),values),connect:async()=>{const db=await pool.connect();return {query:async(query:string,values?:unknown[])=>db.query(rewrite(query),values),release:()=>db.release()};}} as unknown as Pool;
const checks:{name:string;passed:boolean}[]=[];const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function check(name:string,passed:boolean){checks.push({name,passed});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
let completed=false;let execution:unknown=null;
try{
 for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await testPool.query(await Bun.file(new URL(`../migrations/${file}`,import.meta.url)).text());
 const project=crypto.randomUUID(),workflow=crypto.randomUUID(),extract=crypto.randomUUID(),attachment=crypto.randomUUID(),version=crypto.randomUUID();
 await testPool.query('INSERT INTO ai_distill.projects(id,name) VALUES($1,$2)',[project,'isolated authoring fixture']);
 await testPool.query('INSERT INTO ai_distill.workflows(id,project_id,request_id,title) VALUES($1,$2,$3,$4)',[workflow,project,crypto.randomUUID(),'依据附件编写一道订单金额计算题，题面、评分标准和标答应一致']);
 await testPool.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented) SELECT $1,n,'fixture',CASE WHEN n<=2 THEN 'succeeded' ELSE 'waiting' END,n<8 FROM generate_series(1,8) n",[workflow]);
 const material='虚构测试资料：商品单价7元，订单数量2件，总金额按单价乘数量计算。';await writeFile(join(root,'redacted.md'),material);
 await testPool.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision) VALUES($1,$2,2,1,'succeeded',1)",[extract,workflow]);
 await testPool.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[attachment,workflow,extract,'redacted_markdown','redacted.md',hash(material),Buffer.byteLength(material)]);
 const snapshot=join(root,'snapshot');await mkdir(join(snapshot,'skill'),{recursive:true});const rule='只依据附件出一道可独立作答的文字题。交付为文字答案，无工具。评分标准应给出准确结果的正分条件和错误结果的零分条件，满分由项目规则决定，此测试为1分。完整标答回应题面全部要求。';await writeFile(join(snapshot,'skill','SKILL.md'),rule);
 const files=[{path:'skill/SKILL.md',sha256:hash(rule),size_bytes:Buffer.byteLength(rule)}];
 await testPool.query("INSERT INTO ai_distill.rule_versions(id,project_id,version,status,manifest) VALUES($1,$2,1,'published',$3)",[version,project,JSON.stringify({snapshot_path:snapshot,source_digest:hash(rule),files,issues:[]})]);
 const app=createApp(testPool,root);
 check('current frozen rules loaded through step-three API',(await app.request(`/api/workflows/${workflow}/load-rules`,{method:'POST'})).status===200);
 check('explicit step-four Codex configuration saved',(await app.request(`/api/projects/${project}/steps/4/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-6.1-sol',reasoning_effort:'low'})})).status===200);
 const [a,b]=await Promise.all([app.request(`/api/workflows/${workflow}/author`,{method:'POST'}),app.request(`/api/workflows/${workflow}/author`,{method:'POST'})]);const first=await a.json() as any,second=await b.json() as any;
 check('concurrent API submissions deduplicate the same frozen input',a.status===202&&b.status===202&&first.id===second.id&&first.reused!==second.reused);
 check('real worker executes authoring and independent review',await runNextAuthoring(testPool,root));
 const saved=(await testPool.query('SELECT status,result FROM ai_distill.step_attempts WHERE id=$1',[first.id])).rows[0];
 execution={question_version:saved.result.question_version,rubric_version:saved.result.rubric_version,quality_check:saved.result.quality_check,codex:saved.result.codex};
 check('both real Codex sessions are distinct and quality passes',saved.status==='succeeded'&&saved.result.quality_check.passed&&saved.result.codex.author.session_id!==saved.result.codex.review.session_id);
 check('database result excludes private reference answer',!('reference_answer' in saved.result));
 const detail=await (await app.request(`/api/workflows/${workflow}`)).json() as any;
 check('workflow history publishes question and rubric without reference',detail.steps[3].status==='succeeded'&&detail.attempts.find((item:any)=>item.id===first.id).result.question===saved.result.question&&!('reference_answer' in detail.steps[3].result));
 const output=(await testPool.query("SELECT id,storage_path FROM ai_distill.artifacts WHERE attempt_id=$1 AND kind='authored_question'",[first.id])).rows[0];
 const download=await app.request(`/api/artifacts/${output.id}/download`);const publicResult=await download.json() as any;
 check('published public artifact downloads without reference',!!output&&await Bun.file(join(root,output.storage_path)).exists()&&download.status===200&&publicResult.question===saved.result.question&&!('reference_answer' in publicResult));
 check('private reference answer is retained in role output', (await readdir(join(root,workflow,first.id,'private'))).length===1);
 const privateDirs=await readdir(join(root,workflow,first.id,'private'));const draft=await Bun.file(join(root,workflow,first.id,'private',privateDirs[0]!,'author','output','result.json')).json();
 check('private author result has complete reference answer',typeof draft.reference_answer==='string'&&draft.reference_answer.trim().length>0);
 const indexed=(await testPool.query('SELECT id,storage_path FROM ai_distill.artifacts WHERE attempt_id=$1',[first.id])).rows;
 check('private role files have no download index',indexed.length===1&&indexed[0].id===output.id&&!indexed[0].storage_path.includes('/private/')&&(await app.request(`/api/artifacts/${crypto.randomUUID()}/download`)).status===404);
 await testPool.query("INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,5,$2)",[project,JSON.stringify({provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'})]);
 const answer=await enqueueAnswer(testPool,workflow,root);const answerInput=(await testPool.query('SELECT input FROM ai_distill.step_attempts WHERE id=$1',[answer.id])).rows[0].input;
 check('step-five accepts the genuine step-four result without rubric/reference',answerInput.question===saved.result.question&&answerInput.attachments[0].id===attachment&&!('rubric' in answerInput)&&!('reference_answer' in answerInput));
 // Failure and late-result cases use injected execution; no extra model calls are made.
 await testPool.query('UPDATE ai_distill.workflows SET title=$2 WHERE id=$1',[workflow,'quality rejection fixture']);const rejected=await enqueueAuthoring(testPool,workflow);
 const report={...saved.result.quality_check,passed:false,issues:[{code:'fixture_conflict',detail:'明确事实冲突',blocking:true}]};await runNextAuthoring(testPool,root,async()=>{throw new AuthoringQualityError(report);});
 const failed=(await testPool.query('SELECT status,result FROM ai_distill.step_attempts WHERE id=$1',[rejected.id])).rows[0];check('quality rejection is retained as failed with no published artifact',failed.status==='failed'&&failed.result.quality_check.passed===false&&!(await testPool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1',[rejected.id])).rowCount);
 await testPool.query('UPDATE ai_distill.workflows SET title=$2 WHERE id=$1',[workflow,'late result fixture']);const late=await enqueueAuthoring(testPool,workflow);
 await runNextAuthoring(testPool,root,async()=>{await testPool.query('UPDATE ai_distill.workflows SET input_revision=2 WHERE id=$1',[workflow]);return saved.result;});
 check('late result cannot publish after material revision changes',(await testPool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[late.id])).rows[0].status==='failed'&&!(await testPool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1',[late.id])).rowCount);
 completed=true;
}catch{console.error('第四步集成验证失败；未输出凭证或私有产物');process.exitCode=1;}
finally{
 try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);check('temporary database schema cleaned',true);}catch{process.exitCode=1;checks.push({name:'temporary database schema cleaned',passed:false});}
 await pool.end();await rm(root,{recursive:true,force:true});
 await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/authoring-flow-results.json',JSON.stringify({checked_at:new Date().toISOString(),scope:'isolated PostgreSQL schema; synthetic step-two material and frozen rules; real Codex author and independent reviewer; step-five enqueue only; failure cases injected',status:completed&&checks.every(item=>item.passed)?'passed':'failed',execution,checks},null,2)+'\n');
}
