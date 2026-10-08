export interface WorkflowMetricsRow {
 workflow_id:string;input_revision:number;current:boolean;started:boolean;processed:boolean;authored:boolean;quality_passed:boolean;
 valid_assessments:number;accepted:boolean;quarantined:boolean;exported:boolean;
}
export function summarizeProduction(rows:WorkflowMetricsRow[]){
 const current=new Map<string,WorkflowMetricsRow>();
 for(const row of rows){if(!row.workflow_id||!Number.isSafeInteger(row.input_revision)||row.input_revision<1)continue;const prior=current.get(row.workflow_id);if(!prior||row.input_revision>prior.input_revision)current.set(row.workflow_id,row);}
 const counts={started:0,processed:0,authored:0,quality_passed:0,valid_assessments:0,accepted:0,quarantined:0,exported:0};
 for(const row of current.values()){
  if(row.started)counts.started++;
  if(!row.current)continue;
  if(row.processed)counts.processed++;if(row.authored)counts.authored++;if(row.quality_passed)counts.quality_passed++;
  if(Number.isSafeInteger(row.valid_assessments)&&row.valid_assessments>0)counts.valid_assessments+=row.valid_assessments;
  if(row.accepted)counts.accepted++;if(row.quarantined)counts.quarantined++;if(row.exported)counts.exported++;
 }
 return counts;
}
