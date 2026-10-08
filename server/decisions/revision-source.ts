import {HTTPException} from 'hono/http-exception';
import {validateRevisionBudget} from './config';
import type {IssueKind,RevisionBudget} from './revision';

export interface RevisionSource {ordinal:number;status?:string;result?:any;error?:string|null}
export interface RevisionEvidence {kind:IssueKind;evidence:{reasons?:string[];quality_check?:unknown;error?:string|null;materials?:{material_id:string;pages:number[];kinds:string[]}[]}}
export function classifyRevisionSource(source:RevisionSource):RevisionEvidence|null{
 if(source.status==='failed'&&source.result?.error){
  const error=source.result.error;
  if(error.kind==='authentication'||error.kind==='quota')return {kind:error.kind,evidence:{error:error.kind}};
  if(error.retryable===true)return {kind:'service_transient',evidence:{error:`${error.kind}:${error.http_status??'unknown'}`}};
 }
 if(source.ordinal===2&&Array.isArray(source.result?.issues)&&source.result.issues.length){
  const materials=source.result.materials,pages=source.result.pages,issues=source.result.issues;
  if(Array.isArray(materials)&&Array.isArray(pages)&&issues.every((issue:any)=>typeof issue.material_id==='string'&&Number.isSafeInteger(issue.page)&&issue.page>0&&['empty_page','unreadable','ocr_page_error','ocr_truncated'].includes(issue.kind)&&materials.some((m:any)=>m.material_id===issue.material_id&&issue.page<=m.pages)&&pages.some((p:any)=>p.material_id===issue.material_id&&p.page===issue.page))){
   const ids=[...new Set<string>(issues.map((issue:any)=>issue.material_id))];
   return {kind:'material',evidence:{materials:ids.map(material_id=>({material_id,pages:[...new Set<number>(issues.filter((i:any)=>i.material_id===material_id).map((i:any)=>i.page))],kinds:[...new Set<string>(issues.filter((i:any)=>i.material_id===material_id).map((i:any)=>i.kind))]}))}};
  }
  return {kind:'unknown',evidence:{error:'material_issue_without_verified_page_source'}};
 }
 if(source.ordinal===6&&source.status==='failed'&&source.result?.validation?.valid===false)return {kind:'score',evidence:{reasons:Array.isArray(source.result.report?.disputes)?source.result.report.disputes.filter((item:unknown):item is string=>typeof item==='string'):['score_validation_failed']}};
 if(source.ordinal===7){
  if(source.result?.decision!=='repair')return null;
  const reasons=Array.isArray(source.result.reasons)?source.result.reasons.filter((item:unknown):item is string=>typeof item==='string'):[];
  // A low score requests analysis under the frozen rules; it is not evidence
  // that the rubric should be relaxed or that a particular fact is wrong.
  const kind:IssueKind=reasons.length&&reasons.every((reason:string)=>reason.startsWith('score_invalid_or_disputed:'))?'score':reasons.length&&reasons.every((reason:string)=>reason.startsWith('below_model_threshold:'))?'question':'unknown';
  return {kind,evidence:{reasons}};
 }
 if(source.ordinal===4&&source.status==='failed'&&source.result?.quality_check?.passed===false){
  const report=source.result.quality_check,checks=report.checks;
  const rubricOnly=checks?.rubric_consistent===false&&['material_grounding','question_complete','reference_answer_complete','deliverables_complete'].every(key=>checks[key]===true);
  return {kind:rubricOnly?'rubric':'question',evidence:{quality_check:report}};
 }
 if(source.status==='failed')return {kind:'unknown',evidence:{error:source.error}};
 return null;
}

export function freezeRevisionBudget(raw:unknown):Required<Pick<RevisionBudget,'max_content_revisions'|'max_technical_retries'|'max_calls'|'max_duration_ms'>>{
 const budget=validateRevisionBudget(raw);
 if(budget?.max_technical_retries===undefined||budget.max_calls===undefined||budget.max_duration_ms===undefined)throw new HTTPException(409,{message:'启动自动返修前请配置技术重试、累计调用及有效耗时上限'});
 return {max_content_revisions:budget.max_content_revisions??3,max_technical_retries:budget.max_technical_retries,max_calls:budget.max_calls,max_duration_ms:budget.max_duration_ms};
}
