import {test,expect} from 'bun:test';
import {runRevisionTick} from './revision-runner';
function fixture(options:{blocked?:boolean;stale?:boolean;pending?:boolean;failure?:boolean;rubric?:boolean;exhausted?:boolean;materialStage?:2|9}={}){
 const calls:{sql:string;values:any[]}[]=[];
 const chain={id:'chain',workflow_id:'workflow',input_revision:1,status:'running',content_revisions:options.exhausted?3:1,technical_retries:0,calls_reserved:1,spent_duration_ms:10,budget:{max_content_revisions:3,max_technical_retries:2,max_calls:20,max_duration_ms:10000}};
 const round={id:'round',chain_id:'chain',round:1,stage:options.materialStage??4,status:'running',issue_kind:options.rubric?'rubric':'question'};
 const attempt={id:'author',ordinal:options.materialStage??4,status:options.pending?'running':options.failure?'failed':'succeeded',result:options.failure?{quality_check:{passed:false,checks:{material_grounding:false},issues:[{detail:'事实缺失'}]}}:{}};
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT c.*'))return {rows:[chain]};
  if(sql.includes('pg_try_advisory_xact_lock'))return {rows:[{acquired:true}]};
  if(sql.includes('dispatch_allowed'))return {rows:[{allowed:!options.blocked}]};
  if(sql.startsWith('SELECT input_revision'))return {rows:[{input_revision:options.stale?2:1}]};
  if(sql.startsWith('SELECT * FROM ai_distill.revision_rounds'))return {rows:[round]};
  if(sql.startsWith('SELECT * FROM ai_distill.step_attempts WHERE revision_round_id'))return {rows:[attempt]};
  if(sql.startsWith('SELECT ordinal,status'))return {rows:[{ordinal:2,status:'succeeded'},{ordinal:9,status:'succeeded'},{ordinal:4,status:'succeeded'},{ordinal:5,status:options.rubric?'succeeded':'waiting'}]};
  if(sql.startsWith('SELECT * FROM ai_distill.revision_chains'))return {rows:[chain]};
  if(sql.startsWith('SELECT id FROM ai_distill.revision_rounds'))return {rows:[],rowCount:0};
  return {rows:[],rowCount:1};
 };
 return {pool:{query,connect:async()=>({query,release(){}})} as any,calls};
}
test('paused or cancelled revision does not advance and releases its chain lock',async()=>{
 const {pool,calls}=fixture({blocked:true});await runRevisionTick(pool,'unused');
 expect(calls.some(call=>call.sql.startsWith('UPDATE'))).toBe(false);
 expect(calls.some(call=>call.sql.includes('pg_try_advisory_xact_lock('))).toBe(true);
 expect(calls.at(-1)?.sql).toBe('COMMIT');
 expect(calls.some(call=>call.sql.includes('pg_advisory_lock_shared'))).toBe(false);
});
test('pending round does not dispatch or advance again',async()=>{
 const {pool,calls}=fixture({pending:true});await runRevisionTick(pool,'unused');
 expect(calls.some(call=>call.sql.startsWith('UPDATE'))).toBe(false);
});
test('rubric revision skips paid answers only when the existing answer step is complete',async()=>{
 for(const rubric of [false,true]){
  const {pool,calls}=fixture({rubric});await runRevisionTick(pool,'unused');
  expect(calls.find(call=>call.sql.startsWith('UPDATE ai_distill.revision_rounds SET stage'))?.values[1]).toBe(rubric?6:5);
 }
});
test('changed material version marks the chain stale without dispatch',async()=>{
 const {pool,calls}=fixture({stale:true});await runRevisionTick(pool,'unused');
 expect(calls.some(call=>call.sql.includes("status='stale'"))).toBe(true);
 expect(calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false);
});
test('failed quality creates next recorded round and enforces the content limit',async()=>{
 for(const exhausted of [false,true]){
  const {pool,calls}=fixture({failure:true,exhausted});await runRevisionTick(pool,'unused');
  const update=calls.find(call=>call.sql.startsWith('UPDATE ai_distill.revision_chains SET status=$2'))!;
  expect(update.values[1]).toBe(exhausted?'isolated':'waiting');
  expect(update.values[3]).toBe(exhausted?3:2);
  expect(calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.revision_rounds'))).toBe(true);
 }
});

test('material repair runs independent redaction before authoring',async()=>{
 for(const materialStage of [2,9] as const){const {pool,calls}=fixture({materialStage});await runRevisionTick(pool,'unused');expect(calls.find(c=>c.sql.startsWith('UPDATE ai_distill.revision_rounds SET stage'))?.values[1]).toBe(materialStage===2?9:4);}
});
