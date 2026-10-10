/** 验证返修链启动与复用、来源证据和预算快照的原子保存及冲突回滚。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resumeRevision,startRevision} from './revision-jobs';
import {configureLogger} from '../logging';
function fixture(options:{previous?:boolean;resume?:boolean;active?:boolean;stale?:boolean;pending?:boolean;projectStepConfigs?:{ordinal:number;config:Record<string,unknown>}[]}={}){
 const calls:{sql:string;values:any[]}[]=[];
 const source={id:'source',attempt:3,ordinal:7,status:'succeeded',result:{decision:'repair',reasons:['below_model_threshold:model'],model_scores:{model:{score:6,max_score:10}},evaluation_records:[{model_id:'model',answer_attempt_id:'answer-3',score_attempt_id:'score-3',question_version:'qv1',rubric_version:'rv1'}]}};
 const db={release(){},async query(sql:string,values:any[]=[]){
  calls.push({sql,values});
  if(sql.startsWith('SELECT w.project_id'))return {rows:[{project_id:'project'}]};
  if(sql.startsWith('SELECT status,finished_at'))return {rows:[{status:'failed',finished_at:'2026-10-09T00:00:00Z'}]};
  if(sql.startsWith('SELECT * FROM ai_distill.step_attempts'))return {rows:[source]};
  if(sql.includes("result->>'decision'='repair'"))return {rows:[source]};
  if(sql.startsWith('SELECT * FROM ai_distill.revision_chains'))return {rows:options.resume?[{id:'chain',workflow_id:'workflow',status:'blocked',budget:{},content_revisions:0,technical_retries:0,calls_reserved:0,spent_duration_ms:0}]:options.previous?[{id:'existing'}]:[]};
  if(sql.startsWith('SELECT * FROM ai_distill.revision_rounds'))return {rows:[{id:'round',issue_kind:'content'}]};
  if(sql.startsWith('SELECT ordinal,config FROM ai_distill.project_step_configs'))return {rows:options.projectStepConfigs??[]};
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return {rows:[{codex_model:null,codex_reasoning_effort:null}]};
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return {rows:[{credential_home:null,model:'system-model',reasoning_effort:'high'}]};
  if(sql.startsWith('SELECT id FROM ai_distill.revision_chains'))return {rows:options.active?[{id:'active'}]:[]};
  if(sql.includes('ORDER BY attempt DESC'))return {rows:[{id:options.stale?'newer':'source'}]};
  if(sql.includes("status IN ('waiting','running')"))return {rowCount:options.pending?1:0,rows:[]};
  if(sql.startsWith('SELECT config'))return {rows:[{config:{revision_budget:{max_technical_retries:2,max_calls:20,max_duration_ms:10000}}}]};
  if(sql.startsWith('INSERT INTO ai_distill.revision_chains'))return {rows:[{id:values[0],status:values[3]}]};
  return {rows:[],rowCount:0};
 }};
 return {calls,pool:{connect:async()=>db} as any};
}
test('revision start stores source evidence, frozen budget and one content round atomically',async()=>{
 const {pool,calls}=fixture();const result=await startRevision(pool,'workflow','source');
 expect(result).toMatchObject({status:'waiting',reused:false});
 const chain=calls.find(call=>call.sql.startsWith('INSERT INTO ai_distill.revision_chains'))!;
 expect(JSON.parse(chain.values[4])).toEqual({max_content_revisions:3,max_technical_retries:2,max_calls:20,max_duration_ms:10000});
 expect(chain.values[5]).toBe(1);
 const round=calls.find(call=>call.sql.startsWith('INSERT INTO ai_distill.revision_rounds'))!;
 expect(JSON.parse(round.values[4])).toEqual({reasons:['below_model_threshold:model'],evaluation_records:[{acceptance_attempt_id:'source',attempt:3,reasons:['below_model_threshold:model'],model_scores:{model:{score:6,max_score:10}},models:[{model_id:'model',answer_attempt_id:'answer-3',score_attempt_id:'score-3',question_version:'qv1',rubric_version:'rv1'}],details_available:true}]});
 expect(calls.at(-1)?.sql).toBe('COMMIT');
});
test('revision start writes correlated lifecycle events',async()=>{
 const root=await mkdtemp(join(tmpdir(),'revision-logs-'));const logger=configureLogger({root,service:'worker'});
 try{
  await startRevision(fixture().pool,'workflow','source');await logger.flush();
  const day=new Date().toISOString().slice(0,10),directory=join(root,'logs',day);await mkdir(directory,{recursive:true});const files=await readdir(directory);
  const records=files.length?(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  expect(records.map(record=>record.event)).toContain('revision.start.completed');
  expect(records.find(record=>record.event==='revision.start.completed')).toMatchObject({workflow_id:'workflow',component:'revision'});
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});
test('revision resume writes correlated lifecycle events',async()=>{
 const root=await mkdtemp(join(tmpdir(),'revision-resume-logs-'));const logger=configureLogger({root,service:'worker'});
 try{
  await resumeRevision(fixture({resume:true}).pool,'workflow','chain');await logger.flush();
  const directory=join(root,'logs',new Date().toISOString().slice(0,10));await mkdir(directory,{recursive:true});const files=await readdir(directory);
  const records=files.length?(await readFile(join(directory,files[0]!), 'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  expect(records.map(record=>record.event)).toContain('revision.resume.completed');
  expect(records.find(record=>record.event==='revision.resume.completed')).toMatchObject({workflow_id:'workflow',project_id:'project',operation_id:'chain'});
 }finally{await logger.close();await rm(root,{recursive:true,force:true});}
});
test('revision snapshot freezes system Codex defaults while preserving project overrides',async()=>{
 const {pool,calls}=fixture({projectStepConfigs:[{ordinal:4,config:{provider:'codex',model:'project-model',reasoning_effort:'low'}},{ordinal:7,config:{revision_budget:{max_technical_retries:2,max_calls:20,max_duration_ms:10000}}}]});
 await startRevision(pool,'workflow','source');
 const snapshotCall=calls.find(call=>call.sql.startsWith('UPDATE ai_distill.revision_chains SET config_snapshot'))!;
 const snapshot=JSON.parse(snapshotCall.values[1]);
 expect(snapshot.configs['3']).toMatchObject({provider:'codex',model:'system-model',reasoning_effort:'high'});
 expect(snapshot.configs['4']).toMatchObject({provider:'codex',model:'project-model',reasoning_effort:'low'});
 expect(snapshot.configs['6']).toMatchObject({provider:'codex',model:'system-model',reasoning_effort:'high'});
 expect(snapshot.configs['9']).toMatchObject({provider:'codex',model:'system-model',reasoning_effort:'high',prompt:expect.any(String)});
});
test('same source reuses its chain without increasing counters',async()=>{
 const {pool,calls}=fixture({previous:true});expect(await startRevision(pool,'workflow','source')).toMatchObject({id:'existing',reused:true});
 expect(calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false);
});
test('active chain, historic source and pending tasks each reject and roll back',async()=>{
 for(const options of [{active:true},{stale:true},{pending:true}]){
  const {pool,calls}=fixture(options);await expect(startRevision(pool,'workflow','source')).rejects.toThrow();
  expect(calls.at(-1)?.sql).toBe('ROLLBACK');expect(calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false);
 }
});
