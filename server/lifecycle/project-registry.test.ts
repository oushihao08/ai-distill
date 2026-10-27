/** 项目 key 分派与实际交付适配器验证；使用替身，不调用模型、数据库或飞书。 */
import {test,expect} from 'bun:test';
import type {Pool} from 'pg';
import {ProjectImplementations} from './project-registry';
import {executeProjectDelivery,projectDeliveries,type ProjectDeliveryContext} from './project-delivery';
import {completeProjectPublication} from './publication';

test('同一入口按 key 精确选择、无注册回退、注销与重复保护',async()=>{
 const r=new ProjectImplementations<number,string>(n=>`default:${n}`);
 const remove=r.register('work',n=>`work:${n}`);r.register('doubao',n=>`doubao:${n}`);
 expect(await r.execute('work',1)).toBe('work:1');expect(await r.execute('doubao',2)).toBe('doubao:2');
 expect(await r.execute('future',3)).toBe('default:3');expect(await r.execute(null,4)).toBe('default:4');
 expect(()=>r.register('work',()=>'' )).toThrow('重复');expect(()=>r.register(' ',()=>'' )).toThrow('不能为空');
 remove();expect(await r.execute('work',5)).toBe('default:5');
});
test('项目实现必须完成才返回，错误原样传播不执行默认实现',async()=>{
 let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 let returned=false,fallback=0;const error=new Error('delivery');
 const r=new ProjectImplementations<void,void>(()=>{fallback++;});
 r.register('work',async()=>{entered();await gate;throw error;});
 const pending=r.execute('work',undefined).then(()=>{returned=true;},e=>{expect(e).toBe(error);returned=true;});
 await started;expect(returned).toBe(false);release();await pending;expect(returned).toBe(true);expect(fallback).toBe(0);
});
function context(order:string[]):ProjectDeliveryContext{return{
 delivery:{mode:'noop',digest:'test'},input:{} as any,outputDir:'/tmp',archive:{pool:{} as Pool,workflowId:'w',storageRoot:'/tmp',frozen:{}},
 prepare:async()=>{order.push('prepare');},deliver:async()=>{order.push('deliver');},
 checkpoint:async run=>{order.push('checkpoint');await run();},
};}
test('生产交付入口保留准备、检查点、交付的顺序且不同项目可替换',async()=>{
 const work:string[]=[],doubao:string[]=[];
 await executeProjectDelivery('Work法律全场景',context(work));expect(work).toEqual(['prepare','checkpoint','deliver']);
 await executeProjectDelivery('豆包高经济价值',context(doubao));expect(doubao).toEqual(work);
 const remove=projectDeliveries.register('其他项目',async c=>{c.input.title='custom';});
 try{const other=context([]);await executeProjectDelivery('其他项目',other);expect(other.input.title).toBe('custom');}finally{remove();}
});
test('准备失败不交付，交付失败不吞掉，取消不执行项目代码',async()=>{
 const order:string[]=[],c=context(order);c.prepare=async()=>{throw new Error('prepare failed');};
 await expect(executeProjectDelivery('Work法律全场景',c)).rejects.toThrow('prepare failed');expect(order).toEqual([]);
 c.prepare=async()=>{};c.deliver=async()=>{throw new Error('delivery failed');};
 await expect(executeProjectDelivery('Work法律全场景',c)).rejects.toThrow('delivery failed');
 const abort=new AbortController();abort.abort();c.archive.signal=abort.signal;order.length=0;
 await expect(executeProjectDelivery('Work法律全场景',c)).rejects.toThrow();expect(order).toEqual([]);
});
test('豆包才执行飞书且等待回执，Work与未知项目不调用飞书',async()=>{
 let calls=0,release!:()=>void,entered!:()=>void,returned=false;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const c={pool:{} as Pool,workflowId:'w',root:'/tmp',exportsRoot:'/tmp',signal:new AbortController().signal,
  sync:(async()=>{calls++;entered();await gate;return {status:'succeeded'};}) as any};
 await completeProjectPublication('Work法律全场景',c);await completeProjectPublication('其他项目',c);expect(calls).toBe(0);
 const pending=completeProjectPublication('豆包高经济价值',c).then(()=>{returned=true;});
 await started;expect(returned).toBe(false);release();await pending;expect(calls).toBe(1);expect(returned).toBe(true);
});
test('飞书失败、远端删除、进行中、不适用都不能冒充交付成功',async()=>{
 for(const status of ['failed','remote_deleted','in_progress','not_applicable']){
  await expect(completeProjectPublication('豆包高经济价值',{pool:{} as Pool,workflowId:'w',root:'/tmp',exportsRoot:'/tmp',signal:new AbortController().signal,sync:async()=>({status}) as any})).rejects.toThrow('未完成');
 }
});
