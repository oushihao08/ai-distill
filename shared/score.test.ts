/** 验证页面及达标显示采用模型报告指标，不把负原始分换算或将空指标当零。 */
import {expect,test} from 'bun:test';
import * as score from './score';
test('新评分使用明确指标，原始分和否决不改变指标',()=>{
 expect(typeof score.evaluationPercentage).toBe('function');
 expect(score.evaluationPercentage({score_contract:'model_report_v1',raw_score:-8,full_score:100,evaluation_percent:12,veto_triggered:true})).toBe(12);
 expect(score.evaluationPercentage({score_contract:'model_report_v1',evaluation_percent:null,score:0,max_score:100})).toBeNull();
 expect(score.evaluationPercentage({score:2,max_score:10})).toBe(20);
 expect(score.evaluationPercentage(undefined)).toBeNull();
});
