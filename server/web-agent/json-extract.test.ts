/**
 * 测试对象：`json-extract.ts`（唯一 JSON 提取、截断判断）。验证边界：纯函数，不涉及浏览器。
 */
import {describe,expect,test} from 'bun:test';
import {extractJsonFromReply,isLikelyTruncatedJson,JsonExtractError} from './json-extract';
import {WebAgentError} from './types';

const fence=(body:string,lang='json')=>'```'+lang+'\n'+body+'\n```';
function reason(text:string){
 try{extractJsonFromReply(text);return 'ok';}
 catch(error){
  if(error instanceof JsonExtractError){expect(error.reason_code).toBe('web_reply_incomplete');expect(error).toBeInstanceOf(WebAgentError);return error.json_reason;}
  throw error;
 }
}

describe('extractJsonFromReply',()=>{
 test('唯一 ```json 围栏，忽略前后说明文字',()=>{
  expect(extractJsonFromReply(`好的，结果如下：\n${fence('{"a":1,"b":[1,2]}')}\n以上。`)).toEqual({a:1,b:[1,2]});
 });
 test('整段可解析的裸 JSON 与数组',()=>{
  expect(extractJsonFromReply('  {"x":"y"}\n')).toEqual({x:'y'});
  expect(extractJsonFromReply('[1,2,3]')).toEqual([1,2,3]);
  expect(extractJsonFromReply('"text"')).toBe('text');
 });
 test('无语言的单个围栏仅在围栏外无其他文字时接受',()=>{
  expect(extractJsonFromReply('```\n{"k":1}\n```')).toEqual({k:1});
  expect(reason('说明\n```\n{"k":1}\n```')).toBe('no_json');
 });
 test('字符串内的围栏与括号不干扰',()=>{
  expect(extractJsonFromReply(fence('{"text":"```not a fence``` } ]"}'))).toEqual({text:'```not a fence``` } ]'});
  expect(extractJsonFromReply('````json\n{"t":"```"}\n````')).toEqual({t:'```'});
 });
 test('多个 json 围栏 → multiple_candidates，不猜测',()=>{
  expect(reason(`${fence('{"a":1}')}\n${fence('{"b":2}')}`)).toBe('multiple_candidates');
 });
 test('围栏未关闭/括号未闭合 → truncated',()=>{
  expect(reason('```json\n{"a":[1,2')).toBe('truncated');
  expect(reason(fence('{"a":[1,2,')) ).toBe('truncated');
  expect(reason('{"a":"unterminated')).toBe('truncated');
 });
 test('结构闭合但不合法 → invalid_json；纯文字 → no_json；空 → empty',()=>{
  expect(reason(fence('{"a":1,}'))).toBe('invalid_json');
  expect(reason('{a:1}')).toBe('invalid_json');
  expect(reason('没有 JSON 的普通回复')).toBe('no_json');
  expect(reason('  \n ')).toBe('empty');
 });
 test('非 json 语言围栏不当作 JSON 候选',()=>{
  expect(reason(fence('{"a":1}','python'))).toBe('no_json');
 });
});

describe('isLikelyTruncatedJson',()=>{
 test('完整 JSON、纯文字、完整围栏均不是截断',()=>{
  expect(isLikelyTruncatedJson('{"a":1}')).toBe(false);
  expect(isLikelyTruncatedJson(fence('{"a":1}'))).toBe(false);
  expect(isLikelyTruncatedJson('你好，这是说明')).toBe(false);
  expect(isLikelyTruncatedJson('')).toBe(false);
 });
 test('括号未闭合、字符串未结束、围栏未关闭是截断',()=>{
  expect(isLikelyTruncatedJson('{"a":[1,2')).toBe(true);
  expect(isLikelyTruncatedJson('{"a":"abc')).toBe(true);
  expect(isLikelyTruncatedJson('```json\n{"a":1}')).toBe(true);
  expect(isLikelyTruncatedJson(fence('{"a":[{"b":1},'))).toBe(true);
 });
 test('结构闭合但语法错误不算截断',()=>{
  expect(isLikelyTruncatedJson(fence('{"a":1,}'))).toBe(false);
 });
});
