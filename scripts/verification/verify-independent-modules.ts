/**
 * 职责：已退役的历史验证入口，仅保留明确失败提示，防止旧操作记录误调用。
 * 原脚本直接向业务schema写合成行且依赖旧步骤布局；不得恢复此行为。
 * 当前隔离验证：bun scripts/verification/verify-project-material-usage.ts。
 * 本入口不加载配置、不连接数据库、不调用模型、不写文件。
 */
console.error('此历史验证入口已停用。请阅读 scripts/verification/README.md，改用随机临时schema的 verify-project-material-usage.ts；不要对业务库写入合成记录。');
process.exitCode=1;
