/** 验证模型价格快照的字段归一化及费率、币种、来源和有效期校验。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {validateApiPrice} from './prices';
const price={provider:'qwen',model:'qwen-plus',currency:'CNY',input_per_million:2,output_per_million:8,source:'供应商价格表 2026-10',valid_from:'2026-10-01T00:00:00Z'};
test('validates and normalizes explicit model price snapshots',()=>expect(validateApiPrice(price)).toMatchObject({...price,valid_from:'2026-10-01T00:00:00.000Z',valid_until:null}));
test('rejects missing rates, currencies, provenance and invalid periods',()=>{for(const value of [{...price,input_per_million:-1},{...price,currency:'CNY/USD'},{...price,source:''},{...price,valid_until:'2026-09-01T00:00:00Z'},{...price,unexpected:true}])expect(()=>validateApiPrice(value)).toThrow();});
