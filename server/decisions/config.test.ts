/** 验证达标门槛的显式配置限制。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {validateAcceptanceConfig} from './config';
test('acceptance config requires explicit model set and each model threshold',()=>{expect(validateAcceptanceConfig({required_models:['qwen','kimi'],minimum_score_by_model:{qwen:8,kimi:7}})).toMatchObject({required_models:['qwen','kimi']});for(const config of [{required_models:[],minimum_score_by_model:{}},{required_models:['qwen'],minimum_score_by_model:{}},{required_models:['qwen'],minimum_score_by_model:{qwen:-1}},{required_models:['qwen'],minimum_score_by_model:{qwen:101}},{required_models:['qwen'],minimum_score_by_model:{qwen:8,kimi:7}}])expect(()=>validateAcceptanceConfig(config)).toThrow();});
