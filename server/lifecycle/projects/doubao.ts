/**
 * 豆包法律与医疗两个主项目的生命周期注册位置。
 * 由 project-delivery.ts/publication.ts 装配；公共步骤不导入飞书实现或判断项目名称。
 * 归档前复用已有项目脚本适配；归档后生成对应材料DOCX并同步该期飞书目标，等待最终回执。
 * 两个主项目共用同一回调，飞书目标仍由 feishu-targets 按主项目分别冻结；注册 key 不代替权限或业务检查。
 * 同步未成功必须向调用方报告；已提交的本地归档不回滚，也不自动重跑模型/归档。
 */
import {syncArchivedWorkflowToFeishu} from '../../publishing/feishu';
import type {ProjectImplementations, ProjectImplementation} from '../project-registry';
import type {ProjectDeliveryContext} from '../project-delivery';
import type {PublicationContext} from '../publication';
export const DOUBAO_PROJECT_KEY = '豆包高经济价值';
export const DOUBAO_MEDICAL_PROJECT_KEY = '豆包高经济价值-医疗';
const PROJECT_KEYS=[DOUBAO_PROJECT_KEY,DOUBAO_MEDICAL_PROJECT_KEY] as const;
export function registerDoubaoDelivery(registry:ProjectImplementations<ProjectDeliveryContext,void>,scriptDelivery:ProjectImplementation<ProjectDeliveryContext,void>) {
 const disposers=PROJECT_KEYS.map(key=>registry.register(key,scriptDelivery));
 return()=>{for(const dispose of disposers)dispose();};
}
export function registerDoubaoPublication(registry:ProjectImplementations<PublicationContext,void>) {
 const publish=async (context:PublicationContext)=>{
  try {
   context.signal.throwIfAborted();
   const receipt=await (context.sync??syncArchivedWorkflowToFeishu)(context.pool,context.workflowId,context.root,context.exportsRoot);
   if(receipt.status!=='succeeded')throw Object.assign(new Error('项目飞书交付未完成，请查看独立同步回执'),{reason_code:'project_feishu_delivery_incomplete'});
  } catch(error){throw error;}
 };
 const disposers=PROJECT_KEYS.map(key=>registry.register(key,publish));
 return()=>{for(const dispose of disposers)dispose();};
}
