/**
 * 文件职责：在独立临时schema验证迁移、主项目防重、历史导入及脱敏/原文从出题到DOCX/Excel的完整链路。
 * 入口：bun --no-env-file scripts/verification/verify-project-material-usage.ts --local-port <端口> --out <证据JSON>；只用合成TXT和注入Agent/模型，不调用真实模型。
 * 边界：所有业务SQL替换到随机verify schema；退出清理该schema和临时目录，不操作现有业务项目。经授权可用--connection-stdin无回显读取连接；--serve-port临时开放本机隔离API用于页面读取核对（接口写能力仅作用于本轮合成schema）。
 */
import {readdir,readFile,mkdtemp,mkdir,writeFile,rm,cp} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {readQuestionMaterials} from '../../server/question-materials';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {ApiClient} from '../../cli/client';
import {exportPreparedMaterials} from '../../cli/material-export';
import {createInterface} from 'node:readline';
import {claimLibraryJob} from '../../server/material-library/jobs';
import {executeRedaction} from '../../server/material-library/redaction-runner';
import {createApp} from '../../server/app';
import {claimMaterialUse,materialSetSignature,updateMaterialUse} from '../../server/material-library/uses';
import {renderRedactedMaterials} from '../../server/materials/redaction';
import {STEP_BY_ORDINAL} from '../../shared/step-registry';
import {canonicalJson} from '../../shared/workflow-config';
import {runNextAuthoring} from '../../server/authoring/jobs';
import {inputDigest as authoringInputDigest} from '../../server/authoring/jobs';
import {runNextAnswer} from '../../server/answer-models/jobs';
import {runNextPublication} from '../../server/publishing/tasks';
import {runNextScore} from '../../server/scoring/jobs';

// 本验证器仅直接消费随机schema内合成任务，不启动本机SQLite消费者；禁止继承工作台local模式。
process.env.EXECUTION_QUEUE_MODE='legacy';
const argument=(name:string)=>{const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;};
const port=Number(argument('--local-port')),evidencePath=argument('--out'),provided=process.argv.includes('--connection-stdin');
if(!evidencePath||!provided&&(!Number.isInteger(port)||port<1024||port>65535))throw new Error('传 --local-port <本机专用PG端口> 或已授权的 --connection-stdin，且须 --out <证据JSON>');
let connection:Record<string,unknown>={host:'127.0.0.1',port,user:'postgres',database:'material_gate_verify',ssl:false};
if(provided){
 const lines=createInterface({input:process.stdin});
 const value=await new Promise<string>(resolve=>lines.once('line',line=>{lines.close();resolve(line.trim());}));
 const url=new URL(value);
 for(const key of ['sslmode','sslcert','sslkey','sslrootcert','channel_binding'])url.searchParams.delete(key);
 connection={connectionString:url.toString(),ssl:{rejectUnauthorized:true},enableChannelBinding:true};
}
const raw=new Pool({...connection,max:4,connectionTimeoutMillis:15000,application_name:'ai-distill-isolated-gate-verification'}),schema=`verify_project_phases_${randomUUID().replaceAll('-','')}`;
let databaseVerified=false,failure:string|null=null;
let previewServer:ReturnType<typeof Bun.serve>|undefined;
const servePort=Number(argument('--serve-port'));
if(argument('--serve-port')&&(!Number.isInteger(servePort)||servePort<1024||servePort>65535))throw new Error('隔离页面端口无效');
const root=await mkdtemp(join(tmpdir(),'ai-distill-project-phases-'));
const sql=(text:string)=>text.replaceAll('ai_distill',schema);
const queryFailures:{code:string|null;message:string;statement:string}[]=[];
async function scopedQuery(db:Pick<Pool,'query'>,text:string,values?:unknown[]){
 try{return await db.query(sql(text),values);}
 catch(error:any){queryFailures.push({code:typeof error.code==='string'?error.code:null,message:error instanceof Error?error.message.slice(0,300):'query failed',statement:text.replace(/\s+/g,' ').slice(0,100)});throw error;}
}
const pool={query:async(text:string,values?:unknown[])=>scopedQuery(raw,text,values),connect:async()=>{
 const client=await raw.connect();return{query:async(text:string,values?:unknown[])=>scopedQuery(client,text,values),release:()=>client.release()};
}} as unknown as Pool;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
let passed=0;
function check(name:string,condition:unknown){if(!condition)throw new Error(`FAIL ${name}`);passed++;console.log(`PASS ${name}`);}
async function rejects(name:string,work:()=>Promise<unknown>){let rejected=false;try{await work();}catch{rejected=true;}check(name,rejected);}

