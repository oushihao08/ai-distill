/**
 * 职责：项目产量纯统计：仅聚合各题目当前步骤状态的处理、出题、评分、达标和导出状态。
 * 关键方法与用途：`summarizeProduction()` 按每道题当前步骤状态聚合阶段、评分、达标与导出数量。
 * 使用场景：由 `app.ts` 项目指标接口调用；纯聚合，不派发任务。
 */
export interface WorkflowMetricsRow {
 workflow_id:string;current:boolean;started:boolean;processed:boolean;authored:boolean;
 valid_assessments:number;accepted:boolean;quarantined:boolean;exported:boolean;
}
export function summarizeProduction(rows:WorkflowMetricsRow[]){
 const current=new Map<string,WorkflowMetricsRow>();
 for(const row of rows){if(row.workflow_id)current.set(row.workflow_id,row);}
 const counts={started:0,processed:0,authored:0,valid_assessments:0,accepted:0,quarantined:0,exported:0};
 for(const row of current.values()){
  if(row.started)counts.started++;
  if(!row.current)continue;
  if(row.processed)counts.processed++;if(row.authored)counts.authored++;
  if(Number.isSafeInteger(row.valid_assessments)&&row.valid_assessments>0)counts.valid_assessments+=row.valid_assessments;
  if(row.accepted)counts.accepted++;if(row.quarantined)counts.quarantined++;if(row.exported)counts.exported++;
 }
 return counts;
}
