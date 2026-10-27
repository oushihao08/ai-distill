/**
 * 豆包高经济价值的生命周期注册位置。
 * 由 project-delivery.ts/publication.ts 装配；公共步骤不导入飞书实现或判断项目名称。
 * 归档前复用已有项目脚本适配；归档后生成对应材料DOCX并同步该期飞书目标，等待最终回执。
 * 飞书维护自身权限、主项目资格、材料核对和持久回执；注册 key 不代替这些业务检查。
 * 同步未成功必须向调用方报告；已提交的本地归档不回滚，也不自动重跑模型/归档。
 */
import {syncArchivedWorkflowToFeishu} from '../../publishing/feishu';
import type {ProjectImplementations, ProjectImplementation} from '../project-registry';
import type {ProjectDeliveryContext} from '../project-delivery';
import type {PublicationContext} from '../publication';
export const DOUBAO_PROJECT_KEY = '豆包高经济价值';
export function registerDoubaoDelivery(registry:ProjectImplementations<ProjectDeliveryContext,void>,scriptDelivery:ProjectImplementation<ProjectDeliveryContext,void>) {
 return registry.register(DOUBAO_PROJECT_KEY,scriptDelivery);
}
export function registerDoubaoPublication(registry:ProjectImplementations<PublicationContext,void>) {
 return registry.register(DOUBAO_PROJECT_KEY,async context=>{
  try {
   context.signal.throwIfAborted();
   const receipt=await (context.sync??syncArchivedWorkflowToFeishu)(context.pool,context.workflowId,context.root,context.exportsRoot);
   if(receipt.status!=='succeeded')throw Object.assign(new Error('项目飞书交付未完成，请查看独立同步回执'),{reason_code:'project_feishu_delivery_incomplete'});
  } catch(error){throw error;}
 });
}
