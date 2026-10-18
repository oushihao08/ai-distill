/**
 * 职责：作答输入契约：校验成功出题结果和脱敏附件引用，白名单化公开成果清单，组装无工具的文字输入及冻结呈现约定。
 * 关键方法与用途：`authoringQuestion()` 提取可作答题面；`buildAnswerInput()` 组装允许输入；`buildAnswerMessage()` 组装实际文字作答消息；`inputDigest()` 计算冻结输入指纹。
 * 使用场景：由 `jobs.ts` 入队前调用，拒绝未完成出题或附件绑定无效的任务。
 */
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../shared/workflow-config';
import type {QuestionMaterialOrigin} from '../../shared/material-library';
export interface AnswerPresentation {mode:'text_deliverables_v1';deliverables:{name:string;description:string;required:boolean}[];instructions:string}
export interface AnswerPackage {question_version:string;question:string;materials:{name:string;text:string}[];attachments:{id:string;sha256:string}[];system_prompt?:string;presentation?:AnswerPresentation;material_origin?:QuestionMaterialOrigin}
export interface AnswerAttachment {id:string;kind:string;sha256:string;text:string}
export class AnswerInputError extends Error {constructor(message='题目或附件版本无效，不能作答'){super(message);}}
/** 与就绪列表共用实际执行限制；只读取轻量能力字段，不检查或暴露答案。 */
export function workAnswerCapabilityIssue(value:any):string|null{
 if(value?.task_requirements?.input_mode&&value.task_requirements.input_mode!=='text')return '当前作答器仅支持文字输入；非文字任务不能按文字测试';
 if(value?.content_contract!=='work_legal_v1')return null;
 const task=value.task_requirements,status=value.content_status;
 if(status?.status!=='complete')return 'Work题目仍为草稿，不能作答';
 if(!task||task.input_mode!=='text'||!['text','file'].includes(task.output_mode)||!Array.isArray(task.tools))return '当前作答器仅支持文字输入；非文字任务不能按文字测试';
 return null;
}
export function authoringQuestion(raw:unknown) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new AnswerInputError();
 const value=raw as Record<string,unknown>;
 const issue=workAnswerCapabilityIssue(value);if(issue)throw new AnswerInputError(issue);
 const requirements=value.answer_requirements as Record<string,unknown>|undefined;
 if(!requirements||requirements.input_mode!=='text'||requirements.output_mode!=='text'||!Array.isArray(requirements.tools)||requirements.tools.length)throw new AnswerInputError('当前Qwen执行器仅支持文字输入、文字答案且不执行工具');
 if(typeof value.question_version!=='string'||!value.question_version.trim()||value.question_version.length>160||typeof value.question!=='string'||!value.question.trim()||value.question.length>2_000_000||!Array.isArray(value.attachment_ids)||!value.attachment_ids.length||value.attachment_ids.length>100||value.attachment_ids.some(id=>typeof id!=='string'||!id)||new Set(value.attachment_ids).size!==value.attachment_ids.length)throw new AnswerInputError();
 const presentation=answerPresentation(value);
 return {question_version:value.question_version,question:value.question,attachment_ids:value.attachment_ids as string[],...(presentation?{presentation}:{})};
}
/** 各项目共用成果白名单；只适配呈现方式，不把专业工具要求冒充执行能力。 */
export function answerPresentation(value:Record<string,unknown>):AnswerPresentation|undefined{
 if(value.deliverables===undefined)return undefined;
 if(!Array.isArray(value.deliverables)||!value.deliverables.length||value.deliverables.length>100)throw new AnswerInputError('成果清单无效');
 const deliverables=value.deliverables.map((raw:any)=>{
  const description=raw?.description??raw?.desc;
  if(typeof raw?.path!=='string'||!raw.path.trim()||raw.path.length>500||typeof description!=='string'||!description.trim()||description.length>10000||typeof raw.required!=='boolean')throw new AnswerInputError('成果清单字段无效');
  return {name:raw.path,description,required:raw.required};
 });
 if(new Set(deliverables.map(d=>d.name)).size!==deliverables.length)throw new AnswerInputError('成果清单名称重复');
 return {mode:'text_deliverables_v1',deliverables,instructions:'本轮使用文字呈现成果。按成果名称分节，在回复中完整给出正文、表格及计算过程；不代表实际创建文件。保留题目的专业要求，不提供空标题或仅说明将如何办理。当前不调用外部工具，不得声称已完成外部检索、读取未提供内容或实施实际操作；无法核验处明确说明依据、条件与限制。'};
}
/** 实际发往模型的用户题面；原题面单独冻结，方便同版绑定与评分。 */
export function buildAnswerMessage(input:AnswerPackage):string{
 return input.presentation?[input.question,'【本轮成果呈现方式】',input.presentation.instructions,'【成果清单】',...input.presentation.deliverables.map(d=>JSON.stringify(d))].join('\n\n'):input.question;
}
export function buildAnswerInput(raw:unknown,artifacts:AnswerAttachment[]):AnswerPackage {
 const question=authoringQuestion(raw);
 const selected=question.attachment_ids.map(id=>{
  const matches=artifacts.filter(a=>a.id===id);const a=matches[0];
  if(matches.length!==1||!a||a.kind!=='redacted_markdown'||!/^[a-f0-9]{64}$/.test(a.sha256)||typeof a.text!=='string'||!a.text.trim())throw new AnswerInputError();
  return a;
 });
 if(selected.reduce((n,a)=>n+a.text.length,question.question.length)>8_000_000)throw new AnswerInputError('题面和附件过大，不能作答');
 return {question_version:question.question_version,question:question.question,materials:selected.map((a,i)=>({name:`附件${i+1}`,text:a.text})),attachments:selected.map(a=>({id:a.id,sha256:a.sha256})),...(question.presentation?{presentation:question.presentation}:{})};
}
export function inputDigest(input:AnswerPackage):string {
 // 文字成果快照整体规范化；旧无presentation尝试保持原摘要算法。
 if(input.material_origin)return createHash('sha256').update(canonicalJson(input)).digest('hex');
 return createHash('sha256').update(input.presentation?canonicalJson(input):JSON.stringify(input)).digest('hex');
}
/** 兼容最初文字呈现尝试的固定字段摘要；只接受相同内容，不放宽业务绑定。 */
export function matchesInputDigest(input:AnswerPackage,expected:string):boolean{
 if(inputDigest(input)===expected)return true;
 if(!input.presentation)return false;
 const p=input.presentation;
 const legacy={question_version:input.question_version,question:input.question,materials:input.materials.map(m=>({name:m.name,text:m.text})),attachments:input.attachments.map(a=>({id:a.id,sha256:a.sha256})),...(input.system_prompt!==undefined?{system_prompt:input.system_prompt}:{}),presentation:{mode:p.mode,deliverables:p.deliverables.map(d=>({name:d.name,description:d.description,required:d.required})),instructions:p.instructions}};
 return createHash('sha256').update(JSON.stringify(legacy)).digest('hex')===expected;
}
