/** 验证作答就绪状态与现有文字执行器能力一致；不查询数据库或调用模型。 */
import {test,expect} from 'bun:test';
import {workflowStepReadiness,readProjectWorkflowStepRows} from '../project-folders';

const states=(result:any)=>new Map<number,any>([[4,{ordinal:4,status:'succeeded',enabled:true,active:false,result}],[5,{ordinal:5,status:'waiting',enabled:true,active:false}]]);
test('Work草稿不能显示为作答就绪',()=>{
 const value=workflowStepReadiness(5,states({content_contract:'work_legal_v1',content_status:{status:'draft'},task_requirements:{input_mode:'text',output_mode:'text',tools:[]}}));
 expect(value).toEqual({ready:false,reason:'Work题目仍为草稿，不能作答'});
});
test('文字材料的文件成果可文字作答，旧文字题保持就绪',()=>{
 const work={content_contract:'work_legal_v1',content_status:{status:'complete'},task_requirements:{input_mode:'text',output_mode:'file',tools:[]}};
 expect(workflowStepReadiness(5,states(work))).toEqual({ready:true});
 expect(workflowStepReadiness(5,states({question:'旧文字题'}))).toEqual({ready:true});
 expect(workflowStepReadiness(5,states({...work,task_requirements:{input_mode:'text',output_mode:'text',tools:[]}}))).toEqual({ready:true});
});
test('状态查询只投影能力与内容状态，不读取完整题面和标准成果',async()=>{
 let query='';await readProjectWorkflowStepRows({query:async(sql:string)=>{query=sql;return{rows:[]};}} as any,'fixture');
 expect(query).toContain("'content_status',s.result->'content_status'");expect(query).toContain("'task_requirements',s.result->'task_requirements'");expect(query).not.toContain("s.result->'reference_outputs'");
});
