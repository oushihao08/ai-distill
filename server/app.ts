import { Hono, type Context } from 'hono';
import {startRevision,resumeRevision} from './decisions/revision-jobs';
import {configureCodexCredentialsHome,runCodex} from './codex/client';
import {clearProjectCodexSettings,readCodexCredentialHome,readCodexSettings,readProjectCodexSettings,saveCodexSettings,saveProjectCodexSettings} from './codex/system-config';
import {readCodexModelCatalog} from './codex/models';
import {readWorkerMonitor} from './monitoring/worker-monitor';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { Pool } from 'pg';
import { mkdir, readFile, writeFile, rm, realpath, stat, mkdtemp } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { receiveMaterials } from './intake';
import { validateFolder, scanProjectFolder, registerQuestionFolders, projectStepSummary, validateStepConfig } from './project-folders';
import { enqueueIngestion } from './intake-jobs';
import { enqueueRedaction } from './materials/redaction-jobs';
import {clearGeneratedData} from './generated-data';
import {validateAnswerScore} from './scoring/context';
import {enqueueScore} from './scoring/jobs';
import {enqueueAuthoring} from './authoring/jobs';
import {enqueueProjectSkill,listProjectSkillAttempts} from './skill-generation/jobs';
import {enqueueAnswer} from './answer-models/jobs';
import {listAnswerModels,registerAnswerModel,setAnswerModelEnabled,readProjectModelSet,saveProjectModelSet} from './answer-models/model-set';
import {runAcceptance} from './decisions/jobs';
import {publishWorkflow} from './publishing/jobs';
import {buildProjectExport,workbookSha256,collectProjectResults} from './reporting/export';
import {summarizeProduction} from './reporting/metrics';
import {validateApiPrice} from './reporting/prices';
import { enqueueExtraction } from './materials/jobs';
import { waitDuration, waitForAttempt } from './attempts';
import { readProjectRules,registerProjectRules,publishProjectRules,editProjectRuleFile,adoptProjectSkill } from './rules';
import { readRuleFile } from './rule-files';
import {createHash} from 'node:crypto';
import { uuid, text, sourceKey, validateFile, MAX_BATCH } from './validation';

