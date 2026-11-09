/** Tests Skill Dependency rubric dimensions at authoring and legacy delivery boundaries. Run with bun test on this file. */
import {describe,expect,test} from 'bun:test';
import {dependencyFields,platformDimensions,validateDependencyDelivery} from './contract';

function sample(dimensions:string[]){
 const rubric=dimensions.map((dimension,index)=>({id:`R${index+1}`,description:`可核对结果${index+1}`,dimension,criterion_type:'Objective',criterion_necessity:'Explicit',type:'Binary',weight:index===2?-3:10,levels:[{score:0,description:'未成立'},{score:1,description:'成立'}]}));
 return{
  question:'读取附件1.txt，使用专项Skill.md完成任务。',reference_answer:'完整处理结果',
  skill_files:[{name:'专项Skill.md',content:'按触发条件处理'}],golden_files:[],
  task_requirements:{input_mode:'text',output_mode:'text',tools:[]},
  platform_metadata:{task_id:'local-1',task_type:'skill dependency',domain_l1:'专业服务',domain_l2:'法律',domain_l3:'执行',domain_l4:'审签',capabilities:['核对'],requires_vl:false,task_description:'审签任务',required_tools:[],domain_knowledge:'执行知识',skill_dependency:'专项规则改变结果',complexity:'C4',complexity_basis:'多项判断承接'},
  platform_rubric:rubric,rubric:rubric.map(({id,description})=>({id,criterion:description,max_score:1})),
  delivery_contract:{version:'skill_dependency_v2',input_names:['附件1.txt'],skill_names:['专项Skill.md'],golden_names:[],dependency_rules:[{skill_name:'专项Skill.md',rule_locator:'规则一',input_name:'附件1.txt',trigger_locator:'材料一',expected_effect:'改变结论',without_skill_result:'漏判',changed_rule:'规则改写',changed_result:'改变处理范围',unchanged_result:'事实不变',rubric_ids:['R1']}],verification:[{file:'instruction.md',check:'content',status:'performed',method:'核对',evidence:'已读回'}]},
 };
}

describe('Skill Dependency rubric dimension',()=>{
 test('new authoring schema accepts only platform dimensions',()=>{
  const dimension=(dependencyFields.platform_rubric.items as any).properties.dimension;
  expect(dimension.enum).toEqual(platformDimensions);
  expect(dimension.enum).not.toContain('交付物内容质量');
 });
 test('valid content dimensions count toward the professional content share',()=>{
  expect(validateDependencyDelivery(sample(['内容质量-数值与计算准确性','内容质量-专业规范','内容质量-事实忠实性']),['附件1.txt']).checks).toBe('structure_and_references_passed');
 });
 test('existing saved questions retain read-only export compatibility',()=>{
  expect(validateDependencyDelivery(sample(['交付物内容质量','交付物内容质量','可信性']),['附件1.txt']).checks).toBe('structure_and_references_passed');
 });
 test('unknown dimensions are rejected by delivery validation',()=>{
  expect(()=>validateDependencyDelivery(sample(['任意维度','内容质量-专业规范','可信性']),['附件1.txt'])).toThrow('字段无效');
 });
});
