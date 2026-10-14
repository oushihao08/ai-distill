/** 职责：普通API与钩子API共用本机请求槽位；复用已有SQLite槽位实现并使用独立命名空间，不占用Agent槽位。入口 withModelApiSlot，关闭入口供进程退出和测试使用。 */
import {join} from 'node:path';
import {getAgentConcurrencyGate,closeAgentConcurrencyGate,readConcurrencySettings} from '../concurrency';
import {storageDirectory} from '../paths';
import {ModelApiError} from './types';
const gateRoot=(root:string)=>join(root,'.model-api-slots');
export async function withModelApiSlot<T>(execute:()=>Promise<T>,options:{root?:string;env?:NodeJS.ProcessEnv;signal?:AbortSignal;queue_timeout_ms?:number;onAcquired?:(wait_ms:number)=>void}={}):Promise<T>{
 const env=options.env??process.env,root=options.root??storageDirectory(env);
 const limit=readConcurrencySettings(env,root).llmApi;
 if(options.queue_timeout_ms!==undefined&&(!Number.isSafeInteger(options.queue_timeout_ms)||options.queue_timeout_ms<=0||options.queue_timeout_ms>2147483647))throw new ModelApiError('configuration');
 const started=performance.now(),controller=new AbortController(),cancel=()=>controller.abort(options.signal?.reason);let expired=false,queueWait:number|undefined;
 options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
 const timer=options.queue_timeout_ms===undefined?undefined:setTimeout(()=>{expired=true;controller.abort();},options.queue_timeout_ms);
 try{
  const result=await getAgentConcurrencyGate(gateRoot(root),limit).run(async()=>{
   clearTimeout(timer);queueWait=Math.round(performance.now()-started);options.onAcquired?.(queueWait);return await execute();
  },{signal:controller.signal});
  if(!result.acquired)throw expired?new ModelApiError('timeout',false,null,null,null,'api_queue_timeout'):new ModelApiError('cancelled');
  return result.value;
 }catch(error){if(error&&typeof error==='object')Object.assign(error,{queue_wait_ms:queueWait??Math.max(0,Math.round(performance.now()-started))});throw error;}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);}
}
export function closeModelApiSlots(root=storageDirectory()){closeAgentConcurrencyGate(gateRoot(root));}
