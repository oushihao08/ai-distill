/**
 * 职责：项目级定制步骤白名单注册表与启动期强约束校验器。
 * 主要公开入口：`CustomStepRegistry`、`defineProjectCustomSteps()`。
 * 安全不变量：
 * - 无动态目录盲扫；每个项目通过自己的独立文件夹导出清单并在 `index.ts` 显式挂载。
 * - 强制校验 `project_key` 归属、`step_key` 全局唯一、锚点顺序无冲突，以及 `max_parallel_subruns` 不超过安全上限（杜绝一次死锁 8 槽）。
 * - 未注册任何定制步骤的项目调用查询方法时 O(1) 返回空数组，零副作用。
 */
import {
  MAX_ALLOWED_PARALLEL_SUBRUNS,
  type CustomStepDefinition,
  type CustomStepPlacement,
} from './contract';

const SAFE_KEY_RE = /^[a-z][a-z0-9_]{2,63}$/;

export function defineProjectCustomSteps(
  projectKey: string,
  steps: ReadonlyArray<Omit<CustomStepDefinition, 'project_key'>>,
): CustomStepDefinition[] {
  const cleanProjectKey = projectKey.trim();
  if (!cleanProjectKey) {
    throw new Error('定制步骤注册必须提供非空 project_key');
  }
  return steps.map((step) => ({
    ...step,
    project_key: cleanProjectKey,
  }));
}

export class CustomStepRegistry {
  private readonly byStepKey = new Map<string, CustomStepDefinition>();
  private readonly byProject = new Map<string, CustomStepDefinition[]>();

  registerProject(projectKey: string, definitions: ReadonlyArray<CustomStepDefinition>): () => void {
    const cleanProjectKey = projectKey.trim();
    if (!cleanProjectKey) throw new Error('project_key 不能为空');
    if (this.byProject.has(cleanProjectKey)) {
      throw new Error(`项目定制步骤重复注册: ${cleanProjectKey}`);
    }

    const validated: CustomStepDefinition[] = [];
    const seenOrders = new Set<string>();

    for (const def of definitions) {
      if (def.project_key !== cleanProjectKey) {
        throw new Error(`定制步骤 ${def.step_key} 的 project_key(${def.project_key}) 与注册目录(${cleanProjectKey})不一致`);
      }
      if (!SAFE_KEY_RE.test(def.step_key)) {
        throw new Error(`定制步骤 step_key 格式无效（须为小写字母数字下划线）: ${def.step_key}`);
      }
      if (this.byStepKey.has(def.step_key) || validated.some((v) => v.step_key === def.step_key)) {
        throw new Error(`定制步骤 step_key 全局冲突: ${def.step_key}`);
      }
      if (!Number.isInteger(def.anchor.order) || def.anchor.order < 1) {
        throw new Error(`定制步骤 ${def.step_key} anchor.order 须为正整数`);
      }
      const anchorSlot = `${def.anchor.ordinal}:${def.anchor.placement}:${def.anchor.order}`;
      if (seenOrders.has(anchorSlot)) {
        throw new Error(`项目 ${cleanProjectKey} 在锚点 ${anchorSlot} 存在顺序冲突`);
      }
      seenOrders.add(anchorSlot);

      if (def.mode === 'inline_before_gate') {
        if (def.anchor.placement !== 'before') {
          throw new Error(`inline_before_gate 步骤 ${def.step_key} 只能挂载在 placement="before"`);
        }
        if (def.lane !== 'internal') {
          throw new Error(`inline_before_gate 步骤 ${def.step_key} 只能使用 internal 通道，不得占用模型槽位`);
        }
        if (typeof def.runBeforeGate !== 'function') {
          throw new Error(`inline_before_gate 步骤 ${def.step_key} 缺少 runBeforeGate 实现`);
        }
      } else if (def.mode === 'queued_single') {
        if (typeof def.executeRun !== 'function') {
          throw new Error(`queued_single 步骤 ${def.step_key} 缺少 executeRun 实现`);
        }
      } else if (def.mode === 'queued_subruns') {
        const cap = def.max_parallel_subruns ?? 2;
        if (!Number.isInteger(cap) || cap < 1 || cap > MAX_ALLOWED_PARALLEL_SUBRUNS) {
          throw new Error(
            `queued_subruns 步骤 ${def.step_key} 的 max_parallel_subruns(${cap}) 超出安全范围 1..${MAX_ALLOWED_PARALLEL_SUBRUNS}（禁止单题一次锁死全部槽位）`,
          );
        }
        if (typeof def.planSubRuns !== 'function' || typeof def.executeRun !== 'function') {
          throw new Error(`queued_subruns 步骤 ${def.step_key} 必须同时提供 planSubRuns 与 executeRun`);
        }
      }

      validated.push({ ...def, anchor: { ...def.anchor } });
    }

    validated.sort((a, b) =>
      a.anchor.ordinal !== b.anchor.ordinal
        ? a.anchor.ordinal - b.anchor.ordinal
        : a.anchor.placement !== b.anchor.placement
          ? a.anchor.placement === 'before'
            ? -1
            : 1
          : a.anchor.order - b.anchor.order,
    );

    this.byProject.set(cleanProjectKey, validated);
    for (const def of validated) this.byStepKey.set(def.step_key, def);

    return () => {
      this.byProject.delete(cleanProjectKey);
      for (const def of validated) this.byStepKey.delete(def.step_key);
    };
  }

  hasProject(projectKey: string | null | undefined): boolean {
    return typeof projectKey === 'string' && this.byProject.has(projectKey);
  }

  listForProject(
    projectKey: string | null | undefined,
    filter?: { ordinal?: number; placement?: CustomStepPlacement; queuedOnly?: boolean },
  ): CustomStepDefinition[] {
    if (!projectKey) return [];
    const list = this.byProject.get(projectKey);
    if (!list?.length) return [];
    return list.filter(
      (item) =>
        (filter?.ordinal === undefined || item.anchor.ordinal === filter.ordinal) &&
        (filter?.placement === undefined || item.anchor.placement === filter.placement) &&
        (!filter?.queuedOnly || item.mode !== 'inline_before_gate'),
    );
  }

  getByStepKey(stepKey: string): CustomStepDefinition | undefined {
    return this.byStepKey.get(stepKey);
  }

  registeredProjects(): string[] {
    return [...this.byProject.keys()].sort();
  }
}
