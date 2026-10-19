/** 验证移除最后一份当前附件后入库步骤回到 waiting 且不新增失败尝试；使用注入 Pool，不访问真实数据库或写入材料文件。 */
import {test,expect} from 'bun:test';
import type {Pool} from 'pg';
import {receiveMaterials} from './intake';

const workflowId='11111111-1111-4111-8111-111111111111';
const projectId='22222222-2222-4222-8222-222222222222';
test('removing the last current attachment leaves intake waiting without a failed attempt',async()=>{
 const calls:string[]=[];
 const query=async(sql:string)=>{
  calls.push(sql);
  if(sql.startsWith('SELECT id FROM ai_distill.workflows WHERE project_id'))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT id FROM ai_distill.projects'))return{rows:[{id:projectId}],rowCount:1};
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return{rows:[{id:workflowId}],rowCount:1};
  if(sql.startsWith('SELECT original_name,sha256 FROM ai_distill.materials'))return{rows:[{original_name:'last.pdf',sha256:'a'.repeat(64)}],rowCount:1};
  return{rows:[],rowCount:0};
 };
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 const result=await receiveMaterials(pool,'/tmp/unused',{projectId,requestId:crypto.randomUUID(),title:'题目1',key:'题目1',workflowId,files:[],allowEmpty:true});
 expect(result).toMatchObject({id:workflowId,updated:true,empty:true});
 expect(calls.some(sql=>sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(false);
 expect(calls.some(sql=>sql.includes("SET status='waiting',result=NULL,error=NULL")&&sql.includes('ordinal=1'))).toBe(true);
 expect(calls.some(sql=>sql.includes('没有材料，请补充后重试'))).toBe(false);
});
