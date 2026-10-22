/**
 * 职责：项目目录与步骤投影：扫描来源附件，按项目模式登记题目或材料包，校验阶段配置并计算批量就绪状态。
 * 关键方法与用途：`scanProjectFolder()`／`scanQuestionFolder()` 扫描只读来源；`registerQuestionFolders()` 登记工作流；`validateStepConfig()` 校验保存设置；`validateStepConfigForExecution()` 校验已保存 Codex 步骤配置而不把模型缓存当执行白名单；`projectStepSummary()` 汇总可派发状态。
 * 使用场景：`app.ts` 提供目录同步与列表接口，入库队列按扫描结果处理材料。
 */
import {mergeRedactionDefaults,validateRedactionConfig,type RedactionConfig} from './materials/redaction-config';
import {resolveMaterialProcessingMode,materialProcessingSourceMode,type MaterialProcessingMode} from '../shared/material-library';
import {resolveModelApiConfig,type ModelApiConfig} from './llm-api';
import {mergeCodexDefaults,validateAgentModel,readProjectAgentSettings} from './agent/config';
import { readdir, realpath, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {resolveRepositoryPath} from './paths';
import {MAX_FILE,MAX_BATCH,MAX_FOLDER_BATCH} from './validation';
import {splitLargePdf} from './materials/pdf-split';
import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import {invalidateMaterialResults} from './materials/state';
import type { Pool, PoolClient } from 'pg';
import { STEP_REGISTRY,getWorkflowStepDefinitions } from '../shared/step-registry';
import { SYSTEM_STEP_PROMPTS } from '../shared/step-prompts';
import {resolveQwenConfig,QwenError} from './answer-models/qwen';
import {resolveAnswerConfig} from './answer-models/dispatch';
import {DomesticError} from './answer-models/domestic';
import {workAnswerCapabilityIssue} from './answer-models/input';
import {validateAcceptanceConfig,validateAcceptancePolicy} from './decisions/config';
import { text } from './validation';
import {validateWorkflowConfig,type WorkflowConfig} from '../shared/workflow-config';
export interface FolderFile { name: string; path: string; sha256: string; size: number; split_from?: string }
export interface QuestionFolder { key: string; files: FolderFile[] }
const supportedDocument=/\.(pdf|docx|txt|md)$/i;
export interface WorkflowStepState { ordinal:number;status:string;result?:any;enabled:boolean;active:boolean;has_pdf?:boolean;extraction_status?:string|null;workflow_kind?:'question'|'material_package';source_workflow_id?:string|null;library_source?:boolean }
export function workflowStepReadiness(ordinal:number,steps:Map<number,WorkflowStepState>):{ready:true}|{ready:false;reason:string}{
 const identity=steps.values().next().value as WorkflowStepState|undefined;
 if(identity?.workflow_kind==='material_package'&&![1,2,9].includes(ordinal))return{ready:false,reason:'材料包只执行入库和脱敏'};
 if(identity?.library_source&&[1,2,9].includes(ordinal))return{ready:false,reason:'题目使用已冻结的共享材料包快照'};
 if(identity?.source_workflow_id&&[1,2,9].includes(ordinal))return{ready:false,reason:'派生题目使用已冻结的材料快照'};
 const visible=STEP_REGISTRY.filter(stage=>stage.visible),index=visible.findIndex(stage=>stage.ordinal===ordinal),stage=visible[index];
 if(!stage)return{ready:false,reason:'此步骤不支持批量执行'};
 const current=steps.get(ordinal);
 if(!current)return{ready:false,reason:'此题目缺少当前步骤记录'};
 if(!stage.defaultEnabled||!current.enabled)return{ready:false,reason:'此步骤未启用'};
 const status=ordinal===1&&current.has_pdf?current.extraction_status??current.status:current.status;
 const retryingRepair=[4,5,6].includes(ordinal)&&steps.get(7)?.status==='succeeded'&&steps.get(7)?.result?.decision==='repair';
 if(!['waiting','failed'].includes(status)&&!(status==='succeeded'&&retryingRepair))return{ready:false,reason:current.active?'此步骤已有排队或运行任务':status==='succeeded'?'此步骤已完成':'当前步骤状态不可执行'};
 if(current.active)return{ready:false,reason:'此步骤已有排队或运行任务'};
 if(ordinal===5){const issue=workAnswerCapabilityIssue(steps.get(4)?.result);if(issue)return{ready:false,reason:issue};}
 if(ordinal===8){
  const decision=steps.get(7);
  if(!decision||!decision.enabled||decision.status!=='succeeded'||decision.result?.decision!=='accepted')return{ready:false,reason:'题目未达标，不能归档'};
 }
 let previous:typeof visible[number]|undefined,previousRow:WorkflowStepState|undefined;
 for(let position=index-1;position>=0;position--){const candidate=visible[position]!,row=steps.get(candidate.ordinal);if(identity?.library_source&&[1,2,9].includes(candidate.ordinal))continue;if(row?.enabled){previous=candidate;previousRow=row;break;}}
 if(!previous)return{ready:true};
 const previousStatus=previous.ordinal===1&&previousRow?.has_pdf?previousRow.extraction_status??previousRow.status:previousRow!.status;
 const models=previousRow?.result?.models;
 const settledPartialAnswers=ordinal===6&&previous.ordinal===5&&Array.isArray(models)&&models.length>0&&models.every((model:any)=>['succeeded','failed','skipped'].includes(model?.status))&&models.some((model:any)=>model?.status==='succeeded'&&typeof model.attempt_id==='string');
 return previousStatus==='succeeded'||settledPartialAnswers?{ready:true}:{ready:false,reason:`前置步骤「${previous.name}」尚未完成`};
}
export function isWorkflowStepReady(ordinal:number,steps:Map<number,WorkflowStepState>){return workflowStepReadiness(ordinal,steps).ready;}
export function readBatchChunkSize(value=process.env.BATCH_DISPATCH_CHUNK_SIZE){
 if(value===undefined||value.trim()==='')return 100;
 const size=Number(value);
 if(!Number.isInteger(size)||size<1||size>1000)throw new Error('BATCH_DISPATCH_CHUNK_SIZE 须为 1 至 1000 的整数');
 return size;
}
export function splitIntoBatches<T>(values:T[],size:number):T[][]{
 if(!Number.isInteger(size)||size<1)throw new Error('批次大小须为正整数');
 const batches:T[][]=[];for(let start=0;start<values.length;start+=size)batches.push(values.slice(start,start+size));return batches;
}
export async function readProjectWorkflowStepRows(pool:Pool,projectId:string,workflowIds?:string[]){
 // 远端数据库逐行传输此状态表成本明显高于单个JSON载荷；外部仍返回相同rows结构。
 const result=await pool.query("SELECT COALESCE(jsonb_agg(to_jsonb(state_rows)),'[]'::jsonb) AS items FROM (SELECT w.id AS workflow_id,w.workflow_kind,w.source_workflow_id,EXISTS(SELECT 1 FROM ai_distill.question_library_sources qls WHERE qls.workflow_id=w.id) AS library_source,s.ordinal,s.status,s.error,s.started_at,s.finished_at,CASE WHEN s.ordinal=4 THEN jsonb_build_object('content_contract',s.result->'content_contract','content_status',s.result->'content_status','task_requirements',s.result->'task_requirements') WHEN s.ordinal=7 THEN jsonb_build_object('decision',s.result->'decision','model_scores',s.result->'model_scores','aggregate',s.result->'aggregate','reasons',s.result->'reasons') WHEN s.ordinal=6 THEN jsonb_build_object('models',(SELECT COALESCE(jsonb_agg(jsonb_build_object('model_id',m->'model_id','name',m->'name','answer_status',m->'answer_status','score_status',m->'score_status','score_contract',m->'score_contract','score',m->'score','max_score',m->'max_score','raw_score',m->'raw_score','full_score',m->'full_score','evaluation_percent',m->'evaluation_percent','veto_triggered',m->'veto_triggered','valid',m->'valid')),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.result->'models')='array' THEN s.result->'models' ELSE '[]'::jsonb END) m)) WHEN s.ordinal=5 THEN jsonb_build_object('models',(SELECT COALESCE(jsonb_agg(jsonb_build_object('model_id',m->'model_id','name',m->'name','status',m->'status','attempt_id',m->'attempt_id')),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.result->'models')='array' THEN s.result->'models' ELSE '[]'::jsonb END) m)) ELSE NULL END AS result,s.implemented,s.enabled,\n   EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.deleted_at IS NULL AND (lower(m.original_name) LIKE '%.pdf' OR lower(m.original_name) LIKE '%.docx')) AS has_pdf,\n   (SELECT x.status FROM ai_distill.steps x WHERE x.workflow_id=w.id AND x.ordinal=2) AS extraction_status,\n   (SELECT x.error FROM ai_distill.steps x WHERE x.workflow_id=w.id AND x.ordinal=2) AS extraction_error,\n   (SELECT x.started_at FROM ai_distill.steps x WHERE x.workflow_id=w.id AND x.ordinal=2) AS extraction_started_at,\n   (SELECT x.finished_at FROM ai_distill.steps x WHERE x.workflow_id=w.id AND x.ordinal=2) AS extraction_finished_at,\n   EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.workflow_id=w.id AND a.status IN ('waiting','running') AND ((s.ordinal=1 AND (a.ordinal=1 OR (a.ordinal=2 AND EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.deleted_at IS NULL AND (lower(m.original_name) LIKE '%.pdf' OR lower(m.original_name) LIKE '%.docx'))))) OR (s.ordinal<>1 AND a.ordinal=s.ordinal))) AS active\n   FROM ai_distill.workflows w JOIN ai_distill.steps s ON s.workflow_id=w.id\n   WHERE w.project_id=$1 AND w.deleted_at IS NULL AND s.ordinal NOT IN (2,3,10) AND ($2::uuid[] IS NULL OR w.id=ANY($2::uuid[])) ORDER BY w.id,s.display_position) state_rows",[projectId,workflowIds??null]);
 const rows:(WorkflowStepState&Record<string,any>)[]=result.rows[0]?.items??[];
 return{...result,rows,rowCount:rows.length};
}
export async function validateFolder(value: unknown, label = '材料文件夹') {
 const path = text(value, label, 4096);
 try { const actual = await realpath(resolveRepositoryPath(path)); if (!(await stat(actual)).isDirectory()) throw new Error('not directory'); return actual; }
 catch { throw new HTTPException(400, { message: `${label}不存在或无法读取` }); }
}
export async function scanProjectFolder(root: string): Promise<QuestionFolder[]> {
 try {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some(entry => entry.isFile() && supportedDocument.test(entry.name))) throw new HTTPException(400, { message: '请将材料放入每道题目的子文件夹，项目根目录不能直接放文件' });
  const questions: QuestionFolder[] = [];
  for (const entry of entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).sort((a,b) => a.name.localeCompare(b.name, 'zh-CN'))) {
   questions.push(await scanQuestionFolder(root, entry.name));
  }
  return questions;
 } catch (error) { if (error instanceof HTTPException) throw error; throw new HTTPException(400, { message: '材料文件夹读取失败，请检查访问权限' }); }
}
export async function scanQuestionFolder(root: string, key: string): Promise<QuestionFolder> {
 const files: FolderFile[] = [];
 let hasSplitPdf=false;
 async function visit(directory: string, prefix = '') {
  for (const child of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'zh-CN'))) {
   const name = prefix + child.name; const path = join(directory, child.name);
   if (child.isDirectory() && !child.name.startsWith('.')) await visit(path, `${name}/`);
   else if (child.isFile() && supportedDocument.test(child.name)) {
    const info = await stat(path);
    const bytes = await readFile(path);
    if(/\.pdf$/i.test(child.name)){
     const splitName=child.name.match(/^(.*)-页\d{4,}-\d{4,}\.pdf$/i);
     const parts=await splitLargePdf(path,bytes);
     if(parts.some(part=>part.path!==path)||splitName)hasSplitPdf=true;
     const splitFrom=splitName?join(directory,`${splitName[1]}.pdf`):path;
     for(const part of parts){
      const partBytes=await readFile(part.path);
      files.push({name:`${name.slice(0,-child.name.length)}${part.name}`,path:part.path,size:partBytes.length,sha256:createHash('sha256').update(partBytes).digest('hex'),...(part.path!==path?{split_from:splitFrom}:splitName?{split_from:splitFrom}:{})});
     }
    }else{
     if(info.size>MAX_FILE)throw new HTTPException(400,{message:`题目「${key}」的非PDF材料超过单文件限制`});
     const splitName=child.name.match(/^(.*)-页\d{4,}-\d{4,}\.pdf$/i);
     if(splitName)hasSplitPdf=true;
     files.push({ name, path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),...(splitName?{split_from:join(directory,`${splitName[1]}.pdf`)}:{}) });
    }
   }
  }
 }
 try { await visit(join(root, key)); }
 catch (error) { if (error instanceof HTTPException) throw error; throw new HTTPException(409, { message: `题目「${key}」目录不存在或无法读取，请检查目录后重试` }); }
 const batchLimit=hasSplitPdf?MAX_FOLDER_BATCH:MAX_BATCH;
 const currentFiles=[...new Map(files.map(file=>[file.name,file])).values()];
 if (currentFiles.length > 100 || currentFiles.reduce((sum, file) => sum + file.size, 0) > batchLimit) throw new HTTPException(400, { message: `题目「${key}」的材料超过100份或${batchLimit/1024/1024}MB限制` });
 currentFiles.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
 return { key, files:currentFiles };
}
export async function registerQuestionFolders(db: PoolClient, projectId: string, projectName: string, questions: QuestionFolder[], mode:'question_folders'|'material_packages'='question_folders') {
 const rows=await db.query("SELECT id,source_key,source_manifest,deleted_at,workflow_kind FROM ai_distill.workflows WHERE project_id=$1 AND source_key IS NOT NULL FOR UPDATE",[projectId]);
 const existingByKey=new Map(rows.rows.map(row=>[row.source_key,row]));
 const added:{id:string;request_id:string;title:string;source_key:string;source_manifest:FolderFile[]}[]=[];
 const changed:{id:string;source_manifest:FolderFile[]}[]=[];
 const signature=(files:FolderFile[])=>JSON.stringify(files.map(file=>[file.name,file.path,file.size,file.sha256]));
 for(const question of questions){
  const existing=existingByKey.get(question.key);
  if(!existing) added.push({id:crypto.randomUUID(),request_id:crypto.randomUUID(),title:`${projectName}-${question.key}`,source_key:question.key,source_manifest:question.files});
  else if(!existing.deleted_at&&existing.workflow_kind!==(mode==='material_packages'?'material_package':'question'))throw new HTTPException(409,{message:'来源目录已绑定另一种工作流，请先处理旧题目'});
  else if(!existing.deleted_at && signature(existing.source_manifest)!==signature(question.files)) changed.push({id:existing.id,source_manifest:question.files});
 }
 if(added.length){
  await db.query(`INSERT INTO ai_distill.workflows(id,project_id,request_id,title,source_key,source_manifest,workflow_kind)
   SELECT r.id,$1,r.request_id,r.title,r.source_key,r.source_manifest,$3 FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,request_id uuid,title text,source_key text,source_manifest jsonb)`,[projectId,JSON.stringify(added),mode==='material_packages'?'material_package':'question']);
  for(const workflow of added)for(const stage of STEP_REGISTRY){
   const status=stage.ordinal===2&&!workflow.source_manifest.some(file=>/\.pdf$/i.test(file.name))?'skipped':'waiting';
   await db.query('INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,step_key,display_position,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[workflow.id,stage.ordinal,stage.name,status,stage.defaultEnabled,stage.key,stage.position,stage.defaultEnabled]);
  }
 }
 if(changed.length){
  const ids=changed.map(row=>row.id);
  await db.query("UPDATE ai_distill.workflows w SET source_manifest=r.source_manifest,status='waiting'\n   FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,source_manifest jsonb) WHERE w.id=r.id",[JSON.stringify(changed)]);
  for(const id of ids){
   await invalidateMaterialResults(db,id);
   await db.query('UPDATE ai_distill.materials SET deleted_at=now() WHERE workflow_id=$1 AND deleted_at IS NULL',[id]);
  }
 }
 return {discovered:questions.length,added:added.length,changed:changed.length};
}
export type AnswerStepConfig=ModelApiConfig&{prompt:string;workflow?:WorkflowConfig};
export type AuthoringStepConfig={provider:'codex';model:string;reasoning_effort:string;prompt:string;timeout_ms?:number;material_source_mode?:'redacted'|'original';material_processing_mode?:MaterialProcessingMode;workflow?:WorkflowConfig};
export type ScoringStepConfig=AuthoringStepConfig|{provider:'api';api:ModelApiConfig;prompt:string;workflow?:WorkflowConfig};
export function validateStepConfig(ordinal:9,raw:unknown,modelCatalog?:Parameters<typeof validateAgentModel>[2]):RedactionConfig;
export function validateStepConfig(ordinal:4,raw:unknown,modelCatalog?:Parameters<typeof validateAgentModel>[2]):AuthoringStepConfig;
export function validateStepConfig(ordinal:6,raw:unknown,modelCatalog?:Parameters<typeof validateAgentModel>[2]):ScoringStepConfig;
export function validateStepConfig(ordinal:5,raw:unknown,modelCatalog?:Parameters<typeof validateAgentModel>[2]):AnswerStepConfig;
export function validateStepConfig(ordinal:7,raw:unknown,modelCatalog?:Parameters<typeof validateAgentModel>[2]):ReturnType<typeof validateAcceptancePolicy>;
export function validateStepConfig(ordinal:number,raw:unknown,modelCatalog?:Parameters<typeof validateAgentModel>[2]):object;
export function validateStepConfig(ordinal: number, raw: unknown, modelCatalog?:Parameters<typeof validateAgentModel>[2]):object {
 return validateStepConfigInternal(ordinal,raw,modelCatalog,true);
}
/** Validate persisted author/reviewer settings for execution without treating a cached model list as an execution allowlist. */
export function validateStepConfigForExecution(ordinal:4,raw:unknown):AuthoringStepConfig;
export function validateStepConfigForExecution(ordinal:6,raw:unknown):ScoringStepConfig;
export function validateStepConfigForExecution(ordinal:4|6,raw:unknown):AuthoringStepConfig|ScoringStepConfig {
 return validateStepConfigInternal(ordinal,raw,undefined,false) as AuthoringStepConfig|ScoringStepConfig;
}
function validateStepConfigInternal(ordinal:number,raw:unknown,modelCatalog:Parameters<typeof validateAgentModel>[2]|undefined,validateAdvertisedModel:boolean) {
 if (![4,5,6,7,9].includes(ordinal)) throw new HTTPException(400, { message: '此步骤没有模型设置' });
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HTTPException(400, { message: '步骤设置须为JSON对象' });
 if(ordinal===5){try{const {workflow:rawWorkflow,prompt:rawPrompt,...provider}=raw as Record<string,unknown>;const workflow=validateWorkflowConfig(rawWorkflow);const prompt=rawPrompt??SYSTEM_STEP_PROMPTS[5];if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)throw new Error('请填写有效的步骤提示词');return {...resolveAnswerConfig(provider),prompt,...(workflow?{workflow}:{})};}catch(error){if(error instanceof QwenError||error instanceof DomesticError||error instanceof Error&&['项目流程配置格式无效','请填写有效的步骤提示词'].includes(error.message))throw new HTTPException(400,{message:error.message});throw error;}}
 if(ordinal===7)return validateAcceptancePolicy(raw);
 if(ordinal===9)return validateRedactionConfig(raw,modelCatalog);
 const value = raw as Record<string,unknown>;
 let workflow:WorkflowConfig|undefined;try{workflow=validateWorkflowConfig(value.workflow);}catch(error){throw new HTTPException(400,{message:error instanceof Error?error.message:'项目流程配置格式无效'});}
 let materialProcessingMode:MaterialProcessingMode|undefined;
 if(ordinal===4){
  if(value.material_source_mode!==undefined&&!['redacted','original'].includes(String(value.material_source_mode)))throw new HTTPException(400,{message:'出题材料版本设置无效'});
  try{materialProcessingMode=resolveMaterialProcessingMode(value);}catch{throw new HTTPException(400,{message:'材料处理模式无效'});}
  if(value.material_processing_mode!==undefined&&value.material_source_mode!==undefined&&value.material_source_mode!==materialProcessingSourceMode(materialProcessingMode))throw new HTTPException(400,{message:'材料处理模式与来源版本不一致'});
 }
 const extension={...(workflow?{workflow}:{}),...(materialProcessingMode?{material_processing_mode:materialProcessingMode,material_source_mode:materialProcessingSourceMode(materialProcessingMode)}:{})};
 if(ordinal===6&&value.provider==='api'){
  if(Object.keys(value).some(key=>!['provider','api','prompt','workflow'].includes(key))||!value.api||typeof value.api!=='object'||Array.isArray(value.api))throw new HTTPException(400,{message:'评分API设置格式无效'});
  let api:ModelApiConfig;try{api=resolveModelApiConfig(value.api);}catch(error){throw new HTTPException(400,{message:error instanceof Error?error.message:'评分API设置无效'});}
  const prompt=value.prompt??SYSTEM_STEP_PROMPTS[6];
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)throw new HTTPException(400,{message:'请填写有效的步骤提示词'});
  return{provider:'api',api,prompt,...extension};
 }
 const provider = 'codex';
 if (value.provider !== undefined && value.provider !== provider) throw new HTTPException(400, { message: `此步骤使用${provider}` });
 const model = text(value.model, '模型ID', 160);
 const effort = text(value.reasoning_effort ?? 'medium', '推理强度', 20);
 if(provider==='codex'&&validateAdvertisedModel)validateAgentModel(model,effort,modelCatalog);
 const prompt=value.prompt??SYSTEM_STEP_PROMPTS[ordinal as 4|6];
 if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)throw new HTTPException(400,{message:'请填写有效的步骤提示词'});
 const timeout=value.timeout_ms;
 if(ordinal===4&&timeout!==undefined&&(!Number.isInteger(timeout)||Number(timeout)<60000||Number(timeout)>7200000))throw new HTTPException(400,{message:'出题超时须为 1 至 120 分钟的毫秒数'});
 return { provider, model, reasoning_effort: effort, prompt, ...(ordinal===4&&timeout!==undefined?{timeout_ms:timeout as number}:{}), ...extension };
}
function defaultAnswerConfig(){try{return resolveQwenConfig({});}catch{return {provider:'qwen'};}}
export async function projectStepSummary(pool: Pool, projectId: string, materialBackend:'legacy'|'library_v1'|Promise<'legacy'|'library_v1'>='legacy',preloadedRows?:ReturnType<typeof readProjectWorkflowStepRows>,preloadedCodexSettings?:ReturnType<typeof readProjectAgentSettings>,preloadedConfigs?:{rows:{ordinal:number;config:any}[]}|Promise<{rows:{ordinal:number;config:any}[]}>) {
 const [rows,configs,codexSettings,resolvedMaterialBackend]=await Promise.all([
  preloadedRows??readProjectWorkflowStepRows(pool,projectId),
  preloadedConfigs??pool.query('SELECT ordinal,config FROM ai_distill.project_step_configs WHERE project_id=$1 ORDER BY ordinal',[projectId]),
  preloadedCodexSettings??readProjectAgentSettings(pool,projectId),
  materialBackend,
 ]);
 const visible=getWorkflowStepDefinitions(resolvedMaterialBackend);
 const totals=new Map<number,Record<string,number>>();
 for(const stage of visible)totals.set(stage.ordinal,{total:0,ready:0,queued:0,running:0,succeeded:0,failed:0,needs_repair:0,quarantined:0});
 const workflowRows=new Map<string,Map<number,WorkflowStepState>>();
 for(const row of rows.rows){if(!workflowRows.has(row.workflow_id))workflowRows.set(row.workflow_id,new Map());workflowRows.get(row.workflow_id)!.set(row.ordinal,{ordinal:row.ordinal,status:row.status,result:row.result,enabled:Boolean(row.enabled),active:Boolean(row.active),has_pdf:Boolean(row.has_pdf),extraction_status:row.extraction_status,workflow_kind:row.workflow_kind,source_workflow_id:row.source_workflow_id,library_source:Boolean(row.library_source)});}
 for(const [,steps] of workflowRows){
  for(const stage of visible){
   const row=steps.get(stage.ordinal);if(!row||row.workflow_kind==='material_package'&&![1,9].includes(stage.ordinal)||row.source_workflow_id&&[1,9].includes(stage.ordinal)||row.library_source&&[1,2,9].includes(stage.ordinal))continue;
   const status=stage.ordinal===1&&row.has_pdf?row.extraction_status??row.status:row.status;
   const values=totals.get(stage.ordinal)!;values.total++;
   if(stage.ordinal===7&&status==='succeeded'){
    if(row.result?.decision==='repair')values.needs_repair++;
    else if(row.result?.decision==='quarantine')values.quarantined++;
    else if(row.result?.decision==='accepted')values.succeeded++;
   }else if(status&&status in values)values[status]++;
   if(row.active&&status==='waiting')values.queued++;
   if(isWorkflowStepReady(stage.ordinal,steps))values.ready++;
  }
 }
 return visible.map(stage=>{
  const stored=configs.rows.find(row=>row.ordinal===stage.ordinal)?.config;
  const isCodex=[4,6,9].includes(stage.ordinal);
  const explicit=Boolean(stored&&(stored.provider==='api'||typeof stored.model==='string'&&typeof stored.reasoning_effort==='string'));
  const defaults={model:codexSettings.model,reasoning_effort:codexSettings.reasoning_effort};
  const config=stage.ordinal===9?mergeRedactionDefaults({...stored,prompt:typeof stored?.prompt==='string'?stored.prompt:SYSTEM_STEP_PROMPTS[9]},defaults):stage.ordinal===5?{...defaultAnswerConfig(),...stored,prompt:typeof stored?.prompt==='string'?stored.prompt:SYSTEM_STEP_PROMPTS[5]}:isCodex?{
   ...(stage.ordinal===6&&stored?.provider==='api'?{...stored,prompt:typeof stored.prompt==='string'?stored.prompt:SYSTEM_STEP_PROMPTS[6]}:{provider:'codex',...mergeCodexDefaults({prompt:SYSTEM_STEP_PROMPTS[stage.ordinal as 4|6],...(stored??{})},defaults)}),
  }:stored??{};
  const hasProjectPrompt=typeof stored?.prompt==='string';
  return{ordinal:stage.ordinal,position:stage.position,name:stage.name,key:stage.key,implemented:stage.defaultEnabled,...totals.get(stage.ordinal),config,...(isCodex?{config_source:explicit?'step':hasProjectPrompt?'project':stage.ordinal===9&&config.provider==='api'?'system':codexSettings.source}:{})};
 });
}
