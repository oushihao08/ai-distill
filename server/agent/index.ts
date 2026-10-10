/**
 * 职责：独立 Agent 执行模块公共导出，汇集任务入口、契约和设置能力。
 * 使用场景：业务执行器及 HTTP 层只从本入口依赖 Agent 能力。
 */
export {configureAgentAdapter,runAgent,SCORE_ISOLATION_CONFIG} from './runner';
export type {AgentTask,AgentResult,AgentAdapter} from './runner';
export * from './config';
