/**
 * 职责：ALE 出题前（before:4）内联校验关卡：核验材料非空并预先锁定将挂载进 `environment/input/` 的精确文件名与 SHA-256。
 * 主要公开入口：`runAlePreAuthoringLock(ctx)`。
 * 边界：仅在 `project_key === "ALE"` 时运行，0 模型槽位、无外部网络或跨项目副作用。
 */
import type { InlineBeforeGateContext, InlineBeforeGateOutput } from '../../../server/custom-steps/contract';

export function runAlePreAuthoringLock(ctx: InlineBeforeGateContext): InlineBeforeGateOutput {
  const effectiveMaterials = ctx.model_materials?.length ? ctx.model_materials : ctx.materials;
  if (!effectiveMaterials.length) {
    throw new Error('ALE 出题前检查未通过：当前题目未绑定任何有效来源材料');
  }

  const lockedInputs = effectiveMaterials.map((mat, idx) => {
    if (!mat.sha256 || !/^[a-f0-9]{64}$/i.test(mat.sha256)) {
      throw new Error(`ALE 出题前检查未通过：第 ${idx + 1} 份材料缺少有效 SHA-256 指纹`);
    }
    if (typeof mat.text === 'string' && !mat.text.trim()) {
      throw new Error(`ALE 出题前检查未通过：第 ${idx + 1} 份材料正文为空`);
    }
    return {
      index: idx + 1,
      authoring_attachment_name: `附件${idx + 1}.txt`,
      environment_input_path: `environment/input/附件${idx + 1}.txt`,
      material_id: mat.id,
      sha256: mat.sha256,
      ...(typeof mat.text === 'string' ? { bytes: Buffer.byteLength(mat.text, 'utf8') } : {}),
      source_names: mat.source_names ?? [],
    };
  });

  return {
    frozen_metadata: {
      locked_environment_inputs: lockedInputs,
      locked_at: new Date().toISOString(),
    },
  };
}
