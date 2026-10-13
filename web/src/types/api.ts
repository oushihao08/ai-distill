/** 文件职责：集中转出前端使用的后端 API 类型。
 * 关键导出与用法：重导出 shared/types.ts 的项目、工作流、步骤、材料和结果契约，API client 消费端据此标注响应；字段变更须同时检查服务端运行时校验。
 */
export * from '@shared/types';
export * from '@shared/workflow-results';
