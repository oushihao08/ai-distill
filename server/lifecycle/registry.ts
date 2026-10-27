/** 可插拔生命周期注册表。调用者逐个 await 回调；不创建队列、不决定步骤是否执行或达标。 */
export type LifecycleEvent = 'before' | 'committed' | 'failed' | 'cancelled' | 'skipped';
export interface LifecycleContext {
 stage: string;
 execution_id: string;
 project_id?: string;
 project_key?: string;
 workflow_id?: string;
 signal?: AbortSignal;
 /** 仅传本步骤允许公开给扩展的输入/结果，不自动读取其他步骤。 */
 data?: Readonly<Record<string, unknown>>;
}
export interface LifecycleRegistration {
 id: string;
 stage: string;
 event: LifecycleEvent;
 project_id?: string;
 project_key?: string;
 run: (context: LifecycleContext) => void | Promise<void>;
}
export interface LifecycleOutcome { id: string; status: 'succeeded' | 'failed' | 'cancelled' }
export class LifecycleRegistry {
 private readonly callbacks = new Map<string, LifecycleRegistration>();
 has(event:LifecycleEvent,stage:string):boolean {
  return [...this.callbacks.values()].some(entry=>entry.event===event&&entry.stage===stage);
 }
 hasProjectKeyCallbacks(event:LifecycleEvent,stage:string):boolean {
  return [...this.callbacks.values()].some(entry=>entry.event===event&&entry.stage===stage&&entry.project_key!==undefined);
 }
 register(registration: LifecycleRegistration): () => void {
  if(this.callbacks.has(registration.id))throw new Error(`生命周期注册重复：${registration.id}`);
  const entry = {...registration};
  this.callbacks.set(entry.id, entry);
  return () => { if(this.callbacks.get(entry.id) === entry)this.callbacks.delete(entry.id); };
 }
 /** 固定本次匹配列表，按注册顺序执行；失败记录由调用方接收，不改写主结果。 */
 async emit(event: LifecycleEvent, context: LifecycleContext): Promise<LifecycleOutcome[]> {
  const matches = [...this.callbacks.values()].filter(entry => entry.stage === context.stage && entry.event === event && (entry.project_id === undefined || entry.project_id === context.project_id) && (entry.project_key === undefined || entry.project_key === context.project_key));
  const results: LifecycleOutcome[] = [];
  for(const entry of matches) {
   if(context.signal?.aborted && event !== 'cancelled' && event !== 'failed') {
    results.push({id:entry.id,status:'cancelled'});
    continue;
   }
   try {
    // 每个回调独立的数据副本；扩展不得改写后续回调或主步骤的数据。
    await entry.run({...context, data:context.data ? structuredClone(context.data) : undefined});
    results.push({id:entry.id,status:'succeeded'});
   } catch {
    results.push({id:entry.id,status:context.signal?.aborted?'cancelled':'failed'});
   }
  }
  return results;
 }
}
