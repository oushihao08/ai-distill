/** 验证题目草稿、附件、rubric 与标答隐私的结构约束。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {validateDraft,type Draft} from './validate';
const materials=[{id:'attachment-1',text:'合同金额100元'}];
const draft:Draft={task_name:'金额核算',task_type:'合同计算',header:{industry_l1:'待确认',industry_l2:'待确认',task_form:'single_round',occupation_l1:'待确认',occupation_l2:'待确认'},question:'合同金额多少？',attachment_ids:['attachment-1'],rubric:[{id:'amount',criterion:'准确写明100元；金额错误得零分',max_score:1}],answer_approach:'核对金额条款',reference_answer:'100元',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
test('新出题契约保留完整扣分否决规则和业务元数据',()=>{
 const rubric=[{id:'deduct',criterion:'金额错误',rule:'出现错误扣7分',metadata:{dimension:'专业质量',score:-7}},{id:'veto',criterion:'不可用',rule:'单独否决，不计入分数',metadata:{score:null}}];
 expect(validateDraft({...draft,rubric},materials,'model_report_v1').rubric).toEqual(rubric);
 expect(()=>validateDraft({...draft,rubric},materials)).toThrow();
});
test('新出题契约仍拒绝缺规则、重复编号及非法业务元数据',()=>{
 for(const rubric of [[{id:'x',criterion:'判断',rule:''}],[{id:'x',criterion:'判断',rule:'按规则',metadata:{bad:Infinity}}],[{id:'x',criterion:'判断',rule:'规则'},{id:'x',criterion:'判断',rule:'规则'}]])expect(()=>validateDraft({...draft,rubric},materials,'model_report_v1')).toThrow();
});
test('complete draft keeps reference private and strips model selected versions',()=>{
 const result=validateDraft({...draft,question_version:'forged',quality_check:{passed:true}},materials);
 expect(result).toEqual(draft);expect(result).not.toHaveProperty('quality_check');expect(result).not.toHaveProperty('question_version');
});
test('missing or foreign attachments and duplicated rubric IDs are rejected',()=>{
 for(const raw of [{...draft,attachment_ids:[]},{...draft,attachment_ids:['foreign']},{...draft,attachment_ids:['attachment-1','attachment-1']},{...draft,rubric:[draft.rubric[0],draft.rubric[0]]}])expect(()=>validateDraft(raw,materials)).toThrow();
});
test('empty full reference and invalid score cannot become a valid draft',()=>{
 expect(()=>validateDraft({...draft,reference_answer:' '},materials)).toThrow();
 for(const max_score of [0,-1,NaN,Infinity])expect(()=>validateDraft({...draft,rubric:[{...draft.rubric[0],max_score}]},materials)).toThrow();
});
test('unsupported delivery requirements are rejected before publication',()=>{
 expect(()=>validateDraft({...draft,answer_requirements:{input_mode:'text',output_mode:'file',tools:['python']}},materials)).toThrow('被测作答器只接收文字');
});
