/**
 * 职责：出题产物契约：校验题面、附件、rubric 和标答的结构与完整性。
 * 关键方法与用途：`validateDraft()` 校验模型返回的题目草稿及其附件引用。
 * 使用场景：由 `executor.ts` 与 `jobs.ts` 在出题结果写入前调用。
 */
import {normalizeWorkQuestion,type WorkContent} from './work-contract';
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
const record=(raw:unknown):Record<string,any>=>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('出题或质检结果结构无效');
 return raw as Record<string,any>;
};
const text=(value:unknown,max=2_000_000):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract?:'legacy',options?:DraftValidationOptions):Draft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract:'model_report_v1',options?:DraftValidationOptions):ModelDraft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract:'legacy'|'model_report_v1',options?:DraftValidationOptions):Draft|ModelDraft;
export function validateDraft(raw:unknown,materials:{id:string;text:string}[],contract:'legacy'|'model_report_v1'='legacy',options:DraftValidationOptions={}):Draft|ModelDraft{
 if(contract!=='legacy'&&contract!=='model_report_v1')throw new Error('出题契约无效');
 if(options.requireHarborMetadata&&contract!=='model_report_v1')throw new Error('Work 法律全场景出题必须使用 model_report_v1，才能保留 Harbor 元数据');
 const isWork=options.contentContract==='work_legal_v1';
 if((raw as any)?.content_contract&&!isWork)throw new Error('出题内容契约与冻结配置不一致');
 if(isWork&&contract!=='model_report_v1')throw new Error('Work内容契约需要model_report_v1评分');
 const value=record(isWork?normalizeWorkQuestion(raw,materials):raw);
 if(!materials.length||materials.length>(isWork?1000:100)||materials.some(m=>!text(m.id,160)||!text(m.text,8_000_000))||new Set(materials.map(m=>m.id)).size!==materials.length)throw new Error('出题附件输入无效');
 const header=record(value.header);
 if(!text(value.task_name,500)||!text(value.task_type,500)||!text(header.industry_l1,500)||!text(header.industry_l2,500)||header.task_form!=='single_round'||!text(header.occupation_l1,500)||!text(header.occupation_l2,500)||!text(value.answer_approach,200_000))throw new Error('题目名称、表头或作答思路缺失');
 if(!text(value.question)||!text(value.reference_answer))throw new Error('题面或完整标答缺失');
 if(!Array.isArray(value.attachment_ids)||!value.attachment_ids.length||value.attachment_ids.length>(isWork?1000:100)||value.attachment_ids.some((id:unknown)=>!text(id,160)||!materials.some(m=>m.id===id))||new Set(value.attachment_ids).size!==value.attachment_ids.length)throw Object.assign(new Error('题目返回的附件 ID 缺失、重复或不属于本题材料'),{reason_code:'attachment_reference_invalid'});
 if(!Array.isArray(value.rubric)||!value.rubric.length||value.rubric.length>500)throw new Error('评分标准缺失或过大');
 const rubric=value.rubric.map((rawItem:unknown)=>{
  const item=record(rawItem);
  if(contract==='model_report_v1'){
   if(!text(item.id,160)||!text(item.criterion)||!text(item.rule,200_000))throw new Error('评分条目规则缺失或无效');
   let metadata:Record<string,unknown>|undefined;
   if(item.metadata!==undefined){
    record(item.metadata);
    let serialized:string;try{serialized=JSON.stringify(item.metadata,(_key,entry)=>{if(typeof entry==='undefined'||typeof entry==='function'||typeof entry==='bigint'||typeof entry==='number'&&!Number.isFinite(entry))throw new Error('业务元数据不是JSON');return entry;});}catch{throw new Error('业务元数据不是有效JSON');}
    if(serialized.length>64000)throw new Error('业务元数据过大');
    metadata=JSON.parse(serialized);
   }
   return {id:item.id as string,criterion:item.criterion as string,rule:item.rule as string,...(metadata?{metadata}:{})};
  }
  if(!text(item.id,160)||!text(item.criterion)||typeof item.max_score!=='number'||!Number.isFinite(item.max_score)||item.max_score<=0)throw new Error('评分条目无效');
  return {id:item.id as string,criterion:item.criterion as string,max_score:item.max_score as number};
 });
 if(options.requireHarborMetadata&&!isWork){
  const harbor=rubric.map(item=>'metadata'in item&&item.metadata&&typeof item.metadata==='object'?(item.metadata as Record<string,unknown>).project_context:undefined)
   .map(context=>context&&typeof context==='object'&&!Array.isArray(context)?(context as Record<string,unknown>).harbor:undefined)
   .find(item=>item&&typeof item==='object'&&!Array.isArray(item)) as Record<string,unknown>|undefined;
  if(!harbor)throw new Error('Work 题目缺少 project_context.harbor，不能进入可归档题包');
  // 外部登记身份在归档校验；出题只要求保留专业元数据和输入映射。
  if(!harbor.metadata||typeof harbor.metadata!=='object'||Array.isArray(harbor.metadata))throw new Error('project_context.harbor.metadata 无效');
  const metadata=harbor.metadata as Record<string,unknown>;
  const requiredMetadata=['domain_l2','capabilities','vl_dependency','source_note','tools','task_complexity','tool_set','skill_set','expected_tool_dependencies','expected_skill_dependencies','deliverables'];
  if(requiredMetadata.some(key=>!Object.hasOwn(metadata,key))||!Array.isArray(metadata.deliverables)||!metadata.deliverables.length)throw new Error('project_context.harbor.metadata 未完整映射 Harbor 必填字段或交付清单');
  if(!Array.isArray(harbor.input_files)||harbor.input_files.length!==materials.length||harbor.input_files.some((rawFile,index)=>{
   if(!rawFile||typeof rawFile!=='object'||Array.isArray(rawFile))return true;
   const file=rawFile as Record<string,unknown>;
   return file.path!==`材料-${String(index+1).padStart(3,'0')}.md`||!text(file.description,2000);
  }))throw new Error('project_context.harbor.input_files 必须逐份对应归档生成的脱敏材料并提供说明');
 }
 if(new Set(rubric.map(r=>r.id)).size!==rubric.length||contract==='legacy'&&!Number.isFinite(rubric.reduce((sum,r)=>sum+('max_score' in r&&typeof r.max_score==='number'?r.max_score:0),0)))throw new Error('评分条目重复或满分无效');
 const requirements=record(value.answer_requirements);
 if(!['text','image'].includes(requirements.input_mode)||!['text','file'].includes(requirements.output_mode)||!Array.isArray(requirements.tools)||requirements.tools.length>100||requirements.tools.some((tool:unknown)=>!text(tool,160))||new Set(requirements.tools).size!==requirements.tools.length)throw new Error('作答能力声明无效');
 if(requirements.input_mode!=='text'||requirements.output_mode!=='text'||requirements.tools.length)throw Object.assign(new Error('被测作答器只接收文字、返回文字且不调用工具；作者Codex使用的工具不属于作答器能力'),{reason_code:'unsupported_answer_requirements'});
 return {...(isWork?value:{}),task_name:value.task_name,task_type:value.task_type,header:{industry_l1:header.industry_l1,industry_l2:header.industry_l2,task_form:'single_round',occupation_l1:header.occupation_l1,occupation_l2:header.occupation_l2},question:value.question,attachment_ids:[...value.attachment_ids],rubric,answer_approach:value.answer_approach,reference_answer:value.reference_answer,answer_requirements:{input_mode:requirements.input_mode,output_mode:requirements.output_mode,tools:[...requirements.tools]}} as Draft|ModelDraft;
}
