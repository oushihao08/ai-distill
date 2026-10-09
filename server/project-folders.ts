import {validateCodexModel} from './codex/models';
import {readProjectCodexSettings} from './codex/system-config';
import { readdir, realpath, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { Pool, PoolClient } from 'pg';
import { DEFAULT_REDACTION_PROMPT, STEP_REGISTRY } from '../shared/step-registry';
import {resolveQwenConfig,QwenError} from './answer-models/qwen';
import {resolveAnswerConfig} from './answer-models/dispatch';
import {DomesticError} from './answer-models/domestic';
import {validateAcceptanceConfig} from './decisions/config';
import { text } from './validation';
export interface FolderFile { name: string; path: string; sha256: string; size: number }
export interface QuestionFolder { key: string; files: FolderFile[] }
const supportedDocument=/\.(pdf|docx|txt|md)$/i;
export async function validateFolder(value: unknown, label = '材料文件夹') {
 const path = text(value, label, 4096);
 if (!isAbsolute(path)) throw new HTTPException(400, { message: `${label}须为本机绝对路径` });
 try { const actual = await realpath(path); if (!(await stat(actual)).isDirectory()) throw new Error('not directory'); return actual; }
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
 async function visit(directory: string, prefix = '') {
  for (const child of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'zh-CN'))) {
   const name = prefix + child.name; const path = join(directory, child.name);
   if (child.isDirectory() && !child.name.startsWith('.')) await visit(path, `${name}/`);
   else if (child.isFile() && supportedDocument.test(child.name)) {
    const info = await stat(path);
    if (info.size > 30 * 1024 * 1024) throw new HTTPException(400, { message: '题目「'+key+'」的材料超过30MB限制' });
    const bytes = await readFile(path);
    files.push({ name, path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
   }
  }
 }
 try { await visit(join(root, key)); }
 catch (error) { if (error instanceof HTTPException) throw error; throw new HTTPException(409, { message: `题目「${key}」目录不存在或无法读取，请检查目录后重试` }); }
 if (files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) throw new HTTPException(400, { message: `题目「${key}」的材料超过100份或100MB限制` });
 files.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
 return { key, files };
}
export async function registerQuestionFolders(db: PoolClient, projectId: string, projectName: string, questions: QuestionFolder[]) {
 const rows=await db.query('SELECT id,source_key,input_revision,source_manifest,deleted_at FROM ai_distill.workflows WHERE project_id=$1 FOR UPDATE',[projectId]);
 const existingByKey=new Map(rows.rows.map(row=>[row.source_key,row]));
 const added:{id:string;request_id:string;title:string;source_key:string;source_manifest:FolderFile[]}[]=[];
 const changed:{id:string;source_manifest:FolderFile[]}[]=[];
 const signature=(files:FolderFile[])=>JSON.stringify(files.map(file=>[file.name,file.path,file.size,file.sha256]));
 for(const question of questions){
  const existing=existingByKey.get(question.key);
  if(!existing) added.push({id:crypto.randomUUID(),request_id:crypto.randomUUID(),title:`${projectName}-${question.key}`,source_key:question.key,source_manifest:question.files});
  else if(!existing.deleted_at && signature(existing.source_manifest)!==signature(question.files)) changed.push({id:existing.id,source_manifest:question.files});
 }
 if(added.length){
  await db.query(`INSERT INTO ai_distill.workflows(id,project_id,request_id,title,source_key,source_manifest)
   SELECT r.id,$1,r.request_id,r.title,r.source_key,r.source_manifest FROM jsonb_to_recordset($2::jsonb) AS r(id uuid,request_id uuid,title text,source_key text,source_manifest jsonb)`,[projectId,JSON.stringify(added)]);
  for(const workflow of added)for(const stage of STEP_REGISTRY){
   const status=stage.ordinal===2&&!workflow.source_manifest.some(file=>/\.pdf$/i.test(file.name))?'skipped':'waiting';
   await db.query('INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,step_key,display_position,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[workflow.id,stage.ordinal,stage.name,status,stage.defaultEnabled,stage.key,stage.position,stage.defaultEnabled]);
  }
 }
 if(changed.length){
  const ids=changed.map(row=>row.id);
  await db.query(`UPDATE ai_distill.workflows w SET source_manifest=r.source_manifest,input_revision=w.input_revision+1,status='waiting'
   FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,source_manifest jsonb) WHERE w.id=r.id`,[JSON.stringify(changed)]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='材料目录更新，任务失效',finished_at=now() WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running')",[ids]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=ANY($1::uuid[])",[ids]);
 }
 return {discovered:questions.length,added:added.length,changed:changed.length};
}
export function validateStepConfig(ordinal: number, raw: unknown) {
 if (![3,4,5,6,7,9].includes(ordinal)) throw new HTTPException(400, { message: '此步骤没有模型设置' });
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HTTPException(400, { message: '步骤设置须为JSON对象' });
 if(ordinal===5){try{return resolveAnswerConfig(raw);}catch(error){if(error instanceof QwenError||error instanceof DomesticError)throw new HTTPException(400,{message:error.message});throw error;}}
 if(ordinal===7)return validateAcceptanceConfig(raw);
 const value = raw as Record<string,unknown>;
 const provider = 'codex';
 if (value.provider !== undefined && value.provider !== provider) throw new HTTPException(400, { message: `此步骤使用${provider}` });
 const model = text(value.model, '模型ID', 160);
 const effort = text(value.reasoning_effort ?? 'medium', '推理强度', 20);
 if(ordinal===9){const prompt=text(value.prompt,'脱敏提示词',12000);validateCodexModel(model,effort);return{provider,model,reasoning_effort:effort,prompt};}
 if(provider==='codex')validateCodexModel(model,effort);
 return { provider, model, reasoning_effort: effort };
}
function defaultAnswerConfig(){try{return resolveQwenConfig({});}catch{return {provider:'qwen'};}}
export async function projectStepSummary(pool: Pool, projectId: string) {
 const visible=STEP_REGISTRY.filter(stage=>stage.visible);
 const [rows,configs,codexSettings]=await Promise.all([
  pool.query(`SELECT w.id AS workflow_id,w.input_revision,s.ordinal,s.status,s.implemented,s.enabled,
   EXISTS(SELECT 1 FROM ai_distill.materials m WHERE m.workflow_id=w.id AND m.input_revision=w.input_revision AND lower(m.original_name) LIKE '%.pdf') AS has_pdf,
   (SELECT x.status FROM ai_distill.steps x WHERE x.workflow_id=w.id AND x.ordinal=2) AS extraction_status,
   EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.workflow_id=w.id AND a.input_revision=w.input_revision AND a.ordinal IN (CASE WHEN s.ordinal=1 THEN 1 ELSE s.ordinal END,CASE WHEN s.ordinal=1 THEN 2 ELSE s.ordinal END) AND a.status IN ('waiting','running')) AS active
   FROM ai_distill.workflows w JOIN ai_distill.steps s ON s.workflow_id=w.id
   WHERE w.project_id=$1 AND w.deleted_at IS NULL AND s.ordinal NOT IN (2,3) ORDER BY w.id,s.display_position`,[projectId]),
  pool.query('SELECT ordinal,config FROM ai_distill.project_step_configs WHERE project_id=$1 ORDER BY ordinal',[projectId]),
  readProjectCodexSettings(pool,projectId),
 ]);
 const totals=new Map<number,Record<string,number>>();
 for(const stage of visible)totals.set(stage.ordinal,{total:0,ready:0,queued:0,running:0,succeeded:0,failed:0});
 const workflowRows=new Map<string,Map<number,any>>();
 for(const row of rows.rows){if(!workflowRows.has(row.workflow_id))workflowRows.set(row.workflow_id,new Map());workflowRows.get(row.workflow_id)!.set(row.ordinal,row);}
 for(const [,steps] of workflowRows){
  for(let index=0;index<visible.length;index++){
   const stage=visible[index]!,row=steps.get(stage.ordinal);if(!row)continue;
   const status=stage.ordinal===1&&row.has_pdf?row.extraction_status:row.status;
   const values=totals.get(stage.ordinal)!;values.total++;
   if(status in values)values[status]++;
   const queued=Boolean(row.active)&&status==='waiting';if(queued)values.queued++;
   const previous=index?visible[index-1]!:undefined;
   const previousRow=previous?steps.get(previous.ordinal):undefined;
   const previousStatus=previous?previous.ordinal===1&&previousRow?.has_pdf?previousRow.extraction_status:previousRow?.status:'succeeded';
   if((status==='waiting'||status==='failed')&&previousStatus==='succeeded'&&!row.active&&row.enabled)values.ready++;
  }
 }
 return visible.map(stage=>{
  const stored=configs.rows.find(row=>row.ordinal===stage.ordinal)?.config;
  const isCodex=[4,6,9].includes(stage.ordinal);
  const explicit=Boolean(stored&&typeof stored.model==='string'&&typeof stored.reasoning_effort==='string');
  const defaults={model:codexSettings.model,reasoning_effort:codexSettings.reasoning_effort};
  const config=stage.ordinal===5?stored??defaultAnswerConfig():isCodex?{
   provider:'codex',...(stage.ordinal===9?{prompt:DEFAULT_REDACTION_PROMPT}:{}),...defaults,...(stored??{}),
  }:stored??{};
  return{ordinal:stage.ordinal,position:stage.position,name:stage.name,key:stage.key,implemented:stage.defaultEnabled,...totals.get(stage.ordinal),config,...(isCodex?{config_source:explicit?'step':codexSettings.source}:{})};
 });
}
