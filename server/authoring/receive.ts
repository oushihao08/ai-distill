/**
 * 职责：出题结果兼容转换，不执行内容和格式准入。
 * 关键方法与用途：`validateDraft()` 接收JSON题包并派生兼容字段。
 * 使用场景：由 `executor.ts` 与 `jobs.ts` 在出题结果写入前调用。
 * 项目差异：同源派生通过 lifecycle/steps 注册策略；此入口只做通用缺省/兼容字段，不新增准入。
 */
import type {WorkContent} from './work-contract';
import {projectStepPolicies,resolveStepProjectKey} from '../lifecycle/steps';
import {formatCriterionRule} from '../lifecycle/default-projection';
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
export interface DraftValidationOptions {project_key?:string|null;requireHarborMetadata?:boolean;contentContract?:'work_legal_v1'}
export type ModelDraft=Omit<Draft,'rubric'>&{rubric:ModelRubricItem[]}&Partial<WorkContent>;
/** 无内容准入的接收转换；完整保留模型字段，兼容下游读取。 */
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract?:'legacy',options?:DraftValidationOptions):Draft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract:'model_report_v1',options?:DraftValidationOptions):ModelDraft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract:'legacy'|'model_report_v1',options?:DraftValidationOptions):Draft|ModelDraft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],_contract:'legacy'|'model_report_v1'='legacy',options:DraftValidationOptions={}):Draft|ModelDraft{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('出题结果须为JSON对象');
 let value=structuredClone(raw) as Record<string,any>;
 value=projectStepPolicies.normalize.execute(resolveStepProjectKey({project_key:options.project_key,content_contract:options.contentContract??value.content_contract}),{value,contentContract:options.contentContract});
 value.rubric=(Array.isArray(value.rubric)?value.rubric:[]).map((item:any)=>({...item,...(item?.metadata?{criterion:item.criterion??item.metadata.statement??'',rule:item.rule??formatCriterionRule(item.metadata)}:{})}));
 return {...value,task_name:value.task_name??'',task_type:value.task_type??'',header:value.header??{},question:value.question??'',attachment_ids:value.attachment_ids??materials.map(m=>m.id),answer_approach:value.answer_approach??'',reference_answer:value.reference_answer??'',answer_requirements:value.answer_requirements??{input_mode:'text',output_mode:'text',tools:[]}} as Draft|ModelDraft;
}
