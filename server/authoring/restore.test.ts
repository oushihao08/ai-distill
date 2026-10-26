/** 验证从已完成本机检查点恢复保存、重复请求幂等及缺失结果拒绝；临时SQLite/HTTP/PG替身，无模型或真实数据库。 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from 'hono';
import {restoreAuthoringResult} from './restore';
import {localQueue,withLocalQueueRoot} from '../execution-queue/runtime';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'restore-author-'));const q=localQueue(root);const id=crypto.randomUUID(),workflow=crypto.randomUUID();let calls=0;
 q.intent(id,'step','agent','authoring');q.confirm(id);
 const draft={task_name:'金额核算',task_type:'计算',header:{industry_l1:'法律',industry_l2:'诉讼',task_form:'single_round',occupation_l1:'法律',occupation_l2:'律师'},question:'核对金额',attachment_ids:[],rubric:[],answer_approach:'核对',reference_answer:'100元',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
 const result={question_id:'原题',draft,question_version:'qv',rubric_version:'rv',package_text:'题面',codex:{session_id:'original-session',usage:null,duration_ms:1}};
 await q.call(id,'0:authoring_complete',async()=>{calls++;return result;});q.resolve(id,'failed');
 const row:any={id,workflow_id:workflow,status:'failed',ordinal:4,input:{title:'原题',source_files:[]},result:{failure_phase:'result_persistence'},error:'原保存失败'};
 const writes:any[]=[];let latest:string=id,failWrite=false;
 const query=async(sql:string,values:any[]=[])=>{
  if(sql.includes('SELECT a.*,w.project_id'))return {rows:[row],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return {rows:[{id:latest}],rowCount:1};
  writes.push({sql,values});
  if(failWrite&&sql.startsWith('UPDATE ai_distill.steps'))throw new Error('synthetic persistence unavailable');
  // 状态由COMMIT才改变，模拟失败回滚不产生成功业务状态。
  if(sql==='COMMIT'&&writes.some(w=>w.sql.startsWith('UPDATE ai_distill.steps')))row.status='succeeded';
  return{rows:[],rowCount:1};
 };
 const pool={connect:async()=>({query,release(){}})} as any;
 const app=new Hono();app.onError(()=>new Response("synthetic persistence failure",{status:500}));app.post('/restore',()=>withLocalQueueRoot(root,async()=>Response.json(await restoreAuthoringResult(pool,root,workflow,id))));
 return{root,q,id,workflow,row,writes,app,get calls(){return calls;},setLatest(v:string){latest=v;},breakWrite(){failWrite=true;},cleanup:async()=>{q.close();await rm(root,{recursive:true,force:true});}};
}
test('HTTP恢复使用原结果、原会话和原版本，第二次请求不重复保存或调用模型',async()=>{
 const f=await fixture();try{
  const first=await f.app.request('/restore',{method:'POST'});expect(first.status).toBe(200);expect(await first.json()).toMatchObject({id:f.id,status:'succeeded',question_version:'qv',reused:false});expect(f.calls).toBe(1);expect(f.q.get(f.id)?.state).toBe('committed');
  const saved=JSON.parse(f.writes.find(w=>w.sql.startsWith('UPDATE ai_distill.step_attempts'))!.values[1]);expect(saved.codex.author.session_id).toBe('original-session');expect(saved.result_recovery.prior_failure.failure_phase).toBe('result_persistence');
  expect(await (await f.app.request('/restore',{method:'POST'})).json()).toMatchObject({reused:true});expect(f.writes.filter(w=>w.sql.startsWith('UPDATE ai_distill.step_attempts'))).toHaveLength(1);expect(f.calls).toBe(1);
 }finally{await f.cleanup();}
});
test('更新题目存在时不覆盖；没有已完成检查点不会创建或重放调用',async()=>{
 const f=await fixture();try{
  f.setLatest(crypto.randomUUID());await expect(restoreAuthoringResult({connect:async()=>({query:async(sql:string)=>sql.includes('SELECT a.*')?{rows:[f.row]}:{rows:[{id:'newer'}]},release(){}})} as any,f.root,f.workflow,f.id)).rejects.toThrow('不能覆盖');
  expect(f.q.completedCall(f.id,'missing')).toBeNull();expect(f.q.hasUnknownCall(f.id)).toBe(false);expect(f.calls).toBe(1);expect(f.q.get(f.id)?.state).toBe('failed');
 }finally{await f.cleanup();}
});
test('数据库保存失败不把本机检查点标成成功，原检查点仍可继续恢复',async()=>{
 const f=await fixture();try{f.breakWrite();const response=await f.app.request('/restore',{method:'POST'});expect(response.status).toBe(500);expect(f.row.status).toBe('failed');expect(f.q.get(f.id)?.state).toBe('failed');expect(f.q.completedCall(f.id,'0:authoring_complete')).not.toBeNull();expect(f.calls).toBe(1);expect(f.writes.some(w=>w.sql==='ROLLBACK')).toBe(true);}finally{await f.cleanup();}
});
