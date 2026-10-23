/** 验证达标快照绑定当前题面、答案、rubric、模型集合和继承答案来源。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {buildAcceptanceInput,buildEvaluationRecordRefs,readAcceptanceSnapshot} from './jobs';
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
