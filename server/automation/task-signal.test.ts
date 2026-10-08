import {test,expect} from 'bun:test';
import {watchTaskCancellation,withTaskSignal,currentTaskSignal} from './task-signal';
test('database cancellation aborts in-flight work; concurrent task signals stay isolated',async()=>{
 const watcher=watchTaskCancellation({query:async()=>({rows:[{status:'skipped'}]})} as any,'a',undefined,false,2);
 try{await new Promise(resolve=>watcher.signal.addEventListener('abort',resolve,{once:true}));expect(watcher.signal.aborted).toBe(true);}finally{watcher.dispose();}
 const a=new AbortController(),b=new AbortController();
 expect(await Promise.all([withTaskSignal(a.signal,async()=>{await Bun.sleep(2);return currentTaskSignal()===a.signal;}),withTaskSignal(b.signal,async()=>currentTaskSignal()===b.signal)])).toEqual([true,true]);
 expect(currentTaskSignal()).toBeUndefined();
});
