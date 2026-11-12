/** 验证材料库网页Agent设置的请求校验、执行器选择及脱敏/整理入队冻结；用SQL替身与临时本机队列，不连接PG、不启动浏览器或模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import {validateLibraryJobRequest,chooseLibraryExecutor,enqueueLibraryJob} from './jobs';
import {enqueuePreparation,resumePreparation} from './preparation';
import {saveLibraryProcessingSettings} from './settings';
import {localQueue,withLocalQueueRoot} from '../execution-queue/runtime';
import {hash} from './execution-shared';

const key='123e4567-e89b-42d3-a456-426614174000',extraction='123e4567-e89b-42d3-a456-426614174001';
const redact={kind:'redact',request_key:key,execution_target:'local',extraction_job_id:extraction};
const apiSettings={provider:'siliconflow',base_url:'https://api.siliconflow.com/v1',model:'deepseek-ai/DeepSeek-V4.1-Flash'};
const status=(run:()=>unknown)=>{try{run();}catch(error){return error instanceof HTTPException?error.status:'other';}return 'none';};

test('web_settings is redact-only, validated and mutually exclusive with agent/api settings',()=>{
 expect(validateLibraryJobRequest({...redact,web_settings:{provider:'deepseek',thinking:true,model_label:' 专家 '}}).web_settings).toEqual({provider:'deepseek',thinking:true,model_label:'专家'});
 expect(validateLibraryJobRequest({...redact,web_settings:{provider:'gemini'}}).web_settings).toEqual({provider:'gemini'});
 expect(validateLibraryJobRequest(redact).web_settings).toBeUndefined();
 expect(status(()=>validateLibraryJobRequest({...redact,web_settings:{provider:'gemini'},agent_settings:{model:'gpt-6-luna',reasoning_effort:'high'}}))).toBe(400);
 expect(status(()=>validateLibraryJobRequest({...redact,web_settings:{provider:'gemini'},api_settings:apiSettings}))).toBe(400);
 expect(status(()=>validateLibraryJobRequest({kind:'extract',request_key:key,execution_target:'local',web_settings:{provider:'gemini'}}))).toBe(400);
 expect(status(()=>validateLibraryJobRequest({kind:'intake',request_key:key,execution_target:'local',web_settings:{provider:'gemini'}}))).toBe(400);
 for(const bad of [{provider:'chatgpt'},{provider:'gemini',thinking:'yes'},{provider:'gemini',extra:1},{provider:'gemini',model_label:''},'gemini',[],null])expect(status(()=>validateLibraryJobRequest({...redact,web_settings:bad}))).toBe(400);
});

test('chooseLibraryExecutor routes frozen web redaction to the web lane and refuses the server target',()=>{
 expect(chooseLibraryExecutor('redact',[{format:'docx',redaction_mode:'model'}],{provider:'web'})).toBe('web');
 expect(chooseLibraryExecutor('redact',[{format:'docx'}],{provider:'web'},'local')).toBe('web');
 expect(status(()=>chooseLibraryExecutor('redact',[{format:'docx'}],{provider:'web'},'server'))).toBe(409);
 expect(chooseLibraryExecutor('redact',[{format:'docx'}],{provider:'api'})).toBe('api');expect(chooseLibraryExecutor('redact',[{format:'docx'}],{provider:'codex'})).toBe('agent');
 expect(chooseLibraryExecutor('extract',[{format:'pdf'}],{provider:'web'})).toBe('api');expect(chooseLibraryExecutor('intake',[],{provider:'web'})).toBe('internal');
});

async function withTemporaryLocalQueue<T>(run:(root:string)=>Promise<T>){
 const root=await mkdtemp(join(tmpdir(),'library-web-')),before=process.env.EXECUTION_QUEUE_MODE;
 try{process.env.EXECUTION_QUEUE_MODE='local';return await withLocalQueueRoot(root,()=>run(root));}
 finally{try{localQueue(root).close();}catch{/* 队列可能未创建 */}if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;await rm(root,{recursive:true,force:true});}
}

