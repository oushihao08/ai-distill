/**
 * 被测对象：`server/custom-steps/registry.ts`、`server/custom-steps/index.ts` 及定制步骤目录物理边界。
 * 验证边界：注册契约校验、未注册项目零开销返回、底座对业务项目零耦合、项目间零交叉引用。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STEP_REGISTRY } from '../../shared/step-registry';
import { customStepRegistry } from './index';
import { CustomStepRegistry, defineProjectCustomSteps } from './registry';

const repoRoot = resolve(import.meta.dir, '../..');

describe('CustomStepRegistry 与笼式物理隔离校验 (T1)', () => {
  test('默认全局注册表仅挂载 ALE，对豆包、Work 与未知项目 O(1) 返回空数组', () => {
    expect(customStepRegistry.hasProject('ALE')).toBe(true);
    expect(customStepRegistry.listForProject('ALE').map((s) => s.step_key)).toEqual([
      'ale_pre_authoring_lock',
      'ale_verify_gate',
      'ale_calibrate_8plus1',
    ]);

    for (const untouched of ['豆包高经济价值', 'Work法律全场景', 'Skill Dependency', '', null, undefined]) {
      expect(customStepRegistry.hasProject(untouched)).toBe(false);
      expect(customStepRegistry.listForProject(untouched)).toEqual([]);
      expect(customStepRegistry.listForProject(untouched, { queuedOnly: true })).toEqual([]);
    }
  });

  test('基础步骤注册表 STEP_REGISTRY 保持既有 9 条原始步骤未改动', () => {
    const ordinals = STEP_REGISTRY.map((s) => s.ordinal);
    expect(ordinals).toEqual([1, 2, 9, 3, 4, 5, 6, 7, 8]);
  });

  test('拒绝重复 step_key、同锚点同 order 冲突、超上限并发窗口及缺失处理器', () => {
    const reg = new CustomStepRegistry();
    reg.registerProject(
      'DemoA',
      defineProjectCustomSteps('DemoA', [
        {
          step_key: 'demo_gate_1',
          name: '测试门禁1',
          description: 'desc',
          anchor: { ordinal: 4, placement: 'after', order: 1 },
          mode: 'queued_single',
          lane: 'internal',
          executeRun: async () => ({ ok: true }),
        },
      ]),
    );

    // 重复 step_key
    expect(() =>
      reg.registerProject(
        'DemoB',
        defineProjectCustomSteps('DemoB', [
          {
            step_key: 'demo_gate_1',
            name: '同名冲突',
            description: 'desc',
            anchor: { ordinal: 4, placement: 'after', order: 1 },
            mode: 'queued_single',
            lane: 'internal',
            executeRun: async () => ({ ok: true }),
          },
        ]),
      ),
    ).toThrow(/全局冲突/);

    // 同项目同锚点 order 冲突
    expect(() =>
      reg.registerProject(
        'DemoC',
        defineProjectCustomSteps('DemoC', [
          {
            step_key: 'demo_c_1',
            name: '步骤1',
            description: 'desc',
            anchor: { ordinal: 4, placement: 'after', order: 1 },
            mode: 'queued_single',
            lane: 'internal',
            executeRun: async () => ({}),
          },
          {
            step_key: 'demo_c_2',
            name: '步骤2',
            description: 'desc',
            anchor: { ordinal: 4, placement: 'after', order: 1 },
            mode: 'queued_single',
            lane: 'internal',
            executeRun: async () => ({}),
          },
        ]),
      ),
    ).toThrow(/顺序冲突/);

    // 8 路全并发合法通过，超过安全上限 8 拒绝
    expect(() =>
      reg.registerProject(
        'Demo8Parallel',
        defineProjectCustomSteps('Demo8Parallel', [
          {
            step_key: 'demo_8_ok',
            name: '8路并发标定',
            description: 'desc',
            anchor: { ordinal: 4, placement: 'after', order: 1 },
            mode: 'queued_subruns',
            lane: 'agent',
            max_parallel_subruns: 8,
            planSubRuns: () => ({ action: 'succeeded', progress_label: 'ok', summary: {} }),
            executeRun: async () => ({}),
          },
        ]),
      ),
    ).not.toThrow();

    expect(() =>
      reg.registerProject(
        'DemoD',
        defineProjectCustomSteps('DemoD', [
          {
            step_key: 'demo_d_sub',
            name: '超限并发',
            description: 'desc',
            anchor: { ordinal: 4, placement: 'after', order: 1 },
            mode: 'queued_subruns',
            lane: 'agent',
            max_parallel_subruns: 13,
            planSubRuns: () => ({ action: 'succeeded', progress_label: 'ok', summary: {} }),
            executeRun: async () => ({}),
          },
        ]),
      ),
    ).toThrow(/超出安全范围 1\.\.12/);
  });

  test('静态笼式边界：server/custom-steps 核心实现零业务项目硬编码，projects/ALE/custom-steps 零跨项目引用', () => {
    const coreDir = join(repoRoot, 'server/custom-steps');
    for (const name of readdirSync(coreDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'index.ts') continue;
      const content = readFileSync(join(coreDir, name), 'utf8');
      expect(content).not.toMatch(/projects\/ALE|豆包高经济价值|Work法律全场景/);
    }

    const aleCustomDir = join(repoRoot, 'projects/ALE/custom-steps');
    for (const name of readdirSync(aleCustomDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const content = readFileSync(join(aleCustomDir, name), 'utf8');
      expect(content).not.toMatch(/projects\/(?!ALE\/)/);
      expect(content).not.toMatch(/豆包高经济价值|Work法律全场景/);
    }
  });
});
