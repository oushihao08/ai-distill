/** 验证作答输入只包含题面和获准附件，并随实际输入内容生成指纹。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {buildAnswerInput, buildAnswerMessage, inputDigest, matchesInputDigest} from './input';
const artifact={id:'a',kind:'redacted_markdown',sha256:'f'.repeat(64),text:'甲公司欠款100元'};
const question={question_version:'v1',question:'应付多少？',attachment_ids:['a'],quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric:'秘密',reference_answer:'秘密',target_score:0};
test('answer input selects question and approved attachments only',()=>{const input=buildAnswerInput(question,[artifact]);expect(input.question).toBe('应付多少？');expect(input.materials).toEqual([{name:'附件1',text:artifact.text}]);expect(JSON.stringify(input)).not.toContain('秘密');expect(JSON.stringify(input)).not.toContain('target_score');});
test.each([{...question,question_version:''},{...question,attachment_ids:['missing']},{...question,attachment_ids:['a','a']}])('rejects unavailable or mismatched authoring result',value=>{expect(()=>buildAnswerInput(value,[artifact])).toThrow();});
test('legacy quality report does not reinstate the removed review gate',()=>{expect(buildAnswerInput({...question,quality_check:{passed:false}},[artifact]).question).toBe(question.question);});
test('private artifact and blank text cannot enter answer input',()=>{expect(()=>buildAnswerInput(question,[{...artifact,kind:'private_extracted_pages'}])).toThrow();expect(()=>buildAnswerInput(question,[{...artifact,text:' '}])).toThrow();});
test('digest changes with question or attachment content, preserves exact text',()=>{const a=buildAnswerInput(question,[artifact]);expect(inputDigest(a)).not.toBe(inputDigest({...a,question:a.question+' '}));expect(inputDigest(a)).not.toBe(inputDigest({...a,materials:[{name:'附件1',text:'changed'}]}));});
test.each([undefined,{input_mode:'image',output_mode:'text',tools:[]},{input_mode:'text',output_mode:'files',tools:[]},{input_mode:'text',output_mode:'text',tools:['browser']}])('unsupported or unstated answer capabilities block dispatch',requirements=>{expect(()=>buildAnswerInput({...question,answer_requirements:requirements},[artifact])).toThrow('文字');});

const deliverables=[{id:'D1',path:'意见.md',description:'完整法律意见',required:true}];
const fileTask={...question,content_contract:'work_legal_v1',content_status:{status:'complete'},task_requirements:{input_mode:'text',output_mode:'file',tools:[]},deliverables};
test('完整Work题按成果清单生成文字呈现快照',()=>{
 const input=buildAnswerInput(fileTask,[artifact]) as any;
 expect(input.question).toBe(question.question);
 expect(input.presentation).toMatchObject({mode:'text_deliverables_v1',deliverables:[{name:'意见.md',description:'完整法律意见',required:true}]});
 expect(input.presentation.instructions).toContain('不代表实际创建文件');
 expect(JSON.stringify(input)).not.toContain('秘密');
});
test('其他项目带成果清单也使用文字呈现，元数据不进入作答',()=>{
 const input=buildAnswerInput({...question,deliverables},[artifact]) as any;
 expect(input.presentation?.deliverables).toHaveLength(1);expect(input.presentation.deliverables[0]).not.toHaveProperty('id');
});
test('草稿与非文字输入不因成果文字呈现被放开',()=>{
 expect(()=>buildAnswerInput({...fileTask,content_status:{status:'draft'}},[artifact])).toThrow('草稿');
 expect(()=>buildAnswerInput({...fileTask,task_requirements:{...fileTask.task_requirements,input_mode:'image'}},[artifact])).toThrow('文字');
});
test('缺省说明不阻断成果呈现，名称与要求仍冻结',()=>{
 expect(buildAnswerInput({...question,deliverables:[{path:'意见.md',required:true}]},[artifact]).presentation?.deliverables).toEqual([{name:'意见.md',description:'',required:true}]);
});

test('实际作答消息包含成果且快照对清单变化敏感，JSONB键序不影响新增字段',()=>{
 const input=buildAnswerInput(fileTask,[artifact]);expect(buildAnswerMessage(input)).toContain('意见.md');
 const changed=buildAnswerInput({...fileTask,deliverables:[{...deliverables[0],description:'不同要求'}]},[artifact]);expect(inputDigest(input)).not.toBe(inputDigest(changed));
 const shuffled={...input,presentation:{instructions:input.presentation!.instructions,deliverables:input.presentation!.deliverables.map(d=>({required:d.required,description:d.description,name:d.name})),mode:input.presentation!.mode}};
 expect(inputDigest(input)).toBe(inputDigest(shuffled));
});

test('文字成果快照在所有对象键重排后仍保持同一指纹',()=>{
 const input={...buildAnswerInput(fileTask,[artifact]),system_prompt:'文字作答'};
 const reorder=(v:any):any=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reorder(v[k])])):v;
 expect(inputDigest(input)).toBe(inputDigest(reorder(input)));
});

test('兼容已派发的文字呈现摘要，正文变化仍拒绝',()=>{
 const input=buildAnswerInput(fileTask,[artifact]);
 const legacy=JSON.stringify(input);const digest=require('node:crypto').createHash('sha256').update(legacy).digest('hex');
 expect(matchesInputDigest(input,digest)).toBe(true);
 expect(matchesInputDigest({...input,question:'篡改'},digest)).toBe(false);
});

test('large inputs and long version identifiers are preserved without arbitrary character limits',()=>{
 const text='文'.repeat(8_000_001),q='题'.repeat(2_000_001);
 const input=buildAnswerInput({...question,question_version:'v'.repeat(161),question:q},[{...artifact,text}]);
 expect(input.question).toBe(q);expect(input.materials[0]!.text).toBe(text);
 const artifacts=Array.from({length:101},(_,i)=>({...artifact,id:`a${i}`}));
 expect(buildAnswerInput({...question,attachment_ids:artifacts.map(a=>a.id)},artifacts).attachments).toHaveLength(101);
});
test('optional presentation preserves incomplete values and duplicate names without exposing private metadata',()=>{
 const input=buildAnswerInput({...question,deliverables:[{name:'成果',desc:'说明',required:'false',rubric:'秘密'},{path:'成果',description:'长'.repeat(10001)},{path:12,required:'未注明'},'原样任务要求']},[artifact]);
 expect(input.presentation?.deliverables[0]).toEqual({name:'成果',description:'说明',required:false});
 expect(input.presentation?.deliverables[1]?.description).toHaveLength(10001);
 expect(buildAnswerMessage(input)).toContain('原始必交标记');expect(buildAnswerMessage(input)).toContain('原样任务要求');expect(JSON.stringify(input)).not.toContain('秘密');
 expect(buildAnswerInput({...question,deliverables:[]},[artifact]).presentation).toBeUndefined();
});
