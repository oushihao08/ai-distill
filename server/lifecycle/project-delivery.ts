/** 交付项目装配：主项目名作为 key，公共归档通过相同入口执行准备与交付；脚本发现/摘要/子进程复用原模块。 */
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
 try {
  context.archive.signal?.throwIfAborted();
  const prepare = context.prepare ?? (await loadProjectArchive(context.delivery))?.prepare;
  if (prepare) await prepare(context.input, context.archive);
  context.archive.signal?.throwIfAborted();
  await context.checkpoint(() => (context.deliver ?? runProjectDelivery)(context.delivery, context.input, context.outputDir));
  context.archive.signal?.throwIfAborted();
 } catch (error) { throw error; }
}
// 未单独注册的项目继续使用原有可选项目脚本；没有脚本即原有空实现。
export const projectDeliveries = new ProjectImplementations<ProjectDeliveryContext, void>(scriptDelivery);
registerWorkDelivery(projectDeliveries,scriptDelivery);
registerDoubaoDelivery(projectDeliveries,scriptDelivery);
export async function executeProjectDelivery(projectKey: string | null, context: ProjectDeliveryContext) {
 try { await projectDeliveries.execute(projectKey, context); } catch (error) { throw error; }
}
