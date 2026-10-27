/** 验证同步顺序、隔离和失败边界；无网络、模型、数据库调用。 */
import {test,expect} from 'bun:test';
import {LifecycleRegistry} from './registry';
test('回调未结束时后续回调和调用方不能继续',async()=>{
 const registry=new LifecycleRegistry(),order:string[]=[];
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 registry.register({id:'first',stage:'answer',event:'committed',run:async()=>{order.push('first');await gate;order.push('first done');}});
 registry.register({id:'second',stage:'answer',event:'committed',run:()=>{order.push('second');}});
 const pending=registry.emit('committed',{stage:'answer',execution_id:'1'}).then(()=>order.push('returned'));
 await Promise.resolve();expect(order).toEqual(['first']);release();await pending;
 expect(order).toEqual(['first','first done','second','returned']);
});
test('空注册和未知新增步骤不需要注册表许可',async()=>{
 expect(await new LifecycleRegistry().emit('before',{stage:'future-step',execution_id:'1'})).toEqual([]);
});
test('项目隔离、注销及重复ID',async()=>{
 const r=new LifecycleRegistry();let called=0;
 const item={id:'x',stage:'intake',event:'before' as const,project_id:'A',run:()=>{called++;}};
 const remove=r.register(item);expect(()=>r.register(item)).toThrow('重复');
 await r.emit('before',{stage:'intake',execution_id:'1',project_id:'B'});expect(called).toBe(0);
 await r.emit('before',{stage:'intake',execution_id:'2',project_id:'A'});expect(called).toBe(1);
 remove();await r.emit('before',{stage:'intake',execution_id:'3',project_id:'A'});expect(called).toBe(1);
});
test('回调异常不丢主结果，回调不能修改共享数据',async()=>{
 const r=new LifecycleRegistry();const data={result:{text:'original'}};
 r.register({id:'fail',stage:'authoring',event:'committed',run:context=>{(context.data!.result as any).text='changed';throw new Error('private');}});
 r.register({id:'read',stage:'authoring',event:'committed',run:context=>{expect(context.data).toEqual(data);}});
 expect(await r.emit('committed',{stage:'authoring',execution_id:'1',data})).toEqual([{id:'fail',status:'failed'},{id:'read',status:'succeeded'}]);
 expect(data.result.text).toBe('original');
});
test('跳过仅发跳过事件，取消不执行成功回调',async()=>{
 const r=new LifecycleRegistry();const calls:string[]=[];
 for(const event of ['before','committed','skipped','cancelled'] as const)r.register({id:event,stage:'score',event,run:()=>{calls.push(event);}});
 await r.emit('skipped',{stage:'score',execution_id:'1'});expect(calls).toEqual(['skipped']);
 const c=new AbortController();c.abort();
 expect(await r.emit('committed',{stage:'score',execution_id:'2',signal:c.signal})).toEqual([{id:'committed',status:'cancelled'}]);
 await r.emit('cancelled',{stage:'score',execution_id:'2',signal:c.signal});expect(calls).toEqual(['skipped','cancelled']);
});
