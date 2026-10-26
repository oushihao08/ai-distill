/** 验证模板独立提示词、旧设置兼容、请求限定与摘要冻结；无真实模型或业务数据库写入。 */
import {test,expect} from 'bun:test';
import {resolveLibraryTemplate} from './templates';
import {validateProcessingSettings} from './service';
import {validateLibraryJobRequest} from './jobs';
import {libraryRedactionTemplates} from '../../shared/redaction-templates';
import {readProjectMaterialProcessingMode,projectRedactionTemplate} from './processing-policy';
import {withLocalQueueRoot} from '../execution-queue/runtime';
const settings=()=>({version:1,extraction:{protocol:'v1',provider_config:{}},redaction:{provider:'codex',model:'existing',reasoning_effort:'medium',prompt:'原有提示词'},execution:{task_timeout_ms:1000,request_timeout_ms:1000},policy:{preserve_dates:true,preserve_amounts:true}});
test('模板仅提供Agent化名，旧mask不存在且不回退',()=>{
 const s=settings(),alias=resolveLibraryTemplate(s);
 expect(libraryRedactionTemplates(s).map(t=>t.id)).toEqual(['aliases']);
 expect(alias.workflow).toBe('codex_plan');
 expect(()=>resolveLibraryTemplate(s,'mask')).toThrow('不存在');
 s.redaction.prompt='旧配置变更';expect(resolveLibraryTemplate(s).digest).toBe(alias.digest);
});
test('允许多个独立模板，拒绝未知/重复身份和错误执行流程',()=>{
 const s={...settings(),redaction_templates:[resolveLibraryTemplate(settings(),'aliases')]};
 const t:any=s.redaction_templates[0];delete t.digest;
 expect(()=>validateProcessingSettings(s)).not.toThrow();expect(()=>resolveLibraryTemplate(s,'missing')).toThrow('不存在');
 expect(()=>validateProcessingSettings({...s,redaction_templates:[t,t]})).toThrow('身份');
 expect(()=>validateProcessingSettings({...s,redaction_templates:[{...t,redaction:{provider:'api',prompt:'错误'}}]})).toThrow('Codex');
});
test('模板参数只用于脱敏任务；旧请求形状不变',()=>{
 const base={kind:'redact',execution_target:'local',request_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',extraction_job_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'} as const;
 expect(validateLibraryJobRequest(base)).toEqual(base);expect(validateLibraryJobRequest({...base,template_id:'aliases'}).template_id).toBe('aliases');
 expect(()=>validateLibraryJobRequest({...base,kind:'extract',template_id:'mask'})).toThrow();expect(()=>validateLibraryJobRequest({...base,template_id:'../x'})).toThrow();
});

