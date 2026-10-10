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
