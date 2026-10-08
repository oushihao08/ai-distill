import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPool} from '../server/db';
import {createApp} from '../server/app';
import {createHash} from 'node:crypto';
const pool=createPool(),storage=await mkdtemp(join(tmpdir(),'independent-modules-'));
const projectId=crypto.randomUUID(),workflowId=crypto.randomUUID(),requestId=crypto.randomUUID(),questionAttempt=crypto.randomUUID(),answerAttempt=crypto.randomUUID(),scoreAttempt=crypto.randomUUID(),extractAttempt=crypto.randomUUID(),materialArtifact=crypto.randomUUID();
const provider='qwen',model='fixture-token-model',validFrom='2026-10-01T00:00:00.000Z';
let report:Record<string,unknown>={checked_at:new Date().toISOString(),fixture:'synthetic data in temporary real PostgreSQL rows',real_database:true,migrations:['008_acceptance_reporting.sql','009_stale_exports.sql','011_publication_step.sql'],acceptance:false,prices:false,export_failure_isolated:false,export_retry:false,export:false,repeated_export:false,download:false,metrics:false,nonaccepted_gate:false,stale_export:false};
try{
 await pool.query("INSERT INTO ai_distill.projects(id,name) VALUES($1,'independent-module-verification')",[projectId]);
 await pool.query("INSERT INTO ai_distill.workflows(id,project_id,request_id,title,source_key) VALUES($1,$2,$3,'verification question','verification-batch')",[workflowId,projectId,requestId]);
 await pool.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented) SELECT $1,n,($2::text[])[n],'waiting',true FROM generate_series(1,8) n",[workflowId,['接收材料','提取与脱敏','加载本期规则','出题与质检','模型作答','独立评分','达标或返修','发布成果与导出']]);
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 const questionResult={input_revision:1,rubric:[{id:'amount',criterion:'金额正确',max_score:10}],answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},question:'根据材料金额是多少？',question_version:'qv1',rubric_version:'rv1',attachment_ids:[materialArtifact],quality_check:{passed:true,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]}};
 const answerResult={text:'100元',answer_sha256:hash('100元'),input_digest:'a'.repeat(64),provider:'qwen',model,question_attempt_id:questionAttempt,question_version:'qv1',input_revision:1,usage:{prompt_tokens:100,completion_tokens:20}};
 const rubric=[{id:'amount',criterion:'金额正确',max_score:10}];
 const scoreBinding={question_version:'qv1',input_revision:1,rubric_version:'rv1',input_digest:'a'.repeat(64),rubric_digest:'b'.repeat(64),answer_attempt_id:answerAttempt,answer_sha256:hash('100元')};
 const scoreResult={binding:scoreBinding,validation:{valid:true},report:{assessment_valid:true,items:[{id:'amount',score:9,reason:'与答案相符',evidence:[{source:'answer',quote:'100元'}]}],total:9,max_score:10,disputes:[]}};
 const attempts=[
  [extractAttempt,2,'succeeded',{},{},{},1],
  [questionAttempt,4,'succeeded',{extraction_attempt_id:extractAttempt,materials:[{id:materialArtifact,sha256:hash('脱敏测试资料')}]},questionResult,{provider:'codex',model:'fixture'},1],
  [answerAttempt,5,'succeeded',{question_attempt_id:questionAttempt},answerResult,{provider:'qwen',model},1],
  [scoreAttempt,6,'succeeded',{context:{binding:scoreBinding,rubric}},scoreResult,{provider:'codex',model:'fixture'},1],
 ];
 for(const [id,ordinal,status,input,result,config,revision] of attempts)await pool.query('INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,result,config,input_revision,finished_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,now())',[id,workflowId,ordinal,status,JSON.stringify(input),JSON.stringify(result),JSON.stringify(config),revision]);
 await pool.query("UPDATE ai_distill.steps SET status='succeeded',implemented=true WHERE workflow_id=$1 AND ordinal IN(2,3,4,5,6)",[workflowId]);
 await pool.query('UPDATE ai_distill.steps SET result=$2 WHERE workflow_id=$1 AND ordinal=4',[workflowId,JSON.stringify(questionResult)]);
 await pool.query('UPDATE ai_distill.steps SET result=$2 WHERE workflow_id=$1 AND ordinal=5',[workflowId,JSON.stringify(answerResult)]);
 await pool.query('UPDATE ai_distill.steps SET result=$2 WHERE workflow_id=$1 AND ordinal=6',[workflowId,JSON.stringify(scoreResult)]);
 await pool.query('INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,7,$2)',[projectId,JSON.stringify({required_models:[model],minimum_score_by_model:{[model]:8}})]);
 for(const [attempt,kind,filename,body] of [[questionAttempt,'authored_question','authoring.json',JSON.stringify(questionResult)],[answerAttempt,'model_answer','answer.txt',answerResult.text],[scoreAttempt,'score_report','score.json',JSON.stringify(scoreResult)]]){
  await writeFile(join(storage,filename!),body!);await pool.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),workflowId,attempt,kind,filename,hash(body!),Buffer.byteLength(body!)]);
 }
 await writeFile(join(storage,'material.md'),'脱敏测试资料');await pool.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[materialArtifact,workflowId,extractAttempt,'redacted_markdown','material.md',hash('脱敏测试资料'),Buffer.byteLength('脱敏测试资料')]);
 const app=createApp(pool,storage);
 const accepted=await app.request(`/api/workflows/${workflowId}/accept`,{method:'POST'});const acceptanceBody=await accepted.json() as any;
 if(accepted.status!==200||acceptanceBody.decision!=='accepted')throw new Error('acceptance endpoint failed');report.acceptance=true;
 const before=await app.request(`/api/projects/${projectId}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 if(before.status!==201||(await before.json() as any).workflow_count!==0)throw new Error('unpublished accepted result exported');report.unpublished_gate=true;
 const publications=await Promise.all([app.request(`/api/workflows/${workflowId}/publish`,{method:'POST'}),app.request(`/api/workflows/${workflowId}/publish`,{method:'POST'})]);
 const published=await publications[0]!.json() as any,duplicate=await publications[1]!.json() as any;
 if(publications.some(item=>item.status!==200)||published.id!==duplicate.id||published.reused===duplicate.reused)throw new Error('publication or concurrent reuse failed');report.publication=true;report.publication_reused=true;
 const artifact=(await pool.query("SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 AND kind='published_result'",[published.id])).rows[0];
 const publicationDownload=await app.request(`/api/artifacts/${artifact.id}/download`);const publicationBody=await publicationDownload.json() as any;
 if(publicationDownload.status!==200||publicationBody.question_version!==questionResult.question_version||'reference_answer' in publicationBody)throw new Error('publication download failed');report.publication_download=true;

 await pool.query('UPDATE ai_distill.step_attempts SET config=jsonb_set(config,\'{provider}\',to_jsonb($2::text)),result=jsonb_set(result,\'{provider}\',to_jsonb($2::text)) WHERE id=$1',[answerAttempt,provider]);
 const priceWrite=await app.request('/api/api-model-prices',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,model,currency:'CNY',input_per_million:2,output_per_million:8,source:'verification fixture',valid_from:validFrom})});
 const prices=await app.request('/api/api-model-prices');if(priceWrite.status!==200||!(await prices.json() as any[]).some(p=>p.provider===provider&&p.model===model))throw new Error('price endpoints failed');report.prices=true;
 const attemptsBeforeExport=(await pool.query('SELECT count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1',[workflowId])).rows[0].count;
 const blockedStorage=join(storage,'blocked-export');await mkdir(blockedStorage,{recursive:true});await writeFile(join(blockedStorage,'exports'),'not a directory');
 const blockedExport=await createApp(pool,blockedStorage).request(`/api/projects/${projectId}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch:'verification-batch'})});
 const failedExportRow=await pool.query("SELECT status FROM ai_distill.project_exports WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 1",[projectId]);
 const attemptsAfterFailure=(await pool.query('SELECT count(*)::int AS count FROM ai_distill.step_attempts WHERE workflow_id=$1',[workflowId])).rows[0].count;
 if(blockedExport.status!==500||failedExportRow.rows[0]?.status!=='failed'||attemptsAfterFailure!==attemptsBeforeExport)throw new Error('export failure changed workflow or was not recorded independently');report.export_failure_isolated=true;
 await rm(join(blockedStorage,'exports'),{force:true});
 const retryExport=await createApp(pool,blockedStorage).request(`/api/projects/${projectId}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch:'verification-batch'})});
 const retriedRow=await pool.query("SELECT status,workflow_count FROM ai_distill.project_exports WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 1",[projectId]);
 if(retryExport.status!==201||retriedRow.rows[0]?.status!=='succeeded'||retriedRow.rows[0]?.workflow_count!==1)throw new Error('independent export retry failed');report.export_retry=true;
 const exported=await app.request(`/api/projects/${projectId}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch:'verification-batch'})});const exportBody=await exported.json() as any;
 if(exported.status!==201||exportBody.workflow_count!==1)throw new Error('export endpoint failed');report.export=true;
 const repeated=await app.request(`/api/projects/${projectId}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch:'verification-batch'})});const repeatedBody=await repeated.json() as any;
 if(repeated.status!==201||repeatedBody.id===exportBody.id)throw new Error('repeated export failed');report.repeated_export=true;
 const downloaded=await app.request(`/api/exports/${exportBody.id}/download`);const workbook=new Uint8Array(await downloaded.arrayBuffer());if(downloaded.status!==200||workbook[0]!==0x50||workbook[1]!==0x4b)throw new Error('download endpoint failed');report.download=true;
 const metrics=await app.request(`/api/projects/${projectId}/metrics`);const metricsBody=await metrics.json() as any;if(metrics.status!==200||metricsBody.production.accepted!==1||metricsBody.api_costs.known_calls!==1)throw new Error('metrics endpoint failed');report.metrics=true;
 await pool.query("UPDATE ai_distill.project_step_configs SET config=jsonb_set(config,'{minimum_score_by_model}',jsonb_build_object($2::text,10)) WHERE project_id=$1 AND ordinal=7",[projectId,model]);
 const below=await app.request(`/api/workflows/${workflowId}/accept`,{method:'POST'});const belowBody=await below.json() as any;const stepState=await pool.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=7',[workflowId]);const exportState=await pool.query('SELECT status FROM ai_distill.project_exports WHERE id=ANY($1::uuid[])',[ [exportBody.id,repeatedBody.id] ]);
 if(below.status!==200||belowBody.decision!=='repair'||stepState.rows[0]?.status!=='failed')throw new Error('nonaccepted result was not gated');report.nonaccepted_gate=true;
 if(exportState.rows.length!==2||exportState.rows.some((row:any)=>row.status!=='stale'))throw new Error('prior exports were not invalidated');report.stale_export=true;
 report={...report,decision:acceptanceBody.decision,api_cost:metricsBody.api_costs,export_sha256:exportBody.sha256,workbook_bytes:workbook.length};
}catch(error){report={...report,error:error instanceof Error?error.message:'verification failed'};process.exitCode=1;}
finally{
 try{await pool.query('DELETE FROM ai_distill.project_exports WHERE project_id=$1',[projectId]);await pool.query('DELETE FROM ai_distill.artifacts WHERE workflow_id=$1',[workflowId]);await pool.query('DELETE FROM ai_distill.step_attempts WHERE workflow_id=$1',[workflowId]);await pool.query('DELETE FROM ai_distill.steps WHERE workflow_id=$1',[workflowId]);await pool.query('DELETE FROM ai_distill.workflows WHERE id=$1',[workflowId]);await pool.query('DELETE FROM ai_distill.project_step_configs WHERE project_id=$1',[projectId]);await pool.query('DELETE FROM ai_distill.projects WHERE id=$1',[projectId]);await pool.query('DELETE FROM ai_distill.api_model_prices WHERE provider=$1 AND model=$2 AND source=$3',[provider,model,'verification fixture']);const leftovers=await pool.query("SELECT (SELECT count(*) FROM ai_distill.projects WHERE id=$1)::int AS projects,(SELECT count(*) FROM ai_distill.api_model_prices WHERE provider=$2 AND model=$3 AND source=$4)::int AS prices",[projectId,provider,model,'verification fixture']);if(leftovers.rows[0].projects||leftovers.rows[0].prices)throw new Error('cleanup incomplete');report.cleanup_complete=true;}catch{report={...report,cleanup_complete:false};process.exitCode=1;}
 await rm(storage,{recursive:true,force:true});await pool.end();await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/independent-modules-integration.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
