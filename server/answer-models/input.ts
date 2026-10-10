/**
 * 职责：作答输入契约：校验成功出题结果和脱敏附件引用，组装无工具的文字输入并计算指纹。
 * 关键方法与用途：`authoringQuestion()` 提取可作答题面；`buildAnswerInput()` 组装允许输入；`inputDigest()` 计算冻结输入指纹。
 * 使用场景：由 `jobs.ts` 入队前调用，拒绝未完成出题或附件绑定无效的任务。
 */
import {createHash} from 'node:crypto';
export interface AnswerPackage {question_version:string;question:string;materials:{name:string;text:string}[];attachments:{id:string;sha256:string}[]}
export interface AnswerAttachment {id:string;kind:string;sha256:string;text:string}
export class AnswerInputError extends Error {constructor(message='题目或附件版本无效，不能作答'){super(message);}}
export function authoringQuestion(raw:unknown) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new AnswerInputError();
 const value=raw as Record<string,unknown>;
 const requirements=value.answer_requirements as Record<string,unknown>|undefined;
 if(!requirements||requirements.input_mode!=='text'||requirements.output_mode!=='text'||!Array.isArray(requirements.tools)||requirements.tools.length)throw new AnswerInputError('当前Qwen执行器仅支持文字输入、文字答案且不执行工具');
 if(typeof value.question_version!=='string'||!value.question_version.trim()||value.question_version.length>160||typeof value.question!=='string'||!value.question.trim()||value.question.length>2_000_000||!Array.isArray(value.attachment_ids)||!value.attachment_ids.length||value.attachment_ids.length>100||value.attachment_ids.some(id=>typeof id!=='string'||!id)||new Set(value.attachment_ids).size!==value.attachment_ids.length)throw new AnswerInputError();
 return {question_version:value.question_version,question:value.question,attachment_ids:value.attachment_ids as string[]};
}
export function buildAnswerInput(raw:unknown,artifacts:AnswerAttachment[]):AnswerPackage {
 const question=authoringQuestion(raw);
 const selected=question.attachment_ids.map(id=>{
  const matches=artifacts.filter(a=>a.id===id);const a=matches[0];
  if(matches.length!==1||!a||a.kind!=='redacted_markdown'||!/^[a-f0-9]{64}$/.test(a.sha256)||typeof a.text!=='string'||!a.text.trim())throw new AnswerInputError();
  return a;
 });
 if(selected.reduce((n,a)=>n+a.text.length,question.question.length)>8_000_000)throw new AnswerInputError('题面和附件过大，不能作答');
 return {question_version:question.question_version,question:question.question,materials:selected.map((a,i)=>({name:`附件${i+1}`,text:a.text})),attachments:selected.map(a=>({id:a.id,sha256:a.sha256}))};
}
export function inputDigest(input:AnswerPackage):string {return createHash('sha256').update(JSON.stringify(input)).digest('hex');}
