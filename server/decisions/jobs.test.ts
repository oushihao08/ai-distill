/** 验证达标快照绑定当前题面、答案、rubric、模型集合和继承答案来源。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {buildAcceptanceInput,buildEvaluationRecordRefs,readAcceptanceSnapshot} from './jobs';
import type {PoolClient} from 'pg';
import type {AcceptanceConfig} from './acceptance';
const config:AcceptanceConfig={required_models:['qwen'],minimum_score_by_model:{qwen:8}};
const question={id:'q1',status:'succeeded',result:{question_version:'qv2',rubric_version:'rv1',quality_check:{passed:true}}};
const answer={id:'a1',model:'qwen',status:'succeeded',result:{question_attempt_id:'q1',question_version:'qv2'}};
const score={answer_attempt_id:'a1',status:'succeeded',result:{binding:{answer_attempt_id:'a1',question_version:'qv2',rubric_version:'rv1'},validation:{valid:true},report:{total:9,max_score:10,disputes:[]}}};
test('acceptance assembly matches latest question, answer and rubric versions',()=>{const input=buildAcceptanceInput({config,question,answers:[answer],scores:[score]});expect(input.question_current).toBe(true);expect(input.quality.status).toBe('passed');expect(input.models[0]).toMatchObject({answer_status:'succeeded',score_status:'succeeded',score_valid:true,binding_matches:true});});
test('acceptance history freezes the answer and score attempt IDs for every selected model',()=>{
 const snapshot={config:{required_models:['qwen','model-b'],minimum_score_by_model:{qwen:8,'model-b':8}},question,answers:[{...answer,result:{...answer.result,answer_sha256:'a'.repeat(64)}},{id:'a2',model:'model-b',status:'succeeded',result:{question_attempt_id:'q1',question_version:'qv2',answer_sha256:'b'.repeat(64)}}],scores:[{...score,id:'s1',result:{...score.result,raw_text:'逐项评分原文'}},{...score,id:'s2',answer_attempt_id:'a2',result:{...score.result,binding:{...score.result.binding,answer_attempt_id:'a2'},raw_text:'第二个模型评分原文'}}]};
 expect(buildEvaluationRecordRefs(snapshot,{qwen:{status:'passed',score:6,max_score:10},'model-b':{status:'not_passed',score:9,max_score:10}})).toEqual([{model_id:'qwen',status:'passed',answer_attempt_id:'a1',score_attempt_id:'s1',question_attempt_id:'q1',question_version:'qv2',rubric_version:'rv1',answer_sha256:'a'.repeat(64),score_sha256:expect.any(String)},{model_id:'model-b',status:'not_passed',answer_attempt_id:'a2',score_attempt_id:'s2',question_attempt_id:'q1',question_version:'qv2',rubric_version:'rv1',answer_sha256:'b'.repeat(64),score_sha256:expect.any(String)}]);
});
test('a score from a different rubric cannot match current answer version',()=>{const input=buildAcceptanceInput({config,question,answers:[answer],scores:[{...score,result:{...score.result,binding:{...score.result.binding,rubric_version:'old'}}}]});expect(input.models[0]?.binding_matches).toBe(false);});
test('quality issues and missing current attempts stay explicit',()=>{expect(buildAcceptanceInput({config,question:{...question,status:'failed',result:{quality_check:{passed:false,issues:[{detail:'题目无法作答'}]}}},answers:[],scores:[]}).quality).toMatchObject({status:'failed',issues:['题目无法作答']});expect(buildAcceptanceInput({config,answers:[answer],scores:[score]}).quality.status).toBe('waiting');});
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

test('rubric-only successor accepts explicitly inherited question provenance, but not arbitrary old answers',()=>{
 const revised={...question,id:'q2',result:{...question.result,rubric_version:'rv2',answer_source_attempt_ids:['q1']}};
 const rescored={...score,result:{...score.result,binding:{...score.result.binding,rubric_version:'rv2'}}};
 expect(buildAcceptanceInput({config,question:revised,answers:[answer],scores:[rescored]}).models[0]?.binding_matches).toBe(true);
 expect(buildAcceptanceInput({config,question:{...revised,result:{...revised.result,answer_source_attempt_ids:[]}},answers:[answer],scores:[rescored]}).models[0]?.binding_matches).toBe(false);
});
