/**
 * 文件职责：兼容转发层（`authoring/validate`），仅将调用转至唯一权威实现 `server/authoring/receive.ts`。
 * 关键入口：重导出 `receive.ts` 全部符号（如 `validateDraft`、`AuthoringDraft`）。
 * 维护边界：新增或修改出题接收与字段兼容逻辑时，必须直接修改 `server/authoring/receive.ts`，禁止在本文件追加独立实现。
 */
export * from './receive';
