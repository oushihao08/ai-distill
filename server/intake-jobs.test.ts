/** 验证入库任务被领取后收到停止信号时会回到 waiting，且不开始材料插入/文件保存；使用注入 Pool，不访问真实数据库或文件。 */
import{test,expect}from'bun:test';
import type{Pool}from'pg';
import{runNextIntake}from'./intake-jobs';

test('worker stop after intake claim requeues the task before reading or saving files',async()=>{
 const controller=new AbortController(),calls:{sql:string;values:unknown[]}[]=[];
 const job={id:'intake-attempt',workflow_id:'workflow',project_id:'project',title:'题目',source_key:'题目1',input:{files:[{path:'/must-not-read',name:'input.pdf',sha256:'source'}]}};
 const query=async(sql:string,values:unknown[]=[]):Promise<any>=>{
  calls.push({sql,values});
  if(sql.startsWith('SELECT a.id,a.workflow_id,a.heartbeat_at'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT a.*,w.project_id,w.title,w.source_key')){controller.abort();return{rows:[job],rowCount:1};}
  return{rows:[],rowCount:1};
 };
 const pool={connect:async()=>({query,release(){}})} as unknown as Pool;
 expect(await runNextIntake(pool,'unused',undefined,controller.signal)).toBe(true);
 expect(calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.materials'))).toBe(false);
 expect(calls.some(call=>call.sql.startsWith("UPDATE ai_distill.step_attempts SET status='waiting'"))).toBe(true);
 expect(calls.some(call=>call.sql.startsWith("UPDATE ai_distill.steps SET status='waiting'"))).toBe(true);
});
