/** 验证达标门槛和返修重试、时长、调用预算的显式配置限制。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {validateAcceptanceConfig,validateRevisionBudget} from './config';
test('revision budget validates independently of legacy model thresholds',()=>{
 expect(validateRevisionBudget({max_calls:0,max_content_revisions:0})).toEqual({max_calls:0,max_content_revisions:0});
 expect(validateRevisionBudget(undefined)).toBeUndefined();
 for(const value of [null,[],{max_calls:-1},{max_duration_ms:0},{calls:1}])expect(()=>validateRevisionBudget(value)).toThrow();
});
test('acceptance config requires explicit model set and each model threshold',()=>{expect(validateAcceptanceConfig({required_models:['qwen','kimi'],minimum_score_by_model:{qwen:8,kimi:7}})).toMatchObject({required_models:['qwen','kimi']});for(const config of [{required_models:[],minimum_score_by_model:{}},{required_models:['qwen'],minimum_score_by_model:{}},{required_models:['qwen'],minimum_score_by_model:{qwen:-1}},{required_models:['qwen'],minimum_score_by_model:{qwen:101}},{required_models:['qwen'],minimum_score_by_model:{qwen:8,kimi:7}}])expect(()=>validateAcceptanceConfig(config)).toThrow();});
test('revision budgets accept only explicit bounded non-negative integers',()=>{expect(validateAcceptanceConfig({required_models:['qwen'],minimum_score_by_model:{qwen:8},revision_budget:{max_content_revisions:3,max_technical_retries:2,max_calls:8,max_duration_ms:30000}}).revision_budget?.max_content_revisions).toBe(3);expect(()=>validateAcceptanceConfig({required_models:['qwen'],minimum_score_by_model:{qwen:8},revision_budget:{max_calls:-1}})).toThrow();});