test('web redaction enqueue freezes web settings, uses lane web and registers a web dispatch',()=>withTemporaryLocalQueue(async root=>{
 const settings={version:1,extraction:{protocol:'v1',provider_config:{}},redaction:{provider:'codex',model:'gpt-6-luna',reasoning_effort:'high',prompt:'合成模板'},execution:{task_timeout_ms:1200000,request_timeout_ms:1000},policy:{preserve_dates:true,preserve_amounts:true}};
 saveLibraryProcessingSettings(root,0,settings);
 let frozen:any,input:any,lane:unknown,dispatchLane:unknown,defaultsRead=false;const executorId=localQueue(root).executorId;
 const query=async(sql:string,v:any[]=[])=>{
  if(sql.startsWith('SELECT id,processing_settings'))return{rows:[{id:'package'}]};
  if(sql.startsWith('SELECT id,package_id,state'))return{rows:[{id:'revision',package_id:'package',state:'ready',manifest_sha256:'hash',file_count:1}]};
  if(sql.startsWith('SELECT f.id'))return{rows:[{id:'file',original_name:'synthetic.txt',storage_target:'local',position:1,sha256:'hash',size_bytes:1}]};
  if(sql.startsWith('SELECT id,status,input_digest'))return{rows:[{id:'extraction',status:'succeeded'}]};
  if(sql.startsWith('SELECT d.id AS document_id'))return{rows:[{document_id:'doc',file_id:'file',source_sha256:'hash',document_sha256:'doc-hash',text_sha256:'text-hash',page_count:1,issues:[]}]};
  if(sql.includes('agent_defaults'))defaultsRead=true;
  if(sql.startsWith('INSERT INTO ai_distill.library_jobs')){frozen=JSON.parse(v[9]);input=JSON.parse(v[7]);lane=v[10];return{rows:[{id:'job',executor_kind:v[10]}]};}
  if(sql.startsWith('INSERT INTO ai_distill.execution_dispatches')){dispatchLane=v[3];return{rows:[{executor_id:executorId}]};}
  return{rows:[],rowCount:0};
 };
 const request={kind:'redact',extraction_job_id:'11111111-1111-4111-8111-111111111111',request_key:'22222222-2222-4222-8222-222222222222',execution_target:'local'};
 const result=await enqueueLibraryJob({connect:async()=>({query,release(){}})} as any,'package','revision',{...request,web_settings:{provider:'deepseek',thinking:true}},root);
 expect(result.executor_kind).toBe('web');expect(lane).toBe('web');expect(dispatchLane).toBe('web');
 expect(frozen.settings.redaction).toMatchObject({provider:'web',web:{provider:'deepseek',thinking:true}});expect(typeof frozen.settings.redaction.prompt).toBe('string');
 expect(frozen.settings.redaction.model).toBeUndefined();expect(frozen.redaction_template.workflow).toBe('codex_plan');expect(input.web_settings).toEqual({provider:'deepseek',thinking:true});expect(defaultsRead).toBe(false);
 expect(frozen.settings.execution.task_timeout_ms).toBe(1200000);
 // 服务器执行目标：web与server文件集合均被拒绝（本机目标限制）。
 await expect(enqueueLibraryJob({connect:async()=>({query,release(){}})} as any,'package','revision',{...request,request_key:'33333333-3333-4333-8333-333333333333',execution_target:'server',web_settings:{provider:'gemini'}},root)).rejects.toMatchObject({status:409});
}));

test('web redaction enqueue is rejected when the local execution queue is not enabled',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-web-legacy-')),before=process.env.EXECUTION_QUEUE_MODE;
 try{
  process.env.EXECUTION_QUEUE_MODE='legacy';
  saveLibraryProcessingSettings(root,0,{version:1,extraction:{protocol:'v1',provider_config:{}},redaction:{provider:'codex',model:'gpt-6-luna',reasoning_effort:'high',prompt:'合成模板'},execution:{task_timeout_ms:1200000,request_timeout_ms:1000},policy:{preserve_dates:true,preserve_amounts:true}});
  let inserted=false;
  const query=async(sql:string)=>{
   if(sql.startsWith('SELECT id,processing_settings'))return{rows:[{id:'package'}]};
   if(sql.startsWith('SELECT id,package_id,state'))return{rows:[{id:'revision',package_id:'package',state:'ready',manifest_sha256:'hash',file_count:1}]};
   if(sql.startsWith('SELECT f.id'))return{rows:[{id:'file',original_name:'synthetic.txt',storage_target:'local',position:1,sha256:'hash',size_bytes:1}]};
   if(sql.startsWith('INSERT INTO ai_distill.library_jobs'))inserted=true;
   return{rows:[],rowCount:0};
  };
  await expect(enqueueLibraryJob({connect:async()=>({query,release(){}})} as any,'package','revision',{...redact,web_settings:{provider:'gemini'}},root)).rejects.toMatchObject({status:409});
  expect(inserted).toBe(false);
 }finally{if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;await rm(root,{recursive:true,force:true});}
});

