/**
 * 职责：兼容旧 Work 契约导入路径，不承载新的项目分支。
 * 公开入口：转出 lifecycle 项目契约并保留 normalizeWorkQuestion 别名；旧调用方使用，通用步骤不得由此选择项目行为。
 */
export * from '../lifecycle/projects/work-contract';
export {validateDraft as normalizeWorkQuestion} from './receive';
