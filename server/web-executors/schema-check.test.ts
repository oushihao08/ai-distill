/** 验证网页路径使用的JSON Schema子集结构校验；只覆盖结构，不涉及内容准入。 */
import {test,expect} from 'bun:test';
import {assertMatchesSchema,validateAgainstSchema} from './schema-check';

const schema={type:'object',additionalProperties:false,required:['name','items'],properties:{name:{type:'string',minLength:1},items:{type:'array',minItems:1,items:{type:'object',additionalProperties:false,required:['id','score'],properties:{id:{type:'string'},score:{type:'number',minimum:0,maximum:10}}}},kind:{type:'string',enum:['a','b']}}};

test('accepts a conforming value',()=>{
  expect(validateAgainstSchema({name:'x',items:[{id:'1',score:3}],kind:'a'},schema)).toEqual([]);
  expect(()=>assertMatchesSchema({name:'x',items:[{id:'1',score:10}]},schema)).not.toThrow();
});
test('reports missing, extra, type, enum, range and size problems with paths',()=>{
  const issues=validateAgainstSchema({items:[{id:1,score:11,extra:true}],kind:'z',more:1},schema);
  const text=issues.map(i=>`${i.path}:${i.problem}`).join('|');
  expect(text).toContain('name:缺少必填字段');
  expect(text).toContain('more:不允许的额外字段');
  expect(text).toContain('items[0].id:类型应为string');
  expect(text).toContain('items[0].score:不得大于10');
  expect(text).toContain('items[0].extra:不允许的额外字段');
  expect(text).toContain('kind:取值不在允许范围内');
  expect(validateAgainstSchema({name:'x',items:[]},schema).map(i=>i.problem)).toContain('至少1项');
});
test('assert throws a feedback-friendly error carrying reason_code and details',()=>{
  try{assertMatchesSchema([],schema);throw new Error('should fail');}
  catch(error){expect((error as any).reason_code).toBe('schema_invalid');expect(Array.isArray((error as any).validation_details)).toBe(true);}
});
test('integers satisfy number and non-integers fail integer; missing schema accepts anything',()=>{
  expect(validateAgainstSchema(2,{type:'number'})).toEqual([]);
  expect(validateAgainstSchema(2.5,{type:'integer'}).length).toBe(1);
  expect(validateAgainstSchema({a:1},undefined)).toEqual([]);
});
