/**
 * 验证答案/评分投影恢复的事务前置与失败回滚；使用可观测PG替身，不调用模型或真实数据库。
 * 成功聚合与评分上下文分别由 jobs/context 测试覆盖，本文件专注恢复入口不能跨版、带活动任务或留下半恢复状态。
 */
import {expect,test} from 'bun:test';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {restoreAnswerScoreResults} from './restore';
import {inputDigest} from './input';
import {scoreRubricBindingText} from '../scoring/validate';

const workflowId='11111111-1111-4111-8111-111111111111';
type Result={rows:any[];rowCount:number};
const result=(rows:any[]=[]):Result=>({rows,rowCount:rows.length});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

function poolFor(query:(sql:string,values?:unknown[])=>Result|Promise<Result>){
 const calls:{sql:string;values?:unknown[]}[]=[];let released=false;
 const db={query:async(sql:string,values?:unknown[])=>{calls.push({sql,values});if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return result();return query(sql,values);},release(){released=true;}};
 return{pool:{connect:async()=>db}as any,calls,get released(){return released;}};
}

test('恢复只读取同一工作流最新成功题目绑定的答案，缺失时完整回滚',async()=>{
 const authorId='22222222-2222-4222-8222-222222222222';
 const f=poolFor((sql,values)=>{
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return result([{id:workflowId}]);
  if(sql.includes("ordinal IN (5,6)"))return result();
  if(sql.includes('ordinal=4'))return result([{id:authorId}]);
  if(sql.includes('ordinal=5')){expect(values).toEqual([workflowId,authorId]);return result();}
  return result();
 });
 await expect(restoreAnswerScoreResults(f.pool,workflowId)).rejects.toThrow('没有同版题目的成功答案可恢复');
 expect(f.calls.map(call=>call.sql)).toContain('ROLLBACK');
 expect(f.calls.some(call=>call.sql==='COMMIT')).toBe(false);
 expect(f.released).toBe(true);
});

test('活动作答或评分存在时在读取历史结果前拒绝恢复',async()=>{
 const f=poolFor(sql=>{
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return result([{id:workflowId}]);
  if(sql.includes("ordinal IN (5,6)"))return result([{id:'active'}]);
  throw new Error('不应继续读取历史结果');
 });
 await expect(restoreAnswerScoreResults(f.pool,workflowId,true)).rejects.toThrow('作答或评分仍有活动任务');
 expect(f.calls.some(call=>call.sql.includes('ordinal=4'))).toBe(false);
 expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
 expect(f.released).toBe(true);
});

test('答案聚合不能恢复为成功时回滚，不继续查评分或提交部分投影',async()=>{
 const answer={id:'33333333-3333-4333-8333-333333333333',workflow_id:workflowId,status:'succeeded',input:{question_attempt_id:'author'},config:{},result:{text:'答案'}};
 const f=poolFor(sql=>{
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return result([{id:workflowId}]);
  if(sql.includes("ordinal IN (5,6)"))return result();
  if(sql.includes('ordinal=4'))return result([{id:'author'}]);
  if(sql.startsWith('SELECT * FROM ai_distill.step_attempts')&&sql.includes('ordinal=5'))return result([answer]);
  if(sql.startsWith('UPDATE ai_distill.steps SET status=$2'))return{rows:[],rowCount:1};
  if(sql.startsWith('SELECT status,result FROM ai_distill.steps'))return result([{status:'failed',result:null}]);
  throw new Error(`意外SQL: ${sql}`);
 });
 await expect(restoreAnswerScoreResults(f.pool,workflowId)).rejects.toThrow('本版模型答案尚未全部成功');
 expect(f.calls.map(call=>call.sql)).toContain('ROLLBACK');
 expect(f.calls.some(call=>call.sql.includes('ordinal=6'))).toBe(false);
 expect(f.calls.some(call=>call.sql==='COMMIT')).toBe(false);
});

test('不存在的工作流返回404并释放事务连接',async()=>{
 const f=poolFor(sql=>sql.startsWith('SELECT id FROM ai_distill.workflows')?result():result());
 try{await restoreAnswerScoreResults(f.pool,workflowId);throw new Error('应当失败');}
 catch(error){expect(error).toBeInstanceOf(HTTPException);expect((error as HTTPException).status).toBe(404);}
 expect(f.calls.map(call=>call.sql)).toEqual(['BEGIN','SELECT id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE','ROLLBACK']);
 expect(f.released).toBe(true);
});

