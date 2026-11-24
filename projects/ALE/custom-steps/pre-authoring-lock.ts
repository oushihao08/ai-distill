/**
 * 职责：ALE 出题前（before:4）内联校验关卡：核验材料非空，计算确定性 DOCX 二进制指纹，并预先锁定将挂载进 `environment/input/` 的精确文件名与 SHA-256。
 * 主要公开入口：`runAlePreAuthoringLock(ctx)`。
 * 边界：仅在 `project_key === "ALE"` 时运行，0 模型槽位、无外部网络或跨项目副作用。
 */
import type { InlineBeforeGateContext, InlineBeforeGateOutput } from '../../../server/custom-steps/contract';
import { sha256Hex } from '../scripts/contracts';
import { buildDeterministicAleMaterialDocx } from '../scripts/docx-material';

export async function runAlePreAuthoringLock(ctx: InlineBeforeGateContext): Promise<InlineBeforeGateOutput> {
  const effectiveMaterials = ctx.model_materials?.length ? ctx.model_materials : ctx.materials;
  if (!effectiveMaterials.length) {
    throw new Error('ALE 出题前检查未通过：当前题目未绑定任何有效来源材料');
  }

  const lockedInputs = [];
  for (const [idx, mat] of effectiveMaterials.entries()) {
    if (!mat.sha256 || !/^[a-f0-9]{64}$/i.test(mat.sha256)) {
      throw new Error(`ALE 出题前检查未通过：第 ${idx + 1} 份材料缺少有效 SHA-256 指纹`);
    }
    const hasPreparedDocs = Array.isArray(mat.prepared_documents) && mat.prepared_documents.length > 0;
    if (typeof mat.text === 'string' && !mat.text.trim() && !hasPreparedDocs) {
      throw new Error(`ALE 出题前检查未通过：第 ${idx + 1} 份材料正文为空`);
    }

    let docxSha256 = mat.sha256;
    let byteCount = typeof mat.text === 'string' ? Buffer.byteLength(mat.text, 'utf8') : undefined;
    if (hasPreparedDocs || (typeof mat.text === 'string' && mat.text.trim())) {
      const docxBytes = await buildDeterministicAleMaterialDocx({
        prepared_documents: mat.prepared_documents,
        text: mat.text,
      });
      docxSha256 = sha256Hex(docxBytes);
      byteCount = docxBytes.byteLength;
    }

    lockedInputs.push({
      index: idx + 1,
      authoring_attachment_name: `附件${idx + 1}.docx`,
      environment_input_path: `environment/input/附件${idx + 1}.docx`,
      material_id: mat.id,
      format: 'docx',
      source_sha256: mat.sha256,
      sha256: docxSha256,
      ...(typeof byteCount === 'number' ? { bytes: byteCount } : {}),
      source_names: mat.source_names ?? [],
    });
  }

  return {
    frozen_metadata: {
      locked_environment_inputs: lockedInputs,
      locked_at: new Date().toISOString(),
    },
  };
}