test('拒绝新字段映射任务；Agent模板自动入队并冻结数据库提示词与模型',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {saveLibraryProcessingSettings}=await import('./settings'),{enqueueLibraryJob}=await import('./jobs');
 const root=await mkdtemp(join(tmpdir(),'library-template-queue-'));const alias=resolveLibraryTemplate(settings(),'aliases');const s={...settings(),redaction_templates:[{id:'strict',name:'另一项目',workflow:'codex_plan',redaction:{provider:'codex',prompt:'独立规则'}},{id:alias.id,name:alias.name,workflow:alias.workflow,redaction:alias.redaction}]};saveLibraryProcessingSettings(root,0,s);
 let frozen:any;
 const query=async(sql:string,v:any[]=[])=>{
  if(sql.startsWith('SELECT id,processing_settings'))return{rows:[{id:'package'}]};
  if(sql.startsWith('SELECT id,package_id,state'))return{rows:[{state:'ready',manifest_sha256:'hash',file_count:1}]};
  if(sql.startsWith('SELECT f.id'))return{rows:[{id:'file',original_name:'a.txt',redaction_mode:'model',storage_target:'local',sha256:'source'}]};
  if(sql.startsWith('SELECT id,status,input_digest'))return{rows:[{id:'extraction',status:'succeeded'}]};
  if(sql.startsWith('SELECT d.id AS document_id'))return{rows:[{file_id:'file',source_sha256:'source',page_count:1,issues:[]}]};
  if(sql.startsWith('INSERT INTO ai_distill.library_jobs')){frozen=JSON.parse(v[9]);return{rows:[{id:'queued'}]};}
  if(sql.startsWith('INSERT INTO ai_distill.execution_dispatches'))return{rows:[{executor_id:v[2]}]};
  return{rows:[],rowCount:0};
 };
 const pool={connect:async()=>({query,release(){}})} as any;
 const enqueue=(body:unknown)=>withLocalQueueRoot(root,()=>enqueueLibraryJob(pool,'package','revision',body,root));
 const body={kind:'redact',execution_target:'local',request_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',extraction_job_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',template_id:'strict'};
 try{
  await expect(enqueue({...body,template_id:'mask'})).rejects.toThrow('不存在');
  expect(frozen).toBeUndefined();
  await enqueue(body);
  expect(frozen.settings.redaction.prompt).toBe('独立规则');
  expect(()=>saveLibraryProcessingSettings(root,1,{...s,redaction_templates:[{id:'old',name:'旧流程',workflow:'field_mapping',redaction:settings().redaction}]})).toThrow('流程无效');
  await expect(enqueue({...body,template_id:'aliases'})).resolves.toMatchObject({id:'queued'});
  expect(frozen.redaction_template.workflow).toBe('codex_plan');expect(frozen.settings.redaction.provider).toBe('codex');expect(frozen.settings.redaction.model).toBeTruthy();
  expect(frozen.settings.redaction.prompt).toBe(alias.redaction.prompt);
  await expect(enqueue({...body,template_id:'mask'})).rejects.toThrow('不存在');
 }finally{await rm(root,{recursive:true,force:true});}
});
import {resolveMaterialProcessingMode,materialProcessingSourceMode,redactionProcessingMode} from '../../shared/material-library';
test('persisted material processing mode defaults to aliases and retains original compatibility',()=>{
 expect(resolveMaterialProcessingMode()).toBe('aliases');
 expect(resolveMaterialProcessingMode({material_source_mode:'original'})).toBe('original');
 for(const mode of ['original','mask','aliases'] as const){expect(resolveMaterialProcessingMode({material_processing_mode:mode})).toBe(mode);expect(materialProcessingSourceMode(mode)).toBe(mode==='original'?'original':'redacted');}
 expect(()=>resolveMaterialProcessingMode({material_processing_mode:'unexpected'})).toThrow();
 expect(redactionProcessingMode({redaction_template_workflow:'codex_plan'})).toBe('aliases');
 expect(redactionProcessingMode({redaction_template_id:'aliases'})).toBe('aliases');
 expect(redactionProcessingMode({})).toBe('mask');
});
test('project job routing reads persisted mode and rejects prompt/template overrides',async()=>{
 const db={query:async()=>({rows:[{id:'phase',config:{material_processing_mode:'mask'}}]})} as any;
 expect(await readProjectMaterialProcessingMode(db,'phase')).toBe('mask');
 expect(()=>projectRedactionTemplate('mask')).toThrow('已退役');
 expect(projectRedactionTemplate('aliases')).toBe('aliases');
 expect(projectRedactionTemplate('aliases','custom-agent-template')).toBe('custom-agent-template');
 expect(()=>projectRedactionTemplate('original')).toThrow('无需派发脱敏');
 expect(()=>projectRedactionTemplate('mask','aliases')).toThrow('已退役');
});
test('project mode freezes real queue lane: API mask, Agent aliases, and no original redaction',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {saveLibraryProcessingSettings}=await import('./settings'),{enqueueLibraryJob}=await import('./jobs');
 const root=await mkdtemp(join(tmpdir(),'project-mode-lane-'));
 saveLibraryProcessingSettings(root,0,{...settings(),redaction:{provider:'api',api:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'fixture/model'},prompt:'遮挡规则'}});
 let mode:'original'|'mask'|'aliases'='mask',written:any;
 const query=async(sql:string,v:any[]=[])=>{
  if(sql.startsWith('SELECT id,processing_settings'))return{rows:[{id:'package'}]};
  if(sql.startsWith('SELECT id,package_id,state'))return{rows:[{state:'ready',manifest_sha256:'hash',file_count:1}]};
  if(sql.startsWith('SELECT f.id'))return{rows:[{id:'file',original_name:'a.txt',redaction_mode:'declared_redacted',storage_target:'local',sha256:'source'}]};
  if(sql.startsWith('SELECT p.id,c.config'))return{rows:[{id:'phase',config:{material_processing_mode:mode}}]};
  if(sql.startsWith('SELECT id,status,input_digest'))return{rows:[{id:'extraction',status:'succeeded'}]};
  if(sql.startsWith('SELECT d.id AS document_id'))return{rows:[{file_id:'file',source_sha256:'source',page_count:1,issues:[]}]};
  if(sql.startsWith('INSERT INTO ai_distill.library_jobs')){written={input:JSON.parse(v[7]),config:JSON.parse(v[9]),lane:v[10]};return{rows:[{id:'queued'}]};}
  if(sql.startsWith('INSERT INTO ai_distill.execution_dispatches'))return{rows:[{executor_id:v[2]}]};
  return{rows:[],rowCount:0};
 };
 const pool={connect:async()=>({query,release(){}})} as any;
 const enqueue=(body:unknown)=>withLocalQueueRoot(root,()=>enqueueLibraryJob(pool,'package','revision',body,root));
 const body={kind:'redact',execution_target:'local',request_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',extraction_job_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',project_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
 try{
  await expect(enqueue(body)).rejects.toThrow('已退役');expect(written).toBeUndefined();
  mode='aliases';await enqueue(body);expect(written).toMatchObject({lane:'agent',input:{material_processing_mode:'aliases'},config:{redaction_template:{id:'aliases'}}});
  mode='original';written=undefined;await expect(enqueue(body)).rejects.toThrow('无需派发脱敏');expect(written).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('旧材料库冻结任务在读取正文前拒绝执行，不回退到字段映射',async()=>{
 const {executeRedaction}=await import('./redaction-runner');
 let reads=0;
 const pool={query:async()=>{reads++;throw new Error('不应读取正文');}} as any;
 for(const template of [undefined,{workflow:'field_mapping'}]){
  await expect(executeRedaction(pool,'unused',{config_snapshot:{redaction_template:template}} as any,new AbortController().signal)).rejects.toThrow('已删除');
 }
 expect(reads).toBe(0);
});

test('读取历史共用设置排除已删除模板，但不回写旧配置',async()=>{
 const {mkdtemp,mkdir,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {Database}=await import('bun:sqlite'),{readLibraryProcessingSettings}=await import('./settings');
 const root=await mkdtemp(join(tmpdir(),'retired-template-settings-'));
 try{
  await mkdir(join(root,'material-library'));
  const db=new Database(join(root,'material-library','processing-settings.sqlite3'));
  try{
   db.exec('CREATE TABLE processing_settings(id INTEGER PRIMARY KEY,settings TEXT,version INTEGER,updated_at TEXT)');
   const historical={...settings(),redaction_templates:[{id:'aliases',name:'旧映射',workflow:'field_mapping',redaction:settings().redaction}]};
   db.query('INSERT INTO processing_settings VALUES(1,?,3,?)').run(JSON.stringify(historical),'fixture');
   const read=await readLibraryProcessingSettings({query:async()=>{throw new Error('不读取业务库');}} as any,root);
   expect((read.processing_settings.redaction_templates as any[]).map(t=>t.workflow)).toEqual(['codex_plan']);
   expect(read.lock_version).toBe(3);
   expect((db.query('SELECT settings FROM processing_settings').get() as {settings:string}).settings).toBe(JSON.stringify(historical));
  }finally{db.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});
