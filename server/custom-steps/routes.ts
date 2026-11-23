/**
 * 职责：挂载工作流定制步骤 HTTP 路由（查询状态、触发单步/子任务队列、手动取消、保存结构化 JSON 返修评价）。
 * 主要公开入口：`registerCustomStepRoutes(app, pool, storageRoot, registry)`。
 * 边界：仅操作 `custom_step_runs` 隔离表，强制 `repair_evaluation` 为 JSON 对象，不修改基础 `steps` 或其他项目数据。
 */
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Pool } from 'pg';
import {
  cancelCustomStep,
  enqueueCustomStep,
  listWorkflowCustomSteps,
  saveCustomStepRepairEvaluation,
} from './jobs';
import type { CustomStepRegistry } from './registry';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseUuid(raw: string): string {
  if (!UUID_RE.test(raw)) throw new HTTPException(400, { message: '无效的 UUID 参数' });
  return raw;
}

export function registerCustomStepRoutes(
  app: Hono,
  pool: Pool,
  storageRoot: string,
  registry: CustomStepRegistry,
): void {
  app.get('/api/workflows/:id/custom-steps', async (c) => {
    const workflowId = parseUuid(c.req.param('id'));
    return c.json(await listWorkflowCustomSteps(pool, registry, workflowId));
  });

  app.post('/api/workflows/:id/custom-steps/:stepKey/run', async (c) => {
    const workflowId = parseUuid(c.req.param('id'));
    const stepKey = c.req.param('stepKey').trim();
    let body: Record<string, unknown> = {};
    const rawText = await c.req.text();
    if (rawText.trim()) {
      try {
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not object');
        }
        body = parsed as Record<string, unknown>;
      } catch {
        throw new HTTPException(400, { message: '请求体必须是有效 JSON 对象' });
      }
    }
    const result = await enqueueCustomStep(pool, storageRoot, registry, workflowId, stepKey, body);
    return c.json(result, 202);
  });

  app.put('/api/workflows/:id/custom-steps/:stepKey/repair-evaluation', async (c) => {
    const workflowId = parseUuid(c.req.param('id'));
    const stepKey = c.req.param('stepKey').trim();
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: '返修评价请求体必须是合法 JSON 对象' });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HTTPException(400, { message: '返修评价字段必须是 JSON 对象，不允许字符串或数组' });
    }
    const body = parsed as Record<string, unknown>;
    const candidate = 'repair_evaluation' in body ? body.repair_evaluation : body;
    return c.json(await saveCustomStepRepairEvaluation(pool, registry, workflowId, stepKey, candidate));
  });

  app.post('/api/workflows/:id/custom-steps/:stepKey/cancel', async (c) => {
    const workflowId = parseUuid(c.req.param('id'));
    const stepKey = c.req.param('stepKey').trim();
    return c.json(await cancelCustomStep(pool, storageRoot, registry, workflowId, stepKey));
  });
}
