import {test,expect} from 'bun:test';
import {startRevision} from './revision-jobs';
function fixture(options:{previous?:boolean;active?:boolean;stale?:boolean;pending?:boolean}={}){
 const calls:{sql:string;values:any[]}[]=[];
 const source={id:'source',ordinal:7,status:'succeeded',result:{decision:'repair',reasons:['below_model_threshold:model'],model_scores:{model:{score:2,max_score:10}}}};
 const db={release(){},async query(sql:string,values:any[]=[]){
  calls.push({sql,values});
  if(sql.startsWith('SELECT w.input_revision'))return {rows:[{input_revision:1,project_id:'project'}]};
  if(sql.startsWith('SELECT * FROM ai_distill.step_attempts'))return {rows:[source]};
  if(sql.startsWith('SELECT * FROM ai_distill.revision_chains'))return {rows:options.previous?[{id:'existing'}]:[]};
  if(sql.startsWith('SELECT id FROM ai_distill.revision_chains'))return {rows:options.active?[{id:'active'}]:[]};
  if(sql.includes('ORDER BY attempt DESC'))return {rows:[{id:options.stale?'newer':'source'}]};
  if(sql.includes("status IN ('waiting','running')"))return {rowCount:options.pending?1:0,rows:[]};
  if(sql.startsWith('SELECT config'))return {rows:[{config:{revision_budget:{max_technical_retries:2,max_calls:20,max_duration_ms:10000}}}]};
  if(sql.startsWith('INSERT INTO ai_distill.revision_chains'))return {rows:[{id:values[0],status:values[4]}]};
  return {rows:[],rowCount:0};
 }};
 return {calls,pool:{connect:async()=>db} as any};
}
test('revision start stores source evidence, frozen budget and one content round atomically',async()=>{
 const {pool,calls}=fixture();const result=await startRevision(pool,'workflow','source');
 expect(result).toMatchObject({status:'waiting',reused:false});
 const chain=calls.find(call=>call.sql.startsWith('INSERT INTO ai_distill.revision_chains'))!;
 expect(JSON.parse(chain.values[5])).toEqual({max_content_revisions:3,max_technical_retries:2,max_calls:20,max_duration_ms:10000});
 expect(chain.values[6]).toBe(1);
 const round=calls.find(call=>call.sql.startsWith('INSERT INTO ai_distill.revision_rounds'))!;
 expect(JSON.parse(round.values[4])).toEqual({reasons:['below_model_threshold:model']});
 expect(calls.at(-1)?.sql).toBe('COMMIT');
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
