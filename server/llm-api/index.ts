/**
 * 职责：独立大模型 API 模块公共入口；与 server/agent 并列，供作答、脱敏及其他业务复用。
 * 关键入口：createModelApiClient()、resolveModelApiConfig()、readModelApiDefaults() 及请求/结果契约。
 */
export {createModelApiClient} from './client';
export {readModelApiCatalog,type ModelApiOption} from './models';
export {resolveModelApiConfig,readModelApiDefaults,resolveQwenConfig,resolveOtherApiConfig} from './config';
export type {QwenApiConfig,OtherApiConfig} from './config';
export * from './types';
