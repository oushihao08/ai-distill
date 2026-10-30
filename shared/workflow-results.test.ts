/** 验证当前答案、评分和达标汇总的读取边界及历史缺字段处理。 */
import {expect,test} from 'bun:test';
import type {AnswerStepModelSummary} from './workflow-results';

const modulePromise=import('./workflow-results').catch(()=>undefined);
test('新评分摘要保留模型指标并拒绝非法新字段',async()=>{
 const module=await modulePromise;
 const row={model_id:'m1',answer_status:'succeeded',score_status:'succeeded',score_contract:'model_report_v1',raw_score:-7,full_score:100,evaluation_percent:12,veto_triggered:true};
 expect(module!.readScoreStepResult({models:[row]})?.models[0]).toMatchObject(row);
 for(const changes of [{evaluation_percent:101},{evaluation_percent:'12'},{raw_score:Infinity},{veto_triggered:'yes'},{score_contract:'other'}])expect(module!.readScoreStepResult({models:[{...row,...changes}]})).toBeUndefined();
});

test('reads current answer summaries and rejects incomplete model rows',async()=>{
 const module=await modulePromise;
 expect(typeof module?.readAnswerStepResult).toBe('function');
 const historical:AnswerStepModelSummary={model_id:'legacy',status:'succeeded',minimum_score:null};
 expect(module!.readAnswerStepResult({models:[historical]})?.models[0]?.minimum_score).toBeNull();
 expect(module!.readAnswerStepResult({models:[{model_id:'m1',name:'模型一',attempt_id:'a1',status:'succeeded'}]})?.models[0]?.status).toBe('succeeded');
 expect(module!.readAnswerStepResult({models:[{model_id:'m1',status:'skipped',outcome:'qualified_timeout_unscored',generation_activity:{event_count:4}},{model_id:'m2',status:'failed'}]})?.models).toHaveLength(2);
 expect(module!.readAnswerStepResult({models:[{status:'succeeded'}]})?.models[0]).toMatchObject({status:'succeeded'});
 expect(module!.readAnswerStepResult({models:[{model_id:'m1',status:'unknown'}]})).toBeUndefined();
});

test('reads current score summaries and rejects invalid score values',async()=>{
 const module=await modulePromise;
 expect(typeof module?.readScoreStepResult).toBe('function');
 expect(module!.readScoreStepResult({models:[{model_id:'m1',name:'模型一',answer_status:'succeeded',score_status:'failed',score:null,max_score:null}]})?.models[0]?.score_status).toBe('failed');
 expect(module!.readScoreStepResult({models:[{model_id:'m1',answer_status:'succeeded',score_status:'succeeded',score:8,max_score:20,valid:true},{model_id:'m2',answer_status:'failed',score_status:'waiting',score:null,max_score:null,valid:false}]})?.models).toHaveLength(2);
 expect(module!.readScoreStepResult({models:[{answer_status:'succeeded',score_status:'succeeded'}]})?.models).toHaveLength(1);
 expect(module!.readScoreStepResult({models:[{answer_status:'succeeded',score_status:'succeeded',score:'8'}]})).toBeUndefined();
});

test('reads acceptance decisions only when reasons and score summaries are valid',async()=>{
 const module=await modulePromise;
 expect(typeof module?.readAcceptanceResult).toBe('function');
 expect(module!.readAcceptanceResult({decision:'accepted',reasons:[],model_scores:{m1:{status:'passed',threshold:50,score:8,max_score:20,percentage:40}}})?.decision).toBe('accepted');
 expect(module!.readAcceptanceResult({decision:'repair',reasons:['未达标'],model_scores:{m1:{status:'not_passed',threshold:50,score:12,max_score:20,percentage:60}}})?.decision).toBe('repair');
 expect(module!.readAcceptanceResult({decision:'waiting',reasons:['等待评分']})?.decision).toBe('waiting');
 expect(module!.readAcceptanceResult({decision:'quarantine',reasons:['无效评分']})?.decision).toBe('quarantine');
 expect(module!.readAcceptanceResult({decision:'accepted',model_scores:{}})).toBeUndefined();
});
