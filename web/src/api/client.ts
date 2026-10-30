/** 文件职责：集中处理前端对本地 /api 的 JSON 请求及错误转换。
 * 关键方法与用法：api<T>(path, init) 负责 fetch、解析响应、识别 HTTP／空响应／非 JSON 错误并抛出可展示消息；页面和 useResource 通过它访问服务端路由。
 */
export class ApiRequestError extends Error{
 constructor(message:string,readonly outcome_unknown:boolean,readonly status?:number,readonly code?:string){super(message);this.name='ApiRequestError';}
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
 const deadline=AbortSignal.timeout(35000);
 const signal=init?.signal?AbortSignal.any([init.signal,deadline]):deadline;
 const write=!['GET','HEAD','OPTIONS'].includes((init?.method??'GET').toUpperCase());
 const operationId=write?crypto.randomUUID():undefined;
 const headers=new Headers(init?.headers);if(operationId)headers.set('X-Operation-ID',operationId);
 const failure=(message:string,unknown:boolean,status?:number,code?:string)=>new ApiRequestError(operationId?`${message}（操作标识：${operationId}）`:message,unknown,status,code);
 try {
  const response = await fetch(`/api${path}`, {...init,headers,signal});
  const text = await response.text();
  let data: unknown;
  if (text.trim()) {
   try { data = JSON.parse(text); }
   catch { throw new Error(`工作台接口返回非 JSON 响应（HTTP ${response.status}），请检查后端服务`); }
  }
  if (!response.ok) {
   const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : undefined;
   throw new ApiRequestError(message ?? `工作台接口请求失败（HTTP ${response.status}），请检查后端服务是否启动`,response.status>=500&&(init?.method??'GET').toUpperCase()!=='GET',response.status,data&&typeof data==='object'&&'code'in data&&typeof data.code==='string'?data.code:undefined);
  }
  if (data === undefined && response.status !== 204) throw new Error('工作台接口返回空响应，请检查后端服务');
  return data as T;
 } catch (error) {
  if(deadline.aborted&&!init?.signal?.aborted)throw failure((init?.method??'GET').toUpperCase()==='GET'?'读取超过35秒，请刷新状态后重试':'请求等待超过35秒，后台操作可能仍在执行；请刷新状态确认，勿直接重复提交',(init?.method??'GET').toUpperCase()!=='GET');
  if(error instanceof ApiRequestError)throw failure(error.message,error.outcome_unknown,error.status,error.code);
  throw failure(error instanceof Error?error.message:'无法连接工作台接口',(init?.method??'GET').toUpperCase()!=='GET');
 }
}

/** 同一输入结果未知时保留request_key；成功回执后释放，下次明确操作可新建尝试。
 * 会话存储仅保存输入摘要/随机键，不保存正文；存储不可用时退回当前页面内恢复。 */
const pendingIntents=new Map<string,string>();
export async function apiPostIntent<T>(path:string,body:Record<string,unknown>):Promise<T>{
 const input=JSON.stringify([path,body]);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));
 const storageKey='ai-distill:intent:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
 let stored:string|null=null;
 try{stored=sessionStorage.getItem(storageKey);}catch{stored=null;}
 const key=pendingIntents.get(storageKey)??stored??crypto.randomUUID();
 pendingIntents.set(storageKey,key);
 try{sessionStorage.setItem(storageKey,key);}catch{ /* 私密浏览等环境使用上面的页面内Map，不影响已冻结请求键。 */ stored=null;}
 try{
  const result=await api<T>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,request_key:key})});
  pendingIntents.delete(storageKey);
  try{sessionStorage.removeItem(storageKey);}catch{stored=null;}
  return result;
 }catch(cause){throw new Error(`${cause instanceof Error?cause.message:'派发失败'}。本次请求标识已保留；相同输入再次提交会先恢复原请求。`);}
}
