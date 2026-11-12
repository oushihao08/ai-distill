/**
 * 职责：可插拔生命周期注册表与单步回调隔离执行器。
 * 核心入口：
 * - `LifecycleRegistry`：按 `stage`、`event` 及可选 `project_id`/`project_key` 注册和触发可选生命周期通知。
 * - `runLifecycleTask()`：执行单个隔离回调并返回 `{ id, status }`，不向主流程抛出异常。
 * 不变量与修改禁区：
 * - `emit()` 对传入 `context.data` 执行 `structuredClone`，防止回调篡改主步骤状态。
 * - 回调失败只记入返回结果，不中断或回滚主步骤已提交结果。
 */
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

export async function runLifecycleTask(
 id: string,
 signal: AbortSignal | undefined,
 run: () => void | Promise<void>,
 allowWhenAborted = false
): Promise<LifecycleOutcome> {
 if (signal?.aborted && !allowWhenAborted) return { id, status: 'cancelled' };
 try {
  await run();
  return { id, status: 'succeeded' };
 } catch {
  return { id, status: signal?.aborted ? 'cancelled' : 'failed' };
 }
}

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
  const allowWhenAborted = event === 'cancelled' || event === 'failed';
  for(const entry of matches) {
   results.push(await runLifecycleTask(
    entry.id,
    context.signal,
    () => entry.run({...context, data:context.data ? structuredClone(context.data) : undefined}),
    allowWhenAborted
   ));
  }
  return results;
 }
}
