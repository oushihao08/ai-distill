/** 验证返修调用预留、真实用量记账、不确定失败保留预算及规则变更隔离。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {runRevisionCall} from './revision-calls';
function fixture(options:{ordinary?:boolean;exhausted?:boolean;previous?:boolean;rulesChanged?:boolean}={}){
 const calls:{sql:string;values:any[]}[]=[];
 const chain={...(options.rulesChanged?{config_snapshot:{rule_version_id:'old'},current_rule_version_id:'new'}:{}),id:'chain',round_id:'round',status:'running',calls_reserved:options.exhausted?2:0,spent_duration_ms:'10',budget:{max_calls:2,max_duration_ms:1000}};
 const query=async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT c.*'))return {rows:options.ordinary?[]:[chain]};
  if(sql.startsWith('SELECT id FROM ai_distill.revision_calls'))return {rows:options.previous?[{id:'prior'}]:[]};
  if(sql.startsWith('UPDATE ai_distill.revision_calls c'))return {rowCount:0,rows:[]};
  if(sql.startsWith('UPDATE ai_distill.revision_calls'))return {rowCount:1,rows:[{chain_id:'chain'}]};
  return {rows:[],rowCount:1};
 };
 return {pool:{connect:async()=>({query,release(){}})} as any,calls};
}
test('reserves before invocation and persists actual usage and time after success',async()=>{
 const {pool,calls}=fixture();const result=await runRevisionCall(pool,'attempt','review',async remaining=>{
  expect(remaining).toBe(990);expect(calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.revision_calls'))).toBe(true);
  return {usage:{input_tokens:2},duration_ms:1};
 });
 expect(result.usage.input_tokens).toBe(2);
 expect(calls.find(call=>call.sql.startsWith('UPDATE ai_distill.revision_calls SET'))?.values[1]).toBe('completed');
 expect(calls.some(call=>call.sql.includes('spent_duration_ms=spent_duration_ms+'))).toBe(true);
});
test('exhaustion and a prior reservation each prevent an external call',async()=>{
 for(const options of [{exhausted:true},{previous:true}]){
  const {pool,calls}=fixture(options);let invoked=false;
  await expect(runRevisionCall(pool,'attempt','author',async()=>{invoked=true;return {};})).rejects.toThrow();
  expect(invoked).toBe(false);expect(calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false);
 }
});
test('uncertain failed invocation retains reservation rather than refunding budget',async()=>{
 const {pool,calls}=fixture();await expect(runRevisionCall(pool,'attempt','answer',async()=>{throw new Error('connection closed');})).rejects.toThrow('connection closed');
 expect(calls.find(call=>call.sql.startsWith('UPDATE ai_distill.revision_calls SET'))?.values[1]).toBe('unknown');
 expect(calls.some(call=>call.sql.includes('calls_reserved=calls_reserved-'))).toBe(false);
});
test('ordinary manual attempts do not allocate revision budget',async()=>{
 const {pool,calls}=fixture({ordinary:true});expect(await runRevisionCall(pool,'attempt','answer',async (remaining,callId)=>{expect(remaining).toBeUndefined();expect(callId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));return {};})).toEqual({});
 expect(calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false);
});

test('a changed rule version isolates the chain before reserving or sending another model request',async()=>{const {pool,calls}=fixture({rulesChanged:true});let sent=false;await expect(runRevisionCall(pool,'attempt','author',async()=>{sent=true;return {};})).rejects.toThrow('rule_version_changed');expect(sent).toBe(false);expect(calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);expect(calls.find(c=>c.sql.startsWith('UPDATE ai_distill.revision_chains SET status'))?.values[1]).toBe('isolated');});
