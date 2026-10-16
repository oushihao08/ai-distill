/** 验证脱敏进度在工作流投影中有明确白名单；不访问数据库，不暴露原文或任务配置。 */
import {expect,test} from 'bun:test';
import {stepResultProjection} from './workflow-view';
test('轻量和详情投影都保留脱敏进度',()=>{
 for(const content of [false,true]){
  const sql=stepResultProjection('s',content);expect(sql).toContain('ordinal=9');expect(sql).toContain("result->'progress'");
 }
});
test('Work完整题目详情保留独立内容字段，轻量列表不发送正文',()=>{
 const detail=stepResultProjection('s',true),light=stepResultProjection('s',false);
 for(const field of ['content_contract','task_metadata','input_files','deliverables','reference_outputs','research_records','task_requirements','content_status']){expect(detail).toContain(`'${field}'`);expect(light).not.toContain(`'${field}'`);}
});
