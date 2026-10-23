/**
 * 职责：HTTP 接口装配：连接项目、材料包、派生题目、配置、任务、规则、产物下载及报表导出的业务入口。
 * 关键方法与用途：`createApp()` 注册并组合项目、题目、配置、步骤、下载与报表路由。
 * 使用场景：由 `index.ts` 创建本地服务实例；路由处理器调用各业务模块完成读写。
 */
import {registerExecutionQueueRoutes} from './execution-queue/routes';
import {localQueueEnabled,localQueue,withLocalQueueRoot} from './execution-queue/runtime';
import {answerModelSummaryProjection,stepResultProjection,readWorkflowAttempts,readProjectWorkflowViews,projectWorkflowViewsFromSnapshot,readWorkflowStepHistory} from './workflow-view';
import {readModelApiCatalog} from './llm-api';
import { Hono, type Context } from 'hono';
import {runAgent} from './agent';
import {AgentConcurrencyConfigurationError,getAgentConcurrencyGate,readConcurrencySettings,readSavedWorkerConcurrencySettings,saveWorkerConcurrencySettings,SAFE_WORKER_CONCURRENCY_LIMITS} from './concurrency';
import {clearProjectAgentSettings,configureAgentCredentialHome,readAgentCredentialHome,readAgentModelCatalog,readAgentSettings,readProjectAgentSettings,saveAgentSettings,saveProjectAgentSettings} from './agent/config';
import {readActiveWorkflowTasks,readMaterialLibraryQueue,readWorkerMonitor} from './monitoring/worker-monitor';
import {DEFAULT_CODEX_SETTINGS} from './codex/system-config';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { Pool } from 'pg';
import { mkdir, readFile, writeFile, rm, realpath, stat, mkdtemp, readdir } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { receiveMaterials } from './intake';
import { validateFolder, scanProjectFolder, registerQuestionFolders, projectStepSummary,readProjectWorkflowStepRows, validateStepConfig,workflowStepReadiness,type WorkflowStepState } from './project-folders';
import { enqueueIngestion } from './intake-jobs';
import { enqueueRedaction } from './materials/redaction-jobs';
import {clearGeneratedData} from './generated-data';
import {enqueueScore} from './scoring/jobs';
import {scoreExecutionInstructions} from './scoring/executor';
import {enqueueAuthoring} from './authoring/jobs';
import {enqueueProjectSkill,listProjectSkillAttempts} from './skill-generation/jobs';
import {enqueueAnswer} from './answer-models/jobs';
import {listAnswerModels,registerAnswerModel,setAnswerModelEnabled,readProjectModelSet,saveProjectModelSet} from './answer-models/model-set';
import {mergeAnswerGenerationPolicyIntoStepConfig,parseAnswerGenerationPolicyMinutes,readAnswerGenerationPolicyFromStepConfig,serializeAnswerGenerationPolicyMinutes} from './answer-models/generation-policy';
import {runAcceptance} from './decisions/jobs';
import {readPublicationHistory,readSiriserArchive,withdrawPublication} from './publishing/jobs';
import {buildProjectExport,verifyProjectAuthoringRules,workbookSha256,withProjectExportLock} from './reporting/export';
import {enqueuePublication} from './publishing/tasks';
import {readArchivedWorkflowWorkbook} from './reporting/archive-workbook';
import {exportCurrentMaterialDocx,exportRedactedDocx,readCurrentMaterialDocx} from './materials/redacted-docx-export';
import { enqueueExtraction } from './materials/jobs';
import {createQuestionFromMaterialPackage,listMaterialPackageVersions} from './material-package-questions';
import { readProjectRules,editProjectRuleFile,adoptProjectSkill,invalidateProjectRuleOutputs } from './rules';
import { readRuleFile,resolveEffectiveProjectSkill } from './rule-files';
import {createHash,randomUUID} from 'node:crypto';
import { uuid, text, questionTags, sourceKey, validateFile, MAX_BATCH, requestBodyLimit } from './validation';
import {classifyLogError,logEvent,loggerHealth,withLogContext} from './logging';
import {dispatchWorkflowStep,type StepDispatchTask,type WorkflowStepHandlers,type WorkflowStepOrdinal} from './step-dispatch';
import {registerWorkflowHookRoutes} from './workflow-hook-routes';
import {registerWorkflowExecutionRoutes} from './workflow-execution-routes';
import {registerRemoteMaterialRoutes} from './remote-material-routes';
import {readSystemStepPrompts,saveSystemStepPrompts,readSystemAuthoringDefaults,validateAuthoringDefaults} from './system-step-prompts';
import {registerMaterialLibraryRoutes} from './material-library/routes';
import {registerProjectLibraryRoutes} from './material-library/projects-routes';
import {recoverCreatedProject} from './project-creation-recovery';
import {registerProjectGroupRoutes,resolveProjectGroup,validatePhaseNumber} from './project-groups';
import {documentBlocksToText} from './materials/pdf';

