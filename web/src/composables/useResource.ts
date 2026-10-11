/** 文件职责：封装页面读取单个 API 资源时共用的加载、错误与取消状态。
 * 关键方法与用法：useResource<T>(path) 返回 data/error/loading/refresh，挂载时读取；手动刷新遇到进行中的读取时补一次新状态，卸载后不再续发，卸载时中止请求。
 */
import { api } from '../api/client';
export function useResource<T>(path: string) {
 const data = shallowRef<T>();
 const error = shallowRef('');
 const loading = shallowRef(false);
 let controller: AbortController | undefined;
 let inFlight:Promise<void>|undefined;
 let disposed=false;
 let refreshAgain=false;
 async function refresh() {
  if(disposed)return;
  if(inFlight){refreshAgain=true;return inFlight;}
  loading.value=true;
  inFlight=(async()=>{
   do{
    refreshAgain=false;error.value='';controller=new AbortController();
    try{data.value=await api<T>(path,{signal:controller.signal});}
    catch(cause){if(!controller.signal.aborted)error.value=cause instanceof Error?cause.message:'读取失败';}
   }while(refreshAgain&&!disposed);
  })();
  try{await inFlight;}finally{inFlight=undefined;loading.value=false;}
 }
 onMounted(refresh);
 onUnmounted(() => {disposed=true;controller?.abort();});
 return { data, error, loading, refresh };
}
