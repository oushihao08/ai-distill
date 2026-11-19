/** 验证脱敏进度在工作流投影中有明确白名单；不访问数据库，不暴露原文或任务配置。 */
import {expect,test} from 'bun:test';
import {readProjectWorkflowList,readProjectWorkflowViews,stepResultProjection,answerModelSummaryProjection} from './workflow-view';
test('项目列表紧凑传输保留题目顺序、空值、分数结果和日期精度',async()=>{
 const row=['second','project','题目二','2026-11-15T16:00:01.123456+00:00','waiting',null,'question',null,null,null,null,null,null,[],null,'package','来源',2,null,3,'waiting',null,{decision:'accepted'},'任务','q1','r1',[{model_id:'a',status:'succeeded'}],'waiting',true,false];
 const result=await readProjectWorkflowList({query:async(sql:string,values:unknown[])=>{
  expect(sql).toContain('jsonb_agg(jsonb_build_array(workflow_items.id');expect(values).toEqual(['project']);
  return{rows:[{items:[row,[...row.slice(0,2),'题目一',...row.slice(3)]]}]};
 }} as any,'SELECT fixture','project');
 expect(result.rows.map((item:any)=>item.title)).toEqual(['题目二','题目一']);
 expect(result.rows[0]).toMatchObject({id:'second',source_key:null,material_count:2,has_authored:true,exported:false,acceptance_result:{decision:'accepted'},answer_models:[{model_id:'a',status:'succeeded'}]});
 expect(result.rows[0].created_at.toISOString()).toBe('2026-11-15T16:00:01.123Z');expect(result.rowCount).toBe(2);
});
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
  if(sql.includes('jsonb_agg(jsonb_build_array('))return{rows:[{items:[
   {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:4,status:'succeeded',result:null,enabled:true,active:false},
   {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:5,status:'waiting',result:null,enabled:true,active:true},
   {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:8,status:'waiting',result:null,enabled:true,active:true},
  ]}]};
  return{rows:[{workflow_id:workflowId,has_authored:true}]};
 }} as any;
 const result=await readProjectWorkflowViews(pool,'project',[workflowId]);
 expect(result[workflowId]?.attempt_summary).toEqual({has_authored:true});
 expect(result[workflowId]?.steps.find(step=>step.ordinal===5)).toBeUndefined();
 expect(result[workflowId]?.steps.find(step=>step.ordinal===8)).toMatchObject({active:true,status:'waiting'});
 expect(result[workflowId]).not.toHaveProperty('attempts');
 expect(calls[1]?.sql).toContain('has_authored');
 expect(calls[1]?.sql).not.toContain('DISTINCT ON');
});

test('项目状态可复用项目详情已经读取的状态行与出题尝试摘要',async()=>{
 const workflowId='22222222-2222-4222-8222-222222222222';
 const stateRows={rows:[
  {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:4,status:'succeeded',result:null,enabled:true,active:false},
  {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:5,status:'waiting',result:null,enabled:true,active:false},
  {workflow_id:workflowId,workflow_kind:'question',source_workflow_id:null,library_source:false,ordinal:8,status:'waiting',result:null,enabled:true,active:false},
 ],rowCount:3};
 const pool={query:async()=>{throw new Error('项目详情的预读快照不应再查询数据库');}} as any;
 const result=await readProjectWorkflowViews(pool,'project',[workflowId],{
  states:stateRows as any,
  hasAuthored:new Map([[workflowId,true]]),
 });
 expect(result[workflowId]?.attempt_summary).toEqual({has_authored:true});
 expect(result[workflowId]?.steps.map(step=>step.ordinal)).toEqual([4,8]);
});

test('归档投影保留安全飞书核对回执，不暴露整个归档私有结果',()=>{const sql=stepResultProjection('s',true);expect(sql).toContain("ordinal=8");expect(sql).toContain("{feishu_sync,verification}");expect(sql).not.toMatch(/THEN s\.result(?:\s|$)/);});

// 各目标回执也只投影公开状态；不整份暴露归档或远端请求产物。
test('轻量及详情交付投影包含各目标安全回执，兼容无旧回执及非对象历史值',()=>{
 for(const content of [false,true]){
  const sql=stepResultProjection('s',content).split('WHEN s.ordinal=8')[1]!.split('WHEN s.ordinal=7')[0]!;
  expect(sql).toContain("jsonb_typeof(s.result->'feishu_deliveries')='object'");
  expect(sql).toContain("ELSE '{}'::jsonb");
  for(const key of ['status','verification','reason_code','url','record_id'])expect(sql).toContain(`receipt.value->'${key}'`);
  expect(sql).not.toMatch(/jsonb_object_agg\(receipt.key,\s*receipt.value\)/);
  for(const key of ['snapshot','input','attachment_tokens','api_key'])expect(sql).not.toContain(`->'${key}'`);
 }
});