const repositoryRoot=resolve(fileURLToPath(new URL('../',import.meta.url)));
// 空钩子沿用旧表；033仅在启用可执行钩子时需要，不能使既有文字流程的健康检查失败。
const requiredMigrations=(await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')&&name!=='033_workflow_hooks.sql'&&(name!=='047_local_execution_dispatch.sql'||localQueueEnabled())).sort();
const projectExportsRoot=resolve(repositoryRoot,'assets/out');
const projectPhaseLabel=(parentName:string,phaseName:string)=>phaseName?`${parentName} - ${phaseName}`:parentName;

export function createApp(pool: Pool, storageRoot: string, assetExportRoot=projectExportsRoot) {
 storageRoot=resolve(repositoryRoot,storageRoot);
 configureAgentCredentialHome(()=>readAgentCredentialHome(pool));
 const concurrency=readConcurrencySettings(process.env,storageRoot);
 let agentConcurrencyGate:ReturnType<typeof getAgentConcurrencyGate>|undefined;
 const app = new Hono();
 app.use('/api/*',(_c,next)=>withLocalQueueRoot(storageRoot,()=>next()));
 const materialMime=(name:string)=>{const ext=name.split('.').at(-1)?.toLowerCase();return ext==='pdf'?'application/pdf':ext==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain';};
 const requestRoute=(c:Context)=>{const route=(c.req as any).routePath;return typeof route==='string'?route:'unmatched';};
 const requestFields=(c:Context)=>{
  const route=requestRoute(c),method=c.req.method.toLowerCase(),id=c.req.param('id');
  const identity=id&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)?id:undefined;
  return{component:'http',method,route,operation:`${method}_${route.replaceAll('/','_')}`,...(identity&&route.startsWith('/api/projects/:id')?{project_id:identity}:{}),...(identity&&route.startsWith('/api/workflows/:id')?{workflow_id:identity}:{})};
 };
 const managedChanges:Record<string,{operation:string;fields:string[]}>= {
  'put:/api/codex/config':{operation:'system_codex_settings.update',fields:['credential_home','model','reasoning_effort']},
  'put:/api/agent/config':{operation:'agent_settings.update',fields:['credential_home','model','reasoning_effort']},
  'put:/api/system/concurrency-settings':{operation:'worker_concurrency.update',fields:['agent','llmApi']},
  'put:/api/system/step-prompts':{operation:'system_step_prompts.update',fields:['prompts']},
  'put:/api/projects/:id/steps/:ordinal/prompt':{operation:'project_step_prompt.update',fields:['prompt']},
  'put:/api/projects/:id/codex-settings':{operation:'project_codex_settings.update',fields:['model','reasoning_effort']},
  'put:/api/projects/:id/agent-settings':{operation:'project_agent_settings.update',fields:['model','reasoning_effort']},
  'delete:/api/projects/:id/codex-settings':{operation:'project_codex_settings.reset',fields:['model','reasoning_effort']},
  'delete:/api/projects/:id/agent-settings':{operation:'project_agent_settings.reset',fields:['model','reasoning_effort']},
  'post:/api/projects':{operation:'project.create',fields:['name','description','material_root','material_backend','workspace_path','local_skill_path']},
  'post:/api/material-library/packages':{operation:'material_library.package.create',fields:['name','description','tags','processing_settings']},
  'patch:/api/material-library/packages/:id':{operation:'material_library.package.update',fields:['name','description','tags','processing_settings']},
  'delete:/api/material-library/packages/:id':{operation:'material_library.package.archive',fields:[]},
  'post:/api/material-library/packages/:id/revisions':{operation:'material_library.revision.upload',fields:['files','redaction_modes']},
  'post:/api/projects/:id/loaded-materials':{operation:'project.material_package.load',fields:['package_id','redaction_id']},
  'patch:/api/projects/:id/loaded-materials/:linkId':{operation:'project.material_package.update',fields:['redaction_id','position']},
  'delete:/api/projects/:id/loaded-materials/:linkId':{operation:'project.material_package.remove',fields:[]},
  'post:/api/projects/:id/loaded-materials/:linkId/questions':{operation:'project.library_question.create',fields:['request_key','redaction_id','title','scenario','role_perspective','target_level','authoring_direction','question_tags']},
  'patch:/api/projects/:id':{operation:'project.update',fields:['name','description','material_root','local_skill_path']},
  'delete:/api/projects/:id':{operation:'project.delete',fields:[]},
  'post:/api/answer-models':{operation:'answer_model.register',fields:['provider','model','reasoning_effort']},
  'put:/api/answer-models/:id':{operation:'answer_model.update',fields:['enabled']},
  'put:/api/projects/:id/answer-models':{operation:'project_answer_models.update',fields:['models']},
  'put:/api/projects/:id/answer-generation-policy':{operation:'project_answer_generation_policy.update',fields:['request_timeout_minutes','reasoning_threshold_minutes','skip_scoring_on_qualified_timeout']},
  'put:/api/projects/:id/steps/:ordinal/config':{operation:'project_step_config.update',fields:['config']},
  'put:/api/agent/projects/:id/steps/:ordinal/config':{operation:'agent_step_config.update',fields:['config']},
  'delete:/api/projects/:id/steps/:ordinal/config':{operation:'project_step_config.reset',fields:['config']},
  'delete:/api/agent/projects/:id/steps/:ordinal/config':{operation:'agent_step_config.reset',fields:['config']},
  'post:/api/projects/:id/skill/attempts/:attemptId/adopt':{operation:'project_skill.adopt',fields:['local_skill_path']},
  'put:/api/projects/:id/rules/file':{operation:'project_rule_file.update',fields:['expected_sha256','path','text']},
  'post:/api/projects/:id/rules/file':{operation:'project_rule_file.upload',fields:['expected_sha256','path']},
  'delete:/api/projects/:id/rules/file':{operation:'project_rule_file.delete',fields:['expected_sha256','path']},
 };
 const requestErrorStatus=(error:unknown)=>error instanceof HTTPException?error.status:error&&typeof error==='object'&&'code'in error&&error.code==='23505'&&'constraint'in error&&['projects_local_skill_path','system_answer_models_provider_base_url_model_key'].includes(String(error.constraint))?409:500;
 app.use('*',async(c,next)=>{
  const request_id=randomUUID(),started=performance.now();
  return withLogContext({request_id,operation_id:randomUUID()},async()=>{
   let failedStatus:number|undefined;
   c.header('X-Request-ID',request_id);
   const healthRequest=c.req.method==='GET'&&(c.req.path==='/api/health'||c.req.path==='/api/monitor');
   if(!healthRequest)logEvent('request.started',{level:'info',component:'http',method:c.req.method});
   try{
    await next();
    const change=managedChanges[`${c.req.method.toLowerCase()}:${requestRoute(c)}`];
    if(change&&c.res.status>=200&&c.res.status<300){
     const targetId=c.req.param('id');
     logEvent('management.changed',{level:'info',...requestFields(c),operation:change.operation,state:'succeeded',changed_fields:change.fields.slice().sort().join(',')||'none',...(targetId?{target_id:targetId}:{}),...(c.req.param('ordinal')?{ordinal:Number(c.req.param('ordinal'))}:{})});
    }
   }
   catch(error){failedStatus=requestErrorStatus(error);throw error;}
   finally{
    c.header('X-Request-ID',request_id);
    const status_code=failedStatus??c.res.status;
    if((!healthRequest||status_code>=400)&&status_code<500)logEvent('request.finished',{level:status_code>=400?'warn':'info',...requestFields(c),status_code,duration_ms:Math.round(performance.now()-started)});
   }
  });
 });
 // Bun外层接受最大合法材料包；其他路由保持原100MiB请求预算。
 app.use('/api/*', async (c,next) => bodyLimit({
  maxSize:requestBodyLimit(c.req.path,c.req.method),
  onError:ctx=>ctx.json({error:'请求体超过该接口允许的上传大小'},413),
 })(c,next));
 app.use('/api/*', async (c, next) => {
   try {
     const origin = c.req.header('Origin');
     if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && origin && !['http://127.0.0.1:3800', 'http://localhost:3800', 'http://127.0.0.1:3700', 'http://localhost:3700'].includes(origin)) throw new HTTPException(403, { message: '不允许此来源写入本地工作台' });
     await next();
     c.header('Cache-Control', 'no-store');
   } catch (error) { throw error; }
 });
 app.onError((error, c) => {
   const status=requestErrorStatus(error);
   if(status>=500)logEvent('request.error',{level:'error',...requestFields(c),status_code:status,...classifyLogError(error)});
   if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
   if ('code' in error && error.code==='23505' && 'constraint' in error && error.constraint==='projects_local_skill_path') return c.json({error:'此本地skill目录已被其他项目使用，请设置独立目录'},409);
   if ('code' in error && error.code==='23505' && 'constraint' in error && error.constraint==='system_answer_models_provider_base_url_model_key') return c.json({error:'此供应商模型已登记，请从系统目录选择现有记录'},409);
   console.error('请求失败（已写入安全诊断日志；未输出数据库或材料内容）');
   return c.json({ error: '操作失败，请检查数据库连接或文件存储后重试' }, 500);
 });
 app.notFound(c => {logEvent('request.not_found',{level:'warn',component:'http',method:c.req.method,route:'unmatched',operation:`${c.req.method.toLowerCase()}_unmatched`,status_code:404});return c.json({ error: '接口不存在' }, 404);});
 app.get('/api/agent/scoring-instructions',c=>c.json(scoreExecutionInstructions()));
 app.get('/api/system/concurrency-settings',c=>c.json({settings:readSavedWorkerConcurrencySettings(storageRoot)??concurrency,active:concurrency,limits:SAFE_WORKER_CONCURRENCY_LIMITS}));
 app.put('/api/system/concurrency-settings',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  try{
   const settings=saveWorkerConcurrencySettings(storageRoot,body);
   const next=readConcurrencySettings(process.env,storageRoot);
   return c.json({settings,active:concurrency,limits:SAFE_WORKER_CONCURRENCY_LIMITS,restart_required:next.agent!==concurrency.agent||next.llmApi!==concurrency.llmApi});
  }catch(error){throw new HTTPException(400,{message:error instanceof Error?error.message:'并发设置无效'});}
 });
 app.get('/api/system/step-prompts',async c=>c.json({prompts:await readSystemStepPrompts(pool),authoring_defaults:await readSystemAuthoringDefaults(pool)}));
 app.put('/api/system/step-prompts',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  try{return c.json({prompts:await saveSystemStepPrompts(pool,body?.prompts,body?.authoring_defaults)});}
  catch(error){throw new HTTPException(400,{message:error instanceof Error?error.message:'系统提示词设置无效'});}
 });
 app.put('/api/projects/:id/steps/:ordinal/prompt',async c=>{
  const id=uuid(c.req.param('id')),ordinal=Number(c.req.param('ordinal'));
  if(ordinal===9)throw new HTTPException(409,{message:'旧字段映射提示词设置已退役，请编辑材料库Agent化名模板'});
  if(![4,5,6].includes(ordinal))throw new HTTPException(400,{message:'此步骤不支持提示词设置'});
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  if(typeof body?.prompt!=='string'||!body.prompt.trim()||body.prompt.length>12000)throw new HTTPException(400,{message:'请填写有效的步骤提示词'});
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   if(!(await db.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rowCount)throw new HTTPException(404,{message:'项目不存在'});
   const current=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=$2 FOR UPDATE',[id,ordinal])).rows[0]?.config??{};
   const next={...current,prompt:body.prompt};
   const saved=await db.query(`INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,$2,$3::jsonb)
    ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config,updated_at=now() RETURNING config`,[id,ordinal,JSON.stringify(next)]);
   await db.query('COMMIT');return c.json(saved.rows[0]);
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.on('GET',['/api/agent/config','/api/codex/config'],async c=>{
  const config=await readAgentSettings(pool);
  return c.json({...config,model_options:readAgentModelCatalog(config.credential_home??undefined)});
 });
 app.on('PUT',['/api/agent/config','/api/codex/config'],async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  try{
   const config=await saveAgentSettings(pool,body);
   return c.json({...config,model_options:readAgentModelCatalog(config.credential_home??undefined)});
  }catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(400,{message:error instanceof Error?error.message:'Codex设置无效'});}
 });
 app.on('GET',['/api/projects/:id/agent-settings','/api/projects/:id/codex-settings'],async c=>{
  try{return c.json(await readProjectAgentSettings(pool,uuid(c.req.param('id'))));}catch(error){throw error;}
 });
 app.on('PUT',['/api/projects/:id/agent-settings','/api/projects/:id/codex-settings'],async c=>{
  const id=uuid(c.req.param('id'));
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  try{return c.json(await saveProjectAgentSettings(pool,id,body));}catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(400,{message:error instanceof Error?error.message:'项目Agent设置无效'});}
 });
 app.on('DELETE',['/api/projects/:id/agent-settings','/api/projects/:id/codex-settings'],async c=>{
  try{return c.json(await clearProjectAgentSettings(pool,uuid(c.req.param('id'))));}catch(error){throw error;}
 });
 app.on('POST',['/api/agent/test','/api/codex/test'],async c=>{
  const config=await readAgentSettings(pool);
  const directory=await mkdtemp(join(tmpdir(),'ai-distill-agent-probe-'));
  const schema={type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']};
  try{
   agentConcurrencyGate??=getAgentConcurrencyGate(storageRoot,concurrency.agent);
   const admitted=await agentConcurrencyGate.run(()=>runAgent({task_type:'connection_check',directory,prompt:'Codex 连通性检查。请立即返回JSON：{"ok":true}。',model:config.model,reasoning_effort:config.reasoning_effort,schema,timeout_ms:45000,validate(value){if(!value||typeof value!=='object'||Array.isArray(value)||(value as {ok?:unknown}).ok!==true)throw new Error('Agent 返回校验失败');return {ok:true};}}),{wait:false});
   if(!admitted.acquired)throw new HTTPException(503,{message:'Agent 当前并发已满，请稍后重试'});
   const result=admitted.value;
   return c.json({connected:true,model:config.model,reasoning_effort:config.reasoning_effort,duration_ms:result.duration_ms});
  }catch(error){if(error instanceof HTTPException)throw error;if(error instanceof AgentConcurrencyConfigurationError)throw new HTTPException(503,{message:'API 与 worker 的 AGENT_CONCURRENCY 配置不一致，请统一配置'});throw new HTTPException(502,{message:'Codex 连通性测试失败，请检查凭证路径、ChatGPT 登录和 Codex 服务状态'});}
  finally{await rm(directory,{recursive:true,force:true});}
 });
 registerExecutionQueueRoutes(app,pool,storageRoot);
 app.get('/api/monitor', async c => { try {
  const local_execution_queue=localQueueEnabled()?{executor_id:localQueue(storageRoot).executorId,items:localQueue(storageRoot).list().map(({id,kind,lane,state,cancel_requested})=>({id,kind,lane,state,cancel_requested}))}:null;
  const [monitor,active_workflow_tasks,material_library,logging]=await Promise.all([
   readWorkerMonitor(storageRoot),
   readActiveWorkflowTasks(pool,local_execution_queue?.items.filter(job=>job.kind==='step'&&job.state==='running').map(job=>job.id)).then(items=>({status:'known' as const,items})).catch(error=>{logEvent('monitor.active_tasks_read_failed',{level:'error',component:'worker_monitor',...classifyLogError(error)});return{status:'unavailable' as const,items:[] as Awaited<ReturnType<typeof readActiveWorkflowTasks>>};}),
   readMaterialLibraryQueue(pool),
   loggerHealth(),
  ]);
  if(local_execution_queue){const own=new Set(local_execution_queue.items.map(j=>j.id));const running=new Set(local_execution_queue.items.filter(j=>j.state==='running').map(j=>j.id));active_workflow_tasks.items=active_workflow_tasks.items.filter(j=>running.has(j.attempt_id));if(material_library.status==='known'){material_library.items=material_library.items.filter(j=>own.has(j.job_id));material_library.totals={...material_library.totals,queued:local_execution_queue.items.filter(j=>j.kind==='library'&&j.state==='queued').length,running:local_execution_queue.items.filter(j=>j.kind==='library'&&j.state==='running').length,succeeded:local_execution_queue.items.filter(j=>j.kind==='library'&&j.state==='committed').length,failed:local_execution_queue.items.filter(j=>j.kind==='library'&&j.state==='failed').length,cancelled:local_execution_queue.items.filter(j=>j.kind==='library'&&j.state==='cancelled').length};}}
  return c.json({...monitor,active_workflow_tasks,material_library,logging,local_execution_queue});
 } catch(error) { throw error; } });
 app.get('/api/health', async c => {
   try {
    const result=await pool.query('SELECT name FROM ai_distill.schema_migrations WHERE name=ANY($1::text[])',[requiredMigrations]);
    const applied=new Set(result.rows.map(row=>String(row.name)));
    const pending=requiredMigrations.filter(name=>!applied.has(name));
    if(pending.length)return c.json({database:'connected',schema:'migrations_pending',pending_count:pending.length,phase:2},503);
    return c.json({database:'connected',schema:'ready',phase:2});
   }catch{return c.json({database:'unavailable',schema:'unavailable',phase:2},503);}
 });
 app.get('/api/llm-api/models',async c=>{try{return c.json(await readModelApiCatalog(pool));}catch(error){throw error;}});
 app.get('/api/answer-models',async c=>c.json(await listAnswerModels(pool)));
 app.post('/api/answer-models',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  return c.json(await registerAnswerModel(pool,body),201);
 });
 app.put('/api/answer-models/:id',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  return c.json(await setAnswerModelEnabled(pool,uuid(c.req.param('id')),body?.enabled));
 });
 app.get('/api/projects/:id/answer-models',async c=>{
  const id=uuid(c.req.param('id'));
  const project=await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id]);
  if(!project.rowCount)throw new HTTPException(404,{message:'项目不存在'});
  return c.json(await readProjectModelSet(pool,id,false));
 });
 app.put('/api/projects/:id/answer-models',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  return c.json({models:await saveProjectModelSet(pool,uuid(c.req.param('id')),body?.models)});
 });
 app.get('/api/projects/:id/answer-generation-policy',async c=>{
  const id=uuid(c.req.param('id'));
  const stored=await pool.query(`SELECT p.id,c.config FROM ai_distill.projects p
   LEFT JOIN ai_distill.project_step_configs c ON c.project_id=p.id AND c.ordinal=5
   WHERE p.id=$1 AND p.deleted_at IS NULL`,[id]);
  if(!stored.rowCount)throw new HTTPException(404,{message:'项目不存在'});
  const config=stored.rows[0]?.config;
  const policy=readAnswerGenerationPolicyFromStepConfig(config);
  const source=config&&typeof config==='object'&&!Array.isArray(config)&&Object.hasOwn(config,'answer_generation_policy')?'project':'default';
  return c.json(serializeAnswerGenerationPolicyMinutes(policy,source));
 });
 app.put('/api/projects/:id/answer-generation-policy',async c=>{
  const id=uuid(c.req.param('id'));
  const raw=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  let policy;
  try{policy=parseAnswerGenerationPolicyMinutes(raw);}catch(error){throw new HTTPException(400,{message:error instanceof Error?error.message:'作答时长设置无效'});}
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   if(!(await db.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rowCount)throw new HTTPException(404,{message:'项目不存在'});
   const current=await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=5 FOR UPDATE',[id]);
   const config=mergeAnswerGenerationPolicyIntoStepConfig(current.rows[0]?.config,policy);
   const saved=await db.query(`INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) SELECT id,$2,$3 FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config,updated_at=now() RETURNING config`,[id,5,JSON.stringify(config)]);
   if(!saved.rowCount)throw new HTTPException(404,{message:'项目不存在'});
   await db.query('COMMIT');return c.json(serializeAnswerGenerationPolicyMinutes(policy,'project'));
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.get('/api/projects', async c => {
   try { const result = await pool.query(`SELECT p.*, counts.workflow_count,counts.material_package_count,counts.question_count FROM ai_distill.projects p CROSS JOIN LATERAL (
    SELECT count(*)::int AS workflow_count,count(*) FILTER (WHERE w.workflow_kind='material_package')::int AS material_package_count,
     count(*) FILTER (WHERE w.workflow_kind='question')::int AS question_count
    FROM ai_distill.workflows w WHERE w.project_id=p.id AND w.deleted_at IS NULL
   ) counts WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC,p.id`); return c.json(result.rows); }
   catch (error) { throw error; }
 });
 app.get('/api/results',async c=>{
  const result=await pool.query(`SELECT w.id AS workflow_id,w.project_id,p.name AS project_name,w.title,w.source_key,w.source_workflow_id,source_package.title AS source_material_package_title,w.created_at,
   question.result->>'question_version' AS current_question_version,question.result->>'rubric_version' AS current_rubric_version,
   jsonb_build_object('decision',acceptance.result->'decision','model_scores',acceptance.result->'model_scores','aggregate',acceptance.result->'aggregate') AS acceptance_result,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('model_id',answer->>'model_id','name',answer->>'name')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(answers.result->'models')='array' THEN answers.result->'models' ELSE '[]'::jsonb END) answer),'[]'::jsonb) AS answer_models,
   publication.status AS publication_status,
   EXISTS(SELECT 1 FROM ai_distill.project_exports e WHERE e.project_id=w.project_id AND e.status='succeeded' AND w.id=ANY(e.workflow_ids)) AS exported
   FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL
   LEFT JOIN ai_distill.workflows source_package ON source_package.id=w.source_workflow_id AND source_package.workflow_kind='material_package' AND source_package.deleted_at IS NULL
   JOIN ai_distill.steps acceptance ON acceptance.workflow_id=w.id AND acceptance.ordinal=7 AND acceptance.status='succeeded' AND acceptance.result->>'decision'='accepted'
   LEFT JOIN ai_distill.steps question ON question.workflow_id=w.id AND question.ordinal=4 AND question.status='succeeded'
   LEFT JOIN ai_distill.steps answers ON answers.workflow_id=w.id AND answers.ordinal=5 AND answers.status='succeeded'
   LEFT JOIN ai_distill.steps publication ON publication.workflow_id=w.id AND publication.ordinal=8
   WHERE w.deleted_at IS NULL ORDER BY acceptance.finished_at DESC NULLS LAST,w.id`);
  return c.json(result.rows);
 });
 app.post('/api/projects/creation-receipt',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  return c.json(await recoverCreatedProject(pool,body));
 });
 app.post('/api/projects', async c => {
   const body = await c.req.json().catch(() => { throw new HTTPException(400,{message:'请提交有效JSON'}); });
   const legacyName = body?.name===undefined?undefined:text(body.name,'项目名称',120);
   const parentName = text(body?.parent_name??legacyName,'项目名称',120);
   const phaseName = body?.phase_name===undefined?'':text(body.phase_name,'期数',120,false);
   const name = body?.parent_name!==undefined||body?.phase_name!==undefined?projectPhaseLabel(parentName,phaseName):legacyName!;
   const description = text(body?.description ?? '','项目说明',2000,false);
   const tags=questionTags(body?.question_tags??[]);
   const materialMode=body?.material_mode??(body?.material_backend==='legacy'?'question_folders':'material_packages');
   if(!['question_folders','material_packages'].includes(materialMode))throw new HTTPException(400,{message:'项目材料模式无效'});
   const materialBackend=body?.material_backend??'library_v1';
   if(!['legacy','library_v1'].includes(materialBackend))throw new HTTPException(400,{message:'项目材料后端无效'});
   if(materialBackend==='library_v1'&&materialMode!=='material_packages')throw new HTTPException(400,{message:'共享材料库新期使用material_packages；旧目录模式须显式选择legacy'});
   const workspacePath=materialBackend==='library_v1'?await validateFolder(body?.workspace_path,'项目规则工作区'):null;
   const materialRoot = materialBackend==='legacy'?await validateFolder(body?.material_root):null;
   const questions = materialRoot?await scanProjectFolder(materialRoot):[];
   const id = crypto.randomUUID();
   const db = await pool.connect();
   try {
    await db.query('BEGIN');
    const existingSkills=await db.query('SELECT DISTINCT local_skill_path FROM ai_distill.projects WHERE parent_name=$1 AND deleted_at IS NULL AND local_skill_path IS NOT NULL ORDER BY local_skill_path',[parentName]);
    const skillPaths=[...new Set(existingSkills.rows.map(row=>String(row.local_skill_path)))];
    if(skillPaths.length>1)throw new HTTPException(409,{message:'同一项目的期次绑定了多个 skill 目录，请先统一项目 skill 路径'});
    const requestedSkill=body?.local_skill_path?await validateFolder(body.local_skill_path,'本地skill目录'):undefined;
    if(requestedSkill&&skillPaths.length&&requestedSkill!==skillPaths[0])throw new HTTPException(409,{message:'该项目已有共享 skill 目录，请使用项目现有 skill 路径'});
    const inferredProjectRoot=materialBackend==='legacy'?(phaseName&&materialRoot&&basename(dirname(materialRoot))===phaseName?dirname(dirname(materialRoot)):undefined):undefined;
    if(materialBackend==='library_v1'&&!requestedSkill&&!skillPaths.length)throw new HTTPException(400,{message:'首期创建须明确主项目共享Skill目录，不从本期工作区推断'});
    const skillPath=requestedSkill??skillPaths[0]??(inferredProjectRoot?join(inferredProjectRoot,'skill'):resolve(storageRoot,'project-skills',id));
    await mkdir(skillPath,{recursive:true,mode:0o700});
    const group=await resolveProjectGroup(db,parentName,body?.project_group_id);
    const phaseNo=body?.phase_no===undefined?(materialBackend==='library_v1'?1:null):validatePhaseNumber(body.phase_no);
    const result = await db.query('INSERT INTO ai_distill.projects(id,name,description,material_root,local_skill_path,parent_name,phase_name,material_mode,question_tags,material_backend,workspace_path,project_group_id,phase_no) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',[id,name,description,materialRoot,skillPath,parentName,phaseName,materialMode,tags,materialBackend,workspacePath,group.id,phaseNo]);
    const prompts=await readSystemStepPrompts(db);
    const authoringDefaults=body?.authoring_defaults===undefined?await readSystemAuthoringDefaults(db):validateAuthoringDefaults(body.authoring_defaults);
    const promptOrdinals:readonly (4|5|6|9)[]=materialBackend==='library_v1'?[4,5,6]:[4,5,6,9];
    for(const ordinal of promptOrdinals)await db.query('INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) VALUES($1,$2,$3::jsonb)',[id,ordinal,JSON.stringify({prompt:prompts[ordinal],...(ordinal===4?{...authoringDefaults,material_processing_mode:'aliases',material_source_mode:'redacted'}:{})})]);
    if(materialRoot)await registerQuestionFolders(db,id,name,questions,materialMode);
    await db.query('COMMIT'); return c.json(result.rows[0],201);
   } catch(error) { await db.query('ROLLBACK'); if(error&&typeof error==='object'&&'code'in error&&error.code==='23505'){const constraint='constraint'in error?String(error.constraint):'';throw new HTTPException(409,{message:constraint==='projects_group_phase_no'?'该主项目已登记相同期号，请核对已有期次':constraint==='project_groups_name_key'?'主项目名称已存在，请选择已有主项目':'项目记录发生唯一性冲突，请刷新并核对已有记录'});}throw error; } finally { db.release(); }
 });
 app.get('/api/projects/:id', async c => {
   const id = uuid(c.req.param('id'));
   const projectPromise=pool.query(`SELECT p.*,system_config.model AS __system_codex_model,system_config.reasoning_effort AS __system_codex_reasoning_effort,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('ordinal',step_config.ordinal,'config',step_config.config) ORDER BY step_config.ordinal) FROM ai_distill.project_step_configs step_config WHERE step_config.project_id=p.id),'[]'::jsonb) AS __step_configs
    FROM ai_distill.projects p LEFT JOIN ai_distill.system_codex_config system_config ON system_config.id=1
    WHERE p.id=$1 AND p.deleted_at IS NULL`,[id]);
   const projectBackend=projectPromise.then(result=>result.rows[0]?.material_backend==='library_v1'?'library_v1' as const:'legacy' as const);
   const codexSettings=projectPromise.then(result=>{
    const row=result.rows[0];
    if(typeof row?.codex_model==='string'&&typeof row?.codex_reasoning_effort==='string')return{model:row.codex_model,reasoning_effort:row.codex_reasoning_effort,source:'project' as const};
    return{model:typeof row?.__system_codex_model==='string'?row.__system_codex_model:DEFAULT_CODEX_SETTINGS.model,reasoning_effort:typeof row?.__system_codex_reasoning_effort==='string'?row.__system_codex_reasoning_effort:DEFAULT_CODEX_SETTINGS.reasoning_effort,source:'system' as const};
   });
   const workflowRowsPromise=readProjectWorkflowStepRows(pool,id);
   const [project,workflows,steps,workflowRows] = await Promise.all([
    projectPromise,
    pool.query(`SELECT w.id,w.project_id,w.title,w.created_at,w.status,w.source_key,w.workflow_kind,w.source_workflow_id,
     w.source_redaction_attempt_id,w.source_redaction_sha256,w.scenario,w.role_perspective,w.target_level,w.question_tags,w.authoring_direction,
     library_source.package_id AS library_package_id,library_package.name AS library_package_name,
     (SELECT count(*)::int FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.deleted_at IS NULL) AS material_count,
     (SELECT status FROM ai_distill.steps ms WHERE ms.workflow_id=w.id AND ms.ordinal=9) AS material_redaction_status,
     COALESCE((SELECT CASE s.ordinal WHEN 1 THEN 1 WHEN 9 THEN 2 WHEN 4 THEN 3 WHEN 5 THEN 4 WHEN 6 THEN 5 WHEN 7 THEN 6 WHEN 8 THEN 7 END FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal NOT IN (2,3,10) AND (s.status NOT IN ('succeeded','skipped') OR (s.ordinal=7 AND s.result->>'decision'='repair')) ORDER BY s.display_position LIMIT 1),7) AS current_ordinal,
     (SELECT status FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal NOT IN (2,3,10) AND (s.status NOT IN ('succeeded','skipped') OR (s.ordinal=7 AND s.result->>'decision'='repair')) ORDER BY display_position LIMIT 1) AS current_status,
     (SELECT result->>'decision' FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=7) AS current_decision,
     (SELECT s.result FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=7 AND s.status='succeeded' AND s.result->>'decision'='accepted') AS acceptance_result,
     (SELECT s.result->>'question_version' FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=4) AS current_question_version,
     (SELECT s.result->>'rubric_version' FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=4) AS current_rubric_version,
     (SELECT ${answerModelSummaryProjection('s')} FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=5) AS answer_models,
     (SELECT s.status FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=8) AS publication_status,
     EXISTS(SELECT 1 FROM ai_distill.step_attempts authored WHERE authored.workflow_id=w.id AND authored.ordinal=4 AND authored.status='succeeded') AS has_authored,
     EXISTS(SELECT 1 FROM ai_distill.project_exports e WHERE e.project_id=w.project_id AND e.status='succeeded' AND w.id=ANY(e.workflow_ids)) AS exported
     FROM ai_distill.workflows w
     LEFT JOIN ai_distill.question_library_sources library_source ON library_source.workflow_id=w.id
     LEFT JOIN ai_distill.library_packages library_package ON library_package.id=library_source.package_id
     WHERE w.project_id=$1 AND w.deleted_at IS NULL
     ORDER BY CASE WHEN w.source_key ~ '^题目[0-9]+$' THEN substring(w.source_key from '^题目([0-9]+)$')::numeric END NULLS LAST,
      w.source_key NULLS LAST,w.created_at DESC,w.id`,[id]),
    projectStepSummary(pool,id,projectBackend,workflowRowsPromise,codexSettings,projectPromise.then(result=>({rows:result.rows[0]?.__step_configs??[]}))),
    workflowRowsPromise,
   ]);
   if (!project.rowCount) throw new HTTPException(404,{message:'项目不存在'});
   const workflowStatus=projectWorkflowViewsFromSnapshot({states:workflowRows,hasAuthored:new Map(workflows.rows.map((row:any)=>[String(row.id),Boolean(row.has_authored)]))},workflows.rows.map((row:any)=>String(row.id)));
   const workflowItems=workflows.rows.map(({has_authored,...workflow}:any)=>workflow);
   const {__system_codex_model:_,__system_codex_reasoning_effort:__,__step_configs:___,...projectRow}=project.rows[0];
   let skillExists=false,effectiveSkillPath:string|null=null,skillIssue:string|undefined;
   try{const effective=await resolveEffectiveProjectSkill(projectRow);effectiveSkillPath=effective.path;skillExists=await Bun.file(join(effective.path,'SKILL.md')).exists();}
   catch(error){skillIssue=error instanceof Error?error.message:'无法读取当前Skill路径';}
   return c.json({project:{...projectRow,skill_exists:skillExists,effective_skill_path:effectiveSkillPath,...(skillIssue?{skill_issue:skillIssue}:{})},workflows:workflowItems,steps,workflow_status:workflowStatus});
 });
 app.patch('/api/projects/:id/material-mode',async c=>{
  const id=uuid(c.req.param('id'));
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'项目模式参数须为有效JSON'});});
  if(body?.material_mode!=='material_packages')throw new HTTPException(400,{message:'仅支持显式启用材料包模式'});
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const project=(await db.query('SELECT id,material_mode FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
   if(!project)throw new HTTPException(404,{message:'项目不存在'});
   if(project.material_mode==='material_packages'){await db.query('COMMIT');return c.json({material_mode:'material_packages',changed:false});}
   const workflows=(await db.query('SELECT id,source_key FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows;
   if(workflows.length&&!body?.clear_existing_questions)throw new HTTPException(409,{message:'项目已有旧题目；如需切换，请明确提交 clear_existing_questions=true'});
   const active=(await db.query("SELECT 1 FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE w.project_id=$1 AND w.deleted_at IS NULL AND a.status IN ('waiting','running') LIMIT 1",[id])).rowCount;
   if(active)throw new HTTPException(409,{message:'项目仍有活动任务，结束后再切换材料模式'});
   if(workflows.length){
    await db.query("UPDATE ai_distill.workflows SET deleted_at=now(),source_key=NULL WHERE project_id=$1 AND deleted_at IS NULL",[id]);
    await db.query("UPDATE ai_distill.project_exports SET status='stale',error='项目材料模式已切换',finished_at=now() WHERE project_id=$1 AND status IN ('running','succeeded')",[id]);
   }
   await db.query("UPDATE ai_distill.projects SET material_mode='material_packages' WHERE id=$1",[id]);
   await db.query('COMMIT');return c.json({material_mode:'material_packages',changed:true,hidden_old_questions:workflows.length});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.get('/api/material-packages/:id/versions',async c=>c.json(await listMaterialPackageVersions(pool,uuid(c.req.param('id')))));
 app.post('/api/material-packages/:id/questions',async c=>{
  const packageId=uuid(c.req.param('id'));
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'题目参数须为有效JSON'});});
  const title=text(body?.title,'题目名称',180);
  const redactionAttemptId=uuid(body?.redaction_attempt_id);
  const optional=(value:unknown,label:string,max:number)=>value===undefined||value===null||value===''?null:text(value,label,max);
  const targetLevel=optional(body?.target_level,'目标等级',2);
  if(targetLevel!==null&&!['L2','L3','L4','L5'].includes(targetLevel))throw new HTTPException(400,{message:'目标等级须为L2至L5'});
  const result=await createQuestionFromMaterialPackage(pool,storageRoot,packageId,{title,redaction_attempt_id:redactionAttemptId,scenario:optional(body?.scenario,'场景',180),role_perspective:optional(body?.role_perspective,'角色视角',180),target_level:targetLevel as 'L2'|'L3'|'L4'|'L5'|null,question_tags:questionTags(body?.question_tags??[]),authoring_direction:optional(body?.authoring_direction,'出题方向',4000)});
  return c.json(result,201);
 });
 app.get('/api/projects/:id/workflow-status',async c=>{
  const projectId=uuid(c.req.param('id'));
  const ids=[...new Set((c.req.query('ids')??'').split(',').filter(Boolean).map(value=>uuid(value)))];
  if(!ids.length||ids.length>100)throw new HTTPException(400,{message:'一次读取1至100道题目的状态'});
  return c.json(await readProjectWorkflowViews(pool,projectId,ids));
 });
 app.get('/api/workflows/:id/steps/:ordinal/attempts',async c=>{
  const id=uuid(c.req.param('id')),ordinal=Number(c.req.param('ordinal')),offset=Number(c.req.query('offset')??0);
  if(![1,4,5,6,7,8,9].includes(ordinal)||!Number.isSafeInteger(offset)||offset<0)throw new HTTPException(400,{message:'步骤或分页参数无效'});
  const exists=await pool.query('SELECT 1 FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL',[id]);
  if(!exists.rowCount)throw new HTTPException(404,{message:'工作流不存在'});
  return c.json(await readWorkflowStepHistory(pool,id,ordinal,offset));
 });
 app.get('/api/projects/:id/exports',async c=>{
   const projectId=uuid(c.req.param('id'));
   const [exists,result]=await Promise.all([
    pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[projectId]),
    pool.query('SELECT id,batch,status,sha256,workflow_count,error,created_at,finished_at FROM ai_distill.project_exports WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 100',[projectId]),
   ]);
   if(!exists.rowCount)throw new HTTPException(404,{message:'项目不存在'});
   return c.json(result.rows);
 });
 app.post('/api/projects/:id/export',async c=>{
   const projectId=uuid(c.req.param('id'));
   const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'导出参数须为有效JSON'});});
   const batch=body?.batch===undefined||body.batch===null?null:text(body.batch,'批次',160);
   let pendingFile:string|undefined,pendingExportId:string|undefined;
   try{return await withProjectExportLock(pool,projectId,async db=>{
    const id=crypto.randomUUID();
    pendingExportId=id;
    withLogContext({component:'reporting',project_id:projectId,operation:'export',operation_id:id},()=>logEvent('export.started',{level:'info'}));
    const inserted=await db.query("INSERT INTO ai_distill.project_exports(id,project_id,batch,status) SELECT $2,id,$3,'running' FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL RETURNING id",[projectId,id,batch]);
    if(!inserted.rowCount)throw new HTTPException(404,{message:'项目不存在'});

    const relativePath=join('exports',`${id}.xlsx`);const exportRoot=resolve(storageRoot,'exports');const path=join(exportRoot,`${id}.xlsx`);let wrote=false;
    try{
     const exported=await buildProjectExport(db,projectId,batch??undefined,assetExportRoot);await mkdir(exportRoot,{recursive:true,mode:0o700});
     logEvent('file.write.started',{level:'info',file_kind:'xlsx_export',output_bytes:exported.bytes.length});await writeFile(path,exported.bytes,{mode:0o600,flag:'wx'});wrote=true;pendingFile=path;logEvent('file.write.completed',{level:'info',file_kind:'xlsx_export',output_bytes:exported.bytes.length});
     const sha256=workbookSha256(exported.bytes);const workflowIds=exported.records.map(row=>row.workflow_id);
     await verifyProjectAuthoringRules(db,projectId,workflowIds);
     const saved=await db.query("UPDATE ai_distill.project_exports SET status='succeeded',storage_path=$2,sha256=$3,workflow_count=$4,workflow_ids=$5,finished_at=now() WHERE id=$1 AND status='running' RETURNING id",[id,relativePath,sha256,workflowIds.length,workflowIds]);
     if(!saved.rowCount)throw new HTTPException(409,{message:'导出期间附件或成果已变化，请重新导出'});
     logEvent('export.completed',{level:'info',state:'succeeded',attempt_count:workflowIds.length,output_bytes:exported.bytes.length});return c.json({id,status:'succeeded',sha256,workflow_count:workflowIds.length},201);
    }catch(error){logEvent('export.failed',{level:'error',state:'failed',...classifyLogError(error)});if(wrote){await rm(path,{force:true});pendingFile=undefined;}await db.query("UPDATE ai_distill.project_exports SET status='failed',error='导出生成或保存失败',finished_at=now() WHERE id=$1 AND status='running'",[id]);throw error;}
   });}catch(error){
    if(pendingFile&&pendingExportId){
     try{const saved=await pool.query("SELECT status FROM ai_distill.project_exports WHERE id=$1",[pendingExportId]);if(saved.rows[0]?.status!=='succeeded')await rm(pendingFile,{force:true});}
     catch(cleanupError){logEvent('export.file_cleanup_deferred',{level:'error',component:'reporting',operation:'export',project_id:projectId,reason_code:'export_outcome_unknown',...classifyLogError(cleanupError)});}
    }
    throw error;
   }
 });
 app.get('/api/exports/:id/download',async c=>{
   const db=await pool.connect();let transaction=false;
   try{
    await db.query('BEGIN');transaction=true;
    const row=(await db.query("SELECT project_id,workflow_ids,storage_path,sha256 FROM ai_distill.project_exports WHERE id=$1 AND status='succeeded'",[uuid(c.req.param('id'))])).rows[0];
    if(!row)throw new HTTPException(404,{message:'导出文件不存在'});
    const workflowIds=Array.isArray(row.workflow_ids)?row.workflow_ids.map(String):[];
    await verifyProjectAuthoringRules(db,String(row.project_id),workflowIds);
    const isAssetsExport=typeof row.storage_path==='string'&&row.storage_path.startsWith(`assets${sep}out${sep}`);
    const root=await realpath(isAssetsExport?projectExportsRoot:resolve(storageRoot));
    const path=await realpath(isAssetsExport?resolve(repositoryRoot,row.storage_path):resolve(root,row.storage_path));
    if(!path.startsWith(`${root}${sep}`)||await stat(path).then(s=>!s.isFile()))throw new Error('invalid export path');
    logEvent('file.read.started',{level:'info',component:'reporting',file_kind:'xlsx_export'});const bytes=await readFile(path);if(workbookSha256(bytes)!==row.sha256)throw new Error('export hash mismatch');logEvent('file.read.completed',{level:'info',component:'reporting',file_kind:'xlsx_export',output_bytes:bytes.length});
    await verifyProjectAuthoringRules(db,String(row.project_id),workflowIds);
    await db.query('COMMIT');transaction=false;
    return new Response(Uint8Array.from(bytes).buffer,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${c.req.param('id')}.xlsx"`,'Cache-Control':'no-store'}});
   }catch(error){
    if(transaction){try{await db.query('ROLLBACK');transaction=false;}catch(rollbackError){logEvent('transaction.rollback_failed',{level:'error',transaction_name:'rollback:export_download',...classifyLogError(rollbackError)});}}
    if(error instanceof HTTPException)throw error;
    logEvent('file.read.failed',{level:'error',component:'reporting',file_kind:'xlsx_export',...classifyLogError(error)});throw new HTTPException(404,{message:'导出文件缺失或指纹校验失败'});
   }finally{db.release();}
 });
 app.patch('/api/projects/:id', async c => {
   const id = uuid(c.req.param('id'));
   const body = await c.req.json().catch(() => { throw new HTTPException(400,{message:'请提交有效JSON'}); });
   const legacyName = body?.name===undefined?undefined:text(body.name,'项目名称',120); const description = text(body?.description ?? '','项目说明',2000,false);
   const skill = body?.local_skill_path ? await validateFolder(body.local_skill_path,'本地skill目录') : undefined;
   const db = await pool.connect();
   try {
    await db.query('BEGIN');
    const previous = await db.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id]);
    if (!previous.rowCount) throw new HTTPException(404,{message:'项目不存在'});
    const prior=previous.rows[0],root=prior.material_backend==='library_v1'?null:await validateFolder(body?.material_root),parentName=body?.parent_name===undefined?(prior.parent_name??legacyName??prior.name):text(body.parent_name,'项目名称',120),phaseName=body?.phase_name===undefined?(prior.phase_name??''):text(body.phase_name,'期数',120,false);
    const tags=body?.question_tags===undefined?prior.question_tags:questionTags(body.question_tags);
    const groupedName=body?.parent_name!==undefined||body?.phase_name!==undefined?projectPhaseLabel(parentName,phaseName):legacyName??prior.name;
    const groupChanged=parentName!==prior.parent_name;
    if(prior.project_group_id&&(groupChanged||(body?.project_group_id!==undefined&&body.project_group_id!==prior.project_group_id)))throw new HTTPException(409,{message:'请在主项目入口修改名称，期次不能通过改名更换所属主项目'});
    const phaseNo=body?.phase_no===undefined?prior.phase_no:validatePhaseNumber(body.phase_no);
    let nextSkill=skill??prior.local_skill_path;
    if(groupChanged){
     const groupSkills=await db.query('SELECT DISTINCT local_skill_path FROM ai_distill.projects WHERE parent_name=$1 AND deleted_at IS NULL AND id<>$2 AND local_skill_path IS NOT NULL ORDER BY local_skill_path',[parentName,id]);
     const paths=[...new Set(groupSkills.rows.map(row=>String(row.local_skill_path)))];
     if(paths.length>1)throw new HTTPException(409,{message:'目标项目的期次绑定了多个 skill 目录，请先统一项目 skill 路径'});
     if(skill&&skill!==prior.local_skill_path&&paths.length&&skill!==paths[0])throw new HTTPException(409,{message:'目标项目已有共享 skill 目录，请先统一项目 skill 路径'});
     const inferredProjectRoot=prior.material_backend==='library_v1'?prior.workspace_path:phaseName&&root&&basename(dirname(root))===phaseName?dirname(dirname(root)):undefined;
     nextSkill=paths[0]??(skill&&skill!==prior.local_skill_path?skill:undefined)??(inferredProjectRoot?join(inferredProjectRoot,'skill'):undefined)??prior.local_skill_path??resolve(storageRoot,'project-skills',id);
    }
    nextSkill??=resolve(storageRoot,'project-skills',id);
    const skillBindingChanged=root!==previous.rows[0].material_root||nextSkill!==previous.rows[0].local_skill_path;
    const result = await db.query('UPDATE ai_distill.projects SET name=$2,description=$3,material_root=$4,local_skill_path=$5,parent_name=$6,phase_name=$7,question_tags=$8 WHERE id=$1 RETURNING *',[id,groupedName,description,root,nextSkill,parentName,phaseName,tags]);
    if(body?.phase_no!==undefined){await db.query('UPDATE ai_distill.projects SET phase_no=$2 WHERE id=$1',[id,phaseNo]);result.rows[0].phase_no=phaseNo;}
    if(skill&&skillBindingChanged)await db.query('UPDATE ai_distill.projects SET local_skill_path=$2 WHERE parent_name=$1 AND deleted_at IS NULL',[parentName,nextSkill]);
    // 期次展示名称不属于题目内容，修改期次时保留原题名、结果和冻结输入。
    await mkdir(result.rows[0].local_skill_path,{recursive:true,mode:0o700});
    if (root&&root !== previous.rows[0].material_root) await registerQuestionFolders(db,id,groupedName,await scanProjectFolder(root),previous.rows[0].material_mode);
    if(skillBindingChanged)await invalidateProjectRuleOutputs(db,id);
    await db.query('COMMIT'); return c.json(result.rows[0]);
   } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
 });
 app.delete('/api/projects/:id', async c => {
   const id = uuid(c.req.param('id')); const db = await pool.connect();
   try {
    await db.query('BEGIN');
    if (!(await db.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rowCount) throw new HTTPException(404,{message:'项目不存在'});
    const exportLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('ai-distill-project-export'),hashtext($1)) AS acquired",[id])).rows[0]?.acquired;
    if(!exportLock)throw new HTTPException(409,{message:'项目导出正在执行，结束后才能删除'});
    const workflows=(await db.query('SELECT id FROM ai_distill.workflows WHERE project_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
    const librarySchema=(await db.query("SELECT to_regclass('ai_distill.question_library_sources') IS NOT NULL AS available")).rows[0]?.available===true;
    if(workflows.length){
     const workflowIds=workflows.map(row=>row.id);
     // 题目来源快照引用项目加载关系；先删除快照，再解除关系，避免外键和材料库校验触发器冲突。
     await db.query('UPDATE ai_distill.workflows SET source_workflow_id=NULL,source_redaction_attempt_id=NULL,source_redaction_sha256=NULL WHERE project_id=$1 AND source_workflow_id IS NOT NULL',[id]);
     if(librarySchema)await db.query('DELETE FROM ai_distill.question_library_sources WHERE workflow_id=ANY($1::uuid[])',[workflowIds]);
    }
    if(librarySchema){
     // 活动材料包的加载关系保留为移除历史；已归档包不能再更新其关系，只删除项目侧关联，材料包本身保留。
     await db.query(`UPDATE ai_distill.project_library_packages link SET removed_at=COALESCE(link.removed_at,now()),lock_version=link.lock_version+1,updated_at=now()
      FROM ai_distill.library_packages package WHERE link.package_id=package.id AND link.project_id=$1 AND link.removed_at IS NULL AND package.deleted_at IS NULL`,[id]);
     await db.query(`DELETE FROM ai_distill.project_library_packages link USING ai_distill.library_packages package
      WHERE link.package_id=package.id AND link.project_id=$1 AND package.deleted_at IS NOT NULL`,[id]);
    }
    await db.query('UPDATE ai_distill.projects SET deleted_at=now() WHERE id=$1',[id]);
    await db.query("UPDATE ai_distill.step_attempts a SET status='skipped',error='项目已删除',finished_at=now() FROM ai_distill.workflows w WHERE a.workflow_id=w.id AND w.project_id=$1 AND a.status IN ('waiting','running')",[id]);
    await db.query("UPDATE ai_distill.project_skill_attempts SET status='skipped',error='项目已删除',finished_at=now() WHERE project_id=$1 AND status IN ('waiting','running')",[id]);
    if(workflows.length){
     const workflowIds=workflows.map(row=>row.id);
     await db.query('DELETE FROM ai_distill.artifacts WHERE workflow_id=ANY($1::uuid[])',[workflowIds]);
     await db.query('DELETE FROM ai_distill.materials WHERE workflow_id=ANY($1::uuid[])',[workflowIds]);
     await db.query('DELETE FROM ai_distill.step_attempts WHERE workflow_id=ANY($1::uuid[])',[workflowIds]);
     await db.query('DELETE FROM ai_distill.steps WHERE workflow_id=ANY($1::uuid[])',[workflowIds]);
     await db.query('DELETE FROM ai_distill.workflows WHERE id=ANY($1::uuid[])',[workflowIds]);
    }
    await db.query('DELETE FROM ai_distill.project_exports WHERE project_id=$1',[id]);
    await db.query('COMMIT'); return c.json({deleted:true});
   } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
 });
 app.post('/api/projects/:id/sync-folder', async c => {
   const id = uuid(c.req.param('id'));
   const project = (await pool.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
   if (!project) throw new HTTPException(404,{message:'项目不存在'});
   const questions = await scanProjectFolder(await validateFolder(project.material_root));
   const db = await pool.connect();
   try {
    await db.query('BEGIN');
    const current = (await db.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
    if (!current || current.material_root !== project.material_root) throw new HTTPException(409,{message:'项目设置已变化，请重试同步'});
    const result = await registerQuestionFolders(db,id,current.name,questions,current.material_mode);
    await db.query('COMMIT'); return c.json(result);
   } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
 });
 app.on('PUT',['/api/agent/projects/:id/steps/:ordinal/config','/api/projects/:id/steps/:ordinal/config'], async c => {
   const id = uuid(c.req.param('id')??''); const ordinal = Number(c.req.param('ordinal'));
   if(c.req.path.startsWith('/api/agent/')&&![4,6,9].includes(ordinal))throw new HTTPException(404,{message:'此步骤不使用Agent配置'});
   if(ordinal===9)throw new HTTPException(409,{message:'旧字段映射脱敏配置已退役，请使用材料库Agent化名设置'});
   const raw=await c.req.json().catch(() => { throw new HTTPException(400,{message:'请提交有效JSON'}); });
   const config=validateStepConfig(ordinal,raw);
   if(ordinal!==7){
    const saved=ordinal===5
     ?await pool.query(`INSERT INTO ai_distill.project_step_configs AS current_config(project_id,ordinal,config) SELECT id,$2,$3 FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config || CASE WHEN current_config.config ? 'answer_generation_policy' THEN jsonb_build_object('answer_generation_policy',current_config.config->'answer_generation_policy') ELSE '{}'::jsonb END,updated_at=now() RETURNING config`,[id,ordinal,JSON.stringify(config)])
     :await pool.query(`INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) SELECT id,$2,$3 FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config,updated_at=now() RETURNING config`,[id,ordinal,JSON.stringify(config)]);
    if(!saved.rowCount)throw new HTTPException(404,{message:'项目不存在'});return c.json(saved.rows[0]);
   }
   const db=await pool.connect();try{
    await db.query('BEGIN');
    const saved=await db.query(`INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) SELECT id,$2,$3 FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config,updated_at=now() RETURNING config`,[id,ordinal,JSON.stringify(config)]);
    if(!saved.rowCount)throw new HTTPException(404,{message:'项目不存在'});
    if(ordinal===7){
     await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE ordinal IN (7,8) AND workflow_id IN(SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL)",[id]);
     await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='达标规则更新，原判定失效',finished_at=now() WHERE ordinal=7 AND status IN('waiting','running') AND workflow_id IN(SELECT id FROM ai_distill.workflows WHERE project_id=$1)",[id]);
     await db.query("UPDATE ai_distill.project_exports SET status='stale',error='项目达标规则已更新',finished_at=now() WHERE project_id=$1 AND status='succeeded'",[id]);
    }
    await db.query('COMMIT');return c.json(saved.rows[0]);
   }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.on('DELETE',['/api/agent/projects/:id/steps/:ordinal/config','/api/projects/:id/steps/:ordinal/config'],async c=>{
  const id=uuid(c.req.param('id')??''),ordinal=Number(c.req.param('ordinal'));
  if(c.req.path.startsWith('/api/agent/')&&![4,6,9].includes(ordinal))throw new HTTPException(404,{message:'此步骤不使用Agent配置'});
  if(ordinal===9)throw new HTTPException(409,{message:'旧字段映射脱敏设置已退役，不再恢复旧API默认'});
  if(![4,6].includes(ordinal))throw new HTTPException(400,{message:'此步骤不支持恢复默认'});
  const project=await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id]);
  if(!project.rowCount)throw new HTTPException(404,{message:'项目不存在'});
  await pool.query('DELETE FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=$2',[id,ordinal]);
  return c.json({reset:true});
 });
 app.get('/api/projects/:id/rules',async c=>{
   try{return c.json(await readProjectRules(pool,uuid(c.req.param('id'))));}catch(error){throw error;}
 });
 app.post('/api/projects/:id/skill/generate',async c=>{
   try{const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交Codex模型设置JSON'});});return c.json(await enqueueProjectSkill(pool,uuid(c.req.param('id')),body),202);}catch(error){throw error;}
 });
 app.get('/api/projects/:id/skill/attempts',async c=>{
   try{return c.json(await listProjectSkillAttempts(pool,uuid(c.req.param('id'))));}catch(error){throw error;}
 });
 app.post('/api/projects/:id/skill/attempts/:attemptId/adopt',async c=>{
   try{return c.json(await adoptProjectSkill(pool,uuid(c.req.param('id')),uuid(c.req.param('attemptId')),storageRoot));}catch(error){throw error;}
 });
 app.get('/api/projects/:id/rules/file',async c=>{
   try{
    const view=await readProjectRules(pool,uuid(c.req.param('id')));const path=text(c.req.query('path'),'规则文件路径',1000);const file=view.workspace.files.find(file=>file.path===path);
    if(!file)throw new HTTPException(404,{message:'规则文件不存在'});
    const root=path.startsWith('skill/')?view.workspace.skill_path:path.startsWith('materials/')?view.workspace.materials_path:view.workspace.workspace_path;
    const relativePath=path.startsWith('skill/')?path.slice(6):path.startsWith('materials/')?path.slice(10):path;
    const bytes=await readRuleFile(root,relativePath);
    if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new HTTPException(409,{message:'规则文件已变化，请刷新后读取'});
    if(c.req.query('download')==='1')return new Response(Uint8Array.from(bytes).buffer,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1)!)}`,'Cache-Control':'no-store'}});
    const readable=/\.(md|txt|json|csv|html)$/i.test(path)&&bytes.length<=256*1024;
    return c.json({...file,text:readable?new TextDecoder().decode(bytes):null,editable:readable&&path.startsWith('materials/')});
   }catch(error){throw error;}
 });
 function expectedFingerprint(value:unknown){if(value!==null&&(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value)))throw new HTTPException(400,{message:'修改资料须提供当前文件指纹，新增须明确使用null'});return value as string|null;}
 app.put('/api/projects/:id/rules/file',async c=>{
   try{const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});const expected=expectedFingerprint(body?.expected_sha256);if(typeof body?.text!=='string'||!body.text.trim()||body.text.length>30*1024*1024)throw new HTTPException(400,{message:'请填写非空规则文字'});return c.json(await editProjectRuleFile(pool,uuid(c.req.param('id')),text(body?.path,'规则文件路径',1000),new TextEncoder().encode(body.text),expected));}catch(error){throw error;}
 });
 app.post('/api/projects/:id/rules/file',async c=>{
   try{const form=await c.req.formData().catch(()=>{throw new HTTPException(400,{message:'无法读取资料表单'});});const file=form.get('file');if(!(file instanceof File)||!file.size||file.size>30*1024*1024)throw new HTTPException(400,{message:'请选择一份不超过30MB的规则资料'});return c.json(await editProjectRuleFile(pool,uuid(c.req.param('id')),text(form.get('path')??`materials/${file.name}`,'规则文件路径',1000),new Uint8Array(await file.arrayBuffer()),expectedFingerprint(form.get('expected_sha256')??null)));}catch(error){throw error;}
 });
 app.delete('/api/projects/:id/rules/file',async c=>{
   try{const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});return c.json(await editProjectRuleFile(pool,uuid(c.req.param('id')),text(body?.path,'规则文件路径',1000),null,expectedFingerprint(body?.expected_sha256)));}catch(error){throw error;}
 });
 app.post('/api/projects/:id/workflows', async c => {
   const projectId = uuid(c.req.param('id'));
   const requestId = uuid(c.req.header('Idempotency-Key') ?? crypto.randomUUID());
   let form; try { form = await c.req.formData(); } catch { throw new HTTPException(400, { message: '无法读取上传表单' }); }
   const files = form.getAll('files');
   if (!files.length || files.length > 100 || files.some(file => !(file instanceof File))) throw new HTTPException(400, { message: '请选择1至100份PDF、DOCX、TXT或MD材料' });
   const result = await receiveMaterials(pool, storageRoot, { projectId,requestId,files:files as File[],title:text(form.get('title'),'材料包名称',180),key:sourceKey(form.get('source_key')) });
   if((files as File[]).some(file=>/\.(pdf|docx)$/i.test(file.name)))await enqueueExtraction(pool,result.id);
   return c.json(result, result.reused || result.updated ? 200 : 201);
 });
 app.get('/api/workflows/:id', async c => {
   try {
     const id = uuid(c.req.param('id'));
     const content=c.req.query('view')!=='status';
     const workflow = await pool.query('SELECT w.*,to_jsonb(p) AS project FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL', [id]);
     if (!workflow.rowCount) throw new HTTPException(404, { message: '工作流不存在' });
     const {project,...workflowData}=workflow.rows[0];
     // Keep timestamp serialization identical to the former SELECT * project row.
     if(project.created_at)project.created_at=new Date(project.created_at);
     if(project.deleted_at)project.deleted_at=new Date(project.deleted_at);
     const [materials, steps, attempts, artifacts, materialPackageQuestions, sourceMaterialPackage,publicationHistory,questionMaterialOrigin] = await Promise.all([
       pool.query("SELECT id,original_name,sha256,size_bytes,content_type,processing_status,redaction_mode,created_at FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id", [id]),
       pool.query(`SELECT ordinal,step_key,display_position,enabled,name,status,implemented,${stepResultProjection('s',content)} AS result,error,started_at,finished_at FROM ai_distill.steps s WHERE workflow_id=$1 ORDER BY display_position NULLS LAST,ordinal`, [id]),
       readWorkflowAttempts(pool,id,content),
       pool.query("SELECT ar.id,ar.kind,ar.attempt_id,ar.created_at,CASE WHEN ar.kind IN ('redacted_docx','original_docx') THEN regexp_replace(ar.storage_path,'^.*/','') END AS filename,a.result->>'question_version' AS question_version FROM ai_distill.artifacts ar LEFT JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id WHERE ar.workflow_id=$1 AND ar.kind IN ('source_markdown','source_index','redacted_markdown','redacted_index','redacted_docx','original_docx','authored_question','model_answer','score_report','published_result') ORDER BY ar.created_at DESC,ar.id", [id]),
       workflowData.workflow_kind==='material_package'
        ? pool.query("SELECT id,title,created_at,source_redaction_attempt_id,source_redaction_sha256 FROM ai_distill.workflows WHERE source_workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id",[id])
        : Promise.resolve({rows:[]}),
       workflowData.source_workflow_id
        ? pool.query("SELECT id,title FROM ai_distill.workflows WHERE id=$1 AND workflow_kind='material_package' AND deleted_at IS NULL",[workflowData.source_workflow_id])
        : Promise.resolve({rows:[]}),
       readPublicationHistory(pool,id),
       workflowData.workflow_kind==='question'
        ? pool.query("SELECT COALESCE(to_jsonb(s)->>'material_mode',s.snapshot_manifest#>>'{origin,material_mode}','redacted') AS material_mode,s.package_id,s.revision_id,s.redaction_id,s.snapshot_digest FROM ai_distill.question_library_sources s WHERE s.workflow_id=$1",[id])
        : Promise.resolve({rows:[]}),
     ]);
     const hasPdf=materials.rows.some(material=>/\.(pdf|docx)$/i.test(String(material.original_name)));
     const extraction=steps.rows.find(step=>step.ordinal===2);
     const visibleSteps=steps.rows.filter(step=>![2,3,10].includes(step.ordinal)).map(step=>step.ordinal===1&&hasPdf&&extraction&&extraction.status!=='skipped'?{...step,status:extraction.status,result:extraction.result??step.result,error:extraction.error??step.error,started_at:extraction.started_at??step.started_at,finished_at:extraction.finished_at??step.finished_at}:step).map((step,index)=>({...step,display_position:index+1,position:index+1}));
     const workflowStates=new Map<number,WorkflowStepState>(visibleSteps.map(step=>[step.ordinal,{ordinal:step.ordinal,status:step.status,result:step.result,enabled:Boolean(step.enabled),workflow_kind:workflowData.workflow_kind,source_workflow_id:workflowData.source_workflow_id,active:attempts.rows.some(attempt=>attempt.ordinal===step.ordinal&&['waiting','running'].includes(attempt.status))||(step.ordinal===1&&hasPdf&&attempts.rows.some(attempt=>attempt.ordinal===2&&['waiting','running'].includes(attempt.status)))}]));
     const stepsWithReadiness=visibleSteps.map(step=>{const eligibility=workflowStepReadiness(step.ordinal,workflowStates);return{...step,ready:eligibility.ready,ready_reason:eligibility.ready?null:eligibility.reason};});
     const source=questionMaterialOrigin.rows[0];
     const materialOrigin=source?{kind:'library_v1',material_mode:source.material_mode==='original'?'original':'redacted',package_id:String(source.package_id),revision_id:String(source.revision_id),redaction_id:source.redaction_id===null?null:String(source.redaction_id),snapshot_digest:String(source.snapshot_digest)}:null;
     return c.json({ artifacts: artifacts.rows, workflow: workflowData, project, materials: materials.rows.map(m => ({ ...m, size_bytes: Number(m.size_bytes) })), steps: stepsWithReadiness, attempts: attempts.rows, material_package_questions: materialPackageQuestions.rows,source_material_package:sourceMaterialPackage.rows[0]??null,publication_history:publicationHistory,question_material_origin:materialOrigin });
   } catch (error) { throw error; }
 });
 app.patch('/api/workflows/:id/authoring-direction',async c=>{
  const id=uuid(c.req.param('id'));
  let body:unknown;try{body=await c.req.json();}catch{throw new HTTPException(400,{message:'请求内容须为 JSON'});}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new HTTPException(400,{message:'请求内容须为对象'});
  const values=body as Record<string,unknown>;
  const fields=[['authoring_direction','出题方向',4000],['scenario','出题场景',180],['role_perspective','角色视角',180]] as const;
  const updates:Record<string,string|null>={};
  for(const [key,label,limit] of fields){
   if(!(key in values))continue;
   const value=values[key];
   if(value!==null&&typeof value!=='string')throw new HTTPException(400,{message:`${label}须为文本或空值`});
   updates[key]=value===null?null:text(value,label,limit,false)||null;
  }
  if(!Object.keys(updates).length)throw new HTTPException(400,{message:'缺少出题方向、场景或角色视角'});
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const current=(await db.query("SELECT project_id,workflow_kind,authoring_direction,scenario,role_perspective FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",[id])).rows[0];
   if(!current)throw new HTTPException(404,{message:'工作流不存在'});
   if(current.workflow_kind==='material_package')throw new HTTPException(409,{message:'请在题目上修改出题设置'});
   const direction='authoring_direction'in updates?updates.authoring_direction:current.authoring_direction;
   const scenario='scenario'in updates?updates.scenario:current.scenario;
   const role='role_perspective'in updates?updates.role_perspective:current.role_perspective;
   const changed=current.authoring_direction!==direction||current.scenario!==scenario||current.role_perspective!==role;
   if(changed){
    await db.query("UPDATE ai_distill.workflows SET authoring_direction=$2,scenario=$3,role_perspective=$4,status='waiting' WHERE id=$1",[id,direction,scenario,role]);
    await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='出题设置已更新，任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal BETWEEN 4 AND 8 AND status IN ('waiting','running')",[id]);
    await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal BETWEEN 4 AND 8",[id]);
    await db.query("UPDATE ai_distill.project_exports SET status='stale',error='出题设置已更新',finished_at=now() WHERE project_id=$1 AND (status='running' OR (status='succeeded' AND $2::uuid=ANY(workflow_ids)))",[current.project_id,id]);
   }
   await db.query('COMMIT');return c.json({authoring_direction:direction,scenario,role_perspective:role,changed});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.post('/api/workflows/:id/redacted-docx',async c=>{
  const workflowId=uuid(c.req.param('id'));
  const result=await exportRedactedDocx(pool,workflowId,storageRoot,assetExportRoot);
  return c.json(result,result.reused?200:201);
 });
 app.post('/api/workflows/:id/material-docx',async c=>{
  const workflowId=uuid(c.req.param('id'));
  const result=await exportCurrentMaterialDocx(pool,workflowId,storageRoot,assetExportRoot);
  return c.json(result,result.reused?200:201);
 });
 app.post('/api/workflows/:id/withdraw-archive',async c=>c.json(await withdrawPublication(pool,uuid(c.req.param('id')))));
 async function editMaterials(workflowId: string, incoming: File[], replaceId?: string, deleteId?: string) {
   const workflow = (await pool.query('SELECT w.* FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL',[workflowId])).rows[0];
   if (!workflow) throw new HTTPException(404,{message:'题目不存在'});
   if(workflow.source_workflow_id)throw new HTTPException(409,{message:'派生题目材料已冻结；请在材料包补充材料并新建题目'});
   // Intake compares the attachment IDs under the workflow lock to reject concurrent edits.
   const existing = await pool.query("SELECT id,original_name,storage_path FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id",[workflowId]);
   if ((replaceId || deleteId) && !existing.rows.some(row=>row.id===(replaceId || deleteId))) throw new HTTPException(404,{message:'此题目不存在此附件'});
   const files:File[]=[];
   for (const material of existing.rows) if (material.id!==replaceId && material.id!==deleteId) files.push(new File([await readFile(join(resolve(storageRoot),material.storage_path))],material.original_name,{type:materialMime(material.original_name)}));
   files.push(...incoming);
   const result=await receiveMaterials(pool,storageRoot,{projectId:workflow.project_id,requestId:crypto.randomUUID(),title:workflow.title,key:workflow.source_key,workflowId,expectedMaterialIds:existing.rows.map(row=>row.id),files,allowEmpty:true});
   if(files.some(file=>/\.(pdf|docx)$/i.test(file.name)))await enqueueExtraction(pool,workflowId);
   return result;
 }
 app.post('/api/workflows/:id/materials', async c => {
   const id=uuid(c.req.param('id'));
   const form=await c.req.formData().catch(()=>{throw new HTTPException(400,{message:'无法读取材料表单'});});
   const files=form.getAll('files');
   if(!files.length || files.some(file=>!(file instanceof File))) throw new HTTPException(400,{message:'请选择PDF、DOCX、TXT或MD材料'});
   const replacement=form.get('replace_id');
   if(replacement && files.length!==1) throw new HTTPException(400,{message:'替换材料时只能选择一份文件'});
   return c.json(await editMaterials(id,files as File[],replacement?uuid(String(replacement)):undefined));
 });
 app.delete('/api/workflows/:id/materials/:materialId', async c => c.json(await editMaterials(uuid(c.req.param('id')),[],undefined,uuid(c.req.param('materialId')))));
 app.patch('/api/workflows/:id/materials/:materialId/redaction-mode',async c=>{
  const workflowId=uuid(c.req.param('id')),materialId=uuid(c.req.param('materialId'));
  let body:unknown;try{body=await c.req.json();}catch{throw new HTTPException(400,{message:'请求内容须为 JSON'});}
  const value=body&&typeof body==='object'?body as {mode?:unknown;source_sha256?:unknown}:{};
  if(!['model','declared_redacted'].includes(String(value.mode))||typeof value.source_sha256!=='string'||!/^[a-f0-9]{64}$/i.test(value.source_sha256))throw new HTTPException(400,{message:'须指定脱敏方式和当前附件指纹'});
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const workflow=(await db.query("SELECT w.id,w.project_id,w.workflow_kind,w.source_workflow_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w",[workflowId])).rows[0];
   if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
   if(workflow.source_workflow_id)throw new HTTPException(409,{message:'派生题目的材料快照已冻结'});
   const material=(await db.query("SELECT id,original_name,sha256,redaction_mode FROM ai_distill.materials WHERE id=$1 AND workflow_id=$2 AND deleted_at IS NULL FOR UPDATE",[materialId,workflowId])).rows[0];
   if(!material)throw new HTTPException(404,{message:'当前附件不存在'});
   if(!/\.docx$/i.test(material.original_name))throw new HTTPException(400,{message:'仅 DOCX 可声明为已人工脱敏'});
   if(material.sha256!==value.source_sha256)throw new HTTPException(409,{message:'附件已变化，请刷新后重试'});
   const changed=material.redaction_mode!==value.mode;
   if(changed){
    await db.query('UPDATE ai_distill.materials SET redaction_mode=$2 WHERE id=$1',[materialId,value.mode]);
    await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='附件脱敏声明已更新，原任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal IN (4,5,6,7,8,9,10) AND status IN ('waiting','running')",[workflowId]);
    await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal IN (4,5,6,7,8,9,10)",[workflowId]);
    await db.query("UPDATE ai_distill.materials SET processing_status='text_extracted' WHERE workflow_id=$1 AND deleted_at IS NULL AND processing_status='redacted'",[workflowId]);
    await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[workflowId]);
    if(workflow.workflow_kind==='question')await db.query("UPDATE ai_distill.project_exports SET status='stale',error='附件脱敏声明已更新',finished_at=now() WHERE project_id=$1 AND status IN ('running','succeeded') AND $2::uuid=ANY(workflow_ids)",[workflow.project_id,workflowId]);
   }
   await db.query('COMMIT');return c.json({redaction_mode:value.mode,changed});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.get('/api/workflows/:id/materials/:materialId/extracted-text',async c=>{
  const workflowId=uuid(c.req.param('id')),materialId=uuid(c.req.param('materialId'));
  const material=(await pool.query("SELECT m.id,m.original_name,m.processing_status,m.sha256\n   FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL\n   JOIN ai_distill.materials m ON m.workflow_id=w.id AND m.deleted_at IS NULL\n   WHERE w.id=$1 AND w.deleted_at IS NULL AND m.id=$2",[workflowId,materialId])).rows[0];
  if(!material)throw new HTTPException(404,{message:'当前材料不存在'});
  const questionSource=(await pool.query(`SELECT material_mode,index_artifact_id,snapshot_manifest
   FROM ai_distill.question_library_sources WHERE workflow_id=$1`,[workflowId])).rows[0];
  if(questionSource){
   const manifest=questionSource.snapshot_manifest as {files?:unknown;material_index?:unknown;material_markdown?:unknown;origin?:{material_mode?:unknown}}|undefined;
   const mode=questionSource.material_mode??manifest?.origin?.material_mode;
   const files=Array.isArray(manifest?.files)?manifest.files as Record<string,unknown>[]:[];
   const frozenFile=files.find(file=>file.material_id===materialId);
   if(!frozenFile)throw new HTTPException(409,{message:'题目冻结材料清单与当前附件不匹配'});
   if(mode==='redacted'){
    const frozenIndex=manifest?.material_index as {artifact_id?:unknown;sha256?:unknown;kind?:unknown}|undefined;
    if(!frozenIndex||frozenIndex.artifact_id!==questionSource.index_artifact_id||frozenIndex.kind!=='redacted_index'||typeof frozenIndex.sha256!=='string')throw new HTTPException(409,{message:'题目冻结脱敏索引引用无效'});
    const indexArtifact=(await pool.query(`SELECT content,storage_path,sha256 FROM ai_distill.artifacts
     WHERE id=$1 AND workflow_id=$2 AND material_id IS NULL AND attempt_id IS NULL AND kind='redacted_index'`,[questionSource.index_artifact_id,workflowId])).rows[0];
    if(!indexArtifact)throw new HTTPException(409,{message:'题目冻结脱敏索引不存在'});
    let indexContent:string;
    if(typeof indexArtifact.content==='string')indexContent=indexArtifact.content;
    else{
     const base=resolve(storageRoot),path=resolve(base,indexArtifact.storage_path),rel=relative(base,path);
     if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new HTTPException(404,{message:'题目冻结脱敏索引路径无效'});
     try{indexContent=await readFile(path,'utf8');}catch{throw new HTTPException(404,{message:'题目冻结脱敏索引文件缺失'});}
    }
    if(indexArtifact.sha256!==frozenIndex.sha256||createHash('sha256').update(indexContent).digest('hex')!==indexArtifact.sha256)throw new HTTPException(409,{message:'题目冻结脱敏索引指纹校验失败'});
    let index:any;
    try{index=JSON.parse(indexContent);}catch{throw new HTTPException(500,{message:'题目冻结脱敏索引格式异常'});}
    const markdownRef=manifest?.material_markdown as {sha256?:unknown}|undefined;
    if(index?.format!=='redacted-index-v2'||typeof markdownRef?.sha256!=='string'||index.redacted_sha256!==markdownRef.sha256||!Array.isArray(index.materials))throw new HTTPException(409,{message:'题目冻结脱敏索引与正文不匹配'});
    const entry=index.materials.find((item:any)=>item?.material_id===materialId);
    const document=entry?.document;
    if(typeof entry?.markdown!=='string'||document?.format!=='redacted-structure-v1'||!Array.isArray(document.pages)||typeof entry.structure_sha256!=='string'||createHash('sha256').update(JSON.stringify(document)).digest('hex')!==entry.structure_sha256)throw new HTTPException(409,{message:'题目冻结脱敏附件结构校验失败'});
    const redactedPages=document.pages.map((page:any)=>({page:page.page,text:Array.isArray(page.blocks)?documentBlocksToText(page.blocks):undefined,method:'脱敏',...(Array.isArray(page.issues)?{issues:page.issues.filter((issue:unknown):issue is string=>typeof issue==='string')}: {})}));
    if(redactedPages.some((page:any)=>!Number.isInteger(page.page)||typeof page.text!=='string')||redactedPages.map((page:any)=>page.text).join('\n\n')!==entry.markdown)throw new HTTPException(409,{message:'题目冻结脱敏正文与结构不匹配'});
    if(c.req.query('redacted_only')==='true')return c.json({material:{id:material.id,original_name:material.original_name,processing_status:'redacted',sha256:material.sha256},redaction_status:'redacted',redacted_text:entry.markdown,redacted_pages:redactedPages});
    return c.json({material:{id:material.id,original_name:material.original_name,processing_status:'redacted',sha256:material.sha256},format:'redacted-structure-v1',provider:'library_v1',pages:[],redaction_status:'redacted',redacted_text:entry.markdown,redacted_pages:redactedPages});
   }
   if(mode==='original'){
    if(c.req.query('redacted_only')==='true')throw new HTTPException(409,{message:'此题冻结的是原文材料，没有可查看的脱敏全文'});
    if(typeof frozenFile.pages_artifact_id!=='string')throw new HTTPException(409,{message:'题目冻结提取全文引用无效'});
    const pagesArtifact=(await pool.query(`SELECT content,storage_path,sha256 FROM ai_distill.artifacts
     WHERE id=$1 AND workflow_id=$2 AND material_id=$3 AND attempt_id IS NULL AND kind='private_extracted_pages'`,[frozenFile.pages_artifact_id,workflowId,materialId])).rows[0];
    if(!pagesArtifact)throw new HTTPException(409,{message:'题目冻结提取全文不存在'});
    let pagesContent:string;
    if(typeof pagesArtifact.content==='string')pagesContent=pagesArtifact.content;
    else{
     const base=resolve(storageRoot),path=resolve(base,pagesArtifact.storage_path),rel=relative(base,path);
     if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new HTTPException(404,{message:'题目冻结提取全文路径无效'});
     try{pagesContent=await readFile(path,'utf8');}catch{throw new HTTPException(404,{message:'题目冻结提取全文文件缺失'});}
    }
    if(createHash('sha256').update(pagesContent).digest('hex')!==pagesArtifact.sha256)throw new HTTPException(409,{message:'题目冻结提取全文指纹校验失败'});
    let extracted:any;
    try{extracted=JSON.parse(pagesContent);}catch{throw new HTTPException(500,{message:'题目冻结提取全文格式异常'});}
    if(!Array.isArray(extracted.pages)||extracted.pages.some((page:any)=>!page||typeof page.text!=='string'))throw new HTTPException(500,{message:'题目冻结提取全文页内容不完整'});
    return c.json({material:{id:material.id,original_name:material.original_name,processing_status:'text_extracted',sha256:material.sha256},format:typeof extracted.format==='string'?extracted.format:'unknown',provider:'library_v1',pages:extracted.pages.map((page:any,index:number)=>({page:Number.isInteger(page.page)?page.page:index+1,text:page.text,method:typeof page.method==='string'?page.method:'unknown',...(Array.isArray(page.issues)?{issues:page.issues.filter((issue:unknown):issue is string=>typeof issue==='string')}: {})})),redaction_status:'not_redacted'});
   }
   throw new HTTPException(409,{message:'题目冻结材料来源模式无效'});
  }
  const artifact=(await pool.query("SELECT ar.content,ar.storage_path,ar.sha256\n   FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id\n   WHERE ar.workflow_id=$1 AND ar.material_id=$2 AND ar.kind='private_extracted_pages' AND a.status='succeeded' AND a.ordinal IN (1,2)\n   ORDER BY a.finished_at DESC NULLS LAST,ar.created_at DESC,ar.id DESC LIMIT 1",[workflowId,materialId])).rows[0];
  if(!artifact)throw new HTTPException(409,{message:'该附件尚无已入库全文，请先完成文本提取'});
  let content:string;
  if(typeof artifact.content==='string')content=artifact.content;
  else{
   const storageRootPath=resolve(storageRoot),artifactPath=resolve(storageRootPath,artifact.storage_path),relativePath=relative(storageRootPath,artifactPath);
   if(relativePath==='..'||relativePath.startsWith(`..${sep}`)||isAbsolute(relativePath))throw new HTTPException(404,{message:'已入库全文路径无效'});
   try{content=await readFile(artifactPath,'utf8');}catch{throw new HTTPException(404,{message:'已入库全文文件缺失'});}
  }
  if(createHash('sha256').update(content).digest('hex')!==artifact.sha256)throw new HTTPException(409,{message:'已入库全文指纹校验失败'});
  let extracted:{format?:unknown;provider?:unknown;pages?:unknown};
  try{extracted=JSON.parse(content);}catch{throw new HTTPException(500,{message:'已入库全文格式异常'});}
  if(!Array.isArray(extracted.pages)||extracted.pages.some(page=>!page||typeof page!=='object'||typeof page.text!=='string'))throw new HTTPException(500,{message:'已入库全文页内容不完整'});
  let redactedPages:{page:number;text:string}[]|undefined,redactedText:string|undefined;
  if(material.processing_status==='redacted'){
   const redactedArtifact=(await pool.query("SELECT idx.content AS content,idx.storage_path,idx.sha256\n    FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=9 AND s.status='succeeded'\n    JOIN ai_distill.artifacts idx ON idx.attempt_id=a.id AND idx.workflow_id=a.workflow_id AND idx.kind='redacted_index'\n    WHERE a.workflow_id=$1 AND a.ordinal=9 AND a.status='succeeded'\n    ORDER BY a.finished_at DESC NULLS LAST,a.id DESC LIMIT 1",[workflowId])).rows[0];
   if(redactedArtifact){
    let indexContent:string;
    if(typeof redactedArtifact.content==='string')indexContent=redactedArtifact.content;
    else{
     const base=resolve(storageRoot),path=resolve(base,redactedArtifact.storage_path),rel=relative(base,path);
     if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new HTTPException(404,{message:'脱敏索引路径无效'});
     try{indexContent=await readFile(path,'utf8');}catch{throw new HTTPException(404,{message:'脱敏索引文件缺失'});}
    }
    if(createHash('sha256').update(indexContent).digest('hex')!==redactedArtifact.sha256)throw new HTTPException(409,{message:'脱敏索引指纹校验失败'});
    try{
     const index=JSON.parse(indexContent),entry=Array.isArray(index.materials)?index.materials.find((item:any)=>item.material_id===materialId):undefined;
     if(entry&&typeof entry.markdown==='string')redactedText=entry.markdown;
     if(entry&&Array.isArray(entry.pages)&&entry.pages.every((page:any)=>Number.isInteger(page.page)&&typeof page.text==='string'))redactedPages=entry.pages;
     if(redactedText===undefined&&redactedPages)redactedText=redactedPages.map(page=>page.text).join('\n\n');
    }catch{throw new HTTPException(500,{message:'脱敏索引格式异常'});}
   }
  }
  if(c.req.query('redacted_only')==='true'){
   if(material.processing_status!=='redacted'||redactedText===undefined)throw new HTTPException(409,{message:'此附件当前没有可查看的脱敏全文'});
   return c.json({material:{id:material.id,original_name:material.original_name,processing_status:material.processing_status,sha256:material.sha256},redaction_status:'redacted',redacted_text:redactedText,...(redactedPages?{redacted_pages:redactedPages}:{})});
  }
  return c.json({
   material:{id:material.id,original_name:material.original_name,processing_status:material.processing_status,sha256:material.sha256},
   format:typeof extracted.format==='string'?extracted.format:'unknown',
   provider:typeof extracted.provider==='string'?extracted.provider:'unknown',
   pages:extracted.pages.map((page,index)=>({page:Number.isInteger(page.page)?page.page:index+1,text:page.text,method:typeof page.method==='string'?page.method:'unknown',...(Array.isArray(page.issues)?{issues:page.issues.filter((issue:unknown):issue is string=>typeof issue==='string')}: {})})),
   redaction_status:material.processing_status==='redacted'?'redacted':'not_redacted',
   ...(redactedText!==undefined?{redacted_text:redactedText}:{}),
   ...(redactedPages?{redacted_pages:redactedPages}:{}),
  });
 });
 app.delete('/api/workflows/:id/generated', async c => {try{return c.json(await clearGeneratedData(pool,storageRoot,uuid(c.req.param('id')),assetExportRoot));}catch(error){throw error;}});
 app.delete('/api/workflows/:id', async c => {
   const id=uuid(c.req.param('id')); const db=await pool.connect();
   try {
    await db.query('BEGIN');
    const existing=(await db.query('SELECT workflow_kind FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
    if(!existing)throw new HTTPException(404,{message:'工作流不存在'});
    if(existing.workflow_kind==='material_package'&&(await db.query('SELECT 1 FROM ai_distill.workflows WHERE source_workflow_id=$1 AND deleted_at IS NULL LIMIT 1',[id])).rowCount)throw new HTTPException(409,{message:'材料包仍有题目引用，不能删除'});
    await db.query('UPDATE ai_distill.workflows SET deleted_at=now() WHERE id=$1',[id]);
    await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='题目已删除',finished_at=now() WHERE workflow_id=$1 AND status IN ('waiting','running')",[id]);
    await db.query('COMMIT');return c.json({deleted:true});
   }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.get('/api/materials/:id/download', async c => {
   try {
     const result = await pool.query('SELECT original_name,storage_path FROM ai_distill.materials WHERE id=$1', [uuid(c.req.param('id'))]);
     if (!result.rowCount) throw new HTTPException(404, { message: '材料不存在' });
     const file = Bun.file(join(resolve(storageRoot), result.rows[0].storage_path));
     logEvent('file.read.started',{level:'info',component:'materials',file_kind:'source_document'});
     if (!await file.exists()) {logEvent('file.read.failed',{level:'error',component:'materials',file_kind:'source_document',reason_code:'file_missing'});throw new HTTPException(404, { message: '材料文件缺失，请检查本地存储' });}
     logEvent('file.read.completed',{level:'info',component:'materials',file_kind:'source_document',output_bytes:file.size});
     return new Response(file, { headers: { 'Content-Type': materialMime(result.rows[0].original_name), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.rows[0].original_name)}`, 'Cache-Control': 'no-store' } });
   } catch (error) { throw error; }
 });
 const workflowStepHandlers=(workflowId:string,deliveryIdentity?:{task_id:string;org:string}):WorkflowStepHandlers<StepDispatchTask>=>({
  1:()=>enqueueIngestion(pool,workflowId),
  2:()=>enqueueExtraction(pool,workflowId),
  4:()=>enqueueAuthoring(pool,workflowId),
  5:()=>enqueueAnswer(pool,workflowId,storageRoot),
  6:()=>enqueueScore(pool,workflowId),
  7:()=>runAcceptance(pool,workflowId),
  8:()=>enqueuePublication(pool,workflowId,storageRoot,deliveryIdentity,assetExportRoot),
  9:()=>enqueueRedaction(pool,workflowId),
 });
 app.get('/api/workflows/:id/archive-xlsx',async c=>{
  const {bytes,filename}=await readArchivedWorkflowWorkbook(pool,uuid(c.req.param('id')),assetExportRoot);
  return new Response(Uint8Array.from(bytes).buffer,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,'Cache-Control':'no-store'}});
 });
 app.get('/api/workflows/:id/siriser-zip',async c=>{
  const {bytes,filename}=await readSiriserArchive(pool,uuid(c.req.param('id')),assetExportRoot);
  return new Response(Uint8Array.from(bytes).buffer,{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,'Cache-Control':'no-store'}});
 });
 registerWorkflowHookRoutes(app,pool);
 registerWorkflowExecutionRoutes(app,{
  pool,
  dispatch:async(workflowId,ordinal,context)=>{
   const identity=(await pool.query("SELECT workflow_kind,source_workflow_id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL",[workflowId])).rows[0];
   if(!identity)throw new HTTPException(404,{message:'工作流不存在'});
   if(identity.workflow_kind==='material_package'&&![1,2,9].includes(ordinal))throw new HTTPException(409,{message:'材料包只执行入库和脱敏'});
   if(identity.source_workflow_id&&[1,2,9].includes(ordinal))throw new HTTPException(409,{message:'派生题目使用已冻结的材料快照'});
   return dispatchWorkflowStep(ordinal,workflowStepHandlers(workflowId,context?.delivery_identity));
  },
 });
 registerRemoteMaterialRoutes(app,pool,storageRoot);
 registerMaterialLibraryRoutes(app,pool,storageRoot);
 registerProjectGroupRoutes(app,pool);
 registerProjectLibraryRoutes(app,pool,storageRoot);
 app.get('/api/artifacts/:id/download', async c => {
   try {
     const artifactId=uuid(c.req.param('id'));
     const result = await pool.query("SELECT kind,storage_path,sha256,content FROM ai_distill.artifacts WHERE id=$1 AND kind IN ('source_markdown','source_index','redacted_markdown','redacted_index','model_answer','score_report','authored_question','published_result','redacted_docx','original_docx')", [artifactId]);
     if(['redacted_docx','original_docx'].includes(result.rows[0]?.kind)){
      const docx=await readCurrentMaterialDocx(pool,artifactId,assetExportRoot);
      if(!docx)throw new HTTPException(404,{message:'产物不存在或不允许下载'});
      logEvent('file.read.completed',{level:'info',component:'artifacts',artifact_id:artifactId,file_kind:result.rows[0]?.kind,output_bytes:docx.bytes.byteLength});
      return new Response(Uint8Array.from(docx.bytes).buffer,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="material.docx"; filename*=UTF-8''${encodeURIComponent(docx.filename)}`,'Cache-Control':'no-store'}});
     }
     if (!result.rowCount) throw new HTTPException(404, { message: '产物不存在或不允许下载' });
     const fileKind=result.rows[0].kind;
     logEvent('file.read.started',{level:'info',component:'artifacts',artifact_id:artifactId,file_kind:fileKind});
     if(typeof result.rows[0].content==='string'){
      if(createHash('sha256').update(result.rows[0].content).digest('hex')!==result.rows[0].sha256){logEvent('file.read.failed',{level:'error',component:'artifacts',artifact_id:artifactId,file_kind:fileKind,reason_code:'digest_mismatch'});throw new HTTPException(404,{message:'产物内容指纹校验失败'});}
      const filename=['redacted_markdown','source_markdown'].includes(result.rows[0].kind)?'materials.md':['redacted_index','source_index'].includes(result.rows[0].kind)?'pages.json':`${result.rows[0].kind}.txt`;
      logEvent('file.read.completed',{level:'info',component:'artifacts',artifact_id:artifactId,file_kind:fileKind,output_bytes:Buffer.byteLength(result.rows[0].content)});
      return new Response(result.rows[0].content,{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store'}});
     }
     const file = Bun.file(join(resolve(storageRoot), result.rows[0].storage_path));
     if (!await file.exists()) {logEvent('file.read.failed',{level:'error',component:'artifacts',artifact_id:artifactId,file_kind:fileKind,reason_code:'file_missing'});throw new HTTPException(404, { message: '产物文件缺失' });}
     logEvent('file.read.completed',{level:'info',component:'artifacts',artifact_id:artifactId,file_kind:fileKind,output_bytes:file.size});
     const filename = result.rows[0].kind === 'published_result' ? 'published.json' : result.rows[0].kind === 'authored_question' ? 'authoring.txt' : result.rows[0].kind === 'score_report' ? 'score.json' : result.rows[0].kind === 'model_answer' ? 'answer.txt' : result.rows[0].kind === 'redacted_markdown' ? 'materials.md' : 'pages.json';
     return new Response(file, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' } });
   } catch (error) { throw error; }
 });
 return app;
}
