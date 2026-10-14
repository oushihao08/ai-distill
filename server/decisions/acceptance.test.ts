/** 验证百分制逐模型上限、严格小于边界、缺失满分及无效数值处理。
 * 运行方式：由 Bun test 收集；此处更新用例不代表已经运行。
 */
import {test,expect} from 'bun:test';
import {decideAcceptance,type AcceptanceInput} from './acceptance';
const valid:AcceptanceInput={question_current:true,config:{required_models:['qwen','kimi'],minimum_score_by_model:{qwen:50,kimi:50}},models:['qwen','kimi'].map(model=>({model,answer_status:'succeeded',score:9,max_score:20}))};
test('新评分仅比较模型明确给出的指标，不由负原始分或否决改算',()=>{
 const input={...valid,models:valid.models.map(m=>({...m,score_contract:'model_report_v1',score_valid:true,raw_score:-7,full_score:100,evaluation_percent:12,veto_triggered:true}))} as any;
 expect(decideAcceptance(input)).toMatchObject({decision:'accepted',model_scores:{qwen:{percentage:12,raw_score:-7,veto_triggered:true,score_contract:'model_report_v1'}}});
 expect(decideAcceptance({...input,models:input.models.map((m:any)=>({...m,evaluation_percent:null}))}).decision).toBe('waiting');
 expect(decideAcceptance({...input,models:input.models.map((m:any)=>({...m,evaluation_percent:50}))}).decision).toBe('repair');
});
test('each required model must be strictly below its percentage cap, without averaging',()=>{
 expect(decideAcceptance(valid)).toMatchObject({decision:'accepted',model_scores:{qwen:{score:9,max_score:20,percentage:45}}});
 const mixed={...valid,models:valid.models.map(m=>({...m,score:m.model==='qwen'?0:10}))};
 expect(decideAcceptance(mixed)).toMatchObject({decision:'repair',reasons:['at_or_above_model_threshold:kimi']});
});
test('missing configuration or model results wait explicitly',()=>{
 expect(decideAcceptance({...valid,config:undefined})).toMatchObject({decision:'waiting',reasons:['acceptance_config_missing_or_invalid']});
 expect(decideAcceptance({...valid,models:valid.models.slice(0,1)})).toMatchObject({decision:'waiting',reasons:['required_model_missing:kimi']});
 for(const threshold of [null,-1,101,NaN,Infinity])expect(decideAcceptance({...valid,config:{required_models:['qwen'],minimum_score_by_model:{qwen:threshold}}}).decision).toBe('waiting');
});
test('different rubric lengths use the same percentage threshold and equality fails',()=>{
 for(const [score,max_score,decision] of [[7,11,'repair'],[5,15,'accepted'],[9,18,'repair'],[9,20,'accepted'],[10,20,'repair'],[20,20,'repair']] as const){
  expect(decideAcceptance({...valid,models:valid.models.map(m=>({...m,score,max_score}))})).toMatchObject({decision});
 }
});
test('comparison is not rounded to the displayed two decimals',()=>{
 expect(decideAcceptance({...valid,models:valid.models.map(m=>({...m,score:49.999,max_score:100}))}).decision).toBe('accepted');
});
test('missing or invalid maxima and out-of-range scores cannot pass as low scores',()=>{
 for(const max_score of [undefined,0,-1,NaN,Infinity])expect(decideAcceptance({...valid,models:valid.models.map(m=>({...m,max_score}))}).decision).toBe('waiting');
 for(const score of [undefined,-1,21,NaN,Infinity])expect(decideAcceptance({...valid,models:valid.models.map(m=>({...m,score}))}).decision).toBe('waiting');
});
test('stale questions and incomplete answers do not pass',()=>{
 expect(decideAcceptance({...valid,question_current:false}).decision).toBe('quarantine');
 expect(decideAcceptance({...valid,models:valid.models.map(m=>({...m,answer_status:'failed'}))}).decision).toBe('waiting');
});
