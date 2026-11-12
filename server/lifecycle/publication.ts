/**
 * 职责：本地归档完成后的项目级外部发布分派（如豆包飞书同步）。
 * 核心入口：`completeProjectPublication()`；外部发布回执独立持久化，失败向调用方报告但不撤销已保存的本地归档。
 */
import type {Pool} from 'pg';
import type {syncArchivedWorkflowToFeishu} from '../publishing/feishu';
import {ProjectImplementations} from './project-registry';
import {registerDoubaoPublication} from './projects/doubao';
export interface PublicationContext {
 pool:Pool; workflowId:string; root:string; exportsRoot:string; signal:AbortSignal;
 sync?:typeof syncArchivedWorkflowToFeishu;
}
export const projectPublicationCompletions = new ProjectImplementations<PublicationContext, void>(()=>{});
registerDoubaoPublication(projectPublicationCompletions);
export async function completeProjectPublication(projectKey:string|null,context:PublicationContext){
 context.signal.throwIfAborted();
 await projectPublicationCompletions.execute(projectKey,context);
}
