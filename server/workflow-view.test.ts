/** 验证脱敏进度在工作流投影中有明确白名单；不访问数据库，不暴露原文或任务配置。 */
import {expect,test} from 'bun:test';
import {readProjectWorkflowViews,stepResultProjection,answerModelSummaryProjection} from './workflow-view';
test('项目列表的作答模型仅投影摘要，完整正文只在详情按需读取',()=>{
 const sql=answerModelSummaryProjection('s');
 for(const field of ['model_id','name','status','attempt_id'])expect(sql).toContain(`m->'${field}'`);
 for(const field of ['answer','text','reasoning','reference_answer'])expect(sql).not.toContain(`m->'${field}'`);
 expect(stepResultProjection('s',false)).toContain(sql);
});
test('轻量和详情投影都保留脱敏进度',()=>{
 for(const content of [false,true]){
  const sql=stepResultProjection('s',content);expect(sql).toContain('ordinal=9');expect(sql).toContain("result->'progress'");
 }
});
test('Work完整题目详情保留独立内容字段，轻量列表不发送正文',()=>{
 const detail=stepResultProjection('s',true),light=stepResultProjection('s',false);
 for(const field of ['content_contract','task_metadata','input_files','deliverables','reference_outputs','research_records','task_requirements','content_status']){expect(detail).toContain(`'${field}'`);expect(light).not.toContain(`'${field}'`);}
});
test('批量项目状态只返回活动与已出题摘要，不拉取每题尝试历史',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const workflowId='11111111-1111-4111-8111-111111111111';
 const pool={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.includes('jsonb_agg(to_jsonb(state_rows))'))return{rows:[{items:[
   {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:4,status:'succeeded',result:null,enabled:true,active:false},
   {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:5,status:'waiting',result:null,enabled:true,active:true},
  ]}]};
  return{rows:[{workflow_id:workflowId,has_authored:true}]};
 }} as any;
 const result=await readProjectWorkflowViews(pool,'project',[workflowId]);
 expect(result[workflowId]?.attempt_summary).toEqual({has_authored:true});
 expect(result[workflowId]?.steps.find(step=>step.ordinal===5)).toMatchObject({active:true,status:'waiting'});
 expect(result[workflowId]).not.toHaveProperty('attempts');
 expect(calls[1]?.sql).toContain('has_authored');
 expect(calls[1]?.sql).not.toContain('DISTINCT ON');
});

test('项目状态可复用项目详情已经读取的状态行与出题尝试摘要',async()=>{
 const workflowId='22222222-2222-4222-8222-222222222222';
 const stateRows={rows:[
  {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:4,status:'succeeded',result:null,enabled:true,active:false},
  {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:5,status:'waiting',result:null,enabled:true,active:false},
 ],rowCount:2};
 const pool={query:async()=>{throw new Error('项目详情的预读快照不应再查询数据库');}} as any;
 const result=await readProjectWorkflowViews(pool,'project',[workflowId],{
  states:stateRows as any,
  hasAuthored:new Map([[workflowId,true]]),
 });
 expect(result[workflowId]?.attempt_summary).toEqual({has_authored:true});
 expect(result[workflowId]?.steps.map(step=>step.ordinal)).toEqual([4,5]);
});

test('归档投影保留安全飞书核对回执，不暴露整个归档私有结果',()=>{const sql=stepResultProjection('s',true);expect(sql).toContain("ordinal=8");expect(sql).toContain("{feishu_sync,verification}");expect(sql).not.toContain("THEN s.result");});
