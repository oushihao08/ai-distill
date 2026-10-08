export interface AutomationStep {ordinal:number;display_position:number;enabled:boolean;status:string}
export type WorkflowPlan={kind:'dispatch';ordinal:number;position:number}|{kind:'wait';position:number}|{kind:'blocked';ordinal:number;position:number;reason:string}|{kind:'done'};
export function planWorkflow(steps:AutomationStep[],activeOrdinals:number[]):WorkflowPlan{
 for(const step of [...steps].filter(step=>step.enabled).sort((a,b)=>a.display_position-b.display_position)){
  if(step.status==='succeeded'||step.status==='skipped')continue;
  if(activeOrdinals.includes(step.ordinal)||(step.ordinal===1&&activeOrdinals.includes(2))||step.status==='running')return {kind:'wait',position:step.display_position};
  if(step.status==='failed')return {kind:'blocked',ordinal:step.ordinal,position:step.display_position,reason:'step_failed'};
  return {kind:'dispatch',ordinal:step.ordinal,position:step.display_position};
 }
 return {kind:'done'};
}
export function planBatch(mode:'horizontal'|'vertical',members:{id:string;plan:WorkflowPlan}[]):string[]{
 const pending=members.filter(member=>member.plan.kind==='dispatch'||member.plan.kind==='wait');
 const position=Math.min(...pending.map(member=>'position' in member.plan?member.plan.position:Infinity));
 return pending.filter(member=>member.plan.kind==='dispatch'&&(mode==='horizontal'||member.plan.position===position)).map(member=>member.id);
}
