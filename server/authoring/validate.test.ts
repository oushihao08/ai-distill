import {test,expect} from 'bun:test';
import {validateDraft,validateQuality,type Draft} from './validate';
const materials=[{id:'attachment-1',text:'合同金额100元'}];
const draft:Draft={question:'合同金额多少？',attachment_ids:['attachment-1'],rubric:[{id:'amount',criterion:'准确写明100元；金额错误得零分',max_score:1}],reference_answer:'100元',answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
const quality={passed:true,checks:{material_grounding:true,question_complete:true,rubric_consistent:true,reference_answer_complete:true,deliverables_complete:true},issues:[]};
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
test('unsupported delivery requirements are retained for capability rejection',()=>{
 const result=validateDraft({...draft,answer_requirements:{input_mode:'text',output_mode:'file',tools:['python']}},materials);
 expect(result.answer_requirements.output_mode).toBe('file');expect(result.answer_requirements.tools).toEqual(['python']);
});
test('quality pass requires every explicit check and no blocking issue',()=>{
 expect(validateQuality(quality).valid).toBe(true);
 expect(validateQuality({...quality,checks:{...quality.checks,rubric_consistent:false}}).valid).toBe(false);
 expect(validateQuality({...quality,issues:[{code:'conflict',detail:'金额矛盾',blocking:true}]}).valid).toBe(false);
 expect(validateQuality({...quality,passed:false}).valid).toBe(false);
});
test('malformed checks fail closed while nonblocking observations remain recorded',()=>{
 expect(()=>validateQuality({passed:true,issues:[]})).toThrow();
 expect(()=>validateQuality({...quality,issues:[{code:'x',detail:'未确认'}]})).toThrow();
 const result=validateQuality({...quality,issues:[{code:'external',detail:'外部资格待核实',blocking:false}]});
 expect(result.valid).toBe(true);expect(result.report.issues).toHaveLength(1);
});
