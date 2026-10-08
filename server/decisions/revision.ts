export type IssueKind='service_transient'|'authentication'|'quota'|'question'|'rubric'|'material'|'score'|'rules'|'unknown';
export interface RevisionBudget {
 content_revisions?:number;
 max_content_revisions?:number;
 technical_retries?:number;
 max_technical_retries?:number;
 spent_duration_ms?:number;
 max_duration_ms?:number;
 calls?:number;
 max_calls?:number;
}
export type RevisionDecision={action:'retry'|'wait'|'revise'|'isolate';return_step:2|4|6|null;reason:string;content_revisions:number;technical_retries:number};
const count=(n:number|undefined)=>Number.isSafeInteger(n)&&n!>=0;
export function decideRevision(kind:IssueKind,budget:RevisionBudget):RevisionDecision{
 const content=budget.content_revisions??0,technical=budget.technical_retries??0;
 if(!count(content)||!count(technical)||!count(budget.calls??0)||!count(budget.spent_duration_ms??0))return {action:'isolate',return_step:null,reason:'invalid_budget_state',content_revisions:content,technical_retries:technical};
 if(budget.max_calls!==undefined&&(!count(budget.max_calls)||!count(budget.calls??0)||budget.calls!>=budget.max_calls))return {action:'isolate',return_step:null,reason:'call_budget_exhausted',content_revisions:content,technical_retries:technical};
 if(budget.max_duration_ms!==undefined&&(!count(budget.max_duration_ms)||!count(budget.spent_duration_ms??0)||budget.spent_duration_ms!>=budget.max_duration_ms))return {action:'isolate',return_step:null,reason:'time_budget_exhausted',content_revisions:content,technical_retries:technical};
 if(kind==='authentication'||kind==='quota')return {action:'wait',return_step:null,reason:kind==='authentication'?'authentication_required':'quota_recovery_required',content_revisions:content,technical_retries:technical};
 if(kind==='service_transient'){
  if(budget.max_technical_retries===undefined||!count(budget.max_technical_retries))return {action:'wait',return_step:null,reason:'technical_retry_limit_not_configured',content_revisions:content,technical_retries:technical};
  if(technical>=budget.max_technical_retries)return {action:'isolate',return_step:null,reason:'technical_retry_limit_reached',content_revisions:content,technical_retries:technical};
  return {action:'retry',return_step:null,reason:'transient_service_failure',content_revisions:content,technical_retries:technical+1};
 }
 const step=kind==='material'?2:kind==='question'||kind==='rubric'?4:kind==='score'?6:null;
 if(kind==='rules'||kind==='unknown'||step===null)return {action:'isolate',return_step:null,reason:kind==='rules'?'rules_revision_required':'issue_not_classified',content_revisions:content,technical_retries:technical};
 const max=budget.max_content_revisions??3;
 if(!count(max)||content>=max)return {action:'isolate',return_step:null,reason:'content_revision_limit_reached',content_revisions:content,technical_retries:technical};
 return {action:'revise',return_step:step,reason:`content_issue:${kind}`,content_revisions:content+1,technical_retries:technical};
}
