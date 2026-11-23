/**
 * 职责：服务端全局定制步骤注册表唯一装配入口（显式白名单挂载，禁止全盘盲扫）。
 * 主要公开入口：`customStepRegistry`。
 * 新增项目步骤规范：在 `projects/<新项目>/custom-steps/index.ts` 定义专属步骤后，在此文件显式调用一行注册函数。
 */
import { registerAleCustomSteps } from '../../projects/ALE/custom-steps';
import { CustomStepRegistry } from './registry';

export const customStepRegistry = new CustomStepRegistry();

// 显式注册各项目的独立定制步骤笼子（未在此注册的主项目如豆包、Work 零受影响）
registerAleCustomSteps(customStepRegistry);

export * from './contract';
export * from './jobs';
export * from './registry';
export * from './routes';
