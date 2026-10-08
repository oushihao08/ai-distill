import {test,expect} from 'bun:test';
import {resumeRevision} from '../decisions/revision-jobs';
function fixture(exhausted=false){
 const calls:{sql:string;values:any[]}[]=[];
 const db={release(){},async query(sql:string,values:any[]=[]){
  calls.push({sql,values});
  if(sql.startsWith('SELECT w.input_revision'))return {rows:[{input_revision:1}]};
  if(sql.startsWith('SELECT * FROM ai_distill.revision_chains'))return {rows:[{id:'chain',input_revision:1,status:'blocked',reason:'batch_cancelled',budget:{max_technical_retries:2,max_calls:10,max_duration_ms:10000},content_revisions:1,technical_retries:exhausted?2:0,calls_reserved:1,spent_duration_ms:100}]};
  if(sql.startsWith('SELECT * FROM ai_distill.revision_rounds'))return {rows:[{id:'round',round:1,issue_kind:'question',before_versions:{question_version:'v1'}}]};
  if(sql.startsWith('SELECT * FROM ai_distill.step_attempts'))return {rows:[{id:'cancelled',ordinal:4}]};
  return {rows:[],rowCount:0};
 }};
 return {calls,pool:{connect:async()=>db} as any};
}
test('cancelled revision resumes as a new budgeted technical round, never revives old attempt',async()=>{
 const {pool,calls}=fixture();expect(await resumeRevision(pool,'workflow','chain')).toEqual({id:'chain',status:'waiting'});
 const insertion=calls.find(call=>call.sql.startsWith('INSERT INTO ai_distill.revision_rounds'))!;
 expect(insertion.values[2]).toBe(2);expect(insertion.values[4]).toBe('cancelled');
 expect(JSON.parse(insertion.values[6])).toMatchObject({action:'retry',content_revisions:1,technical_retries:1});
 expect(calls.some(call=>call.sql.includes("step_attempts SET status='running'"))).toBe(false);
});
test('cancelled revision cannot reset an exhausted retry budget',async()=>{
 const {pool,calls}=fixture(true);await expect(resumeRevision(pool,'workflow','chain')).rejects.toThrow('恢复预算不足');
 expect(calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false);expect(calls.at(-1)?.sql).toBe('ROLLBACK');
});
