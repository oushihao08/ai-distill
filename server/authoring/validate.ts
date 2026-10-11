/**
 * 职责：出题产物契约：校验题面、附件、rubric 和标答的结构与完整性。
 * 关键方法与用途：`validateDraft()` 校验模型返回的题目草稿及其附件引用。
 * 使用场景：由 `executor.ts` 与 `jobs.ts` 在出题结果写入前调用。
 */
export interface Draft {
 task_name:string;task_type:string;
 header:{industry_l1:string;industry_l2:string;task_form:'single_round';occupation_l1:string;occupation_l2:string};
 question:string;attachment_ids:string[];
 rubric:{id:string;criterion:string;max_score:number}[];
 answer_approach:string;
 reference_answer:string;
 answer_requirements:{input_mode:'text'|'image';output_mode:'text'|'file';tools:string[]};
}
const record=(raw:unknown):Record<string,any>=>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('出题或质检结果结构无效');
 return raw as Record<string,any>;
};
const text=(value:unknown,max=2_000_000):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[]):Draft{
 const value=record(raw);
 if(!materials.length||materials.length>100||materials.some(m=>!text(m.id,160)||!text(m.text,8_000_000))||new Set(materials.map(m=>m.id)).size!==materials.length)throw new Error('出题附件输入无效');
 const header=record(value.header);
 if(!text(value.task_name,500)||!text(value.task_type,500)||!text(header.industry_l1,500)||!text(header.industry_l2,500)||header.task_form!=='single_round'||!text(header.occupation_l1,500)||!text(header.occupation_l2,500)||!text(value.answer_approach,200_000))throw new Error('题目名称、表头或作答思路缺失');
 if(!text(value.question)||!text(value.reference_answer))throw new Error('题面或完整标答缺失');
 if(!Array.isArray(value.attachment_ids)||!value.attachment_ids.length||value.attachment_ids.length>100||value.attachment_ids.some((id:unknown)=>!text(id,160)||!materials.some(m=>m.id===id))||new Set(value.attachment_ids).size!==value.attachment_ids.length)throw Object.assign(new Error('题目返回的附件 ID 缺失、重复或不属于本题材料'),{reason_code:'attachment_reference_invalid'});
 if(!Array.isArray(value.rubric)||!value.rubric.length||value.rubric.length>500)throw new Error('评分标准缺失或过大');
 const rubric=value.rubric.map((rawItem:unknown)=>{
  const item=record(rawItem);
  if(!text(item.id,160)||!text(item.criterion)||typeof item.max_score!=='number'||!Number.isFinite(item.max_score)||item.max_score<=0)throw new Error('评分条目无效');
  return {id:item.id as string,criterion:item.criterion as string,max_score:item.max_score as number};
 });
 if(new Set(rubric.map((r:{id:string})=>r.id)).size!==rubric.length||!Number.isFinite(rubric.reduce((sum:number,r:{max_score:number})=>sum+r.max_score,0)))throw new Error('评分条目重复或满分无效');
 const requirements=record(value.answer_requirements);
 if(!['text','image'].includes(requirements.input_mode)||!['text','file'].includes(requirements.output_mode)||!Array.isArray(requirements.tools)||requirements.tools.length>100||requirements.tools.some((tool:unknown)=>!text(tool,160))||new Set(requirements.tools).size!==requirements.tools.length)throw new Error('作答能力声明无效');
 if(requirements.input_mode!=='text'||requirements.output_mode!=='text'||requirements.tools.length)throw Object.assign(new Error('被测作答器只接收文字、返回文字且不调用工具；作者Codex使用的工具不属于作答器能力'),{reason_code:'unsupported_answer_requirements'});
 return {task_name:value.task_name,task_type:value.task_type,header:{industry_l1:header.industry_l1,industry_l2:header.industry_l2,task_form:'single_round',occupation_l1:header.occupation_l1,occupation_l2:header.occupation_l2},question:value.question,attachment_ids:[...value.attachment_ids],rubric,answer_approach:value.answer_approach,reference_answer:value.reference_answer,answer_requirements:{input_mode:requirements.input_mode,output_mode:requirements.output_mode,tools:[...requirements.tools]}};
}
