/**
 * 职责：作答输入契约：校验成功出题结果和题目冻结来源附件引用，白名单化公开成果清单，组装无工具的文字输入及冻结呈现约定。
 * 关键方法与用途：`authoringQuestion()` 提取可作答题面；`buildAnswerInput()` 组装允许输入；`buildAnswerMessage()` 组装实际文字作答消息；`inputDigest()` 计算冻结输入指纹。
 * 使用场景：由 `jobs.ts` 入队前调用，拒绝未完成出题或附件绑定无效的任务。
 * 项目差异：就绪与派发共用生命周期输入策略，项目独有规则在 lifecycle/projects 注册。
 */
import {createHash} from 'node:crypto';
import {projectStepPolicies,resolveStepProjectKey,type ProjectIdentity} from '../lifecycle/steps';
import {canonicalJson} from '../../shared/workflow-config';
import type {QuestionMaterialOrigin} from '../../shared/material-library';
export interface AnswerPresentation {mode:'text_deliverables_v1';deliverables:{name:string;description:string;required:boolean}[];instructions:string}
export interface AnswerPackage {question_version:string;question:string;materials:{name:string;text:string}[];attachments:{id:string;sha256:string}[];system_prompt?:string;presentation?:AnswerPresentation;material_origin?:QuestionMaterialOrigin}
export interface AnswerAttachment {id:string;kind:string;sha256:string;text:string}
export class AnswerInputError extends Error {constructor(message='题目或附件版本无效，不能作答'){super(message);}}
/** 与就绪列表共用实际执行限制；只读取轻量能力字段，不检查或暴露答案。 */
export function answerCapabilityIssue(value:any,project:ProjectIdentity={}):string|null {
 if(value?.task_requirements?.input_mode&&value.task_requirements.input_mode!=='text')return '当前作答器仅支持文字输入；非文字任务不能按文字测试';
 return projectStepPolicies.answerIssue.execute(resolveStepProjectKey({...project,content_contract:value?.content_contract}),value);
}
/** 历史名称兼容；就绪和派发统一调用上方通用策略入口。 */
export const workAnswerCapabilityIssue=answerCapabilityIssue;

export function authoringQuestion(raw:unknown,project:ProjectIdentity={}) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new AnswerInputError();
 const value=raw as Record<string,unknown>;
 const issue=answerCapabilityIssue(value,project);if(issue)throw new AnswerInputError(issue);
 const requirements=value.answer_requirements as Record<string,unknown>|undefined;
 if(!requirements||requirements.input_mode!=='text'||requirements.output_mode!=='text'||!Array.isArray(requirements.tools)||requirements.tools.length)throw new AnswerInputError('当前Qwen执行器仅支持文字输入、文字答案且不执行工具');
 if(typeof value.question_version!=='string'||!value.question_version.trim()||typeof value.question!=='string'||!value.question.trim()||!Array.isArray(value.attachment_ids)||!value.attachment_ids.length||value.attachment_ids.some(id=>typeof id!=='string'||!id)||new Set(value.attachment_ids).size!==value.attachment_ids.length)throw new AnswerInputError();
 const presentation=answerPresentation(value);
 const material_origin=value.material_origin as QuestionMaterialOrigin|undefined;
 return {question_version:value.question_version,question:value.question,attachment_ids:value.attachment_ids as string[],...(presentation?{presentation}:{}),...(material_origin?{material_origin}:{})};
}
/** 各项目共用成果白名单；只适配呈现方式，不把专业工具要求冒充执行能力。 */
export function answerPresentation(value:Record<string,unknown>):AnswerPresentation|undefined{
 if(value.deliverables===undefined)return undefined;
 const entries=Array.isArray(value.deliverables)?value.deliverables:[value.deliverables];
 if(!entries.length)return undefined;
 const deliverables=entries.map((raw:any,index)=>{
  // 这里只呈现公开成果字段，绝不把题目里的rubric/标答等其他元数据注入作答。
  const object=raw&&typeof raw==='object'&&!Array.isArray(raw);
  const name=object?(raw.path??raw.name):undefined,description=object?(raw.description??raw.desc):raw;
  const required=object?raw.required:undefined;
  const knownRequired=required===undefined||typeof required==='boolean'||required==='true'||required==='false';
  const text=(v:unknown)=>typeof v==='string'?v:v===undefined?'':JSON.stringify(v);
  return {name:typeof name==='string'&&name.trim()?name:`成果${index+1}`,
   description:[text(description),...(name!==undefined&&typeof name!=='string'?[`原始名称：${text(name)}`]:[]),...(!knownRequired?[`原始必交标记（未解释）：${text(required)}`]:[])].filter(Boolean).join('\n'),
   required:required===undefined||required===true||required==='true'};
 });
 return {mode:'text_deliverables_v1',deliverables,instructions:'本轮使用文字呈现成果。按成果名称分节，在回复中完整给出正文、表格及计算过程；不代表实际创建文件。保留题目的专业要求，不提供空标题或仅说明将如何办理。当前不调用外部工具，不得声称已完成外部检索、读取未提供内容或实施实际操作；无法核验处明确说明依据、条件与限制。'};
}
/** 实际发往模型的用户题面；原题面单独冻结，方便同版绑定与评分。 */
export function buildAnswerMessage(input:AnswerPackage):string{
 return input.presentation?[input.question,'【本轮成果呈现方式】',input.presentation.instructions,'【成果清单】',...input.presentation.deliverables.map(d=>JSON.stringify(d))].join('\n\n'):input.question;
}
export function buildAnswerInput(raw:unknown,artifacts:AnswerAttachment[],project:ProjectIdentity={}):AnswerPackage {
 const question=authoringQuestion(raw,project);
 const selected=question.attachment_ids.map(id=>{
  const matches=artifacts.filter(a=>a.id===id);const a=matches[0];
   const expectedKind=question.material_origin?.kind==='library_v1'&&question.material_origin.material_mode==='original'?'source_markdown':'redacted_markdown';
   if(matches.length!==1||!a||a.kind!==expectedKind||!/^[a-f0-9]{64}$/.test(a.sha256)||typeof a.text!=='string'||!a.text.trim())throw new AnswerInputError();
  return a;
 });
 return {question_version:question.question_version,question:question.question,materials:selected.map((a,i)=>({name:`附件${i+1}`,text:a.text})),attachments:selected.map(a=>({id:a.id,sha256:a.sha256})),...(question.presentation?{presentation:question.presentation}:{}),...(question.material_origin?{material_origin:question.material_origin}:{})};
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
