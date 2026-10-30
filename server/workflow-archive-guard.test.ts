/** 验证派发行锁繁忙立即返回冲突、不继续读取/写入；SQL替身，不连接业务库或执行模型。 */
import {test,expect} from 'bun:test';
import type {PoolClient} from 'pg';
import {assertWorkflowNotArchived} from './workflow-archive-guard';
test('locked workflow refuses admission before preparing inputs or touching steps',async()=>{
 const calls:string[]=[];
 const db={query:async(sql:string)=>{calls.push(sql);throw Object.assign(new Error('private lock owner'),{code:'55P03'});}} as unknown as PoolClient;
 try{await assertWorkflowNotArchived(db,'workflow');throw new Error('expected conflict');}
 catch(error:any){expect(error.status).toBe(409);expect(error.message).toContain('未创建新任务');expect(error.message).not.toContain('private');}
 expect(calls).toHaveLength(1);expect(calls[0]).toContain('FOR UPDATE NOWAIT');
});
test('unlocked admission still protects missing and archived workflows',async()=>{
 for(const state of ['missing','archived','open']){
  const calls:string[]=[];
  const db={query:async(sql:string)=>{calls.push(sql);return sql.startsWith('SELECT id')?{rowCount:state==='missing'?0:1,rows:[]}:{rows:state==='archived'?[{status:'succeeded'}]:[]};}} as unknown as PoolClient;
  if(state==='open')await assertWorkflowNotArchived(db,'workflow');
  else await expect(assertWorkflowNotArchived(db,'workflow')).rejects.toMatchObject({status:state==='missing'?404:409});
  expect(calls).toHaveLength(state==='missing'?1:2);
 }
});
test('unexpected database errors remain errors rather than being hidden as busy',async()=>{
 const error=Object.assign(new Error('offline'),{code:'08006'});
 const db={query:async()=>{throw error;}} as unknown as PoolClient;
 await expect(assertWorkflowNotArchived(db,'workflow')).rejects.toBe(error);
});
