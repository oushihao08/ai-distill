/** 提取文本 API：验证路由只从当前材料的脱敏索引返回文本，并保持响应字段与访问边界；不允许原文替代脱敏结果。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import { test, expect } from 'bun:test';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { createApp } from './app';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('extracted-text API returns the current material redacted from redacted_index', async () => {
 const workflowId = '37c316ac-fe11-44d4-b328-6b0f226a98cc';
 const materialId = '37dfadd8-af62-4838-8f4a-d4a2ec1b0030';
 const otherMaterialId = '55dec76c-7b3b-4550-b30c-a5d292f432d0';
 const rawContent = JSON.stringify({ format: 'text', provider: 'local', pages: [{ page: 1, text: '原始文本', method: 'text' }] });
 const redactedContent = JSON.stringify({ materials: [
  { material_id: otherMaterialId, markdown: '另一份脱敏文本' },
  { material_id: materialId, markdown: '当前材料的脱敏文本' },
 ] });
 const queries: { sql: string; values?: unknown[] }[] = [];
 const pool = {
  query: async (sql: string, values?: unknown[]) => {
   queries.push({ sql, values });
   if (sql.includes('FROM ai_distill.workflows w JOIN ai_distill.projects')) {
    return { rows: [{id: materialId,original_name: '材料.txt',processing_status: 'redacted',sha256: 'a'.repeat(64) }], rowCount: 1 };
   }
   if (sql.includes("ar.kind='private_extracted_pages'")) {
    return { rows: [{ content: rawContent, storage_path: 'unused.json', sha256: sha256(rawContent) }], rowCount: 1 };
   }
   if (sql.includes("idx.kind='redacted_index'")) {
    return { rows: [{ content: redactedContent, storage_path: 'unused-index.json', sha256: sha256(redactedContent) }], rowCount: 1 };
   }
   throw new Error(`Unexpected query: ${sql}`);
  },
 } as unknown as Pool;
 const app = createApp(pool, '.');

 const response = await app.request(`/api/workflows/${workflowId}/materials/${materialId}/extracted-text`);
 expect(response.status).toBe(200);
 const body = await response.json() as { redaction_status: string; redacted_text?: string };
 expect(body.redaction_status).toBe('redacted');
 expect(body.redacted_text).toBe('当前材料的脱敏文本');
 expect(body.redacted_text).not.toBe('另一份脱敏文本');
 expect(queries.some(query => query.values?.includes(3))).toBe(true);
});
