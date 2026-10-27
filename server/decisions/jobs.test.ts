/** 验证达标快照绑定当前题面、答案、rubric、模型集合和继承答案来源。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {buildAcceptanceInput,buildEvaluationRecordRefs,readAcceptanceSnapshot,runAcceptance} from './jobs';
import {scoreRubricBindingText} from '../scoring/validate';
import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
import type {AcceptanceConfig} from './acceptance';
const config:AcceptanceConfig={required_models:['qwen'],minimum_score_by_model:{qwen:8}};
const question={id:'q1',status:'succeeded',result:{question_version:'qv2',rubric_version:'rv1',rubric:[{id:'r1',criterion:'明确结论',max_score:10}]}};
const answer={id:'a1',model:'qwen',status:'succeeded',result:{question_attempt_id:'q1',question_version:'qv2',text:'答案',answer_sha256:hash('答案'),input_digest:'input'}};
const score={answer_attempt_id:'a1',status:'succeeded',result:{binding:{answer_attempt_id:'a1',question_version:'qv2',rubric_version:'rv1',input_digest:'input',answer_sha256:hash('答案'),rubric_digest:hash(JSON.stringify(question.result.rubric))},validation:{valid:true},report:{total:9,max_score:10,disputes:[]}}};
test('新达标装配使用完整规则绑定和模型指标，保持原始分独立',()=>{
 const policy={contract:'model_report_v1' as const,rules_text:'按项目判断',reference_answer:'none' as const};
 const rubric=[{id:'r1',criterion:'判断',rule:'扣7分',metadata:{score:-7}}];
 const q={...question,result:{...question.result,rubric,scoring_policy:policy}};
 const s={...score,result:{...score.result,binding:{...score.result.binding,rubric_digest:hash(scoreRubricBindingText(rubric,policy))},validation:{valid:true,mode:'model_report_v1'},report:{contract:'model_report_v1',summary:{raw_score:-7,full_score:100,evaluation_percent:12,veto_triggered:true}}}};
 const input=buildAcceptanceInput({config,question:q,answers:[answer],scores:[s]});
 expect(input.models[0]).toMatchObject({source_current:true,score_contract:'model_report_v1',evaluation_percent:12,raw_score:-7});
 expect(buildAcceptanceInput({config,question:{...q,result:{...q.result,rubric:[{...rubric[0],rule:'另一个口径'}]}},answers:[answer],scores:[s]}).models[0]?.source_current).toBe(false);
});
test('acceptance assembly matches latest question, answer and rubric versions',()=>{const input=buildAcceptanceInput({config,question,answers:[answer],scores:[score]});expect(input.question_current).toBe(true);expect(input.models[0]).toMatchObject({answer_status:'succeeded',score_status:'succeeded',source_current:true});});
test('acceptance history freezes the answer and score attempt IDs for every selected model',()=>{
 const snapshot={config:{required_models:['qwen','model-b'],minimum_score_by_model:{qwen:8,'model-b':8}},question,answers:[{...answer,result:{...answer.result,answer_sha256:'a'.repeat(64)}},{id:'a2',model:'model-b',status:'succeeded',result:{question_attempt_id:'q1',question_version:'qv2',answer_sha256:'b'.repeat(64)}}],scores:[{...score,id:'s1',result:{...score.result,raw_text:'逐项评分原文'}},{...score,id:'s2',answer_attempt_id:'a2',result:{...score.result,binding:{...score.result.binding,answer_attempt_id:'a2'},raw_text:'第二个模型评分原文'}}]};
 expect(buildEvaluationRecordRefs(snapshot,{qwen:{status:'passed',score:6,max_score:10},'model-b':{status:'not_passed',score:9,max_score:10}})).toEqual([{model_id:'qwen',status:'passed',answer_attempt_id:'a1',score_attempt_id:'s1',question_attempt_id:'q1',question_version:'qv2',rubric_version:'rv1',answer_sha256:'a'.repeat(64),score_sha256:expect.any(String)},{model_id:'model-b',status:'not_passed',answer_attempt_id:'a2',score_attempt_id:'s2',question_attempt_id:'q1',question_version:'qv2',rubric_version:'rv1',answer_sha256:'b'.repeat(64),score_sha256:expect.any(String)}]);
});
test('a score from a different rubric cannot match current answer version',()=>{const input=buildAcceptanceInput({config,question,answers:[answer],scores:[{...score,result:{...score.result,binding:{...score.result.binding,rubric_version:'old'}}}]});expect(input.models[0]?.source_current).toBe(false);});
test('failed or missing author attempts cannot be current',()=>{expect(buildAcceptanceInput({config,question:{...question,status:'failed'},answers:[],scores:[]}).question_current).toBe(false);expect(buildAcceptanceInput({config,answers:[answer],scores:[score]}).question_current).toBe(false);});
test('acceptance snapshot filters the current model set and keys answers by stable model ID',async()=>{
 const calls:any[]=[];const db={query:async(sql:string,values:any[]=[])=>{calls.push({sql,values});if(sql.includes('DISTINCT ON'))return {rowCount:1,rows:[{id:'a1',model:'stable-model-id',status:'succeeded',result:{}}]};return {rowCount:0,rows:[]};}} as unknown as PoolClient;
 const snapshot=await readAcceptanceSnapshot(db,'workflow',{required_models:['stable-model-id'],minimum_score_by_model:{'stable-model-id':8}},'current-model-set-digest');
 expect(snapshot.answers[0]?.model).toBe('stable-model-id');expect(calls.find(call=>call.sql.includes('DISTINCT ON'))?.values).toEqual(['workflow','current-model-set-digest']);
 expect(calls.find(call=>call.sql.includes('DISTINCT ON'))?.sql).toContain("COALESCE(input->>'model_id',config->>'model')");
});
test('accepted source fingerprint changes when the actual question or answer changes, not with JSONB key order',async()=>{
 const module=await import('./jobs') as any;expect(typeof module.acceptanceSourceDigest).toBe('function');
 const source={config,question,answers:[answer],scores:[{...score,id:'s1'}]};
 const fingerprint=module.acceptanceSourceDigest(source);
 expect(module.acceptanceSourceDigest({...source,config:{minimum_score_by_model:config.minimum_score_by_model,required_models:config.required_models}})).toBe(fingerprint);
 expect(module.acceptanceSourceDigest({...source,question:{...question,result:{...question.result,question:'changed'}}})).not.toBe(fingerprint);
 expect(module.acceptanceSourceDigest({...source,answers:[{...answer,result:{...answer.result,text:'changed'}}]})).not.toBe(fingerprint);
});

/** SQL替身运行完整判定事务，观察实际写入；不替代PG行锁验收。 */
function acceptanceFixture(){
 const state={question:structuredClone(question),answer:structuredClone(answer),score:{...structuredClone(score),id:'s1'},config:structuredClone(config),previous:null as any,step:null as any,archiveStatus:'waiting',writes:[] as string[]};
 const db={release(){},async query(sql:string,args:any[]=[]):Promise<any>{
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT id FROM ai_distill.workflows'))return{rows:[{id:'workflow'}],rowCount:1};
  if(sql.startsWith('SELECT status FROM ai_distill.steps'))return{rows:[{status:state.archiveStatus}]};
  if(sql.startsWith('SELECT w.project_id'))return{rows:[{project_id:'project'}]};
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs'))return{rows:sql.includes('ordinal=5')?[]:[{config:state.config}]};
  if(sql.includes('FROM ai_distill.project_answer_models'))return{rows:[],rowCount:0};
  if(sql.includes('s.status AS step_status'))return{rows:state.previous?[{...state.previous,step_status:state.step?.status,step_result:state.step?.result}]:[]};
  if(sql.startsWith('SELECT a.id,a.status,a.input,a.result'))return{rows:[state.question]};
  if(sql.startsWith('SELECT DISTINCT ON'))return{rows:[state.answer]};
  if(sql.startsWith("SELECT id,input->'context'"))return{rows:[state.score]};
  if(sql.startsWith('INSERT INTO ai_distill.step_attempts')){state.writes.push(sql);state.previous={id:args[1],status:'succeeded',input:JSON.parse(args[2]),result:JSON.parse(args[3])};return{rowCount:1,rows:[]};}
  if(sql.startsWith('UPDATE ai_distill.steps SET implemented=true')){state.writes.push(sql);state.step={status:args[2],result:JSON.parse(args[1])};return{rowCount:1,rows:[]};}
  if(sql.startsWith('UPDATE ')){state.writes.push(sql);return{rowCount:1,rows:[]};}
  throw new Error(`unexpected acceptance SQL: ${sql}`);
 }};
 return{state,pool:{connect:async()=>db,query:db.query} as any};
}

