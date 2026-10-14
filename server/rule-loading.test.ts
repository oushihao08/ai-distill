/** 验证旧编号规则绑定入口保持停用且不创建尝试、不访问数据库；当前规则读取与冻结由rule-files、authoring等测试覆盖。 */
import {expect,test} from 'bun:test';
import type {Pool} from 'pg';
import {loadWorkflowRules} from './rule-loading';
test('旧编号规则绑定明确返回410，不重新创建隐藏步骤或修改历史绑定',async()=>{
 let queries=0;
 const pool={query:async()=>{queries++;throw new Error('停用入口不应访问数据库');},connect:async()=>{queries++;throw new Error('停用入口不应获取连接');}} as unknown as Pool;
 const error=await loadWorkflowRules(pool,'11111111-1111-4111-8111-111111111111').catch(cause=>cause);
 expect(error).toMatchObject({status:410});expect(error.message).toContain('直接读取当前项目资料');expect(queries).toBe(0);
});
