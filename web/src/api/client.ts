/** 文件职责：集中处理前端对本地 /api 的 JSON 请求及错误转换。
 * 关键方法与用法：api<T>(path, init) 负责 fetch、解析响应、识别 HTTP／空响应／非 JSON 错误并抛出可展示消息；页面和 useResource 通过它访问服务端路由。
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
 try {
  const response = await fetch(`/api${path}`, init);
  const text = await response.text();
  let data: unknown;
  if (text.trim()) {
   try { data = JSON.parse(text); }
   catch { throw new Error(`工作台接口返回非 JSON 响应（HTTP ${response.status}），请检查后端服务`); }
  }
  if (!response.ok) {
   const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : undefined;
   throw new Error(message ?? `工作台接口请求失败（HTTP ${response.status}），请检查后端服务是否启动`);
  }
  if (data === undefined && response.status !== 204) throw new Error('工作台接口返回空响应，请检查后端服务');
  return data as T;
 } catch (error) { throw error instanceof Error ? error : new Error('无法连接工作台接口'); }
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
