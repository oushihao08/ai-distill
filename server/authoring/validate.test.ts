/** 验证出题直接接收、原字段保留和兼容派生；不调用数据库或模型，不评价题目专业质量。 */
import {test,expect} from 'bun:test';
import {validateDraft,type Draft} from './receive';
import {projectRule} from './work-contract';
const materials=[{id:'attachment-1',text:'合同金额100元'}];
const draft:Draft={task_name:'金额核算',task_type:'合同计算',header:{industry_l1:'行业',industry_l2:'细分',task_form:'single_round',occupation_l1:'法律',occupation_l2:'律师'},question:'合同金额多少？',attachment_ids:['attachment-1'],rubric:[{id:'amount',criterion:'金额准确',max_score:1}],answer_approach:'核对金额条款',reference_answer:'100元',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
test('通用和model_report题包完整保留模型内容，不再设置内容准入',()=>{
 const raw={...draft,extra_field:{source:'作者说明'},rubric:[{id:'x',criterion:'业务判据',rule:'错误扣7分',metadata:{score:-7}},{id:'x',criterion:'另一个判据',rule:''}]};
 for(const contract of ['legacy','model_report_v1'] as const)expect(validateDraft(raw,materials,contract)).toEqual(raw);
});
test.each([{ids:[]},{ids:['foreign']},{ids:['attachment-1','attachment-1']}])('直接保存原附件引用 $ids，转换器不改写它',({ids})=>{
 const raw={...draft,attachment_ids:ids};expect(validateDraft(raw,materials).attachment_ids).toEqual([...ids]);
});
test('缺少标答、业务映射、格式和分值不阻断题包保存',()=>{
 const raw={...draft,reference_answer:'',rubric:[{id:'x',criterion:'判断',rule:'',metadata:{score:5}}],answer_requirements:{input_mode:'image',output_mode:'file',tools:['python']}};
 expect(validateDraft(raw,materials,'model_report_v1',{requireHarborMetadata:true})).toMatchObject(raw);
});
test('转换不修改原对象，未知字段保留；版本最终由执行器而非模型决定',()=>{
 const raw={...draft,question_version:'作者自填',quality_check:{passed:true}},before=structuredClone(raw);
 const result=validateDraft(raw,materials);expect(result).toEqual(before);expect(raw).toEqual(before);expect(result).not.toBe(raw);
});
test('缺省字段只补下游兼容形态，不添加完成声明或专业内容',()=>{
 const result:any=validateDraft({task_name:'待完成'},materials);expect(result.question).toBe('');expect(result.reference_answer).toBe('');expect(result.attachment_ids).toEqual(['attachment-1']);expect(result).not.toHaveProperty('content_status');
});
test('非对象JSON无法成为题包，错误明确且不冒充保存成功',()=>{
 for(const value of [null,[],1,'文本'])expect(()=>validateDraft(value,materials)).toThrow('JSON对象');
});

test.each([
 {metadata:{statement:'核清金额',type:'binary',priority:'Important',score:7,points:null,trigger_count:null},expected:'核清金额\n判定类型：binary；重要性：Important；分值：7；档数：不适用；计数：按本条一次判定。'},
 {metadata:{statement:'错误扣分',type:'likert',priority:'Detrimental',score:-7,points:5,trigger_count:'每次'},expected:'错误扣分\n判定类型：likert；重要性：Detrimental；分值：-7；档数：5；计数：每次。'},
 {metadata:{statement:'独立否决',type:'binary',priority:'Veto',score:null},expected:'独立否决\n判定类型：binary；重要性：Veto；分值：独立否决，不计分；档数：不适用；计数：按本条一次判定。'},
 {metadata:{statement:'零值保留',type:'binary',priority:'Important',score:0,points:0,trigger_count:''},expected:'零值保留\n判定类型：binary；重要性：Important；分值：0；档数：0；计数：。'},
 {metadata:{score:5},expected:'undefined\n判定类型：undefined；重要性：undefined；分值：5；档数：不适用；计数：按本条一次判定。'},
])('通用接收与Work判据投影保持历史文本和空值语义：$expected',({metadata,expected})=>{
 const before=structuredClone(metadata);
 const received=validateDraft({...draft,rubric:[{id:'r',metadata}]},materials,'model_report_v1');
 expect(received.rubric[0]?.rule).toBe(expected);
 expect(projectRule(metadata)).toBe(expected);
 expect(metadata).toEqual(before);
});
