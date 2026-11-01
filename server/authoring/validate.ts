/**
 * 职责：保留历史 `authoring/validate` 导入路径，避免旧调用方中断。
 * 公开入口：转出 `receive.ts`；普通出题接收直接使用后者，本文件不维护第二套校验规则。
 */
export * from './receive';
