/**
 * 验证显式题面开头修订的输入、乐观版本绑定、幂等和下游失效事务；PG替身不调用模型或外部同步。
 * 该入口只允许豆包项目，测试重点是修订不能覆盖新版本、不能把无变化请求制造成新attempt。
 */
import {expect,test} from 'bun:test';
import {reviseQuestionOpening} from './revise';

const workflowId='11111111-1111-4111-8111-111111111111';
const sourceId='22222222-2222-4222-8222-222222222222';
const current={task_name:'审查任务',task_type:'分析',header:{industry_l1:'法律',industry_l2:'争议解决',task_form:'single_round',occupation_l1:'法律',occupation_l2:'律师'},question:'请根据材料完成审查。',attachment_ids:[],rubric:[{id:'r1',description:'结论准确',max_score:10}],answer_approach:'核对材料',reference_answer:'结论',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},question_version:'q1',rubric_version:'r1'};
const body=(overrides:Record<string,unknown>={})=>({expected_question_version:'q1',expected_rubric_version:'r1',opening_before:'请根据材料',opening_after:'请依据所附材料',reason:'统一题面措辞',...overrides});
const rows=(items:any[]=[])=>({rows:items,rowCount:items.length});

function fixture(options:{question?:any;active?:boolean;archived?:boolean;parent?:string}={}){
 const calls:{sql:string;values?:unknown[]}[]=[];let connects=0,released=false;
 const query=async(sql:string,values?:unknown[])=>{
  calls.push({sql,values});
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('SET LOCAL'))return rows();
  if(sql.startsWith('SELECT w.project_id'))return rows([{project_id:'project',title:'题目1',parent_name:options.parent??'豆包高经济价值'}]);
  if(sql.startsWith('SELECT pg_try_advisory'))return rows([{locked:true}]);
  if(sql.includes("ordinal=8 AND status='succeeded'"))return options.archived?rows([{}]):rows();
  if(sql.includes("ordinal BETWEEN 4 AND 8")&&sql.includes("status IN ('waiting','running')"))return options.active?rows([{}]):rows();
  if(sql.includes("ordinal=4 AND status='succeeded' FOR UPDATE"))return rows([{result:options.question??current}]);
  if(sql.startsWith('SELECT id,input,config FROM ai_distill.step_attempts'))return rows([{id:sourceId,input:{title:'题目1',source_files:[]},config:{model:'fixture'}}]);
  return rows();
 };
 const db={query,release(){released=true;}};
 return{pool:{connect:async()=>{connects++;return db;}}as any,calls,get connects(){return connects;},get released(){return released;}};
}

test('畸形、缺字段和未知字段在连接数据库前拒绝',async()=>{
 const f=fixture();
 for(const value of [null,[],{},body({extra:true}),body({reason:''}),body({task_type:''})])await expect(reviseQuestionOpening(f.pool,workflowId,value)).rejects.toThrow();
 expect(f.connects).toBe(0);
});

test('题目版本或原开头变化时回滚且不写attempt和当前投影',async()=>{
 for(const value of [body({expected_question_version:'old'}),body({opening_before:'不存在的开头'})]){
  const f=fixture();
  await expect(reviseQuestionOpening(f.pool,workflowId,value)).rejects.toThrow();
  expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
  expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(false);
  expect(f.released).toBe(true);
 }
});

test('题面和任务类型都未变化时幂等提交，不制造新版本或失效下游',async()=>{
 const f=fixture();
 const result=await reviseQuestionOpening(f.pool,workflowId,body({opening_after:'请根据材料',task_type:'分析'}));
 expect(result).toEqual({changed:false,question_version:'q1'});
 expect(f.calls.at(-1)?.sql).toBe('COMMIT');
 expect(f.calls.some(call=>/^(INSERT|UPDATE)/.test(call.sql))).toBe(false);
});

test('真实修订复用冻结输入、生成新attempt并仅失效5至8步',async()=>{
 const f=fixture();
 const result=await reviseQuestionOpening(f.pool,workflowId,body({task_type:'判断'}));
 expect(result).toMatchObject({changed:true,attempt_id:expect.any(String),question_version:expect.any(String),rubric_version:'r1',invalidated_ordinals:[5,6,7,8]});
 const attempt=f.calls.find(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
 expect(JSON.parse(String(attempt.values?.[2]))).toEqual({title:'题目1',source_files:[]});
 expect(JSON.parse(String(attempt.values?.[3]))).toMatchObject({model:'fixture',execution_kind:'manual_revision'});
 expect(JSON.parse(String(attempt.values?.[4]))).toMatchObject({question:'请依据所附材料完成审查。',task_type:'判断',manual_revision:{source_attempt_id:sourceId,previous_question_version:'q1'}});
 expect(f.calls.some(call=>call.sql.includes("ordinal BETWEEN 5 AND 8"))).toBe(true);
 expect(f.calls.some(call=>call.sql.startsWith('UPDATE ai_distill.project_exports'))).toBe(true);
 expect(f.calls.at(-1)?.sql).toBe('COMMIT');
});
