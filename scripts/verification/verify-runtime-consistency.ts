/** 本机运行一致性验收：仅127.0.0.1:显式端口的queue_verify空库，双SQLite、真实迁移/HTTP及合成建议Agent；--serve可供隔离浏览器验收，退出删schema和临时目录。不读取.env或调用真实模型。 */
import {Pool} from 'pg';
import {createApp} from '../../server/app';
import {mkdtemp,readFile,readdir,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createLibraryPackage,createLibraryRevision} from '../../server/material-library/service';
import {enqueueLibraryJob} from '../../server/material-library/jobs';
import {runNextLibraryJob} from '../../server/material-library/runner';
import {STEP_REGISTRY} from '../../shared/step-registry';
import {configureLogger} from '../../server/logging';
import {localQueue,withLocalQueueRoot,withLocalExecution,reconcileRegistrations,registerLocalJob,releaseRolledBackRegistrations} from '../../server/execution-queue/runtime';
import {runNextRevisionAdvice} from '../../server/revision-advice/jobs';
const arg=(name:string)=>process.argv[process.argv.indexOf(name)+1],port=Number(arg('--port')),out=arg('--out'),serve=process.argv.includes('--serve');
if(!process.argv.includes('--port')||!process.argv.includes('--out')||!Number.isInteger(port)||port<1024||port>65535)throw new Error('须明确隔离PG端口及输出文件');
process.env.EXECUTION_QUEUE_MODE='local';process.env.AGENT_CONCURRENCY='4';process.env.LLM_API_CONCURRENCY='4';
const root=await mkdtemp(join(tmpdir(),'runtime-consistency-')),workspace=join(root,'project'),qA=localQueue(join(root,'A')),qB=localQueue(join(root,'B'));
const logger=configureLogger({root,service:'api'}),config={host:'127.0.0.1',port,user:'postgres',database:'queue_verify',ssl:false,max:4,connectionTimeoutMillis:5000,options:'-c statement_timeout=10000'};
const admin=new Pool(config),a=new Pool({...config,application_name:`ai-distill-executor:${qA.executorId}`}),b=new Pool({...config,application_name:`ai-distill-executor:${qB.executorId}`});
const results:{name:string;passed:boolean}[]=[];let created=false,cleaned=false,failure:unknown,models=0;const servers:ReturnType<typeof Bun.serve>[]=[];
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function check(name:string,run:()=>Promise<void>){await run();results.push({name,passed:true});console.log('PASS '+name);}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function seed(project:string,title:string,decision='repair'){
 const id=randomUUID();await admin.query('INSERT INTO ai_distill.workflows(id,project_id,request_id,title,workflow_kind) VALUES($1,$2,$3,$4,\'question\')',[id,project,randomUUID(),title]);
 const authored={task_name:title,task_type:'法律分析',question:'请根据合成材料分析付款时间和证据边界。',question_version:hash(id),rubric_version:hash('rubric-'+id),rubric:[{id:'R1',criterion:'依据材料核对时间',max_score:100}],answer_approach:'合成思路',reference_answer:'合成标答',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
 const answerId=randomUUID(),scoreId=randomUUID(),data:Record<number,unknown>={4:authored,5:{models:[{model_id:randomUUID(),name:'合成候选',status:'succeeded',attempt_id:answerId,answer:'合成作答：付款时间需要核对。'}]},6:{models:[{answer_attempt_id:answerId,score_status:'succeeded',attempt_id:scoreId,score:decision==='accepted'?10:80,max_score:100,report:{reason:'合成评分理由'}}]},7:{decision,reasons:[decision==='accepted'?'已达标':'时间表述需要修正'],model_scores:{}}};
 for(const step of STEP_REGISTRY)await admin.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,step_key,display_position,name,status,enabled,implemented,result) VALUES($1,$2,$3,$4,$5,$6,true,true,$7)",[id,step.ordinal,step.key,step.position,step.name,step.ordinal===8?'waiting':'succeeded',data[step.ordinal]?JSON.stringify(data[step.ordinal]):null]);
 const redaction=randomUUID();await admin.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result) VALUES($1,$2,9,1,'succeeded','{}','{}')",[redaction,id]);
 const content='合成材料：合同约定交付后十五日支付100元。';await admin.query("INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,'redacted_markdown','synthetic.txt',$4,$5,$6)",[randomUUID(),id,redaction,hash(content),Buffer.byteLength(content),content]);
 return id;
}
async function save(extra:Record<string,unknown>={}){await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify({at:new Date().toISOString(),results,passed:results.length,cleaned,real_models_called:0,synthetic_agent_calls:models,error:failure instanceof Error?failure.message:null,...extra},null,2));}
try{
 assert((await admin.query('SELECT current_database() AS db')).rows[0].db==='queue_verify','拒绝业务库');assert(!(await admin.query("SELECT to_regclass('ai_distill.schema_migrations') AS name")).rows[0].name,'只接受专用空库');
 await admin.query('CREATE SCHEMA ai_distill');created=true;await admin.query('CREATE TABLE ai_distill.schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
 for(const name of (await readdir(new URL('../../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()){await admin.query('BEGIN');try{await admin.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));await admin.query('INSERT INTO ai_distill.schema_migrations(name) VALUES($1)',[name]);await admin.query('COMMIT');}catch(error){await admin.query('ROLLBACK');throw new Error(`隔离迁移失败：${name}`,{cause:error});}}
 await check('050与全部真实迁移在隔离空库成功',async()=>{assert((await admin.query("SELECT to_regclass('ai_distill.revision_advice_attempts') AS name")).rows[0].name,'缺少建议表');});
 await mkdir(join(workspace,'skill'),{recursive:true});await writeFile(join(workspace,'skill','SKILL.md'),'---\nname: synthetic-legal\ndescription: 隔离验收合成规则\n---\n# 合成测试规则\n按本次附件设计题目，核对证据时间。');
 const project=randomUUID(),group=randomUUID();await admin.query('INSERT INTO ai_distill.project_groups(id,name) VALUES($1,$2)',[group,'隔离验收主项目']);await admin.query('INSERT INTO ai_distill.projects(id,name,parent_name,project_group_id,phase_name,workspace_path,material_root,local_skill_path,material_backend) VALUES($1,$2,$5,$6,\'隔离一期\',$3,$3,$4,\'legacy\')',[project,'隔离验收项目',workspace,join(workspace,'skill'),'隔离验收主项目',group]);
 const repair=await seed(project,'合成未达标题目'),accepted=await seed(project,'合成已达标题目','accepted'),interrupted=await seed(project,'合成本机待核实');
 const appA=createApp(a,qA.root),appB=createApp(b,qB.root);
 let adviceId='',libraryQuestion='';
 await check('真实HTTP手动派发建议，重复点击复用同一任务',async()=>{const response=await appA.request(`/api/workflows/${repair}/revision-advice`,{method:'POST'});assert(response.status===202,'建议派发未返回202');adviceId=(await response.json()).id;const repeat=await appA.request(`/api/workflows/${repair}/revision-advice`,{method:'POST'});assert((await repeat.json()).id===adviceId,'重复点击产生新任务');assert(qA.get(adviceId)?.lane==='agent'&&!qB.get(adviceId),'建议归属或容量通道错误');});
 await check('建议Agent替身完成后可读取同版文本，不派发出题',async()=>{await reconcileRegistrations(a,qA);const job=qA.claim('agent',[adviceId]);assert(job,'建议未确认');await withLocalExecution(qA,job,()=>runNextRevisionAdvice(a,qA.root,undefined,(async()=>{models++;return{result:{text:'补清合同交付日和付款期限的计算依据，保留原评分标准。'},session_id:'synthetic',duration_ms:1};}) as any));qA.finish(job.id,job.lease!,'committed');const result=await(await appA.request(`/api/workflows/${repair}/revision-advice`)).json();assert(result.attempts[0]?.current&&result.attempts[0]?.result?.text.includes('付款期限'),'建议不属于当前版本或未保存');assert(!(await a.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4",[repair])).rowCount,'生成建议自动出题');});
 await check('下一次出题冻结建议并保持重复派发复用',async()=>{const response=await appA.request(`/api/workflows/${repair}/author`,{method:'POST'});const payload=await response.json();assert(response.status===202,`出题派发失败：${JSON.stringify(payload)}`);const job=(await a.query('SELECT input FROM ai_distill.step_attempts WHERE id=$1',[payload.id])).rows[0];assert(job?.input?.revision_advice?.id===adviceId,'出题未冻结建议');const repeat=await appA.request(`/api/workflows/${repair}/author`,{method:'POST'});assert((await repeat.json()).id===payload.id,'含建议的活动出题未复用');});
 await check('批量出题、作答、评分均跳过已达标且不改结果',async()=>{const before=JSON.stringify((await a.query('SELECT ordinal,status,result FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY ordinal',[accepted])).rows);for(const ordinal of [4,5,6]){const response=await appA.request(`/api/projects/${project}/steps/${ordinal}/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow_ids:[accepted]})});const payload=await response.json();assert(payload.results?.[0]?.status==='already_accepted','批量没有跳过达标');}assert(JSON.stringify((await a.query('SELECT ordinal,status,result FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY ordinal',[accepted])).rows)===before,'达标结果被改变');});
 await check('同一PG运行记录在A投影待核实，在B明确他机，无本机占用',async()=>{const id=randomUUID(),client=await a.connect();try{await client.query('BEGIN');await client.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status) VALUES($1,$2,4,1,'running')",[id,interrupted]);await withLocalQueueRoot(qA.root,()=>registerLocalJob(client,id,'step','agent','authoring'));await client.query('COMMIT');}finally{client.release();}await reconcileRegistrations(a,qA);const job=qA.claim('agent',[id]);assert(job,'投影夹具未领取');qA.finish(id,job.lease!,'needs_review');await a.query("UPDATE ai_distill.steps SET status='running' WHERE workflow_id=$1 AND ordinal=4",[interrupted]);const A=await(await appA.request(`/api/workflows/${interrupted}`)).json(),B=await(await appB.request(`/api/workflows/${interrupted}`)).json();assert(A.steps.find((step:any)=>step.ordinal===4)?.executions?.[0]?.state==='needs_review','A仍显示全局运行');assert(B.steps.find((step:any)=>step.ordinal===4)?.executions?.[0]?.scope==='other_executor','B没有区分其他机器');const summary=await(await appA.request(`/api/projects/${project}`)).json();assert(summary.steps.find((step:any)=>step.ordinal===4)?.running===0,'全局running污染本机运行数');});
 await check('真实PG确认回滚后释放容量，但保留原意图',async()=>{const id=randomUUID(),client=await a.connect(),before=qA.capacity('api',4).waiting;try{await client.query('BEGIN');await withLocalQueueRoot(qA.root,()=>registerLocalJob(client,id,'step','api','answer'));await client.query('ROLLBACK');await releaseRolledBackRegistrations(client);assert(qA.capacity('api',4).waiting===before,'回滚名额未释放');assert(qA.get(id)?.state==='pending_registration','原意图被删除');}finally{client.release();}});
 await check('共享库原文题就绪不依赖旧步骤9，作者派发冻结正确来源',async()=>{
  const pkg=await createLibraryPackage(a,{name:'合成原文包'}),revision=await createLibraryRevision(a,qA.root,pkg.id,Number(pkg.lock_version),randomUUID(),[{original_name:'合成材料.txt',bytes:Buffer.from('合成合同：交付后十五日支付100元。')}]);
  for(const kind of ['intake','extract'] as const){
   const task=await withLocalQueueRoot(qA.root,()=>enqueueLibraryJob(a,pkg.id,revision.id,{kind,request_key:randomUUID(),execution_target:'local'},qA.root));
   await reconcileRegistrations(a,qA);const job=qA.claim('internal',[task.id]);assert(job,'TXT库任务未领取');
   await withLocalExecution(qA,job,()=>runNextLibraryJob(a,qA.root,'internal','local',new AbortController().signal,job.id));qA.finish(job.id,job.lease!,'committed');
   assert((await a.query('SELECT status FROM ai_distill.library_jobs WHERE id=$1',[job.id])).rows[0]?.status==='succeeded','TXT库任务未成功');
  }
  await a.query("INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,4,$2) ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config",[project,JSON.stringify({provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'medium',material_processing_mode:'original',material_source_mode:'original'})]);
  const loaded=await appA.request(`/api/projects/${project}/loaded-materials`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({package_id:pkg.id,revision_id:revision.id})});const link=await loaded.json();assert(loaded.status===201,`原文加载失败：${link.error}`);
  const response=await appA.request(`/api/projects/${project}/loaded-materials/${link.id}/questions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_key:randomUUID(),revision_id:revision.id,expected_link_version:Number(link.lock_version),title:'合成共享库原文题',question_tags:[]})});const question=await response.json();assert(response.status===201,`库建题失败：${question.error}`);libraryQuestion=question.id;
  const detail=await(await appA.request(`/api/workflows/${libraryQuestion}`)).json();assert(detail.question_material_origin?.material_mode==='original'&&detail.steps.find((step:any)=>step.ordinal===4)?.ready,'库题来源或就绪条件错误');assert(!detail.steps.some((step:any)=>step.ordinal===9),'库题要求了旧步骤9');
  if(!serve){const authored=await appA.request(`/api/workflows/${libraryQuestion}/author`,{method:'POST'});const task=await authored.json();assert(authored.status===202,`库题作者派发失败：${task.error}`);assert((await a.query('SELECT input FROM ai_distill.step_attempts WHERE id=$1',[task.id])).rows[0]?.input?.material_origin?.material_mode==='original','作者来源未冻结');}
 });
 await check('取消待领取建议明确记已取消，不改变题目成果',async()=>{const workflow=await seed(project,'合成取消建议');const created=await(await appA.request(`/api/workflows/${workflow}/revision-advice`,{method:'POST'})).json();assert(created.id,'取消建议夹具未派发');const response=await appA.request(`/api/system/execution-queue/${created.id}/cancel`,{method:'POST'});assert(response.status===200,'建议取消失败');assert((await a.query('SELECT status FROM ai_distill.revision_advice_attempts WHERE id=$1',[created.id])).rows[0]?.status==='skipped','建议未记已取消');assert((await a.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=4',[workflow])).rows[0]?.status==='succeeded','取消建议改变了题目');});
 await save({fixture:{project,repair,accepted,interrupted,libraryQuestion},runtime:'checked'});
 if(serve){
  servers.push(Bun.serve({hostname:'127.0.0.1',port:13700,fetch:appA.fetch}),Bun.serve({hostname:'127.0.0.1',port:13701,fetch:appB.fetch}));
  console.log(JSON.stringify({ready:true,apiA:13700,apiB:13701,project,repair,accepted,interrupted,libraryQuestion,root}));
  await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
 }
}catch(error){failure=error;console.error(error instanceof Error?error.message:'隔离验收失败');}finally{
 for(const server of servers)await server.stop(true);
 try{if(created){await admin.query('DROP SCHEMA ai_distill CASCADE');cleaned=true;}}finally{await Promise.all([a.end(),b.end(),admin.end()]);await logger.close();qA.close();qB.close();await rm(root,{recursive:true,force:true});await save({runtime:'stopped'});}
}
if(failure)process.exitCode=1;
