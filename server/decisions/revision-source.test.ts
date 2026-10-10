/** 验证返修问题归类、证据保留、材料绑定和预算边界。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {buildFailedEvaluationHistory,classifyRevisionSource,freezeRevisionBudget} from './revision-source';
test('technical retry uses structured provider classification and never parses raw error strings',()=>{
 expect(classifyRevisionSource({ordinal:5,status:'failed',result:{error:{kind:'authentication',retryable:false}}})).toMatchObject({kind:'authentication'});
 expect(classifyRevisionSource({ordinal:5,status:'failed',result:{error:{kind:'service',retryable:true,http_status:503}}})).toMatchObject({kind:'service_transient'});
 expect(classifyRevisionSource({ordinal:5,status:'failed',error:'HTTP 503'})).toMatchObject({kind:'unknown'});
 expect(classifyRevisionSource({ordinal:6,status:'failed',result:{validation:{valid:false},report:{disputes:['评分依据冲突']}}})).toMatchObject({kind:'score',evidence:{reasons:['评分依据冲突']}});
});
test('repair decisions preserve evidence and distinguish grading from question changes',()=>{
 expect(classifyRevisionSource({ordinal:7,result:{decision:'repair',reasons:['score_invalid_or_disputed:model']}})).toMatchObject({kind:'score'});
 expect(classifyRevisionSource({ordinal:7,result:{decision:'repair',reasons:['below_model_threshold:model']}})).toMatchObject({kind:'question'});
 expect(classifyRevisionSource({ordinal:7,result:{decision:'repair',reasons:['at_or_above_model_threshold:model']}})).toMatchObject({kind:'question'});
 expect(classifyRevisionSource({ordinal:7,result:{decision:'accepted',reasons:[]}})).toBeNull();
});
test('rubric-only rejection is distinguished from mixed quality failures',()=>{
 const checks={material_grounding:true,question_complete:true,rubric_consistent:false,reference_answer_complete:true,deliverables_complete:true};
 expect(classifyRevisionSource({ordinal:4,status:'failed',result:{quality_check:{passed:false,checks,issues:[{code:'rubric',detail:'缺少零分条件',blocking:true}]}}})).toMatchObject({kind:'rubric'});
 expect(classifyRevisionSource({ordinal:4,status:'failed',result:{quality_check:{passed:false,checks:{...checks,material_grounding:false},issues:[{detail:'事实无材料依据'}]}}})).toMatchObject({kind:'question'});
 expect(classifyRevisionSource({ordinal:4,status:'failed',error:'运行失败'})).toMatchObject({kind:'unknown'});
});
test('automatic chain requires explicit technical, call and time bounds and preserves zero',()=>{
 expect(freezeRevisionBudget({max_technical_retries:0,max_calls:0,max_duration_ms:10})).toEqual({max_content_revisions:3,max_technical_retries:0,max_calls:0,max_duration_ms:10});
 for(const value of [undefined,{}, {max_calls:10,max_duration_ms:10}])expect(()=>freezeRevisionBudget(value)).toThrow();
});
test('material repair requires anomaly kind, original identity and an existing page index',()=>{
 const source={ordinal:2,status:'succeeded',result:{materials:[{material_id:'original',pages:2}],pages:[{material_id:'original',page:1},{material_id:'original',page:2}],issues:[{material_id:'original',page:2,kind:'empty_page'}]}};
 expect(classifyRevisionSource(source)).toMatchObject({kind:'material',evidence:{materials:[{material_id:'original',pages:[2],kinds:['empty_page']}]}});
 for(const issue of [{material_id:'missing',page:2,kind:'empty_page'},{material_id:'original',page:3,kind:'empty_page'},{material_id:'original',page:2,kind:'unverified_fact'}])expect(classifyRevisionSource({...source,result:{...source.result,issues:[issue]}})).toMatchObject({kind:'unknown'});
});
test('revision history selects at most the latest three failed evaluation rounds and preserves every model reference',()=>{
 const rows=[1,2,3,4,5].map(attempt=>({id:`accept-${attempt}`,attempt,result:{decision:attempt===4?'accepted':'repair',reasons:[`reason-${attempt}`],model_scores:{a:{status:'passed'},b:{status:'not_passed'}},evaluation_records:[{model_id:'a',answer_attempt_id:`answer-${attempt}-a`},{model_id:'b',answer_attempt_id:`answer-${attempt}-b`}]}}));
 expect(buildFailedEvaluationHistory(rows.reverse())).toEqual([5,3,2].map(attempt=>({acceptance_attempt_id:`accept-${attempt}`,attempt,reasons:[`reason-${attempt}`],model_scores:{a:{status:'passed'},b:{status:'not_passed'}},models:[{model_id:'a',answer_attempt_id:`answer-${attempt}-a`},{model_id:'b',answer_attempt_id:`answer-${attempt}-b`}],details_available:true})));
});
