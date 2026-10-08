import {resolveAnswerConfig,createAnswerClient} from '../server/answer-models/dispatch';
import {runIndependentScore} from '../server/scoring/executor';
import {runNextAnswer} from '../server/answer-models/jobs';
import {DomesticError} from '../server/answer-models/domestic';
import {runNextRedaction} from '../server/materials/redaction-jobs';
import {runNextExtraction} from '../server/materials/jobs';
import {loadExtractionConfig} from '../server/materials/config';
import {runNextAuthoring} from '../server/authoring/jobs';
import {runAuthoring} from '../server/authoring/executor';
import {runRevisionTick} from '../server/decisions/revision-runner';
import {runNextScore} from '../server/scoring/jobs';
import {inputDigest} from '../server/answer-models/input';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPool} from '../server/db';
import {startRevision,resumeRevision} from '../server/decisions/revision-jobs';
import {readRevisionSettings} from '../server/decisions/revision-binding';
import {runRevisionCall} from '../server/decisions/revision-calls';
import {readdir,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import type {Pool} from 'pg';
const pool=createPool(),schema=`test_revision_${crypto.randomUUID().replaceAll('-','')}`;
const rewrite=(sql:string)=>sql.replaceAll('ai_distill',schema);
const db={query:async(sql:string,values?:unknown[])=>{try{return await pool.query(rewrite(sql),values);}catch(error){throw error;}},connect:async()=>{try{const client=await pool.connect();return {query:async(sql:string,values?:unknown[])=>{try{return await client.query(rewrite(sql),values);}catch(error){throw error;}},release:()=>client.release()};}catch(error){throw error;}}} as unknown as Pool;
const realAuthor=process.argv.includes('--real-author'),realGrading=process.argv.includes('--real-grading'),realAnswer=process.argv.includes('--real-answer');
const checks:{name:string;passed:boolean}[]=[];
function check(name:string,passed:boolean){checks.push({name,passed});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
let failure:string|undefined;
const storage=await mkdtemp(join(tmpdir(),'revision-flow-'));
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
try{
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())await db.query(await Bun.file(new URL(`../migrations/${name}`,import.meta.url)).text());
 const project=crypto.randomUUID(),workflow=crypto.randomUUID(),source=crypto.randomUUID();
 await db.query("INSERT INTO ai_distill.projects(id,name) VALUES($1,'revision isolated fixture')",[project]);
 await db.query("INSERT INTO ai_distill.workflows(id,project_id,request_id,title) VALUES($1,$2,$3,'synthetic question')",[workflow,project,crypto.randomUUID()]);
 await db.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,step_key,display_position) SELECT $1,n,'fixture','failed',true,'fixture_'||n,n FROM generate_series(1,9)n",[workflow]);
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,result,input_revision,finished_at) VALUES($1,$2,7,1,'succeeded',$3,1,now())",[source,workflow,JSON.stringify({decision:'repair',reasons:['below_model_threshold:model'],model_scores:{model:{score:1,max_score:10}}})]);
 const config={required_models:['model'],minimum_score_by_model:{model:8},revision_budget:{max_content_revisions:3,max_technical_retries:2,max_calls:2,max_duration_ms:30000}};
 await db.query('INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,7,$2)',[project,JSON.stringify(config)]);
 const started=await Promise.all([startRevision(db,workflow,source),startRevision(db,workflow,source)]);
 check('concurrent starts reuse exactly one chain',started[0].id===started[1].id&&started.filter(item=>item.reused).length===1);
 const chain=started[0].id,round=(await db.query('SELECT * FROM ai_distill.revision_rounds WHERE chain_id=$1',[chain])).rows[0];
 check('first content round and source evidence persist',round.round===1&&round.stage===4&&round.evidence.reasons[0]==='below_model_threshold:model');
 await db.query('UPDATE ai_distill.project_step_configs SET config=$2 WHERE project_id=$1 AND ordinal=7',[project,JSON.stringify({...config,revision_budget:{...config.revision_budget,max_calls:100}})]);
 check('in-flight budget is unchanged by project edits',(await db.query('SELECT budget FROM ai_distill.revision_chains WHERE id=$1',[chain])).rows[0].budget.max_calls===2);
 const snapshotClient=await db.connect();try{const settings=await readRevisionSettings(snapshotClient,workflow,1,round.id);check('step configuration snapshot also preserves pre-edit settings',settings.configs['7'].revision_budget.max_calls===2);}finally{snapshotClient.release();}
 const attempt=crypto.randomUUID();
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,revision_round_id) VALUES($1,$2,4,1,'running',1,$3)",[attempt,workflow,round.id]);
 let actualCalls=0;
 const duplicated=await Promise.allSettled([1,2].map(()=>runRevisionCall(db,attempt,'author',async()=>{actualCalls++;return {usage:{input_tokens:10}};})));
 check('concurrent same-key reservation makes one invocation',actualCalls===1&&duplicated.filter(item=>item.status==='fulfilled').length===1);
 const uncertain=await Promise.allSettled([runRevisionCall(db,attempt,'review',async()=>{actualCalls++;throw new Error('synthetic connection failure');})]);
 check('uncertain request retains quota and unknown state',uncertain[0].status==='rejected'&&(await db.query("SELECT status FROM ai_distill.revision_calls WHERE attempt_id=$1 AND call_key='review'",[attempt])).rows[0].status==='unknown');
 const exhausted=await Promise.allSettled([runRevisionCall(db,attempt,'third',async()=>{actualCalls++;return {};} )]);
 check('call limit prevents a third invocation and isolates',exhausted[0].status==='rejected'&&actualCalls===2&&(await db.query('SELECT status,calls_reserved FROM ai_distill.revision_chains WHERE id=$1',[chain])).rows[0].status==='isolated');
 await db.query("UPDATE ai_distill.step_attempts SET status='failed',finished_at=now() WHERE id=$1",[attempt]);
 const auth=crypto.randomUUID();
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,result,finished_at) VALUES($1,$2,5,1,'failed',1,$3,now())",[auth,workflow,JSON.stringify({error:{kind:'authentication',retryable:false}})]);
 const waiting=await startRevision(db,workflow,auth);
 check('authentication creates a waiting chain without content revision',waiting.status==='blocked'&&waiting.content_revisions===0);
 await resumeRevision(db,workflow,waiting.id);
 const resumed=(await db.query('SELECT * FROM ai_distill.revision_chains WHERE id=$1',[waiting.id])).rows[0];
 check('explicit recovery preserves content count and consumes one technical retry',resumed.status==='waiting'&&resumed.content_revisions===0&&resumed.technical_retries===1);
 const authRound=(await db.query('SELECT id FROM ai_distill.revision_rounds WHERE chain_id=$1',[waiting.id])).rows[0].id;
 const retry=crypto.randomUUID();
 await db.query('UPDATE ai_distill.step_attempts SET revision_round_id=$2 WHERE id=$1',[auth,authRound]);
 await db.query("INSERT INTO ai_distill.revision_calls(id,chain_id,round_id,attempt_id,call_key,created_at) VALUES($1,$2,$3,$4,'crash-fixture',now()-interval '50 milliseconds')",[crypto.randomUUID(),waiting.id,authRound,auth]);
 await db.query('UPDATE ai_distill.revision_chains SET calls_reserved=calls_reserved+1 WHERE id=$1',[waiting.id]);
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,revision_round_id) VALUES($1,$2,5,2,'running',1,$3)",[retry,workflow,authRound]);
 await runRevisionCall(db,retry,'answer',async()=>({usage:{input_tokens:1}}));
 const recovered=(await db.query('SELECT status,duration_ms FROM ai_distill.revision_calls WHERE attempt_id=$1',[auth])).rows[0];
 check('terminal interrupted invocation is reconciled with conservative elapsed time',recovered.status==='unknown'&&Number(recovered.duration_ms)>=50);
 const oldSpent=Number((await db.query('SELECT spent_duration_ms FROM ai_distill.revision_chains WHERE id=$1',[waiting.id])).rows[0].spent_duration_ms);
 await runRevisionCall(db,retry,'second-fixture',async()=>({}));
 check('reconciliation cannot count the interrupted call twice',Number((await db.query('SELECT spent_duration_ms FROM ai_distill.revision_chains WHERE id=$1',[waiting.id])).rows[0].spent_duration_ms)-oldSpent<Number(recovered.duration_ms));
 await db.query('UPDATE ai_distill.workflows SET input_revision=2 WHERE id=$1',[workflow]);
 await db.query("UPDATE ai_distill.revision_chains SET status='blocked' WHERE id=$1",[waiting.id]);
 const stale=await Promise.allSettled([resumeRevision(db,workflow,waiting.id)]);
 check('changed input cannot resume an old chain',stale[0].status==='rejected');
 await db.query('DELETE FROM ai_distill.step_attempts WHERE workflow_id=$1',[workflow]);
 check('generated attempt deletion removes dependent revision records',(await db.query('SELECT id FROM ai_distill.revision_chains WHERE workflow_id=$1',[workflow])).rowCount===0);

 await db.query('UPDATE ai_distill.project_step_configs SET config=$2 WHERE project_id=$1 AND ordinal=7',[project,JSON.stringify({...config,revision_budget:{...config.revision_budget,max_calls:100,max_duration_ms:600000}})]);
 const flow=crypto.randomUUID(),questionId=crypto.randomUUID(),answerId=crypto.randomUUID(),badScore=crypto.randomUUID(),attachment=crypto.randomUUID();
 await db.query("INSERT INTO ai_distill.workflows(id,project_id,request_id,title) VALUES($1,$2,$3,'score revision synthetic fixture')",[flow,project,crypto.randomUUID()]);
 await db.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,step_key,display_position) SELECT $1,n,'fixture',CASE WHEN n IN(4,5) THEN 'succeeded' WHEN n=6 THEN 'failed' ELSE 'waiting' END,true,'fixture_'||n,n FROM generate_series(1,9)n",[flow]);
 const rubric=[{id:'amount',criterion:'准确回答100元；金额错误零分',max_score:10}];
 const question={input_revision:1,question_version:'question-v1',rubric_version:'rubric-v1',question:'欠款多少？',attachment_ids:[attachment],answer_requirements:{input_mode:'text' as const,output_mode:'text' as const,tools:[] as string[]},rubric,quality_check:{passed:true,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]}};
 question.question_version=hash(JSON.stringify({input_revision:1,question:question.question,attachment_ids:question.attachment_ids,answer_requirements:question.answer_requirements}));
 const packaged={question_version:question.question_version,input_revision:1,question:question.question,materials:[{name:'附件1',text:'合同载明欠款100元'}],attachments:[{id:attachment,sha256:hash('合同载明欠款100元')}]};
 const answerInput={...packaged,question_attempt_id:questionId,input_digest:inputDigest(packaged)};
 const answerResult={text:'欠款100元',answer_sha256:hash('欠款100元'),input_digest:answerInput.input_digest,input_revision:1,question_version:question.question_version,question_attempt_id:questionId,model:'model'};
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,result,finished_at) VALUES($1,$2,4,1,'succeeded',1,$3,now())",[questionId,flow,JSON.stringify(question)]);
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,input,result,config,finished_at) VALUES($1,$2,5,1,'succeeded',1,$3,$4,$5,now())",[answerId,flow,JSON.stringify(answerInput),JSON.stringify(answerResult),JSON.stringify({provider:'qwen',model:'model'})]);
 await db.query("UPDATE ai_distill.steps SET result=$2 WHERE workflow_id=$1 AND ordinal=5",[flow,JSON.stringify(answerResult)]);
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,result,finished_at) VALUES($1,$2,6,1,'failed',1,$3,now())",[badScore,flow,JSON.stringify({validation:{valid:false},report:{disputes:['synthetic scoring conflict']}})]);
 await db.query("INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,6,$2)",[project,JSON.stringify({provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low'})]);
 const gradingChain=await startRevision(db,flow,badScore);
 await runRevisionTick(db,storage);
 const queued=(await db.query("SELECT id,revision_round_id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND status='waiting'",[flow])).rows;
 check('revision tick queues a new score bound to its round',queued.length===1&&!!queued[0].revision_round_id);
 let gradingCalls=0;
 const consumed=await runNextScore(db,storage,async(context,options)=>{
  gradingCalls++;
  if(realGrading)return await runIndependentScore(context,options);
  return {report:{binding:context.binding,assessment_valid:true,items:[{id:'amount',score:10,reason:'金额有答案原文依据',missing:false,evidence:[{source:'answer',quote:'100元',material_index:null}]}],total:10,max_score:10,disputes:[]},session_id:'synthetic-score-session',usage:{input_tokens:10,output_tokens:5},duration_ms:1};
 });
 check(realGrading?'queue consumer persists actual Codex grading':'queue consumer persists a valid injected score',consumed&&gradingCalls===1&&(await db.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[queued[0].id])).rows[0].status==='succeeded');
 await runRevisionTick(db,storage);await runRevisionTick(db,storage);await runRevisionTick(db,storage);
 const closed=(await db.query('SELECT status,content_revisions,calls_reserved FROM ai_distill.revision_chains WHERE id=$1',[gradingChain.id])).rows[0];
 if(closed.status!=='accepted')console.error('score chain state',JSON.stringify(closed),(await db.query('SELECT stage,status FROM ai_distill.revision_rounds WHERE chain_id=$1',[gradingChain.id])).rows,(await db.query('SELECT reason FROM ai_distill.revision_chains WHERE id=$1',[gradingChain.id])).rows);
 check('score revision closes as accepted with one recorded invocation',closed.status==='accepted'&&closed.content_revisions===1&&closed.calls_reserved===1);
 const completed=(await db.query('SELECT after_versions,after_scores,status FROM ai_distill.revision_rounds WHERE chain_id=$1',[gradingChain.id])).rows[0];
 check('completed round keeps actual versions and model score',completed.status==='succeeded'&&completed.after_versions.question_version===question.question_version&&completed.after_scores.model.score===10);
 await runRevisionTick(db,storage);
 check('terminal chain is not dispatched again',gradingCalls===1&&(await db.query('SELECT count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6',[flow])).rows[0].count===2);

 await db.query("UPDATE ai_distill.revision_chains SET status='running' WHERE id=$1",[gradingChain.id]);
 const reuseRound=(await db.query('SELECT id FROM ai_distill.revision_rounds WHERE chain_id=$1',[gradingChain.id])).rows[0].id;
 await db.query("UPDATE ai_distill.revision_rounds SET stage=6,status='running' WHERE id=$1",[reuseRound]);
 await db.query('UPDATE ai_distill.step_attempts SET revision_round_id=NULL WHERE id=$1',[queued[0].id]);
 await runRevisionTick(db,storage);
 check('reused successful score advances without another invocation',(await db.query('SELECT stage FROM ai_distill.revision_rounds WHERE id=$1',[reuseRound])).rows[0].stage===7&&gradingCalls===1);
 await runRevisionTick(db,storage);
 const extraction=crypto.randomUUID(),redaction=crypto.randomUUID(),rulesId=crypto.randomUUID(),ruleAttempt=crypto.randomUUID(),rejectedAuthor=crypto.randomUUID(),rejectedParent=crypto.randomUUID();
 const ruleRoot=join(storage,'frozen-rules'),ruleText='# 任务规则\n只围绕附件的欠款金额出一道文字题。题面保持原样。rubric须有明确正分和零分条件，满分10分。标答完整，但仅供质检。不得改动题面或引入新材料。';
 await mkdir(join(ruleRoot,'skill'),{recursive:true});await writeFile(join(ruleRoot,'skill','SKILL.md'),ruleText);
 const files=[{path:'skill/SKILL.md',sha256:hash(ruleText),size_bytes:Buffer.byteLength(ruleText)}];
 await db.query("INSERT INTO ai_distill.rule_versions(id,project_id,version,status) VALUES($1,$2,1,'published')",[rulesId,project]);
 await db.query('UPDATE ai_distill.workflows SET rule_version_id=$2 WHERE id=$1',[flow,rulesId]);
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,result,finished_at) VALUES($1,$2,2,1,'succeeded',1,'{}',now()),($3,$2,9,1,'succeeded',1,'{}',now()),($4,$2,3,1,'succeeded',1,$5,now())",[extraction,flow,redaction,ruleAttempt,JSON.stringify({input_revision:1,rule_version_id:rulesId,source_digest:hash(ruleText),snapshot_path:ruleRoot,files})]);
 await db.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[attachment,flow,redaction,'redacted_markdown','synthetic-database-text',packaged.attachments[0]!.sha256,Buffer.byteLength(packaged.materials[0]!.text),packaged.materials[0]!.text]);
 await db.query("UPDATE ai_distill.steps SET status='succeeded' WHERE workflow_id=$1 AND ordinal IN(1,2,3,9)",[flow]);
 const privateDraft={question:question.question,attachment_ids:question.attachment_ids,answer_requirements:question.answer_requirements,rubric,reference_answer:'欠款100元'};
 await mkdir(join(storage,flow,rejectedAuthor,'private'),{recursive:true});await writeFile(join(storage,flow,rejectedAuthor,'private','draft.json'),JSON.stringify(privateDraft));
 const quality={passed:true,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]};
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,input,result,finished_at) VALUES($1,$2,4,2,'failed',1,$3,$4,now())",[rejectedParent,flow,JSON.stringify({revision:{mode:'rubric',source_attempt_id:questionId}}),JSON.stringify({quality_check:{...quality,passed:false,checks:{...quality.checks,rubric_consistent:false},issues:[]}})]);
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,input,result,finished_at) VALUES($1,$2,4,3,'failed',1,$3,$4,now())",[rejectedAuthor,flow,JSON.stringify({revision:{mode:'rubric',source_attempt_id:rejectedParent}}),JSON.stringify({quality_check:{...quality,passed:false,checks:{...quality.checks,rubric_consistent:false},issues:[{code:'rubric_condition',detail:'评分条目需明确金额正确与缺失时的零分条件',blocking:true}]}})]);
 await db.query("UPDATE ai_distill.steps SET status='failed' WHERE workflow_id=$1 AND ordinal=4",[flow]);
 await db.query('INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,4,$2)',[project,JSON.stringify({provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low'})]);
 const rubricChain=await startRevision(db,flow,rejectedAuthor);
 await runRevisionTick(db,storage);
 check('rubric repair queues authoring and preserves completed answers',(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='waiting'",[flow])).rowCount===1&&(await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=5',[flow])).rows[0].status==='succeeded');
 let simulatedRoles=0;
 await runNextAuthoring(db,storage,realAuthor?undefined:async options=>{
  const attempt=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='running'",[flow])).rows[0].id;
  try{return await runAuthoring({...options,execute:async call=>await runRevisionCall(db,attempt,call.directory.endsWith('/author')?'author':'review',async()=>({result:call.validate(call.directory.endsWith('/author')?{...privateDraft,rubric:[{id:'amount',criterion:'准确回答欠款100元得10分；金额错误、未回答或遗漏金额得0分',max_score:10}]}:quality),session_id:`synthetic-role-${++simulatedRoles}`,usage:{input_tokens:10},duration_ms:1,events_path:'private'}))});}catch(error){console.error('synthetic executor failure',error instanceof Error?error.message:'unknown');throw error;}
 });
 const authored=(await db.query('SELECT id,status,result,error FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1',[flow])).rows[0];
 if(authored.status!=='succeeded')console.error('author failure',authored.status,authored.error);
 check('rubric repair publishes a independently reviewed successor',authored.status==='succeeded');
 check('two failed rubric ancestors preserve original answers without leaking reference answer',authored.result.question_version===question.question_version&&authored.result.answer_source_attempt_ids.includes(questionId)&&!('reference_answer' in authored.result));
 await runRevisionTick(db,storage);await runRevisionTick(db,storage);
 await runNextScore(db,storage,realGrading?runIndependentScore:async context=>({report:{binding:context.binding,assessment_valid:true,items:[{id:'amount',score:10,reason:'金额有原文依据',missing:false,evidence:[{source:'answer',quote:'100元',material_index:null}]}],total:10,max_score:10,disputes:[]},session_id:'synthetic-rubric-score',usage:{input_tokens:10},duration_ms:1}));
 await runRevisionTick(db,storage);await runRevisionTick(db,storage);
 const rubricClosed=(await db.query('SELECT status,calls_reserved FROM ai_distill.revision_chains WHERE id=$1',[rubricChain.id])).rows[0];
 check('rubric revision closes without a second paid answer',rubricClosed.status==='accepted'&&rubricClosed.calls_reserved===3&&(await db.query('SELECT count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5',[flow])).rows[0].count===1);
 const materialFlow=crypto.randomUUID(),materialId=crypto.randomUUID(),ocrSource=crypto.randomUUID();
 await db.query("INSERT INTO ai_distill.workflows(id,project_id,request_id,title) VALUES($1,$2,$3,'material repair fixture')",[materialFlow,project,crypto.randomUUID()]);
 await db.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,enabled,step_key,display_position) SELECT $1,n,'fixture','succeeded',true,true,'fixture_'||n,n FROM generate_series(1,9)n",[materialFlow]);
 await db.query("INSERT INTO ai_distill.materials(id,workflow_id,original_name,storage_path,sha256,size_bytes) VALUES($1,$2,'original.pdf','original.pdf',$3,1)",[materialId,materialFlow,hash('original')]);
 const ocrConfig={model:'glm-ocr',ocr_version:'glm-ocr-layout-v1',base_url:'https://open.bigmodel.cn/api/paas/v4',extraction:loadExtractionConfig()};
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,config,result,finished_at) VALUES($1,$2,2,1,'succeeded',1,$3,$4,now())",[ocrSource,materialFlow,JSON.stringify(ocrConfig),JSON.stringify({materials:[{material_id:materialId,pages:1}],pages:[{material_id:materialId,page:1}],issues:[{material_id:materialId,page:1,kind:'empty_page'}]})]);
 await db.query('INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,5,$2)',[project,JSON.stringify(realAnswer?resolveAnswerConfig({}):{provider:'qwen',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'model'})]);
 await db.query('UPDATE ai_distill.workflows SET rule_version_id=$2 WHERE id=$1',[materialFlow,rulesId]);
 if(realAnswer){const actual=resolveAnswerConfig({});await db.query('UPDATE ai_distill.project_step_configs SET config=$2 WHERE project_id=$1 AND ordinal=7',[project,JSON.stringify({...config,required_models:[actual.model],minimum_score_by_model:{[actual.model]:8},revision_budget:{...config.revision_budget,max_calls:100,max_duration_ms:600000}})]);}
 const multiModelIds=[crypto.randomUUID(),crypto.randomUUID()];
 if(!realAnswer){
  const models=[{id:multiModelIds[0]!,name:'Synthetic Qwen',provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus',minimum:8},{id:multiModelIds[1]!,name:'Synthetic DeepSeek',provider:'deepseek',base_url:'https://api.deepseek.com',model:'deepseek-chat',minimum:7}];
  for(const model of models){const modelConfig={provider:model.provider,base_url:model.base_url,model:model.model};await db.query('INSERT INTO ai_distill.system_answer_models(id,name,provider,base_url,model,config) VALUES($1,$2,$3,$4,$5,$6)',[model.id,model.name,model.provider,model.base_url,model.model,JSON.stringify(modelConfig)]);await db.query('INSERT INTO ai_distill.project_answer_models(project_id,model_id,minimum_score,position) VALUES($1,$2,$3,$4)',[project,model.id,model.minimum,models.indexOf(model)]);}
 }
 const materialChain=await startRevision(db,materialFlow,ocrSource);
 await runRevisionTick(db,storage);
 const materialQueued=(await db.query("SELECT id,revision_round_id,input FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=2 AND status='waiting'",[materialFlow])).rows[0];
 check('material anomaly queues exactly the evidenced PDF in a revision round',!!materialQueued?.revision_round_id&&materialQueued.input.material_repair.material_ids.length===1&&materialQueued.input.material_repair.material_ids[0]===materialId);
 await runNextExtraction(db,storage,async(_root,_workflow,attempt)=>{
  await runRevisionCall(db,attempt,`material:${materialId}`,async()=>({duration_ms:1}));
  const content=JSON.stringify({source_sha256:hash('original'),pages:[{page:1,text:'原件金额100元',method:'ocr'}]});
  return{blocked:false,artifacts:[{kind:'private_extracted_pages',material_id:materialId,storage_path:'synthetic-raw.json',sha256:hash(content),size_bytes:Buffer.byteLength(content),content}],result:{materials:[],pages:[],issues:[],persistence:'synthetic OCR result'}};
 },materialFlow);
 await runRevisionTick(db,storage);await runRevisionTick(db,storage);
 const materialRound=(await db.query('SELECT stage FROM ai_distill.revision_rounds WHERE chain_id=$1',[materialChain.id])).rows[0];
 const redactionQueued=(await db.query("SELECT revision_round_id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9 AND status='waiting'",[materialFlow])).rows[0];
 check('repaired material queues bound independent redaction before authoring',materialRound.stage===9&&redactionQueued?.revision_round_id===materialQueued.revision_round_id);
 check('material invocation consumes chain quota once',(await db.query('SELECT calls_reserved FROM ai_distill.revision_chains WHERE id=$1',[materialChain.id])).rows[0].calls_reserved===1);
 let redactionCalls=0;
 await runNextRedaction(db,storage,undefined,async options=>{
  redactionCalls++;
  return{result:options.validate({materials:[{material_id:materialId,pages:[{page:1,text:'原件金额100元'}]}]}),session_id:'synthetic-material-redaction',usage:{input_tokens:10},duration_ms:1,events_path:'private'};
 });
 const redacted=(await db.query("SELECT status FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=9 ORDER BY attempt DESC LIMIT 1",[materialFlow])).rows[0];
 check('material repair actually consumes and publishes independently validated redaction',redacted.status==='succeeded'&&redactionCalls===1);
 check('redaction invocation consumes a second chain call',(await db.query('SELECT calls_reserved FROM ai_distill.revision_chains WHERE id=$1',[materialChain.id])).rows[0].calls_reserved===2);
 await db.query('UPDATE ai_distill.workflows SET rule_version_id=$2 WHERE id=$1',[materialFlow,rulesId]);
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,result,finished_at) VALUES($1,$2,3,1,'succeeded',1,$3,now())",[crypto.randomUUID(),materialFlow,JSON.stringify({input_revision:1,rule_version_id:rulesId,source_digest:hash(ruleText),snapshot_path:ruleRoot,files})]);
 await runRevisionTick(db,storage);await runRevisionTick(db,storage);
 const afterMaterials=(await db.query("SELECT input,revision_round_id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='waiting'",[materialFlow])).rows[0];
 const newAttachment=(await db.query("SELECT id FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_markdown'",[materialFlow])).rows[0];
 check('material repair authoring freezes the new redacted attachment in the same round',afterMaterials?.revision_round_id===materialQueued.revision_round_id&&afterMaterials?.input.materials[0]?.id===newAttachment?.id);
 let materialRoles=0;
 await runNextAuthoring(db,storage,realAuthor?undefined:async options=>{
  const attempt=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='running'",[materialFlow])).rows[0].id;
  return await runAuthoring({...options,execute:async call=>runRevisionCall(db,attempt,call.directory.endsWith('/author')?'author':'review',async()=>({result:call.validate(call.directory.endsWith('/author')?{...privateDraft,attachment_ids:[newAttachment.id]}:quality),session_id:`synthetic-material-role-${++materialRoles}`,usage:{input_tokens:10},duration_ms:1,events_path:'private'}))});
 });
 await runRevisionTick(db,storage);await runRevisionTick(db,storage);
 let materialAnswers=0,failedModelRetry=false;
 const answerMaterial=async(input:any)=>{
  materialAnswers++;check('fresh answer receives repaired redacted material',input.materials[0]?.text==='原件金额100元');
  if(realAnswer)return await createAnswerClient().answer(input);
  if(input.config.provider==='deepseek'&&!failedModelRetry){failedModelRetry=true;throw new DomesticError('rate_limit',true,429);}
  return{text:'欠款100元',requested_model:input.config.model,model:input.config.model,request_id:null,completion_id:null,usage:{input_tokens:10},started_at:new Date().toISOString(),finished_at:new Date().toISOString(),duration_ms:1};
 };
 await runNextAnswer(db,storage,answerMaterial);
 if(!realAnswer){
  await runNextAnswer(db,storage,answerMaterial);
  const partial=(await db.query('SELECT result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=5',[materialFlow])).rows[0].result.models;
  check('first multi-model pass preserves the successful answer beside one retryable failure',partial.some((item:any)=>item.model_id===multiModelIds[0]&&item.status==='succeeded')&&partial.some((item:any)=>item.model_id===multiModelIds[1]&&item.status==='failed'));
  await runRevisionTick(db,storage);await runRevisionTick(db,storage);
  const retryRound=(await db.query('SELECT id,round,parent_round_id,stage FROM ai_distill.revision_rounds WHERE chain_id=$1 ORDER BY round DESC LIMIT 1',[materialChain.id])).rows[0];
  const retryTasks=(await db.query("SELECT input->>'model_id' AS model_id,status FROM ai_distill.step_attempts WHERE revision_round_id=$1 AND ordinal=5",[retryRound.id])).rows;
  check('technical child round retries only the failed selected model',retryRound.round===2&&retryRound.stage===5&&retryRound.parent_round_id===materialQueued.revision_round_id&&retryTasks.length===1&&retryTasks[0].model_id===multiModelIds[1]);
  await runNextAnswer(db,storage,answerMaterial);
 }else await runRevisionTick(db,storage);
 check('answer dispatch preserves independently redacted materials',(await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=9',[materialFlow])).rows[0].status==='succeeded');
 await runRevisionTick(db,storage);await runRevisionTick(db,storage);
 const gradeMaterial=async(context:any,options:any)=>realGrading?await runIndependentScore(context,options):({report:{binding:context.binding,assessment_valid:true,items:[{id:'amount',score:10,reason:'金额有原文依据',missing:false,evidence:[{source:'answer',quote:'100元',material_index:null}]}],total:10,max_score:10,disputes:[]},session_id:'synthetic-material-score',usage:{input_tokens:10},duration_ms:1});
 await runNextScore(db,storage,gradeMaterial);
 if(!realAnswer)await runNextScore(db,storage,gradeMaterial);
 await runRevisionTick(db,storage);await runRevisionTick(db,storage);
 const modelScores=(await db.query('SELECT result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=7',[materialFlow])).rows[0]?.result?.model_scores??{};
 if(!realAnswer)check('acceptance includes separate scores for every selected model',Object.keys(modelScores).length===2&&Object.values(modelScores).every((score:any)=>score.score===10));
 await runRevisionTick(db,storage);
 const materialClosed=(await db.query('SELECT status,calls_reserved FROM ai_distill.revision_chains WHERE id=$1',[materialChain.id])).rows[0];
 if(materialClosed.status!=='accepted')console.error('material chain state',materialClosed,(await db.query('SELECT status,reason FROM ai_distill.revision_chains WHERE id=$1',[materialChain.id])).rows,(await db.query('SELECT stage,status FROM ai_distill.revision_rounds WHERE chain_id=$1',[materialChain.id])).rows,(await db.query('SELECT ordinal,status,error FROM ai_distill.step_attempts WHERE workflow_id=$1 ORDER BY ordinal,attempt',[materialFlow])).rows);
 const expectedCalls=4+(realAnswer?1:3)+(realGrading?1:realAnswer?1:2);
 check('material repair closes accepted after authoring, every model answer, and every score',materialClosed.status==='accepted'&&materialClosed.calls_reserved===expectedCalls&&materialAnswers===(realAnswer?1:3));
 if(!realAnswer){const finalAnswers=(await db.query("SELECT input->>'model_id' AS model_id,count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND status='succeeded' GROUP BY input->>'model_id'",[materialFlow])).rows;check('successful model answer survives retry without another answer call',finalAnswers.length===2&&finalAnswers.find((item:any)=>item.model_id===multiModelIds[0])?.count===1&&finalAnswers.find((item:any)=>item.model_id===multiModelIds[1])?.count===1);}
 check('complete material chain retains valid independent redaction',(await db.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=9',[materialFlow])).rows[0].status==='succeeded');


 const rulesFailure=crypto.randomUUID(),newRules=crypto.randomUUID();
 await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input_revision,input,config,result,finished_at) SELECT $1,$2,6,a.attempt+1,'failed',1,a.input,a.config,$3,now() FROM ai_distill.step_attempts a WHERE workflow_id=$2 AND ordinal=6 ORDER BY a.attempt DESC LIMIT 1",[rulesFailure,materialFlow,JSON.stringify({error:{kind:'service',retryable:true,http_status:503}})]);
 const rulesChain=await startRevision(db,materialFlow,rulesFailure);
 await runRevisionTick(db,storage);
 const rulesQueued=(await db.query("SELECT id,revision_round_id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND status='waiting'",[materialFlow])).rows[0];
 check('rule-change scenario queues a task under its original frozen rule version',!!rulesQueued?.revision_round_id);
 await db.query("UPDATE ai_distill.step_attempts SET status='running' WHERE id=$1",[rulesQueued.id]);
 await db.query("INSERT INTO ai_distill.rule_versions(id,project_id,version,status) VALUES($1,$2,2,'published')",[newRules,project]);
 await db.query('UPDATE ai_distill.workflows SET rule_version_id=$2 WHERE id=$1',[materialFlow,newRules]);
 const ruleClient=await db.connect();let settingsRejected=false;
 try{await readRevisionSettings(ruleClient,materialFlow,1,rulesQueued.revision_round_id);}catch(error){settingsRejected=error instanceof Error&&error.message.includes('规则版本已变化');}finally{ruleClient.release();}
 check('actual database rule change rejects the frozen chain settings',settingsRejected);
 let rulesSent=false,rulesRejected=false;
 try{await runRevisionCall(db,rulesQueued.id,'score',async()=>{rulesSent=true;return{};});}catch(error){rulesRejected=error instanceof Error&&error.message==='rule_version_changed';}
 const rulesStopped=(await db.query('SELECT status,calls_reserved,reason FROM ai_distill.revision_chains WHERE id=$1',[rulesChain.id])).rows[0];
 check('rule change before an in-flight request isolates without sending or reserving',rulesRejected&&!rulesSent&&rulesStopped.status==='isolated'&&rulesStopped.reason==='rule_version_changed'&&rulesStopped.calls_reserved===0);
 check('historic accepted chain is retained after a rule change',(await db.query('SELECT status FROM ai_distill.revision_chains WHERE id=$1',[materialChain.id])).rows[0].status==='accepted');
}catch(error){failure=error instanceof Error?error.message:'verification_failed';console.error('隔离返修验收失败，详见安全证据记录');process.exitCode=1;}
finally{
 try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{console.error('隔离 schema 清理失败');process.exitCode=1;}
 await pool.end();await rm(storage,{recursive:true,force:true});await mkdir('docs/evidence',{recursive:true});
 await writeFile(realAnswer?'docs/evidence/2026-10-08-revision-real-answer-results.json':realGrading?'docs/evidence/2026-10-08-revision-real-grading-results.json':realAuthor?'docs/evidence/2026-10-08-revision-real-author-results.json':'docs/evidence/2026-10-08-revision-loop-results.json',JSON.stringify({checked_at:new Date().toISOString(),real_database:true,synthetic_sources:true,real_model_calls:realAuthor||realGrading||realAnswer,real_author_and_review:realAuthor,real_author_scope:realAuthor?'rubric_and_material':'none',real_grading:realGrading,real_supplier_answer:realAnswer,synthetic_multi_model_material_repair:!realAnswer,real_material_calls:false,checks,failure},null,2)+'\n');
}