function successfulRestore(tamperedScoreBinding=false){
 const authorId='22222222-2222-4222-8222-222222222222',answerId='33333333-3333-4333-8333-333333333333',scoreId='44444444-4444-4444-8444-444444444444';
 const materials=[{name:'附件1',text:'材料'}],attachments=[{id:'attachment',sha256:hash('材料')}],rubric=[{id:'fact',criterion:'依据材料',max_score:1}];
 const digest=inputDigest({question_version:'q1',question:'题目',materials,attachments});
 const answerInput={question_version:'q1',question:'题目',materials,attachments,question_attempt_id:authorId,input_digest:digest};
 const answerResult={text:'答案',input_digest:digest,answer_sha256:hash('答案')};
 const authorResult={question_version:'q1',question:'题目',attachment_ids:['attachment'],answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric_version:'r1',rubric,answer_approach:'核对材料',reference_answer:'依据材料作答'};
 const binding={question_version:'q1',input_digest:digest,rubric_version:'r1',rubric_digest:hash(scoreRubricBindingText(rubric)),answer_attempt_id:answerId,answer_sha256:hash('答案')};
 const answer={id:answerId,workflow_id:workflowId,status:'succeeded',input:answerInput,config:{},result:answerResult};
 const fixture=poolFor((sql,values)=>{
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return result([{id:workflowId}]);
  if(sql.includes("ordinal IN (5,6)"))return result();
  if(sql.startsWith('SELECT id FROM ai_distill.step_attempts')&&sql.includes('ordinal=4'))return result([{id:authorId}]);
  if(sql.startsWith('SELECT * FROM ai_distill.step_attempts')&&sql.includes('ordinal=5'))return result([answer]);
  if(sql.startsWith('UPDATE ai_distill.steps SET status=$2'))return{rows:[],rowCount:1};
  if(sql.startsWith('SELECT status,result FROM ai_distill.steps'))return result([{status:'succeeded',result:answerResult}]);
  if(sql.startsWith('SELECT w.rule_version_id'))return result([{project_name:'项目',title:'题目1',source_key:'题目1',local_skill_path:'/unused',material_root:'/unused'}]);
  if(sql.startsWith('SELECT a.input,a.result'))return result([{input:answerInput,result:answerResult}]);
  if(sql.startsWith('SELECT a.id,a.input,a.result'))return result([{id:authorId,input:{},result:authorResult}]);
  if(sql.startsWith('SELECT * FROM ai_distill.step_attempts')&&sql.includes('ordinal=6'))return result([{id:scoreId,status:'succeeded',input:{context:{binding:tamperedScoreBinding?{...binding,rubric_version:'old'}:binding}},result:{validation:{valid:true}}}]);
  if(sql.startsWith('SELECT result FROM ai_distill.steps'))return result([{result:answerResult}]);
  if(sql.startsWith('UPDATE ai_distill.steps SET status=$2,result=$3,error=$4'))return{rows:[],rowCount:1};
  throw new Error(`意外SQL: ${sql}; ${JSON.stringify(values)}`);
 });
 return Object.assign(fixture,{authorId,answerId,scoreId,binding});
}

test('完整恢复只提交同版答案和评分，不新建attempt或调用模型',async()=>{
 const f=successfulRestore();
 const restored=await restoreAnswerScoreResults(f.pool,workflowId);
 expect(restored).toEqual({workflow_id:workflowId,answer_ids:[f.answerId],score_ids:[f.scoreId],restored:true});
 expect(f.calls.at(-1)?.sql).toBe('COMMIT');
 expect(f.calls.some(call=>call.sql.startsWith('INSERT INTO ai_distill.step_attempts'))).toBe(false);
 expect(f.released).toBe(true);
});

test('历史评分绑定与当前题面不同时整题回滚，answer_only仍可只恢复已核对答案',async()=>{
 const full=successfulRestore(true);
 await expect(restoreAnswerScoreResults(full.pool,workflowId)).rejects.toThrow('没有同版题面、答案及评分规则的有效评分可恢复');
 expect(full.calls.at(-1)?.sql).toBe('ROLLBACK');
 const answers=successfulRestore(true);
 expect(await restoreAnswerScoreResults(answers.pool,workflowId,true)).toEqual({workflow_id:workflowId,answer_ids:[answers.answerId],score_ids:[],restored:true,answer_only:true});
 expect(answers.calls.some(call=>call.sql.includes('ordinal=6'))).toBe(false);
 expect(answers.calls.at(-1)?.sql).toBe('COMMIT');
});
