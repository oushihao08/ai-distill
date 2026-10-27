/** 旧Work契约导入路径兼容；实际项目实现位于生命周期项目目录，通用步骤不得由此选择项目行为。 */
export * from '../lifecycle/projects/work-contract';
export {validateDraft as normalizeWorkQuestion} from './receive';