try{
 if(!provided){check('连接仅指向本机专用隔离库',(await raw.query('SELECT current_database() AS db')).rows[0].db==='material_gate_verify');check('拒绝含业务schema的目标库',!(await raw.query("SELECT to_regclass('ai_distill.projects') AS name")).rows[0].name);}
 check('随机隔离schema尚不存在',!(await raw.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present',[schema])).rows[0].present);
 databaseVerified=true;
 const seedPhase=randomUUID(),seedOtherPhase=randomUUID(),seedPackage=randomUUID(),seedRevision=randomUUID(),seedFile=randomUUID(),seedBlob=randomUUID();
 for(const name of (await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
  if(name==='045_project_groups_material_use.sql'){
   for(const [id,label] of [[seedPhase,'第五期'],[seedOtherPhase,'第六期']])await pool.query("INSERT INTO ai_distill.projects(id,name,parent_name,phase_name,material_backend,workspace_path) VALUES($1,$2,'迁移前主项目',$3,'library_v1',$4)",[id,`迁移前主项目 - ${label}`,label,root]);
   await pool.query("INSERT INTO ai_distill.library_packages(id,name,processing_settings) VALUES($1,'迁移前加载包','{}')",[seedPackage]);
   await pool.query("INSERT INTO ai_distill.library_revisions(id,package_id,manifest_sha256,file_count,source_info,request_key,request_digest) VALUES($1,$2,$3,1,'{}',$4,$3)",[seedRevision,seedPackage,sha('seed manifest'),randomUUID()]);
   await pool.query("INSERT INTO ai_distill.library_blobs(id,sha256,size_bytes,content_type,storage_kind,storage_target,storage_path) VALUES($1,$2,4,'text/plain','file','local','seed.source')",[seedBlob,sha('seed')]);
   await pool.query("INSERT INTO ai_distill.library_files(id,revision_id,blob_id,original_name,position) VALUES($1,$2,$3,'seed.txt',1)",[seedFile,seedRevision,seedBlob]);
   await pool.query("INSERT INTO ai_distill.library_jobs(id,package_id,revision_id,kind,status,request_key,input_digest,input_snapshot,config_digest,config_snapshot,executor_kind,execution_target,finished_at) VALUES($1,$2,$3,'intake','succeeded',$4,$5,$6::jsonb,$5,'{}','internal','local',now())",[randomUUID(),seedPackage,seedRevision,randomUUID(),sha('seed manifest'),JSON.stringify({manifest_sha256:sha('seed manifest')})]);
   await pool.query("UPDATE ai_distill.library_revisions SET state='ready',sealed_at=now() WHERE id=$1",[seedRevision]);
   await pool.query('UPDATE ai_distill.library_packages SET current_revision_id=$2 WHERE id=$1',[seedPackage,seedRevision]);
   await pool.query("INSERT INTO ai_distill.project_library_packages(id,project_id,package_id,position,created_at) VALUES($1,$2,$3,1,'2026-01-01Z'),($4,$5,$3,1,'2026-01-02Z')",[randomUUID(),seedPhase,seedPackage,randomUUID(),seedOtherPhase]);
  }
  await raw.query(sql(await Bun.file(new URL(`../../migrations/${name}`,import.meta.url)).text()));
 }
 check('全量历史迁移+045可在独立schema建立',true);
 const migrated=(await pool.query('SELECT * FROM ai_distill.project_material_uses WHERE package_id=$1',[seedPackage])).rows;
 check('迁移前已有多期加载保留首次使用账，不删除历史题目',migrated.length===1&&migrated[0].owner_phase_id===seedPhase);
 check('SQL迁移签名与服务端SHA256签名一致',migrated[0].material_signature===materialSetSignature([{sha256:sha('seed'),size_bytes:4}]));
 const app=createApp(pool,root,join(root,'exports'));
 async function request(path:string,body?:unknown,method='POST',headers:Record<string,string>={}){
  const response=await app.request(`/api${path}`,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();return{status:response.status,body:result as any};
 }
 async function phase(parent:string,no:number){const result=await request('/projects',{parent_name:parent,phase_name:`第${no}期`,phase_no:no,material_backend:'library_v1',workspace_path:root,local_skill_path:root});check(`创建${parent}${no}期`,result.status===201);return result.body;}
 const a5=await phase('项目甲',5),a6=await phase('项目甲',6),b1=await phase('项目乙',1);
 check('同主项目各期共享稳定主项目ID',a5.project_group_id===a6.project_group_id&&a5.project_group_id!==b1.project_group_id);
 const phaseOverview=await request(`/project-groups/${a5.project_group_id}/phases`,undefined,'GET');
 check('期次概览分别归属各自主项目',phaseOverview.status===200&&phaseOverview.body.items.some((p:any)=>p.id===a5.id)&&!phaseOverview.body.items.some((p:any)=>p.id===b1.id));
 const duplicate=await request('/projects',{parent_name:'项目甲',phase_name:'重复期名',phase_no:5,material_backend:'library_v1',workspace_path:root});
 check('同主项目不能重复期号',duplicate.status===409);
 const workflow=randomUUID(),material=randomUUID(),attempt=randomUUID(),content='原文包含号码13800138000，金额100元。',sourceSha=sha(content);
 const original=join(root,'legacy.source');await writeFile(original,content);
 await pool.query("INSERT INTO ai_distill.workflows(id,project_id,request_id,title,workflow_kind) VALUES($1,$2,$3,'原材料包','material_package')",[workflow,a5.id,randomUUID()]);
 for(const ordinal of [1,2])await pool.query("INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,display_position,step_key) VALUES($1,$2,'合成入库','succeeded',true,$2,$3)",[workflow,ordinal,STEP_BY_ORDINAL[ordinal]!.key]);
 await pool.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,finished_at) VALUES($1,$2,2,1,'succeeded',now())",[attempt,workflow]);
 await pool.query("INSERT INTO ai_distill.materials(id,workflow_id,original_name,storage_path,sha256,size_bytes,content_type) VALUES($1,$2,'原材料.txt',$3,$4,$5,'text/plain')",[material,workflow,original,sourceSha,Buffer.byteLength(content)]);
 const document=JSON.stringify({source_sha256:sourceSha,pages:[{page:1,text:content,method:'text',structure:[{id:'p',kind:'paragraph',text:content}],issues:['retained-warning']}]});
 await pool.query("INSERT INTO ai_distill.artifacts(id,workflow_id,material_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,$4,'private_extracted_pages','legacy.json',$5,$6,$7)",[randomUUID(),workflow,material,attempt,sha(document),Buffer.byteLength(document),document]);
 const key=randomUUID(),preview=await request(`/projects/${a5.id}/legacy-material-imports`,{source_workflow_id:workflow,request_key:key});
 check('dry-run只返回摘要与计数',preview.status===200&&preview.body.dry_run===true&&preview.body.extracted_file_count===1);
 check('dry-run不建材料包',(await pool.query('SELECT count(*)::int AS n FROM ai_distill.library_packages')).rows[0].n===1);
 const applyBody={source_workflow_id:workflow,request_key:key,dry_run:false,expected_source_digest:preview.body.source_digest};
 const imported=await request(`/projects/${a5.id}/legacy-material-imports`,applyBody);
 check('旧原件和成功提取导入新库',imported.status===200&&!!imported.body.package_id);
 const again=await request(`/projects/${a5.id}/legacy-material-imports`,applyBody);
 check('同一导入请求重放不增加材料或任务',again.status===200&&again.body.reused===true&&(await pool.query("SELECT count(*)::int AS n FROM ai_distill.library_jobs WHERE origin='legacy_import'")).rows[0].n===2);
 check('识别issues保留',(await pool.query('SELECT issues FROM ai_distill.library_documents')).rows[0].issues[0].kind==='retained-warning');
 check('导入任务来源明确且无新脱敏',(await pool.query("SELECT count(*)::int AS n FROM ai_distill.library_jobs WHERE origin='legacy_import'")).rows[0].n===2&&(await pool.query('SELECT count(*)::int AS n FROM ai_distill.library_redactions')).rows[0].n===0);
 const activation=await request(`/projects/${a5.id}/legacy-material-imports/${imported.body.id}/activate`,{});
 check('历史材料关联原期，无需伪造新脱敏',activation.status===200&&activation.body.owner_phase_id===a5.id);
 const useId=activation.body.use_id;
 const before=await pool.query('SELECT title,source_manifest FROM ai_distill.workflows WHERE id=$1',[workflow]);
 const renamed=await request(`/projects/${a5.id}/phase-identity`,{phase_no:5,phase_name:'第五期归组',expected_name:a5.name},'PATCH');
 check('期次归组前后完整业务摘要一致',renamed.status===200&&renamed.body.business_before.sha256===renamed.body.business_after.sha256);
 check('原题名与来源未被更改',JSON.stringify(before.rows)==JSON.stringify((await pool.query('SELECT title,source_manifest FROM ai_distill.workflows WHERE id=$1',[workflow])).rows));
 const signature=materialSetSignature([{sha256:sourceSha,size_bytes:Buffer.byteLength(content)}]);
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await rejects('甲第6期使用同包被拒绝',()=>claimMaterialUse(db,{id:a6.id,project_group_id:a6.project_group_id},imported.body.package_id,signature));await db.query('ROLLBACK');
  await db.query('BEGIN');const b=await claimMaterialUse(db,{id:b1.id,project_group_id:b1.project_group_id},imported.body.package_id,signature);await db.query('COMMIT');check('项目乙仍可首次使用同材料',b.owner_phase_id===b1.id);
 }finally{db.release();}
 await rejects('数据库禁止删除永久使用记录',()=>pool.query('DELETE FROM ai_distill.project_material_uses WHERE id=$1',[useId]));
 await updateMaterialUse(pool,a5.id,useId,1,{status:'submitted',reason:'合成提交验证',evidence:{platform:'Synthetic',project_id:'fixture',task_id:'fixture-task',submitted_at:new Date().toISOString(),receipt:'synthetic-only'}});
 const reopened=await updateMaterialUse(pool,a5.id,useId,2,{status:'in_use',reason:'合成驳回返修'});
 check('已提交可退回原期且保留独立事件',reopened.status==='in_use'&&(await pool.query('SELECT count(*)::int AS n FROM ai_distill.project_material_use_events WHERE use_id=$1',[useId])).rows[0].n===3);
 const client=await pool.connect();try{await client.query('BEGIN');await rejects('退回后仍不可供下一期使用',()=>claimMaterialUse(client,{id:a6.id,project_group_id:a6.project_group_id},imported.body.package_id,signature));await client.query('ROLLBACK');}finally{client.release();}
 const phaseList=await request(`/project-groups/${a5.project_group_id}/phases`,undefined,'GET');
 check('主项目只列自己的期次',phaseList.status===200&&phaseList.body.items.length===2);
 const isolated=await request(`/projects/${a6.id}/loaded-materials`,undefined,'GET');check('第6期看不到第5期材料',isolated.status===200&&isolated.body.items.length===0);
 const useHistory=await request(`/projects/${a6.id}/material-uses/${useId}`,{status:'in_use',reason:'串期请求'},'PATCH',{'If-Match':'3'});
 check('状态写入拒绝串期ID',useHistory.status===404);
 const first=await pool.query('SELECT * FROM ai_distill.library_files WHERE revision_id=$1',[imported.body.revision_id]);
 const rendered=renderRedactedMaterials([{material_id:first.rows[0].id,pages:[{page:1,text:content,structure:[{id:'p',kind:'paragraph',text:content}]}]}]);
 check('新库原件可以生成既有下游正文投影',typeof rendered.markdown==='string'&&rendered.markdown.includes(content));
 // 通过正式HTTP派发、领取和生产发布函数处理合成计划；只有Agent调用被注入，禁止伪插成功产物。
 const pkg=imported.body.package_id,rev=imported.body.revision_id,extraction=(await pool.query("SELECT id FROM ai_distill.library_jobs WHERE revision_id=$1 AND kind='extract'",[rev])).rows[0].id;
 const dispatched=await request(`/material-library/revisions/${rev}/jobs`,{kind:'redact',extraction_job_id:extraction,request_key:randomUUID(),execution_target:'local',agent_settings:{model:'gpt-6-luna',reasoning_effort:'high'}});
 check('合成Agent脱敏经HTTP创建正式任务',dispatched.status===201||dispatched.status===202);
 const claimed=await claimLibraryJob(pool,'agent','local',dispatched.body.id);
 check('领取仅匹配本次合成任务',claimed?.id===dispatched.body.id);
 let syntheticAgentCalls=0;
 await executeRedaction(pool,root,claimed,new AbortController().signal,async task=>{
  syntheticAgentCalls++;
  await mkdir(join(task.directory,'output'),{recursive:true});
  const plan={entities:[],edits:[{target_id:'f1p1b1f1',source_text:'13800138000',occurrence:0,kind:'phone',keep_prefix:''}],documents:[{id:'d1',title:'申请材料:跨格式/'+ '长'.repeat(101),ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[{target_id:'all',kind:'identity',blocking:true,reason:'合成疑点不否决技术发布'}]};
  await writeFile(join(task.directory,'output','material-plan.json'),JSON.stringify(plan));
  const validator=Bun.spawn([process.execPath,'validate-plan.mjs'],{cwd:task.directory,stdout:'pipe',stderr:'pipe'});
  const validation=JSON.parse(await new Response(validator.stdout).text());
  check('同一计划Agent本地自检通过',await validator.exited===0&&validation.valid===true);
  return{result:{plan_file:'output/material-plan.json'},session_id:'synthetic-only',provider:'fixture',model:task.model,usage:null,duration_ms:1} as any;
 });
 check('仅使用注入Agent一次，无真实模型调用',syntheticAgentCalls===1);
 const published=(await pool.query('SELECT r.id,j.status,r.validation_report FROM ai_distill.library_redactions r JOIN ai_distill.library_jobs j ON j.id=r.redaction_job_id WHERE j.id=$1',[claimed.id])).rows[0];
 check('生产事务保存技术成功结果',published?.status==='succeeded'&&published.validation_report.usable_for_question===true);
 const redaction=published.id;
 // 同一计划分别经正式CLI导出、HTTP导入及已发布Agent结果复核，不只比较不同夹具。
 const exactPath=join(root,'material-library','jobs',claimed.id,'private','exact-plan.private.json');
 const exactPlan=JSON.parse(await readFile(exactPath,'utf8'));
 const cliClient=new ApiClient('http://127.0.0.1:13710',async(input,init)=>{const url=new URL(input);return app.request(url.pathname+url.search,init);});
 const cliOut=join(root,'cli-materials');
 const cliResult=await exportPreparedMaterials(cliClient,exactPath,cliOut);
 check('同一计划经CLI正式导出通过',cliResult.document_count===1&&cliResult.source_verified===true);
 const cliDocuments=JSON.parse(await readFile(join(cliOut,'出题材料.json'),'utf8')).documents;
 check('CLI导出与宿主正文及完整标题一致',cliDocuments[0].text===content.replace('13800138000','138******00')&&cliDocuments[0].title===exactPlan.documents[0].title);
 const importedPlan=await request(`/material-library/revisions/${rev}/prepared-redactions`,{request_key:randomUUID(),plan:exactPlan});
 check('同一计划经HTTP正式导入通过',importedPlan.status===201&&!!importedPlan.body.redaction_id);
 const revalidated=await request(`/material-library/redactions/${redaction}/revalidate`,{});
 check('同一计划经已发布结果复核通过',revalidated.status===200&&revalidated.body.usable_for_question===true);
 const c1=await phase('并发项目',1),c2=await phase('并发项目',2);
 const races=await Promise.all([c1,c2].map(p=>request(`/projects/${p.id}/loaded-materials`,{package_id:pkg,redaction_id:redaction})));
 check('两期真实并发加载仅一次成功',races.filter(r=>r.status===201).length===1&&races.filter(r=>r.status===409).length===1);
 const winner=races[0]!.status===201?c1:c2,loser=winner.id===c1.id?c2:c1,link=races.find(r=>r.status===201)!.body;
 const replay=await request(`/projects/${winner.id}/loaded-materials`,{package_id:pkg,redaction_id:redaction});
 check('加载重放复用原行，不重复占用',replay.status===200&&replay.body.id===link.id&&(await pool.query('SELECT count(*)::int AS n FROM ai_distill.project_material_uses WHERE project_group_id=$1',[winner.project_group_id])).rows[0].n===1);
 const invalidPhase=await phase('无效请求项目',1),badLoad=await request(`/projects/${invalidPhase.id}/loaded-materials`,{package_id:pkg,redaction_id:randomUUID()});
 check('无效版本失败不产生占用',badLoad.status===409&&(await pool.query('SELECT count(*)::int AS n FROM ai_distill.project_material_uses WHERE owner_phase_id=$1',[invalidPhase.id])).rows[0].n===0);
 // 新主项目的旧期还未导入材料时，首次发现同源材料需登记到旧期而不是释放资格。
 const oldPhase=await phase('旧期防重项目',5),nextPhase=await phase('旧期防重项目',6),oldWorkflow=randomUUID();
 await pool.query("INSERT INTO ai_distill.workflows(id,project_id,request_id,title,workflow_kind) VALUES($1,$2,$3,'未迁库材料','material_package')",[oldWorkflow,oldPhase.id,randomUUID()]);
 await pool.query("INSERT INTO ai_distill.materials(id,workflow_id,original_name,storage_path,sha256,size_bytes,content_type) VALUES($1,$2,'旧原件.txt',$3,$4,$5,'text/plain')",[randomUUID(),oldWorkflow,original,sourceSha,Buffer.byteLength(content)]);
 const blocked=await request(`/projects/${nextPhase.id}/loaded-materials`,{package_id:pkg,redaction_id:redaction});
 check('旧期未迁库仍阻止新期，并持久保存旧期占用索引',blocked.status===409&&(await pool.query('SELECT owner_phase_id FROM ai_distill.project_material_uses WHERE project_group_id=$1',[oldPhase.project_group_id])).rows[0]?.owner_phase_id===oldPhase.id);
 const questionBody={request_key:randomUUID(),redaction_id:redaction,expected_link_version:Number(link.lock_version),title:'本期合成题',question_tags:[]};
 const question=await request(`/projects/${winner.id}/loaded-materials/${link.id}/questions`,questionBody);
 if(question.status!==201)throw new Error(`合成建题失败 ${question.status}: ${question.body.error}`);
 check('新期从已选脱敏结果创建私有题目',!!question.body.id);
 const questionId=question.body.id;
 const foreignStatus=await request(`/projects/${loser.id}/workflow-status?ids=${questionId}`,undefined,'GET');
 check('本期状态查询拒绝串期题目ID',foreignStatus.status===200&&!Object.hasOwn(foreignStatus.body,questionId));
 const foreignBatch=await request(`/projects/${loser.id}/steps/4/run-batch`,{workflow_ids:[questionId]});
 check('本期批量派发不领取其他期题目',foreignBatch.status===202&&foreignBatch.body.results?.[0]?.status==='not_found');
 const foreignAttachment=await request(`/workflows/${questionId}/materials/${material}/extracted-text`,undefined,'GET');
 check('题目附件全文接口拒绝其他工作流附件ID',foreignAttachment.status===404);
 const exportA=randomUUID(),exportB=randomUUID();
 await pool.query("INSERT INTO ai_distill.project_exports(id,project_id,status,error) VALUES($1,$2,'failed','synthetic isolation fixture'),($3,$4,'failed','synthetic isolation fixture')",[exportA,winner.id,exportB,loser.id]);
 const exportsA=await request(`/projects/${winner.id}/exports`,undefined,'GET'),exportsB=await request(`/projects/${loser.id}/exports`,undefined,'GET');
 check('导出历史按期次隔离',exportsA.status===200&&exportsA.body.some((item:any)=>item.id===exportA)&&!exportsA.body.some((item:any)=>item.id===exportB)&&exportsB.body.some((item:any)=>item.id===exportB)&&!exportsB.body.some((item:any)=>item.id===exportA));
 check('串期加载ID不能建题',(await request(`/projects/${loser.id}/loaded-materials/${link.id}/questions`,{...questionBody,request_key:randomUUID()})).status===404);
 check('新题只创建4至8步骤',(await pool.query('SELECT ordinal FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY ordinal',[questionId])).rows.map(r=>r.ordinal).join(',')==='4,5,6,7,8');
 await mkdir(join(root,'skill'),{recursive:true});await writeFile(join(root,'skill','SKILL.md'),'---\nname: synthetic-period-flow\ndescription: Synthetic queue verification only\n---\n只使用本次附件，生成文字计算题。');
 await pool.query('UPDATE ai_distill.projects SET local_skill_path=$2 WHERE id=$1',[winner.id,join(root,'skill')]);
 await pool.query("INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,4,$2),($1,6,$2) ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config",[winner.id,JSON.stringify({provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low'})]);
 const modelId=randomUUID(),answerConfig={provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'};
 await pool.query("INSERT INTO ai_distill.system_answer_models(id,name,provider,base_url,model,config) VALUES($1,'合成测试模型','openrouter',$2,$3,$4)",[modelId,answerConfig.base_url,answerConfig.model,JSON.stringify(answerConfig)]);
 const redactedModelSelection=await request(`/projects/${winner.id}/answer-models`,{models:[{model_id:modelId,minimum_score:55}]},'PUT');
 check('脱敏测试期仅选择一个合成作答模型',redactedModelSelection.status===200);
 const author=await request(`/workflows/${questionId}/author`,{});
 check('出题经真实HTTP入队',author.status===202);
 await runNextAuthoring(pool,root,async options=>{
  check('脱敏模式作者收到脱敏正文而非原始号码',options.materials[0]?.text.includes('138******00')&&!options.materials[0]?.text.includes('13800138000'));
  return{question_id:'fixture',draft:{task_name:'金额核算',task_type:'计算',header:{industry_l1:'合成',industry_l2:'合成',task_form:'single_round',occupation_l1:'合成',occupation_l2:'合成'},question:'附件金额是多少？',attachment_ids:options.materials.map(m=>m.id),answer_approach:'读附件金额',reference_answer:'100元',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric:[{id:'R1',criterion:'写明100元得10分，否则0分',max_score:10}]},question_version:'fixture-qv',rubric_version:'fixture-rv',package_text:'fixture',codex:{session_id:'synthetic-author',usage:null,duration_ms:1}};
 });
 const authored=(await pool.query('SELECT status,result,input FROM ai_distill.step_attempts WHERE id=$1',[author.body.id])).rows[0];
 if(authored.status!=='succeeded'){
  const {digest,...frozen}=authored.input??{};
  throw new Error(`合成作者失败：${JSON.stringify({attempt_id:author.body.id,status:authored.status,result:authored.result,input_digest_matches:authoringInputDigest(frozen)===digest,material_mode:authored.input?.material_origin?.material_mode,authoring_contract:authored.input?.authoring_contract})}`);
 }
 check('合成作者经正式提交路径保存到本期',authored.status==='succeeded');
 const answer=await request(`/workflows/${questionId}/answer`,{});
 check('作答经真实HTTP入队',answer.status===202);
 await runNextAnswer(pool,root,async input=>{
  check('脱敏模式候选只接收脱敏附件，不含思路标答或Rubric',!Object.hasOwn(input,'rubric')&&!Object.hasOwn(input,'reference_answer')&&!Object.hasOwn(input,'answer_approach')&&input.materials[0]?.text.includes('138******00')&&!input.materials[0]?.text.includes('13800138000')&&input.question==='附件金额是多少？');
  return{text:'金额100元。',requested_model:input.config.model,model:'synthetic',request_id:null,completion_id:'fixture',usage:{total_tokens:1},started_at:new Date().toISOString(),finished_at:new Date().toISOString(),duration_ms:1};
 });
 const score=await request(`/workflows/${questionId}/score`,{});
 if(score.status!==202){const state=(await pool.query("SELECT ordinal,status,error FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY ordinal",[questionId])).rows;const attempts=(await pool.query("SELECT ordinal,status,error FROM ai_distill.step_attempts WHERE workflow_id=$1 ORDER BY ordinal,attempt",[questionId])).rows;throw new Error('合成评分派发失败：'+JSON.stringify({http_status:score.status,response:score.body,state,attempts}));}
 check('评分经真实HTTP入队',score.status===202);
 await runNextScore(pool,root,async context=>{
  check('脱敏模式评分上下文标记正确',context.material_mode==='redacted'&&context.materials[0]?.text.includes('138******00')&&!context.materials[0]?.text.includes('13800138000'));
  return{raw_text:'R1：5 / 10 分，答案证据：“金额100元。”\n最终总分：5 / 10 分',report:{binding:context.binding,assessment_valid:true,items:[{id:'R1',score:5,reason:'合成答案覆盖部分要求',evidence:[{source:'answer',quote:'金额100元。'}]}],total:5,max_score:10,disputes:[]},session_id:'synthetic-scorer',usage:null,duration_ms:1};
 });
 const judged=await request(`/workflows/${questionId}/accept`,{});
 const state=(await pool.query('SELECT ordinal,status,result FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY ordinal',[questionId])).rows;
 if(state.find(s=>s.ordinal===7)?.result?.decision!=='accepted'){
  const scoreRow=(await pool.query("SELECT status,result->'validation' AS validation,result->'report' AS report FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 ORDER BY attempt DESC LIMIT 1",[questionId])).rows[0];
  console.log('DIAGNOSTIC redacted acceptance',JSON.stringify({accept_http_status:judged.status,decision:judged.body.decision,reasons:judged.body.reasons,score_step_status:state.find(s=>s.ordinal===6)?.status,score_status:scoreRow?.status,score_validation:scoreRow?.validation,score_total:scoreRow?.report?.total,score_max:scoreRow?.report?.max_score}));
 }
 check('作答评分成功且本期达标为accepted',state.find(s=>s.ordinal===5)?.status==='succeeded'&&state.find(s=>s.ordinal===6)?.status==='succeeded'&&state.find(s=>s.ordinal===7)?.result?.decision==='accepted');
 const archive=await request(`/workflows/${questionId}/publish`);
 if(archive.status!==202)throw new Error(`合成归档失败 ${archive.status}: ${archive.body.error}`);
 await runNextPublication(pool,root,new AbortController().signal,[questionId]);
 check('脱敏题目归档步骤成功',archive.status===202&&(await pool.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=8',[questionId])).rows[0].status==='succeeded');
 const redactedDocx=await request(`/workflows/${questionId}/material-docx`,{});const redactedDocxRow=(await pool.query("SELECT kind,storage_path FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind IN ('redacted_docx','original_docx')",[questionId])).rows[0];
 check('脱敏题最终材料生成脱敏DOCX',[200,201].includes(redactedDocx.status)&&redactedDocxRow?.kind==='redacted_docx'&&redactedDocxRow.storage_path.endsWith('.docx'));
 const redactedXml=spawnSync('python3',['-c',"import zipfile,sys,xml.etree.ElementTree as E; print(''.join(E.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml')).itertext()))",join(root,'exports',redactedDocxRow.storage_path)],{encoding:'utf8'});
 check('实际脱敏DOCX正文含处理版本且没有原始号码',redactedXml.status===0&&redactedXml.stdout.includes('138******00')&&!redactedXml.stdout.includes('13800138000'));
 const redactedWorkbook=await request(`/projects/${winner.id}/export`,{});check('脱敏题生成项目XLSX导出',redactedWorkbook.status===201&&redactedWorkbook.body.status==='succeeded'&&redactedWorkbook.body.workflow_count===1);
 const originalPhase=await phase('原文模式验收项目',1);
 await pool.query('UPDATE ai_distill.projects SET local_skill_path=$2 WHERE id=$1',[originalPhase.id,join(root,'skill')]);
 const originalConfig={provider:'codex',model:'gpt-6.1-sol',reasoning_effort:'low',material_source_mode:'original'};
 await pool.query("INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,4,$2),($1,6,$2) ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config,updated_at=now()",[originalPhase.id,JSON.stringify(originalConfig)]);
 const originalModelSelection=await request(`/projects/${originalPhase.id}/answer-models`,{models:[{model_id:modelId,minimum_score:55}]},'PUT');
 check('原文测试期仅选择一个合成作答模型',originalModelSelection.status===200);
 const originalLoad=await request(`/projects/${originalPhase.id}/loaded-materials`,{package_id:pkg,revision_id:rev});
 check('原文项目加载原文提取版本而非脱敏结果',originalLoad.status===201&&originalLoad.body.selected_revision_id===rev&&originalLoad.body.selected_redaction_id===null);
 const originalQuestion=await request(`/projects/${originalPhase.id}/loaded-materials/${originalLoad.body.id}/questions`,{request_key:randomUUID(),revision_id:rev,expected_link_version:Number(originalLoad.body.lock_version),title:'原文模式合成题',question_tags:[]});
 if(originalQuestion.status!==201)throw new Error(`原文合成建题失败 ${originalQuestion.status}: ${originalQuestion.body.error}`);
 const originalQuestionId=originalQuestion.body.id,originalSnapshot=(await pool.query('SELECT material_mode,redaction_id,revision_id,snapshot_manifest FROM ai_distill.question_library_sources WHERE workflow_id=$1',[originalQuestionId])).rows[0];
 check('原文建题快照使用source_markdown/source_index且redaction_id为空',originalSnapshot?.material_mode==='original'&&originalSnapshot.redaction_id===null&&originalSnapshot.revision_id===rev&&originalSnapshot.snapshot_manifest?.origin?.material_mode==='original');
 const originalAuthor=await request(`/workflows/${originalQuestionId}/author`,{});check('原文出题经HTTP入队',originalAuthor.status===202);
 await runNextAuthoring(pool,root,async options=>{
  check('原文模式作者收到原始号码且没有脱敏占位符',options.materials[0]?.text.includes('13800138000')&&!options.materials[0]?.text.includes('138******00'));
  return{question_id:'fixture-original',draft:{task_name:'原文金额核算',task_type:'计算',header:{industry_l1:'合成',industry_l2:'合成',task_form:'single_round',occupation_l1:'合成',occupation_l2:'合成'},question:'附件中的金额是多少？',attachment_ids:options.materials.map(m=>m.id),answer_approach:'读取原文附件金额',reference_answer:'100元',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric:[{id:'R1',criterion:'按附件金额作答',max_score:10}]},question_version:'fixture-original-qv',rubric_version:'fixture-original-rv',package_text:'fixture-original',codex:{session_id:'synthetic-author-original',usage:null,duration_ms:1}};
 });
 const originalAuthored=(await pool.query('SELECT status,input FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 ORDER BY attempt DESC LIMIT 1',[originalQuestionId])).rows[0];
 check('出题尝试冻结material_mode=original且来源指纹有效',originalAuthored?.status==='succeeded'&&originalAuthored.input?.material_origin?.material_mode==='original'&&originalAuthored.input.material_origin.redaction_id===null);
 const originalAnswer=await request(`/workflows/${originalQuestionId}/answer`,{});check('原文作答经HTTP入队',originalAnswer.status===202);
 await runNextAnswer(pool,root,async input=>{
  check('原文模式作答只收到原文source_markdown，不带Rubric标答或思路',input.materials[0]?.text.includes('13800138000')&&!input.materials[0]?.text.includes('138******00')&&!Object.hasOwn(input,'rubric')&&!Object.hasOwn(input,'reference_answer')&&!Object.hasOwn(input,'answer_approach'));
  return{text:'金额100元。',requested_model:input.config.model,model:'synthetic',request_id:null,completion_id:'fixture-original',usage:{total_tokens:1},started_at:new Date().toISOString(),finished_at:new Date().toISOString(),duration_ms:1};
 });
 const originalScore=await request(`/workflows/${originalQuestionId}/score`,{});check('原文评分经HTTP入队',originalScore.status===202);
 await runNextScore(pool,root,async context=>{
  check('原文评分读取同一原文快照',context.material_mode==='original'&&context.materials.some(item=>item.text.includes('13800138000')&&!item.text.includes('138******00')));
  return{raw_text:'R1：5 / 10 分，答案证据：“金额100元。”\n最终总分：5 / 10 分',report:{binding:context.binding,assessment_valid:true,items:[{id:'R1',score:5,reason:'合成答案覆盖部分要求',evidence:[{source:'answer',quote:'金额100元。'}]}],total:5,max_score:10,disputes:[]},session_id:'synthetic-scorer-original',usage:null,duration_ms:1};
 });
 const originalAcceptance=(await pool.query("SELECT status,result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=7",[originalQuestionId])).rows[0];
 check('原文评分后达标判断低于55并accepted',originalAcceptance?.status==='succeeded'&&originalAcceptance.result?.decision==='accepted'&&originalAcceptance.result?.model_scores?.[modelId]?.percentage===50);
 const originalPublish=await request(`/workflows/${originalQuestionId}/publish`);
 await runNextPublication(pool,root,new AbortController().signal,[originalQuestionId]);
 check('原文题达标后归档成功',originalPublish.status===202&&(await pool.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=8',[originalQuestionId])).rows[0].status==='succeeded');
 const originalDocx=await request(`/workflows/${originalQuestionId}/material-docx`,{});
 const originalDocxRow=(await pool.query("SELECT kind,storage_path FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind IN ('redacted_docx','original_docx')",[originalQuestionId])).rows[0];
 const originalManifest=(await pool.query("SELECT content FROM ai_distill.artifacts WHERE workflow_id=$1 AND kind='redacted_docx_manifest'",[originalQuestionId])).rows[0]?.content;
 check('原文题最终材料生成original_docx并写入原文模式manifest',[200,201].includes(originalDocx.status)&&originalDocxRow?.kind==='original_docx'&&originalDocxRow.storage_path.endsWith('.docx')&&JSON.parse(originalManifest??'{}').material_mode==='original');
 const originalXml=spawnSync('python3',['-c',"import zipfile,sys,xml.etree.ElementTree as E; print(''.join(E.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml')).itertext()))",join(root,'exports',originalDocxRow.storage_path)],{encoding:'utf8'});
 check('实际原文DOCX保留原始号码且无脱敏占位符',originalXml.status===0&&originalXml.stdout.includes('13800138000')&&!originalXml.stdout.includes('138******00'));
 const modeChange=await request(`/projects/${originalPhase.id}/steps/4/config`,{model:'gpt-6.1-sol',reasoning_effort:'low',prompt:'使用本次冻结材料',material_processing_mode:'aliases'},'PUT');
 const frozenAfterModeChange=await readQuestionMaterials(pool,originalQuestionId);
 check('期次切换化名后旧题仍读取冻结原文',modeChange.status===200&&frozenAfterModeChange.origin.kind==='library_v1'&&frozenAfterModeChange.origin.material_mode==='original'&&frozenAfterModeChange.attachments[0]?.content.includes('13800138000'));
 const originalWorkbook=await request(`/projects/${originalPhase.id}/export`,{});
 check('原文题生成项目XLSX导出',originalWorkbook.status===201&&originalWorkbook.body.status==='succeeded'&&originalWorkbook.body.workflow_count===1);
 const originalAnswerInput=(await pool.query('SELECT input FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 ORDER BY attempt DESC LIMIT 1',[originalQuestionId])).rows[0]?.input;
 const originalAnswerArtifact=(await pool.query('SELECT kind,sha256 FROM ai_distill.artifacts WHERE workflow_id=$1 AND id=$2',[originalQuestionId,originalAnswerInput?.attachments?.[0]?.id])).rows[0];
 check('最终作答尝试保留原文模式及正确附件ID和摘要',originalAnswerInput?.material_origin?.material_mode==='original'&&originalAnswerArtifact?.kind==='source_markdown'&&originalAnswerArtifact.sha256===originalAnswerInput.attachments[0].sha256);
 const opposite=await request(`/projects/${loser.id}`,undefined,'GET');check('另一期间列表和计数不包含本期题目',opposite.status===200&&!opposite.body.workflows.some((w:any)=>w.id===questionId));
 check('本期尝试和产物均绑定原题及期次',(await pool.query('SELECT count(*)::int AS n FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.workflow_id=$1 AND w.project_id=$2',[questionId,winner.id])).rows[0].n>=4);
 if(process.env.VERIFY_EVIDENCE_DIR)await cp(join(root,'exports'),process.env.VERIFY_EVIDENCE_DIR,{recursive:true,errorOnExist:true,force:false});
 // 真正删除发生在注入作答返回之前；step_attempts按真实契约写skipped，不允许晚到结果重新发布。
 const currentLink=(await pool.query('SELECT lock_version FROM ai_distill.project_library_packages WHERE id=$1',[link.id])).rows[0];
 const cancelQuestion=await request(`/projects/${winner.id}/loaded-materials/${link.id}/questions`,{...questionBody,request_key:randomUUID(),expected_link_version:Number(currentLink.lock_version),title:'取消验收合成题'});
 check('创建取消验收题目',cancelQuestion.status===201);
 const cancelAuthor=await request(`/workflows/${cancelQuestion.body.id}/author`,{});check('取消验收出题经HTTP入队',cancelAuthor.status===202);
 await runNextAuthoring(pool,root,async options=>({question_id:'cancel-fixture',draft:{task_name:'取消核对',task_type:'计算',header:{industry_l1:'合成',industry_l2:'合成',task_form:'single_round',occupation_l1:'合成',occupation_l2:'合成'},question:'附件金额是多少？',attachment_ids:options.materials.map(m=>m.id),answer_approach:'读金额',reference_answer:'100元',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric:[{id:'R1',criterion:'写明金额',max_score:10}]},question_version:'cancel-qv',rubric_version:'cancel-rv',package_text:'fixture',codex:{session_id:'synthetic-cancel-author',usage:null,duration_ms:1}}));
 const cancelAnswer=await request(`/workflows/${cancelQuestion.body.id}/answer`,{});check('取消验收作答经HTTP入队',cancelAnswer.status===202);
 await runNextAnswer(pool,root,async input=>{
  check('模型返回前删除仅本轮取消验收题目',(await request(`/workflows/${cancelQuestion.body.id}`,undefined,'DELETE')).status===200);
  return{text:'不应发布的晚到合成答案',requested_model:input.config.model,model:'synthetic',request_id:null,completion_id:'cancel-fixture',usage:{total_tokens:1},started_at:new Date().toISOString(),finished_at:new Date().toISOString(),duration_ms:1};
 });
 const cancelled=(await pool.query('SELECT status FROM ai_distill.step_attempts WHERE id=$1',[cancelAnswer.body.id])).rows[0];
 check('取消状态skipped不被晚到答案覆盖',cancelled?.status==='skipped');
 check('取消后的晚到答案不发布附件',(await pool.query("SELECT count(*)::int AS n FROM ai_distill.artifacts WHERE attempt_id=$1 AND kind='model_answer'",[cancelAnswer.body.id])).rows[0].n===0);
 if(servePort){
  previewServer=Bun.serve({hostname:'127.0.0.1',port:servePort,fetch:request=>app.fetch(request)});
  await writeFile(evidencePath+'.session.json',JSON.stringify({pid:process.pid,api_port:servePort,schema,project_id:winner.id,original_project_id:originalPhase.id,package_id:pkg,question_id:questionId,original_question_id:originalQuestionId,stage:'awaiting_browser_readonly',synthetic_only:true},null,2));
  console.log(`隔离API已就绪：127.0.0.1:${servePort}；页面核对完成后仅向本进程发送SIGUSR1继续清理。`);
  await new Promise<void>(resolve=>process.once('SIGUSR1',resolve));
  await previewServer.stop(true);previewServer=undefined;
 }
 // 删除和归档必须保留主项目永久占用；全部操作仍限于本次随机schema。
 const removedQuestion=await request(`/workflows/${questionId}`,undefined,'DELETE');
 check('删除题目不释放跨期使用资格',removedQuestion.status===200&&(await request(`/projects/${loser.id}/loaded-materials`,{package_id:pkg,redaction_id:redaction})).status===409);
 const latestLink=(await request(`/projects/${winner.id}/loaded-materials`,undefined,'GET')).body.items.find((item:any)=>item.id===link.id);
 const removedLink=await request(`/projects/${winner.id}/loaded-materials/${link.id}`,undefined,'DELETE',{'If-Match':String(latestLink.lock_version)});
 check('移除本期材料后下一期仍被拒绝',removedLink.status===200&&(await request(`/projects/${loser.id}/loaded-materials`,{package_id:pkg,redaction_id:redaction})).status===409);
 const removedVersion=(await pool.query('SELECT lock_version FROM ai_distill.project_library_packages WHERE id=$1',[link.id])).rows[0].lock_version;
 const restoredLink=await request(`/projects/${winner.id}/loaded-materials/${link.id}/restore`,undefined,'POST',{'If-Match':String(removedVersion)});
 check('原期可恢复同一加载关系且不产生新占用',restoredLink.status===200&&restoredLink.body.id===link.id&&(await pool.query('SELECT count(*)::int AS n FROM ai_distill.project_material_uses WHERE project_group_id=$1',[winner.project_group_id])).rows[0].n===1);
 const deletedWinner=await request(`/projects/${winner.id}`,undefined,'DELETE');
 check('删除原期后永久使用账仍阻止后期',deletedWinner.status===200&&(await request(`/projects/${loser.id}/loaded-materials`,{package_id:pkg,redaction_id:redaction})).status===409);
 await request(`/projects/${loser.id}`,undefined,'DELETE');
 const archivedGroup=await request(`/project-groups/${winner.project_group_id}`,undefined,'DELETE');
 const restoredGroup=await request(`/project-groups/${winner.project_group_id}/restore`);
 const later=await phase('并发项目',3);
 check('主项目归档恢复仍保留原占用',archivedGroup.status===200&&restoredGroup.status===200&&later.project_group_id===winner.project_group_id&&(await request(`/projects/${later.id}/loaded-materials`,{package_id:pkg,redaction_id:redaction})).status===409);
 console.log(JSON.stringify({passed,scope:'isolated PostgreSQL/API; synthetic only; no production migration or model calls'}));
}catch(error){failure=error instanceof Error?(error.message||error.name):'验证失败';console.error(failure);process.exitCode=1;}
finally{if(previewServer)await previewServer.stop(true);try{if(databaseVerified)await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await raw.end();await rm(root,{recursive:true,force:true});await writeFile(evidencePath,JSON.stringify({at:new Date().toISOString(),passed,query_failures:queryFailures,status:failure?'failed':'succeeded',failure,real_model_calls:0,temporary_schema_cleaned:databaseVerified,schema,connection_mode:provided?'explicitly_authorized_stdin':'local_dedicated_database',scope:'random isolated schema; real PostgreSQL/Hono/Agent compiler and publication; synthetic model responses'},null,2));}}
