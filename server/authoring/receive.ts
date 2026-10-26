/**
 * 职责：出题结果兼容转换，不执行内容和格式准入。
 * 关键方法与用途：`validateDraft()` 接收JSON题包并派生兼容字段。
 * 使用场景：由 `executor.ts` 与 `jobs.ts` 在出题结果写入前调用。
 */
import {projectReference,projectRule,type WorkContent} from './work-contract';
export interface Draft {
 task_name:string;task_type:string;
 header:{industry_l1:string;industry_l2:string;task_form:'single_round';occupation_l1:string;occupation_l2:string};
 question:string;attachment_ids:string[];
 rubric:{id:string;criterion:string;max_score:number}[];
 answer_approach:string;
 reference_answer:string;
 answer_requirements:{input_mode:'text'|'image';output_mode:'text'|'file';tools:string[]};
}
export interface ModelRubricItem {id:string;criterion:string;rule:string;metadata?:Record<string,unknown>}
export interface DraftValidationOptions {requireHarborMetadata?:boolean;contentContract?:'work_legal_v1'}
export type ModelDraft=Omit<Draft,'rubric'>&{rubric:ModelRubricItem[]}&Partial<WorkContent>;
/** 无内容准入的接收转换；完整保留模型字段，兼容下游读取。 */
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract?:'legacy',options?:DraftValidationOptions):Draft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract:'model_report_v1',options?:DraftValidationOptions):ModelDraft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract:'legacy'|'model_report_v1',options?:DraftValidationOptions):Draft|ModelDraft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],_contract:'legacy'|'model_report_v1'='legacy',options:DraftValidationOptions={}):Draft|ModelDraft{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('出题结果须为JSON对象');
 const value=structuredClone(raw) as Record<string,any>;
 if(options.contentContract==='work_legal_v1'||value.content_contract==='work_legal_v1'){
  const instruction=value.task_metadata?.instruction;
  if(!value.question&&instruction){
   const numbered=(entries:any[])=>entries.map((entry,index)=>`${index+1}. ${entry}`).join('\n');
   value.question=[instruction.background?`背景\n${instruction.background}`:'',Array.isArray(instruction.requests)?`委托方诉求\n${numbered(instruction.requests)}`:'',Array.isArray(value.deliverables)?`交付物要求\n${numbered(value.deliverables.map((file:any)=>`${file.path}（${file.required?'必交':'选交'}）：${file.description??''}`))}`:'',instruction.baseline_date?`基准日：${instruction.baseline_date}`:'',instruction.hard_constraints?.length?`硬性约束\n${numbered(instruction.hard_constraints)}`:''].filter(Boolean).join('\n\n');
  }
  if(!value.reference_answer&&Array.isArray(value.reference_outputs))value.reference_answer=projectReference({...value,deliverables:value.deliverables??[],reference_outputs:value.reference_outputs.map((output:any)=>({...output,sheets:output.sheets??[]}))});
 }
 value.rubric=(Array.isArray(value.rubric)?value.rubric:[]).map((item:any)=>({...item,...(item?.metadata?{criterion:item.criterion??item.metadata.statement??'',rule:item.rule??projectRule(item.metadata)}:{})}));
 return {...value,task_name:value.task_name??'',task_type:value.task_type??'',header:value.header??{},question:value.question??'',attachment_ids:value.attachment_ids??materials.map(m=>m.id),answer_approach:value.answer_approach??'',reference_answer:value.reference_answer??'',answer_requirements:value.answer_requirements??{input_mode:'text',output_mode:'text',tools:[]}} as Draft|ModelDraft;
}
