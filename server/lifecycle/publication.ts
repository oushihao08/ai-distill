/** 本地归档后的项目交付分派。飞书回执独立持久化；失败向调用者报告，不撤销已保存的本地归档。 */
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
 try{context.signal.throwIfAborted();await projectPublicationCompletions.execute(projectKey,context);}catch(error){throw error;}
}
