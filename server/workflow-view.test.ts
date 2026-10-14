/** 验证脱敏进度在工作流投影中有明确白名单；不访问数据库，不暴露原文或任务配置。 */
import {expect,test} from 'bun:test';
import {stepResultProjection} from './workflow-view';
test('轻量和详情投影都保留脱敏进度',()=>{
 for(const content of [false,true]){
  const sql=stepResultProjection('s',content);expect(sql).toContain('ordinal=9');expect(sql).toContain("result->'progress'");
 }
});