export function createApp(pool: Pool, storageRoot: string) {
 configureCodexCredentialsHome(()=>readCodexCredentialHome(pool));
 const app = new Hono();
 const materialMime=(name:string)=>{const ext=name.split('.').at(-1)?.toLowerCase();return ext==='pdf'?'application/pdf':ext==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain';};
 app.use('/api/*', bodyLimit({ maxSize: MAX_BATCH + 1024 * 1024, onError: c => c.json({ error: '上传请求超过100MB限制' }, 413) }));
 app.use('/api/*', async (c, next) => {
   try {
     const origin = c.req.header('Origin');
     if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && origin && !['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:3100', 'http://localhost:3100'].includes(origin)) throw new HTTPException(403, { message: '不允许此来源写入本地工作台' });
     await next();
     c.header('Cache-Control', 'no-store');
   } catch (error) { throw error; }
 });
 app.onError((error, c) => {
   if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
   if ('code' in error && error.code==='23505' && 'constraint' in error && error.constraint==='projects_local_skill_path') return c.json({error:'此本地skill目录已被其他项目使用，请设置独立目录'},409);
   if ('code' in error && error.code==='23505' && 'constraint' in error && error.constraint==='system_answer_models_provider_base_url_model_key') return c.json({error:'此供应商模型已登记，请从系统目录选择现有记录'},409);
   if ('code' in error && error.code==='23505' && 'constraint' in error && error.constraint==='api_model_prices_provider_model_currency_valid_from_key') return c.json({error:'此生效时间已有价格快照，历史价格不可覆盖，请追加新的生效时间'},409);
   console.error('请求失败', c.req.method, c.req.path, '（未输出数据库或材料内容）');
   return c.json({ error: '操作失败，请检查数据库连接或文件存储后重试' }, 500);
 });
 app.notFound(c => c.json({ error: '接口不存在' }, 404));
 app.get('/api/codex/config',async c=>{
  const config=await readCodexSettings(pool);
  return c.json({...config,model_options:readCodexModelCatalog()});
 });
 app.put('/api/codex/config',async c=>{
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  try{
   const config=await saveCodexSettings(pool,body);
   return c.json({...config,model_options:readCodexModelCatalog()});
  }catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(400,{message:error instanceof Error?error.message:'Codex设置无效'});}
 });
 app.get('/api/projects/:id/codex-settings',async c=>{
  try{return c.json(await readProjectCodexSettings(pool,uuid(c.req.param('id'))));}catch(error){throw error;}
 });
 app.put('/api/projects/:id/codex-settings',async c=>{
  const id=uuid(c.req.param('id'));
  const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});
  try{return c.json(await saveProjectCodexSettings(pool,id,body));}catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(400,{message:error instanceof Error?error.message:'项目Codex设置无效'});}
 });
 app.delete('/api/projects/:id/codex-settings',async c=>{
  try{return c.json(await clearProjectCodexSettings(pool,uuid(c.req.param('id'))));}catch(error){throw error;}
 });
 app.post('/api/codex/test',async c=>{
  const config=await readCodexSettings(pool),credentialsHome=config.credential_home??undefined;
  const directory=await mkdtemp(join(tmpdir(),'ai-distill-codex-probe-'));
  const schema={type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']};
  try{
   const result=await runCodex({directory,prompt:'Codex 连通性检查。请立即返回JSON：{"ok":true}。',model:config.model,reasoning_effort:config.reasoning_effort,schema,timeout_ms:45000,credentialsHome,validate(value){if(!value||typeof value!=='object'||Array.isArray(value)||(value as {ok?:unknown}).ok!==true)throw new Error('Codex 返回校验失败');return {ok:true};}});
   return c.json({connected:true,model:config.model,reasoning_effort:config.reasoning_effort,duration_ms:result.duration_ms});
  }catch{throw new HTTPException(502,{message:'Codex 连通性测试失败，请检查凭证路径、ChatGPT 登录和 Codex 服务状态'});}
  finally{await rm(directory,{recursive:true,force:true});}
 });
 app.get('/api/monitor', async c => { try { return c.json(await readWorkerMonitor(storageRoot)); } catch(error) { throw error; } });
 app.get('/api/health', async c => {
   try { await pool.query('SELECT 1'); return c.json({ database: 'connected', phase: 2 }); }
   catch { return c.json({ database: 'unavailable', phase: 2 }, 503); }
 });
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
 app.get('/api/projects', async c => {
   try { const result = await pool.query('SELECT p.*, (SELECT count(*)::int FROM ai_distill.workflows w WHERE w.project_id=p.id AND w.deleted_at IS NULL) AS workflow_count FROM ai_distill.projects p WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC,p.id'); return c.json(result.rows); }
   catch (error) { throw error; }
 });
 app.post('/api/projects', async c => {
   const body = await c.req.json().catch(() => { throw new HTTPException(400,{message:'请提交有效JSON'}); });
   const name = text(body?.name,'项目名称',120);
   const description = text(body?.description ?? '','项目说明',2000,false);
   const materialRoot = await validateFolder(body?.material_root);
   const questions = await scanProjectFolder(materialRoot);
   const id = crypto.randomUUID();
   const skillPath = body?.local_skill_path ? await validateFolder(body.local_skill_path,'本地skill目录') : resolve(storageRoot,'project-skills',id);
   await mkdir(skillPath,{recursive:true,mode:0o700});
   const db = await pool.connect();
   try {
    await db.query('BEGIN');
    const result = await db.query('INSERT INTO ai_distill.projects(id,name,description,material_root,local_skill_path) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,name,description,materialRoot,skillPath]);
    await registerQuestionFolders(db,id,name,questions);
    await db.query('COMMIT'); return c.json(result.rows[0],201);
   } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
 });
 app.get('/api/projects/:id', async c => {
   const id = uuid(c.req.param('id'));
   const project = await pool.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id]);
   if (!project.rowCount) throw new HTTPException(404,{message:'项目不存在'});
   const [workflows,steps] = await Promise.all([
    pool.query(`SELECT w.*, (SELECT count(*)::int FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.input_revision=w.input_revision) AS material_count,
     COALESCE((SELECT CASE s.ordinal WHEN 1 THEN 1 WHEN 9 THEN 2 WHEN 4 THEN 3 WHEN 5 THEN 4 WHEN 6 THEN 5 WHEN 7 THEN 6 WHEN 8 THEN 7 END FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal NOT IN (2,3) AND s.status NOT IN ('succeeded','skipped') ORDER BY s.display_position LIMIT 1),7) AS current_ordinal,
     (SELECT status FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal NOT IN (2,3) AND s.status NOT IN ('succeeded','skipped') ORDER BY display_position LIMIT 1) AS current_status
     FROM ai_distill.workflows w WHERE project_id=$1 AND w.deleted_at IS NULL ORDER BY created_at DESC,id`,[id]),
    projectStepSummary(pool,id),
   ]);
   const skillExists = await Bun.file(join(project.rows[0].local_skill_path ?? '/nonexistent','SKILL.md')).exists();
   return c.json({project:{...project.rows[0],skill_exists:skillExists},workflows:workflows.rows,steps});
 });
 app.get('/api/projects/:id/metrics',async c=>{
   const id=uuid(c.req.param('id'));
   const project=await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id]);
   if(!project.rowCount)throw new HTTPException(404,{message:'项目不存在'});
   const [workflows,results]=await Promise.all([
    pool.query(`SELECT w.id AS workflow_id,w.input_revision,true AS current,true AS started,
     COALESCE((SELECT s.status='succeeded' FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=1),false) AS processed,
     EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.workflow_id=w.id AND a.ordinal=4 AND a.input_revision=w.input_revision AND a.status='succeeded') AS authored,
     COALESCE((SELECT (s.result->>'decision')='accepted' FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=7),false) AS accepted,
     COALESCE((SELECT (s.result->>'decision')='quarantine' FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=7),false) AS quarantined,
     COALESCE((SELECT s.result->'quality_check'->>'passed'='true' FROM ai_distill.steps s WHERE s.workflow_id=w.id AND s.ordinal=4),false) AS quality_passed,
     (SELECT count(DISTINCT a.input->'context'->'binding'->>'answer_attempt_id')::int FROM ai_distill.step_attempts a WHERE a.workflow_id=w.id AND a.ordinal=6 AND a.input_revision=w.input_revision AND a.result->'validation'->>'valid'='true') AS valid_assessments,
     EXISTS(SELECT 1 FROM ai_distill.project_exports e WHERE e.project_id=w.project_id AND e.status='succeeded' AND e.workflow_revisions->>w.id::text=w.input_revision::text) AS exported
     FROM ai_distill.workflows w WHERE w.project_id=$1 AND w.deleted_at IS NULL ORDER BY w.id`,[id]),
    collectProjectResults(pool,id),
   ]);
   const currencyTotals:Record<string,number>={},unknownReasons:Record<string,number>={};let knownCalls=0,unknownCalls=0;
   for(const cost of results.usage_costs){if(!cost.included)continue;if(cost.unknown_reason){unknownCalls++;unknownReasons[cost.unknown_reason]=(unknownReasons[cost.unknown_reason]??0)+1;}else{const currency=cost.currency!;currencyTotals[currency]=(currencyTotals[currency]??0)+cost.cost!;knownCalls++;}}
   return c.json({production:summarizeProduction(workflows.rows),api_costs:{known_calls:knownCalls,known_amount_by_currency:currencyTotals,unknown_calls:unknownCalls,unknown_reasons:unknownReasons}});
 });
 app.get('/api/projects/:id/exports',async c=>{
   const exists=await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[uuid(c.req.param('id'))]);
   if(!exists.rowCount)throw new HTTPException(404,{message:'项目不存在'});
   const result=await pool.query('SELECT id,batch,status,sha256,workflow_count,error,created_at,finished_at FROM ai_distill.project_exports WHERE project_id=$1 ORDER BY created_at DESC,id LIMIT 100',[uuid(c.req.param('id'))]);
   return c.json(result.rows);
 });
 app.get('/api/api-model-prices',async c=>c.json((await pool.query('SELECT id,provider,model,currency,input_per_million,output_per_million,cached_input_per_million,cache_write_per_million,source,valid_from,valid_until FROM ai_distill.api_model_prices ORDER BY provider,model,valid_from DESC')).rows));
 app.put('/api/api-model-prices',async c=>{
   let price;try{price=validateApiPrice(await c.req.json());}catch(error){throw new HTTPException(400,{message:error instanceof Error?error.message:'API价格无效'});}
   const db=await pool.connect();
   try{
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${price.provider}/${price.model}/${price.currency}`]);
    const latest=(await db.query('SELECT max(valid_from) AS valid_from FROM ai_distill.api_model_prices WHERE provider=$1 AND model=$2 AND currency=$3',[price.provider,price.model,price.currency])).rows[0]?.valid_from;
    if(latest&&new Date(price.valid_from)<new Date(latest))throw new HTTPException(409,{message:'价格快照必须按生效时间顺序登记'});
    await db.query('UPDATE ai_distill.api_model_prices SET valid_until=$4 WHERE provider=$1 AND model=$2 AND currency=$3 AND valid_until IS NULL AND valid_from<$4',[price.provider,price.model,price.currency,price.valid_from]);
    const saved=await db.query(`INSERT INTO ai_distill.api_model_prices(id,provider,model,currency,input_per_million,output_per_million,cached_input_per_million,cache_write_per_million,source,valid_from,valid_until)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[crypto.randomUUID(),price.provider,price.model,price.currency,price.input_per_million,price.output_per_million,price.cached_input_per_million??null,price.cache_write_per_million??null,price.source,price.valid_from,price.valid_until]);
    await db.query('COMMIT');return c.json(saved.rows[0]);
   }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.post('/api/projects/:id/export',async c=>{
   const projectId=uuid(c.req.param('id'));
   const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'导出参数须为有效JSON'});});
   const batch=body?.batch===undefined||body.batch===null?null:text(body.batch,'批次',160);
   const id=crypto.randomUUID();
   await pool.query("INSERT INTO ai_distill.project_exports(id,project_id,batch,status) SELECT $2,id,$3,'running' FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL",[projectId,id,batch]);
   if(!(await pool.query('SELECT id FROM ai_distill.project_exports WHERE id=$1',[id])).rowCount)throw new HTTPException(404,{message:'项目不存在'});
   const relativePath=join('exports',`${id}.xlsx`);const path=join(resolve(storageRoot),relativePath);let wrote=false;
   try{
    const exported=await buildProjectExport(pool,projectId,batch??undefined);await mkdir(join(resolve(storageRoot),'exports'),{recursive:true,mode:0o700});
    await writeFile(path,exported.bytes,{mode:0o600,flag:'wx'});wrote=true;
    const sha256=workbookSha256(exported.bytes);const workflowIds=exported.records.map(row=>row.workflow_id);
    const workflowRevisions=Object.fromEntries(exported.records.map(row=>[row.workflow_id,row.input_revision]));
    await pool.query("UPDATE ai_distill.project_exports SET status='succeeded',storage_path=$2,sha256=$3,workflow_count=$4,workflow_ids=$5,workflow_revisions=$6,finished_at=now() WHERE id=$1 AND status='running'",[id,relativePath,sha256,workflowIds.length,workflowIds,JSON.stringify(workflowRevisions)]);
    return c.json({id,status:'succeeded',sha256,workflow_count:workflowIds.length},201);
   }catch(error){if(wrote)await rm(path,{force:true});await pool.query("UPDATE ai_distill.project_exports SET status='failed',error='导出生成或保存失败',finished_at=now() WHERE id=$1 AND status='running'",[id]);throw error;}
 });
 app.get('/api/exports/:id/download',async c=>{
   const row=(await pool.query("SELECT storage_path,sha256 FROM ai_distill.project_exports WHERE id=$1 AND status='succeeded'",[uuid(c.req.param('id'))])).rows[0];
   if(!row)throw new HTTPException(404,{message:'导出文件不存在'});
   try{
    const root=await realpath(resolve(storageRoot)),path=await realpath(resolve(root,row.storage_path));
    if(!path.startsWith(`${root}/`)||await stat(path).then(s=>!s.isFile()))throw new Error('invalid export path');
    const bytes=await readFile(path);if(workbookSha256(bytes)!==row.sha256)throw new Error('export hash mismatch');
    return new Response(Uint8Array.from(bytes).buffer,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${c.req.param('id')}.xlsx"`,'Cache-Control':'no-store'}});
   }catch{throw new HTTPException(404,{message:'导出文件缺失或指纹校验失败'});}
 });
 app.patch('/api/projects/:id', async c => {
   const id = uuid(c.req.param('id'));
   const body = await c.req.json().catch(() => { throw new HTTPException(400,{message:'请提交有效JSON'}); });
   const name = text(body?.name,'项目名称',120); const description = text(body?.description ?? '','项目说明',2000,false);
   const root = await validateFolder(body?.material_root);
   const skill = body?.local_skill_path ? await validateFolder(body.local_skill_path,'本地skill目录') : undefined;
   const db = await pool.connect();
   try {
    await db.query('BEGIN');
    const previous = await db.query('SELECT * FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id]);
    if (!previous.rowCount) throw new HTTPException(404,{message:'项目不存在'});
    const result = await db.query('UPDATE ai_distill.projects SET name=$2,description=$3,material_root=$4,local_skill_path=$5 WHERE id=$1 RETURNING *',[id,name,description,root,skill ?? previous.rows[0].local_skill_path ?? resolve(storageRoot,'project-skills',id)]);
    await db.query("UPDATE ai_distill.workflows SET title=$2||'-'||source_key WHERE project_id=$1 AND source_key IS NOT NULL AND deleted_at IS NULL",[id,name]);
    await mkdir(result.rows[0].local_skill_path,{recursive:true,mode:0o700});
    if (root !== previous.rows[0].material_root) await registerQuestionFolders(db,id,name,await scanProjectFolder(root));
    await db.query('COMMIT'); return c.json(result.rows[0]);
   } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
 });
 app.delete('/api/projects/:id', async c => {
   const id = uuid(c.req.param('id')); const db = await pool.connect();
   try {
    await db.query('BEGIN');
    if (!(await db.query('UPDATE ai_distill.projects SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',[id])).rowCount) throw new HTTPException(404,{message:'项目不存在'});
    await db.query('SELECT id FROM ai_distill.workflows WHERE project_id=$1 ORDER BY id FOR UPDATE',[id]);
    await db.query("UPDATE ai_distill.step_attempts a SET status='skipped',error='项目已删除',finished_at=now() FROM ai_distill.workflows w WHERE a.workflow_id=w.id AND w.project_id=$1 AND a.status IN ('waiting','running')",[id]);
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
    const result = await registerQuestionFolders(db,id,current.name,questions);
    await db.query('COMMIT'); return c.json(result);
   } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
 });
 app.put('/api/projects/:id/steps/:ordinal/config', async c => {
   const id = uuid(c.req.param('id')); const ordinal = Number(c.req.param('ordinal'));
   const config = validateStepConfig(ordinal,await c.req.json().catch(() => { throw new HTTPException(400,{message:'请提交有效JSON'}); }));
   if(ordinal!==7&&ordinal!==9){
    const saved=await pool.query(`INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) SELECT id,$2,$3 FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL ON CONFLICT(project_id,ordinal) DO UPDATE SET config=EXCLUDED.config,updated_at=now() RETURNING config`,[id,ordinal,JSON.stringify(config)]);
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
    }else{
     await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE ordinal IN (3,4,5,6,7,8,9) AND workflow_id IN(SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL)",[id]);
     await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='脱敏设置更新，原结果失效',finished_at=now() WHERE ordinal IN (3,4,5,6,7,8,9) AND status IN('waiting','running') AND workflow_id IN(SELECT id FROM ai_distill.workflows WHERE project_id=$1)",[id]);
     await db.query("UPDATE ai_distill.project_exports SET status='stale',error='脱敏设置已更新',finished_at=now() WHERE project_id=$1 AND status='succeeded'",[id]);
    }
    await db.query('COMMIT');return c.json(saved.rows[0]);
   }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.delete('/api/projects/:id/steps/:ordinal/config',async c=>{
  const id=uuid(c.req.param('id')),ordinal=Number(c.req.param('ordinal'));
  if(![4,6,9].includes(ordinal))throw new HTTPException(400,{message:'仅Codex步骤支持恢复继承'});
  const project=await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[id]);
  if(!project.rowCount)throw new HTTPException(404,{message:'项目不存在'});
  if(ordinal===9){
   const saved=await pool.query(`UPDATE ai_distill.project_step_configs SET config=config-'provider'-'model'-'reasoning_effort',updated_at=now()
    WHERE project_id=$1 AND ordinal=9 RETURNING config`,[id]);
   return c.json({reset:true,config:saved.rows[0]?.config??{}});
  }
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
 app.post('/api/projects/:id/rules/register',async c=>{
   try{const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});const root=await validateFolder(body?.workspace_path,'项目工作区');return c.json(await registerProjectRules(pool,uuid(c.req.param('id')),root));}catch(error){throw error;}
 });
 app.post('/api/projects/:id/rules/publish',async c=>{
   try{const body=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'请提交有效JSON'});});if(typeof body?.source_digest!=='string'||! /^[a-f0-9]{64}$/.test(body.source_digest))throw new HTTPException(400,{message:'请提供当前规则目录指纹'});return c.json(await publishProjectRules(pool,uuid(c.req.param('id')),body.source_digest));}catch(error){throw error;}
 });
 app.get('/api/projects/:id/rules/file',async c=>{
   try{
    const view=await readProjectRules(pool,uuid(c.req.param('id')));const path=text(c.req.query('path'),'规则文件路径',1000);const file=view.workspace.files.find(file=>file.path===path);
    if(!file)throw new HTTPException(404,{message:'规则文件不存在'});
    const bytes=await readRuleFile(path.startsWith('skill/')?view.workspace.skill_path:view.workspace.workspace_path,path.startsWith('skill/')?path.slice(6):path);
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
   if((files as File[]).some(file=>file.name.toLowerCase().endsWith('.pdf')))await enqueueExtraction(pool,result.id);
   return c.json(result, result.reused || result.updated ? 200 : 201);
 });
 app.post('/api/workflows/:id/revisions',async c=>{
  try{const body=await c.req.json();return c.json(await startRevision(pool,uuid(c.req.param('id')),uuid(body.source_attempt_id)));}catch(error){throw error;}
 });
 app.post('/api/workflows/:id/revisions/:chainId/resume',async c=>{
  try{return c.json(await resumeRevision(pool,uuid(c.req.param('id')),uuid(c.req.param('chainId'))));}catch(error){throw error;}
 });
 app.get('/api/workflows/:id/revisions',async c=>{
  try{
   const id=uuid(c.req.param('id'));
   if(!(await pool.query('SELECT w.id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL',[id])).rowCount)throw new HTTPException(404,{message:'工作流不存在'});
   const chains=(await pool.query('SELECT * FROM ai_distill.revision_chains WHERE workflow_id=$1 ORDER BY created_at DESC',[id])).rows;
   const rounds=(await pool.query('SELECT r.* FROM ai_distill.revision_rounds r JOIN ai_distill.revision_chains c ON c.id=r.chain_id WHERE c.workflow_id=$1 ORDER BY r.created_at',[id])).rows;
   return c.json({chains,rounds});
  }catch(error){throw error;}
 });
 app.get('/api/workflows/:id', async c => {
   try {
     const id = uuid(c.req.param('id'));
     const workflow = await pool.query('SELECT * FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=project_id AND p.deleted_at IS NULL)', [id]);
     if (!workflow.rowCount) throw new HTTPException(404, { message: '工作流不存在' });
     const [project, materials, steps, attempts, artifacts] = await Promise.all([
       pool.query('SELECT * FROM ai_distill.projects WHERE id=$1', [workflow.rows[0].project_id]),
       pool.query('SELECT id,original_name,sha256,size_bytes,content_type,processing_status,created_at FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2 ORDER BY created_at,id', [id, workflow.rows[0].input_revision]),
       pool.query('SELECT ordinal,step_key,display_position,enabled,name,status,implemented,result,error,started_at,finished_at FROM ai_distill.steps WHERE workflow_id=$1 ORDER BY display_position NULLS LAST,ordinal', [id]),
       pool.query('SELECT id,ordinal,status,input,result,error,config,session_id,started_at,finished_at,input_revision FROM ai_distill.step_attempts WHERE workflow_id=$1 ORDER BY ordinal,attempt', [id]),
       pool.query("SELECT ar.id,ar.kind,ar.attempt_id,ar.created_at,a.result->>'question_version' AS question_version FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id WHERE ar.workflow_id=$1 AND a.input_revision=$2 AND ar.kind IN ('redacted_markdown','redacted_index','authored_question','model_answer','score_report','published_result') ORDER BY ar.created_at DESC,ar.id", [id, workflow.rows[0].input_revision]),
     ]);
     const hasPdf=materials.rows.some(material=>String(material.original_name).toLowerCase().endsWith('.pdf'));
     const extraction=steps.rows.find(step=>step.ordinal===2);
     const visibleSteps=steps.rows.filter(step=>step.ordinal!==2&&step.ordinal!==3).map(step=>step.ordinal===1&&hasPdf&&extraction?{...step,status:extraction.status,result:extraction.result??step.result,error:extraction.error??step.error,started_at:extraction.started_at??step.started_at,finished_at:extraction.finished_at??step.finished_at}:step).map((step,index)=>({...step,display_position:index+1,position:index+1}));
     return c.json({ artifacts: artifacts.rows, workflow: workflow.rows[0], project: project.rows[0], materials: materials.rows.map(m => ({ ...m, size_bytes: Number(m.size_bytes) })), steps: visibleSteps, attempts: attempts.rows });
   } catch (error) { throw error; }
 });
 async function editMaterials(workflowId: string, incoming: File[], replaceId?: string, deleteId?: string) {
   const workflow = (await pool.query('SELECT w.* FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL',[workflowId])).rows[0];
   if (!workflow) throw new HTTPException(404,{message:'题目不存在'});
   // Optimistic version guard inside intake prevents a concurrent edit from dropping new materials.
   const existing = await pool.query('SELECT id,original_name,storage_path FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2 ORDER BY created_at,id',[workflowId,workflow.input_revision]);
   if ((replaceId || deleteId) && !existing.rows.some(row=>row.id===(replaceId || deleteId))) throw new HTTPException(404,{message:'当前版本中不存在此材料'});
   const files:File[]=[];
   for (const material of existing.rows) if (material.id!==replaceId && material.id!==deleteId) files.push(new File([await readFile(join(resolve(storageRoot),material.storage_path))],material.original_name,{type:materialMime(material.original_name)}));
   files.push(...incoming);
   const result=await receiveMaterials(pool,storageRoot,{projectId:workflow.project_id,requestId:crypto.randomUUID(),title:workflow.title,key:workflow.source_key,workflowId,expectedRevision:workflow.input_revision,files,allowEmpty:true});
   if(files.some(file=>file.name.toLowerCase().endsWith('.pdf')))await enqueueExtraction(pool,workflowId);
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
 app.get('/api/workflows/:id/materials/:materialId/extracted-text',async c=>{
  const workflowId=uuid(c.req.param('id')),materialId=uuid(c.req.param('materialId'));
  const material=(await pool.query(`SELECT m.id,m.original_name,m.processing_status,m.sha256,w.input_revision
   FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL
   JOIN ai_distill.materials m ON m.workflow_id=w.id AND m.input_revision=w.input_revision
   WHERE w.id=$1 AND w.deleted_at IS NULL AND m.id=$2`,[workflowId,materialId])).rows[0];
  if(!material)throw new HTTPException(404,{message:'当前材料不存在'});
  const artifact=(await pool.query(`SELECT ar.content,ar.storage_path,ar.sha256
   FROM ai_distill.artifacts ar JOIN ai_distill.step_attempts a ON a.id=ar.attempt_id
   WHERE ar.workflow_id=$1 AND ar.material_id=$2 AND ar.kind='private_extracted_pages'
    AND a.input_revision=$3 AND a.status='succeeded' AND a.ordinal IN (1,2)
   ORDER BY a.finished_at DESC NULLS LAST,ar.created_at DESC,ar.id DESC LIMIT 1`,[workflowId,materialId,material.input_revision])).rows[0];
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
   const redactedArtifact=(await pool.query(`SELECT idx.content AS content,idx.storage_path,idx.sha256
    FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=9 AND s.status='succeeded'
    JOIN ai_distill.artifacts idx ON idx.attempt_id=a.id AND idx.workflow_id=a.workflow_id AND idx.kind='redacted_index'
    WHERE a.workflow_id=$1 AND a.ordinal=9 AND a.status='succeeded' AND a.input_revision=$2
    ORDER BY a.finished_at DESC NULLS LAST,a.id DESC LIMIT 1`,[workflowId,material.input_revision])).rows[0];
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
 app.delete('/api/workflows/:id/generated', async c => {try{return c.json(await clearGeneratedData(pool,storageRoot,uuid(c.req.param('id'))));}catch(error){throw error;}});
 app.delete('/api/workflows/:id', async c => {
   const id=uuid(c.req.param('id')); const db=await pool.connect();
   try {
    await db.query('BEGIN');
    if(!(await db.query('UPDATE ai_distill.workflows SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',[id])).rowCount) throw new HTTPException(404,{message:'题目不存在'});
    await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='题目已删除',finished_at=now() WHERE workflow_id=$1 AND status IN ('waiting','running')",[id]);
    await db.query('COMMIT');return c.json({deleted:true});
   }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 });
 app.get('/api/materials/:id/download', async c => {
   try {
     const result = await pool.query('SELECT original_name,storage_path FROM ai_distill.materials WHERE id=$1', [uuid(c.req.param('id'))]);
     if (!result.rowCount) throw new HTTPException(404, { message: '材料不存在' });
     const file = Bun.file(join(resolve(storageRoot), result.rows[0].storage_path));
     if (!await file.exists()) throw new HTTPException(404, { message: '材料文件缺失，请检查本地存储' });
     return new Response(file, { headers: { 'Content-Type': materialMime(result.rows[0].original_name), 'Content-Disposition': "attachment; filename*=UTF-8''"+encodeURIComponent(result.rows[0].original_name), 'Cache-Control': 'no-store' } });
   } catch (error) { throw error; }
 });
 async function executeStep(c: Context, ordinal: 1 | 2 | 4 | 5 | 6 | 7 | 8 | 9) {
   try {
    const waitMs=waitDuration(c.req.query('wait_ms'));
    const id=uuid(c.req.param('id') ?? '');
   const task=ordinal===1?await enqueueIngestion(pool,id):ordinal===2?await enqueueExtraction(pool,id):ordinal===9?await enqueueRedaction(pool,id):ordinal===4?await enqueueAuthoring(pool,id):ordinal===5?await enqueueAnswer(pool,id,storageRoot):ordinal===6?await enqueueScore(pool,id):ordinal===7?await runAcceptance(pool,id):await publishWorkflow(pool,id,storageRoot);
    if ('completed' in task && task.completed) return c.json(task,200);
    if (!waitMs) return c.json(task,202);
    const attemptIds=(task as {ids?:unknown}).ids;
    if(Array.isArray(attemptIds)&&attemptIds.length>1&&attemptIds.every((id):id is string=>typeof id==='string')){
     const results=await Promise.all(attemptIds.map((attemptId:string)=>waitForAttempt(pool,attemptId,waitMs,c.req.raw.signal)));
     const completed=results.every(result=>result.completed);
     return c.json({...task,results,completed},completed?200:202);
    }
    const result=await waitForAttempt(pool,task.id,waitMs,c.req.raw.signal);
    return c.json({...task,...result},result.completed?200:202);
   } catch(error) { throw error; }
 }
 app.post('/api/workflows/:id/intake', c => executeStep(c,1));
 app.post('/api/workflows/:id/extract', c => executeStep(c,2));
 app.post('/api/workflows/:id/redact', c => executeStep(c,9));
 app.post('/api/workflows/:id/author', c => executeStep(c,4));
 app.post('/api/workflows/:id/answer', c => executeStep(c,5));
 app.post('/api/workflows/:id/score', c => executeStep(c,6));
 app.post('/api/workflows/:id/accept', c => executeStep(c,7));
 app.post('/api/workflows/:id/publish', c => executeStep(c,8));
 app.post('/api/workflows/:id/answers/:attemptId/validate-score', async c=>{
  try{const report=await c.req.json().catch(()=>{throw new HTTPException(400,{message:'评分结果须为有效JSON'});});return c.json(await validateAnswerScore(pool,uuid(c.req.param('id')),uuid(c.req.param('attemptId')),report));}catch(error){throw error;}
 });
 app.get('/api/attempts/:id', async c => {
   try { return c.json(await waitForAttempt(pool,uuid(c.req.param('id')),waitDuration(c.req.query('wait_ms')),c.req.raw.signal)); }
   catch(error) { throw error; }
 });
 app.post('/api/projects/:id/steps/:ordinal/run-batch', async c => {
   const projectId = uuid(c.req.param('id'));
   const ordinal = Number(c.req.param('ordinal'));
   if (!Number.isInteger(ordinal) || ![1,4,5,6,7,8,9].includes(ordinal)) throw new HTTPException(400, { message: '步骤序号无效' });
   let body: unknown = {};
   try { body = await c.req.json(); } catch { throw new HTTPException(400, { message: '批量执行参数须为有效JSON' }); }
   const rawIds = (body as { workflow_ids?: unknown } | null)?.workflow_ids;
   if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.length > 100)) throw new HTTPException(400, { message: 'workflow_ids须为最多100条记录的数组' });
   const requestedIds = rawIds === undefined ? undefined : [...new Set(rawIds.map(value => uuid(String(value))))];
   if (requestedIds && requestedIds.length > 100) throw new HTTPException(400, { message: '去重后的工作流不能超过100条' });
   const project = await pool.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL', [projectId]);
   if (!project.rowCount) throw new HTTPException(404, { message: '项目不存在' });
   const selected = requestedIds
     ? await pool.query('SELECT id,project_id FROM ai_distill.workflows WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL', [requestedIds])
     : await pool.query('SELECT id,project_id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 101', [projectId]);
   if (!requestedIds && selected.rows.length > 100) throw new HTTPException(400, { message: '单次批量最多执行100条工作流' });
   const byId = new Map(selected.rows.map(row => [row.id, row]));
   const workflowIds = requestedIds ?? selected.rows.map(row => row.id);
   const results = await Promise.all(workflowIds.map(async workflowId => {
     const row = byId.get(workflowId);
     if (!row || row.project_id !== projectId) return { workflow_id: workflowId, status: 'not_found' as const };
     try {
       const ready = await pool.query(`SELECT CASE WHEN s.ordinal=1 AND EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=s.workflow_id AND m.input_revision=(SELECT input_revision FROM ai_distill.workflows WHERE id=s.workflow_id) AND lower(m.original_name) LIKE '%.pdf') THEN (SELECT status FROM ai_distill.steps WHERE workflow_id=s.workflow_id AND ordinal=2) ELSE s.status END AS status,
        EXISTS(SELECT 1 FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.workflow_id=s.workflow_id AND a.input_revision=w.input_revision AND a.ordinal IN (CASE WHEN s.ordinal=1 THEN 1 ELSE s.ordinal END,CASE WHEN s.ordinal=1 THEN 2 ELSE s.ordinal END) AND a.status IN ('waiting','running')) AS active,
        (SELECT p.status FROM ai_distill.steps p WHERE p.workflow_id=s.workflow_id AND p.enabled AND p.ordinal NOT IN (2,3) AND p.display_position<s.display_position ORDER BY p.display_position DESC LIMIT 1) AS previous_status
        FROM ai_distill.steps s WHERE s.workflow_id=$1 AND s.ordinal=$2`,[workflowId,ordinal]);
       if (ready.rowCount && (!['waiting','failed'].includes(ready.rows[0].status) || ready.rows[0].active || (ready.rows[0].previous_status!==null && ready.rows[0].previous_status!=='succeeded'))) return {workflow_id:workflowId,status:'not_ready' as const,reason:'此题目未就绪或此步骤已完成'};
       const task = ordinal===1 ? await enqueueIngestion(pool,workflowId) : ordinal===9 ? await enqueueRedaction(pool,workflowId) : ordinal===4 ? await enqueueAuthoring(pool,workflowId) : ordinal===5 ? await enqueueAnswer(pool,workflowId,storageRoot) : ordinal===6 ? await enqueueScore(pool,workflowId) : ordinal===7 ? await runAcceptance(pool,workflowId) : await publishWorkflow(pool,workflowId,storageRoot);
       const decisionStatus='decision' in task?(task.decision==='accepted'?'succeeded' as const:'decision_recorded' as const):'completed' in task&&task.completed?'succeeded' as const:'queued' as const;
       return { workflow_id: workflowId, status: decisionStatus, attempt_id: task.id,...('ids' in task?{attempt_ids:task.ids}:{}), reused: 'reused' in task?task.reused:false,...('decision' in task?{decision:task.decision,reasons:task.reasons}:{}) };
     } catch (error) {
       if (error instanceof HTTPException && error.status === 409) return { workflow_id: workflowId, status: 'not_ready' as const, reason: error.message };
       if (error instanceof HTTPException && error.status === 404) return { workflow_id: workflowId, status: 'not_found' as const };
       return { workflow_id: workflowId, status: 'failed' as const, reason: '排队失败，请检查数据库连接后重试' };
     }
   }));
   return c.json({ results }, 202);
 });
 app.get('/api/artifacts/:id/download', async c => {
   try {
     const result = await pool.query("SELECT kind,storage_path,sha256,content FROM ai_distill.artifacts WHERE id=$1 AND kind IN ('redacted_markdown','redacted_index','model_answer','score_report','authored_question','published_result')", [uuid(c.req.param('id'))]);
     if (!result.rowCount) throw new HTTPException(404, { message: '产物不存在或不允许下载' });
     if(typeof result.rows[0].content==='string'){
      if(createHash('sha256').update(result.rows[0].content).digest('hex')!==result.rows[0].sha256)throw new HTTPException(404,{message:'产物内容指纹校验失败'});
      const filename=result.rows[0].kind==='redacted_markdown'?'materials.md':result.rows[0].kind==='redacted_index'?'pages.json':`${result.rows[0].kind}.txt`;
      return new Response(result.rows[0].content,{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store'}});
     }
     const file = Bun.file(join(resolve(storageRoot), result.rows[0].storage_path));
     if (!await file.exists()) throw new HTTPException(404, { message: '产物文件缺失' });
     const filename = result.rows[0].kind === 'published_result' ? 'published.json' : result.rows[0].kind === 'authored_question' ? 'authoring.txt' : result.rows[0].kind === 'score_report' ? 'score.json' : result.rows[0].kind === 'model_answer' ? 'answer.txt' : result.rows[0].kind === 'redacted_markdown' ? 'materials.md' : 'pages.json';
     return new Response(file, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' } });
   } catch (error) { throw error; }
 });
 return app;
}