test('同依据连续达标判断复用最新记录，不写入或使下游失效',async()=>{
 const f=acceptanceFixture();const first=await runAcceptance(f.pool,'workflow');expect(first.reused).toBe(false);
 const writes=f.state.writes.length;const second=await runAcceptance(f.pool,'workflow');
 expect(second).toEqual({...first,reused:true});expect(f.state.writes).toHaveLength(writes);
});

test.each(['threshold','score','question','answer','rubric','model','algorithm','invalidated','failed_latest','waiting'])('依据或当前结果变化后正常更新：%s',async change=>{
 const f=acceptanceFixture();await runAcceptance(f.pool,'workflow');const writes=f.state.writes.length;
 if(change==='threshold')f.state.config.minimum_score_by_model.qwen=7;
 if(change==='score')f.state.score.result.report.total=6;
 if(change==='question')f.state.question.result.question_version='qv3';
 if(change==='answer')f.state.answer.result.text='新答案';
 if(change==='rubric')f.state.question.result.rubric[0]!.criterion='新判据';
 if(change==='model')f.state.config={required_models:['other-model'],minimum_score_by_model:{'other-model':8}};
 if(change==='algorithm'){f.state.previous.result.decision='accepted';f.state.step.result.decision='accepted';}
 if(change==='invalidated')f.state.step={status:'waiting',result:null};
 if(change==='failed_latest')f.state.previous.status='failed';
 if(change==='waiting')f.state.answer.status='running';
 expect((await runAcceptance(f.pool,'workflow')).reused).toBe(false);expect(f.state.writes.length).toBeGreaterThan(writes);
 if(change==='waiting'){
  const currentWrites=f.state.writes.length;
  expect((await runAcceptance(f.pool,'workflow')).reused).toBe(true);expect(f.state.writes).toHaveLength(currentWrites);
 }
});

test('已归档题目继续拒绝重新判定',async()=>{
 const f=acceptanceFixture();await runAcceptance(f.pool,'workflow');f.state.archiveStatus='succeeded';const writes=f.state.writes.length;
 await expect(runAcceptance(f.pool,'workflow')).rejects.toThrow('已归档');expect(f.state.writes).toHaveLength(writes);
});
