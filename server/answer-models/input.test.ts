/** 验证作答输入只包含题面和获准附件，并随实际输入内容生成指纹。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {buildAnswerInput, inputDigest} from './input';
const artifact={id:'a',kind:'redacted_markdown',sha256:'f'.repeat(64),text:'甲公司欠款100元'};
const question={question_version:'v1',question:'应付多少？',attachment_ids:['a'],quality_check:{passed:true},answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric:'秘密',reference_answer:'秘密',target_score:0};
test('answer input selects question and approved attachments only',()=>{const input=buildAnswerInput(question,[artifact]);expect(input.question).toBe('应付多少？');expect(input.materials).toEqual([{name:'附件1',text:artifact.text}]);expect(JSON.stringify(input)).not.toContain('秘密');expect(JSON.stringify(input)).not.toContain('target_score');});
test.each([{...question,question_version:''},{...question,attachment_ids:['missing']},{...question,attachment_ids:['a','a']}])('rejects unavailable or mismatched authoring result',value=>{expect(()=>buildAnswerInput(value,[artifact])).toThrow();});
test('legacy quality report does not reinstate the removed review gate',()=>{expect(buildAnswerInput({...question,quality_check:{passed:false}},[artifact]).question).toBe(question.question);});
test('private artifact and blank text cannot enter answer input',()=>{expect(()=>buildAnswerInput(question,[{...artifact,kind:'private_extracted_pages'}])).toThrow();expect(()=>buildAnswerInput(question,[{...artifact,text:' '}])).toThrow();});
test('digest changes with question or attachment content, preserves exact text',()=>{const a=buildAnswerInput(question,[artifact]);expect(inputDigest(a)).not.toBe(inputDigest({...a,question:a.question+' '}));expect(inputDigest(a)).not.toBe(inputDigest({...a,materials:[{name:'附件1',text:'changed'}]}));});
test.each([undefined,{input_mode:'image',output_mode:'text',tools:[]},{input_mode:'text',output_mode:'files',tools:[]},{input_mode:'text',output_mode:'text',tools:['browser']}])('unsupported or unstated answer capabilities block dispatch',requirements=>{expect(()=>buildAnswerInput({...question,answer_requirements:requirements},[artifact])).toThrow('文字');});
