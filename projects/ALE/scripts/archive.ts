/**
 * 职责：ALE 项目第 8 步归档准备入口：读取题目冻结来源材料（支持共享材料库原文/脱敏及旧目录模式）并装填 `input.attachments`。
 * 主要公开入口：`readConfig()` 返回 null（不占用 Agent 槽位）；`prepare()` 由 `server/publishing/project-delivery.ts` 动态加载调用。
 * 边界：只读取本题已验证的冻结快照，不修改业务数据库，不向交付子进程传递数据库或供应商凭证。
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { canonicalJson } from '../../../shared/workflow-config';
import { readCurrentRedactionForDocx, readOriginalFilesForDelivery } from '../../../server/materials/redacted-docx-export';
import type { DeliveryInput, ProjectArchiveContext } from '../../../server/publishing/project-delivery';
import { readQuestionMaterials } from '../../../server/question-materials';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const conflict = (reason_code: string, message: string) => Object.assign(new HTTPException(409, { message }), { reason_code });

export async function readConfig() {
  return null;
}

export async function prepare(input: DeliveryInput, context: ProjectArchiveContext): Promise<void> {
  const { pool, workflowId, storageRoot: root, frozen } = context;
  const ids = input.question.attachment_ids;
  if (!Array.isArray(ids) || !ids.length || !Array.isArray(frozen?.materials)) {
    throw conflict('publication_attachment_snapshot_incomplete', 'ALE 出题附件快照不完整');
  }

  if (frozen.material_origin?.kind === 'library_v1') {
    const source = await readQuestionMaterials(pool, workflowId).catch(() => {
      throw conflict('publication_library_source_invalid', 'ALE 材料库来源快照或正文校验失败');
    });
    if (
      canonicalJson(source.origin) !== canonicalJson(frozen.material_origin) ||
      JSON.stringify(ids) !== JSON.stringify(source.attachments.map((item) => item.id))
    ) {
      throw conflict('publication_library_attachment_mismatch', 'ALE 冻结附件与当前题目版本不一致');
    }

    const materialMode = frozen.material_origin.material_mode ?? 'redacted';
    const structured = await readCurrentRedactionForDocx(pool, workflowId).catch(() => undefined);
    let originalFiles: DeliveryInput['attachments'][number]['original_files'];

    if (materialMode === 'original' && !structured?.selected_materials) {
      const manifest = (
        await pool.query('SELECT snapshot_manifest FROM ai_distill.question_library_sources WHERE workflow_id=$1', [workflowId])
      ).rows[0]?.snapshot_manifest;
      const expected = Array.isArray(manifest?.files)
        ? manifest.files.map((file: any) => ({
            material_id: String(file.material_id),
            original_name: String(file.original_name),
            sha256: String(file.source_sha256),
          }))
        : [];
      if (expected.length) {
        const originals = await readOriginalFilesForDelivery(pool, workflowId, root, expected).catch(() => undefined);
        if (originals?.length) {
          originalFiles = originals.map((file) => ({
            name: file.name,
            sha256: file.sha256,
            content_base64: Buffer.from(file.bytes).toString('base64'),
          }));
        }
      }
    }

    const modelAttachments = source.model_attachments?.length ? source.model_attachments : source.attachments;
    input.attachments = source.attachments.map((att, idx) => ({
      id: att.id,
      sha256: att.sha256,
      name: `材料-${String(idx + 1).padStart(3, '0')}.md`,
      text: att.content,
      ...(modelAttachments[idx]
        ? {
            model_name: `附件${idx + 1}.txt`,
            model_sha256: modelAttachments[idx]!.sha256,
            model_text: modelAttachments[idx]!.content,
          }
        : {}),
      material_mode: materialMode,
      ...(structured && 'prepared_documents' in structured && structured.prepared_documents
        ? { prepared_documents: structured.prepared_documents }
        : {}),
      ...(idx === 0 && originalFiles ? { original_files: originalFiles } : {}),
    }));
    return;
  }

  const rows = (
    await pool.query(
      "SELECT ar.id,ar.storage_path,ar.sha256,ar.content FROM ai_distill.artifacts ar WHERE ar.workflow_id=$1 AND ar.id=ANY($2::uuid[])",
      [workflowId, ids],
    )
  ).rows;
  const base = await realpath(resolve(root));
  input.attachments = await Promise.all(
    ids.map(async (id: string, idx: number) => {
      const row = rows.find((r: any) => r.id === id);
      if (!row) throw conflict('publication_attachment_missing', 'ALE 归档缺少对应附件');
      let bytes: Uint8Array;
      if (typeof row.content === 'string') bytes = Buffer.from(row.content, 'utf8');
      else {
        if (isAbsolute(row.storage_path) || String(row.storage_path).includes('\\')) {
          throw conflict('publication_material_path_invalid', 'ALE 材料路径无效');
        }
        const p = await realpath(join(base, row.storage_path));
        if (!p.startsWith(`${base}/`)) throw conflict('publication_material_path_invalid', 'ALE 材料路径越界');
        bytes = await readFile(p);
      }
      if (hash(bytes) !== row.sha256) throw conflict('publication_material_hash_mismatch', 'ALE 材料摘要不匹配');
      return {
        id,
        sha256: row.sha256,
        name: `材料-${String(idx + 1).padStart(3, '0')}.md`,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        material_mode: 'redacted' as const,
      };
    }),
  );
}
