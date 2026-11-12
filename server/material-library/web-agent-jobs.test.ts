/** 验证材料库网页Agent边界：脱敏/提取/入库拒绝 web_settings，仅材料整理（prepare）允许冻结到 lane=web；用SQL替身与临时本机队列，不连接PG、不启动浏览器或模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import {validateLibraryJobRequest,chooseLibraryExecutor} from './jobs';
import {enqueuePreparation,resumePreparation} from './preparation';
import {localQueue,withLocalQueueRoot} from '../execution-queue/runtime';
import {hash} from './execution-shared';

const key='123e4567-e89b-42d3-a456-426614174000',extraction='123e4567-e89b-42d3-a456-426614174001';
const redact={kind:'redact',request_key:key,execution_target:'local',extraction_job_id:extraction};
const apiSettings={provider:'siliconflow',base_url:'https://api.siliconflow.com/v1',model:'deepseek-ai/DeepSeek-V4.1-Flash'};
const status=(run:()=>unknown)=>{try{run();}catch(error){return error instanceof HTTPException?error.status:'other';}return 'none';};

test('library job requests (intake/extract/redact) reject web_settings and chooseLibraryExecutor rejects provider=web on redact',()=>{
 expect(validateLibraryJobRequest(redact)).toMatchObject({kind:'redact',execution_target:'local'});
 expect(status(()=>validateLibraryJobRequest({...redact,web_settings:{provider:'deepseek'}}))).toBe(400);
 expect(status(()=>validateLibraryJobRequest({...redact,web_settings:{provider:'gemini'}}))).toBe(400);
 expect(status(()=>validateLibraryJobRequest({kind:'extract',request_key:key,execution_target:'local',web_settings:{provider:'deepseek'}}))).toBe(400);
 expect(status(()=>validateLibraryJobRequest({kind:'intake',request_key:key,execution_target:'local',web_settings:{provider:'deepseek'}}))).toBe(400);
 expect(status(()=>chooseLibraryExecutor('redact',[{format:'docx',redaction_mode:'model'}],{provider:'web'}))).toBe(409);
 expect(status(()=>chooseLibraryExecutor('redact',[{format:'docx'}],{provider:'web'},'local'))).toBe(409);
 expect(chooseLibraryExecutor('redact',[{format:'docx'}],{provider:'api'})).toBe('api');
 expect(chooseLibraryExecutor('redact',[{format:'docx'}],{provider:'codex'})).toBe('agent');
});

async function withTemporaryLocalQueue<T>(run:(root:string)=>Promise<T>){
 const root=await mkdtemp(join(tmpdir(),'library-web-')),before=process.env.EXECUTION_QUEUE_MODE;
 try{process.env.EXECUTION_QUEUE_MODE='local';return await withLocalQueueRoot(root,()=>run(root));}
 finally{try{localQueue(root).close();}catch{/* 队列可能未创建 */}if(before===undefined)delete process.env.EXECUTION_QUEUE_MODE;else process.env.EXECUTION_QUEUE_MODE=before;await rm(root,{recursive:true,force:true});}
}

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
 const pool={query:db.query,connect:async()=>db} as any,web={provider:'deepseek' as const,thinking:false};
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