test('material preparation freezes web settings in lane web, rejects mixed settings and resume inherits web',()=>withTemporaryLocalQueue(async root=>{
 const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222',source=JSON.stringify({prepared_documents:[{id:'source',title:'材料',text:'正文'}]});
 const jobs:any[]=[];let dispatchLane:unknown;const executorId=localQueue(root).executorId;
 const db={query:async(sql:string,values:any[]=[])=>{
  if(sql.includes("to_regclass('ai_distill.library_preparations')"))return{rows:[{available:true}]};
  if(sql.includes('SELECT r.package_id'))return{rows:[{package_id:id,revision_id:revision,extraction_job_id:'extract',output_digest:'digest',text_content:source,sha256:hash(source)}]};
  if(sql.includes("WHERE id=$1 AND kind='prepare'"))return{rows:jobs.filter(job=>job.id===values[0])};
  if(sql.includes('SELECT status,input_snapshot'))return{rows:jobs.filter(job=>job.id===values[0])};
  if(sql.includes('WHERE package_id=$1 AND request_key=$2'))return{rows:jobs.filter(job=>job.request_key===values[1])};
  if(sql.includes("j.status IN ('queued','running','succeeded')"))return{rows:[]};
  if(sql.includes('SELECT id FROM ai_distill.library_packages'))return{rows:[{id}]};
  if(sql.startsWith('INSERT INTO ai_distill.library_jobs'))jobs.push({id:values[0],revision_id:values[2],request_key:values[3],status:'queued',input_snapshot:JSON.parse(values[5]),config_snapshot:JSON.parse(values[7]),executor_kind:values[8],previous_job_id:values[9]});
  if(sql.startsWith('INSERT INTO ai_distill.execution_dispatches')){dispatchLane=values[3];return{rows:[{executor_id:executorId}]};}
  return{rows:[],rowCount:1};
 },release:()=>{}};
 const pool={query:db.query,connect:async()=>db} as any,web={provider:'gemini',model_label:'Pro'};
 const first=await enqueuePreparation(pool,root,revision,{request_key:id,redaction_id:id,web_settings:web});
 expect(first.reused).toBe(false);expect(jobs[0].executor_kind).toBe('web');expect(dispatchLane).toBe('web');
 expect(jobs[0].config_snapshot.web).toEqual(web);expect(jobs[0].config_snapshot.agent).toBeUndefined();expect(jobs[0].config_snapshot.api).toBeUndefined();expect(jobs[0].config_snapshot.settings.execution.task_timeout_ms).toBe(1800000);
 expect((await enqueuePreparation(pool,root,revision,{request_key:id,redaction_id:id,web_settings:web})).id).toBe(first.id);expect(jobs).toHaveLength(1);
 await expect(enqueuePreparation(pool,root,revision,{request_key:'33333333-3333-4333-8333-333333333333',redaction_id:id,web_settings:web,api_settings:apiSettings})).rejects.toThrow('不能同时指定');
 await expect(enqueuePreparation(pool,root,revision,{request_key:'33333333-3333-4333-8333-333333333333',redaction_id:id,web_settings:web,agent_settings:{model:'gpt-6-luna',reasoning_effort:'high'}})).rejects.toThrow('不能同时指定');
 await expect(enqueuePreparation(pool,root,revision,{request_key:'33333333-3333-4333-8333-333333333333',redaction_id:id,web_settings:{provider:'chatgpt'}})).rejects.toMatchObject({status:400});
 jobs[0].status='cancelled';
 const next=await resumePreparation(pool,root,first.id,{request_key:'44444444-4444-4444-8444-444444444444'});
 expect(next.reused).toBe(false);expect(jobs[1].executor_kind).toBe('web');expect(jobs[1].config_snapshot.web).toEqual(web);expect(jobs[1].previous_job_id).toBe(first.id);
}));
