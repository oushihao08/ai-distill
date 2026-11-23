<!-- 文件职责：说明通用项目定制步骤隔离插槽（Custom Steps）的契约、沙盒隔离、队列调度与跨项目零干扰边界。 -->
# 项目定制步骤底座（`server/custom-steps`）

面向后端维护者。本目录只提供**与具体项目无关的定制步骤注册表、沙盒目录守卫、单槽位子运行编排器、下游门控与 HTTP 路由**；任何项目独有的质检、反例或难度标定业务代码必须放在各自项目的 `projects/<Project>/custom-steps/` 目录内，禁止写在本目录。

## 文件与职责

| 文件 | 主要公开入口与职责 |
| --- | --- |
| `contract.ts` | 纯类型与常量契约：`CustomStepDefinition`、`SubRunDecision`、`WorkflowCustomStepView`、`MAX_ALLOWED_PARALLEL_SUBRUNS = 4` |
| `registry.ts` | `CustomStepRegistry`、`defineProjectCustomSteps()`：校验步骤锚点、顺序冲突与并发上限；对未注册项目 `O(1)` 内存返回空列表 |
| `jobs.ts` | `prepareCagedDirectories()`（`realpath` 逃逸拦截）、`runBeforeAnchorGates()`、`invalidateDownstreamCustomSteps()`、`assertBeforePublishCustomStepsReady()`、`listWorkflowCustomSteps()`、`enqueueCustomStep()`、`cancelCustomStep()`、`runNextCustomStep()` |
| `routes.ts` | `registerCustomStepRoutes()`：挂载 `/api/workflows/:id/custom-steps` 的查询、触发与取消接口 |
| `index.ts` | 唯一显式装配入口：将各项目 `projects/<Project>/custom-steps` 注册进 `customStepRegistry` |

## 隔离与安全边界

1. **老项目 100% 零干扰**：`ai_distill.steps`（`ordinal 1..10`）与 `step_attempts` 保持原样不变；定制步骤独立持久化于可选迁移 `065_project_custom_steps.sql` 创建的 `ai_distill.custom_step_runs`。未注册定制步骤的项目（如 `豆包高经济价值`、`Work法律全场景`）在出题、查询和归档时均在内存层短路返回，零额外 SQL 查询、零摘要变化、前端组件零渲染。
2. **文件沙盒关笼**：每次运行仅向处理器注入经 `realpath` 核验的 `.storage/<workflow_id>/custom-steps/<project_key>/<step_key>/<run_id>/` 目录。
3. **单槽位子运行与早停保护**：多轮标定步骤（`mode: 'queued_subruns'`）拆分为每次仅占 1 个队列槽位的独立子任务（`kind = 'custom_step'`），受 `max_parallel_subruns`（上限 4）滑窗节流，禁止一次性锁死整机槽位；达到早停条件时自动取消本机排队中的剩余子任务。
