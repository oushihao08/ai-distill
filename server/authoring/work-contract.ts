/**
 * 文件职责：兼容转发层（`authoring/work-contract`），仅将调用转至唯一权威实现 `server/lifecycle/projects/work-contract.ts`。
 * 关键入口：重导出 `work-contract.ts` 全部符号，并提供 `normalizeWorkQuestion` 兼容别名（指向 `receive.ts` 的 `validateDraft`）。
 * 维护边界：Work 专属契约、schema 与同源派生规则统一在 `server/lifecycle/projects/work-contract.ts` 维护，禁止在本文件编写项目分支。
 */
export * from '../lifecycle/projects/work-contract';
export {validateDraft as normalizeWorkQuestion} from './receive';
