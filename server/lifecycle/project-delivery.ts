/**
 * 职责：步骤 8 项目交付装配与分派，按主项目 key 执行准备（prepare）与交付（deliver）。
 * 核心入口：`executeProjectDelivery()` 供归档流程调用；未单独注册的项目回退至 `scriptDelivery`（发现并运行项目脚本，无脚本则空操作）。
 */
import {ProjectImplementations} from './project-registry';
import {registerWorkDelivery} from './projects/work';
import {registerDoubaoDelivery} from './projects/doubao';
import {loadProjectArchive, runProjectDelivery, type ProjectDelivery, type DeliveryInput, type ProjectArchiveContext, type ProjectArchiveModule} from '../publishing/project-delivery';

export interface ProjectDeliveryContext {
 delivery: ProjectDelivery;
 input: DeliveryInput;
 outputDir: string;
 archive: ProjectArchiveContext;
 prepare?: NonNullable<ProjectArchiveModule['prepare']>;
 deliver?: typeof runProjectDelivery;
 /** 复用现有外部调用检查点，保持恢复时不重放已完成交付。 */
 checkpoint: (run: () => Promise<void>) => Promise<void>;
}
async function scriptDelivery(context: ProjectDeliveryContext): Promise<void> {
 context.archive.signal?.throwIfAborted();
 const prepare = context.prepare ?? (await loadProjectArchive(context.delivery))?.prepare;
 if (prepare) await prepare(context.input, context.archive);
 context.archive.signal?.throwIfAborted();
 await context.checkpoint(() => (context.deliver ?? runProjectDelivery)(context.delivery, context.input, context.outputDir));
 context.archive.signal?.throwIfAborted();
}
// 未单独注册的项目继续使用原有可选项目脚本；没有脚本即原有空实现。
export const projectDeliveries = new ProjectImplementations<ProjectDeliveryContext, void>(scriptDelivery);
registerWorkDelivery(projectDeliveries,scriptDelivery);
registerDoubaoDelivery(projectDeliveries,scriptDelivery);
export async function executeProjectDelivery(projectKey: string | null, context: ProjectDeliveryContext) {
 await projectDeliveries.execute(projectKey, context);
}
