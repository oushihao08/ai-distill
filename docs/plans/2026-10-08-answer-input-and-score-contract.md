# 第四、五、六步产物契约

适用于本次 F47、第五步 Qwen 配置/执行、F49 接线。第四步出题与独立质检、第六步独立评分执行器及队列已接入；验收范围分别记录，不得通过直接写数据库模拟生产完成。

## 第四步生产者

入口：`POST /api/workflows/:id/author`；第四步批量执行复用项目单步批量接口。必须显式保存第四步 Codex 模型设置，且当前版本第二、三步成功。队列固定完整冻结规则（包括 references/assets）及脱敏附件；两个隔离目录、独立会话分别起草和质检，共用已有 Codex worker 通道。

质检报告包含五项显式检查及阻断／非阻断问题。只有五项全部通过、无阻断问题、起草／质检会话独立且固定输入仍有效，才发布 `authored_question` 公共产物。标答留在该尝试的 `private` 执行目录，不登记公共 artifact，不进入公共 result 或第五步输入。失败保留执行证据；质检拒绝保留失败报告，用户检查后可显式重试。当前不自动返修。

在同一 `input_revision` 的第四步尝试中，完成出题和独立质检后才发布 `status=succeeded`、步骤成功和下列 `result`：

```ts
{
  input_revision: number;
  question_version: string; // 修改题面/附件时更新；不覆盖历史尝试
  question: string; // 仅正式题面，不混入 rubric、标答、目标分数
  attachment_ids: string[]; // 按题目引用顺序排列的 redacted_markdown artifact UUID
  quality_check: { passed: true }; // 真正独立质检通过，不是起草者自报
  answer_requirements: { input_mode: 'text'; output_mode: 'text'; tools: [] };
  rubric_version: string; // 修改评分标准时更新
  rubric: { id: string; criterion: string; max_score: number }[];
  // 标答等私有产物可另存，第五步不会选取它们
}
```

当前仅支持纯文字题面、至少一个文字脱敏附件、文字答案、无工具。未声明能力要求，或要求图片/文件交付/工具执行时，拒绝入队。`criterion` 保存完整评分要求和零分条件；条目及满分来自本项目，不固定条数或难度门槛。

附件必须属于该工作流当前材料版本的成功第二步产物，且第二步当前为成功。第五步读取文件时校验本机存储目录边界、SHA-256 和 UTF-8；对外使用“附件1”等名称，避免来源文件名泄漏。题面和附件内容本身的脱敏及题目完整性由第二、四步负责，结构白名单不能识别字符串中误贴的标答。

重新出题时，将第五步及以后步骤重置，并跳过排队/运行的旧下游尝试；先锁工作流行，再锁步骤/尝试行。第五步仍会在执行前和发布时复查第四步尝试、题目版本、题面及附件列表，防止迟到覆盖。

## 第五步消费者

- 设置：`PUT /api/projects/:id/steps/5/config`。字段仅 `provider=qwen`、`base_url`、`model`、可选 `enable_thinking`、`max_tokens`，禁止凭证字段。
- 执行：`POST /api/workflows/:id/answer?wait_ms=0`；批量沿用 `POST /api/projects/:id/steps/5/run-batch`。
- 入队：固定完整配置、题面、脱敏附件文本/指纹、材料版本、第四步尝试及 `input_digest`。同输入和配置的等待/运行/成功任务复用；配置变化不修改已入队任务，同一工作流已有活动作答时返回冲突。
- 调用：仅向 Qwen 发送 `question` 和 `materials[{name,text}]`，一题一次无历史请求。端点凭证只由服务端读取。
- 留存：`step_attempts.result` 保存完整答案、实际/请求模型、请求标识、原始 usage、时间、答案 SHA-256 和绑定版本。`model_answer` artifact 保存 UTF-8 `answer.txt`，可通过现有下载接口读取；输入、配置和结果可在执行历史查看。
- 发布：短事务复查当前工作流、题目和运行尝试再原子发布索引/成功状态；失败回滚，未发布文件清理，提交结果不确定时先查产物索引。旧尝试只影响自身历史，不覆盖新结果。
- 恢复：5分钟心跳失联标为失败；失败可显式重新入队。无自动重试计费请求。worker 为所有项目共享4条 Qwen 领取通道，材料处理沿用原有2条；不承诺多个 worker 进程合计限流。
- `tools=[]`、`output_mode=text`、`execution_steps=null`：请求耗时不是工具执行步数，也不能作为专业任务工作时长的充分证据。

## F49 评分消费者

程序入口：`validateScore(report, context)`；已留存答案校验入口：`POST /api/workflows/:id/answers/:attemptId/validate-score`。

评分上下文取自成功第四/五步和固定的作答输入快照；不读取标答、目标分数或模型身份。接口不会接收调用者伪造的上下文，不会把校验通过标记成第六步完成，也不保存/发布评分尝试。第六步执行器负责保存匿名原始评分和校验结果。

```ts
{
  binding: {
    question_version: string; input_revision: number; input_digest: string;
    rubric_version: string; rubric_digest: string;
    answer_attempt_id: string; answer_sha256: string;
  };
  assessment_valid: boolean; // 评分者已核对题目/rubric有效性；未知或冲突填 false
  items: {
    id: string; score: number; reason: string; missing?: boolean;
    evidence: {
      source: 'answer' | 'question' | 'material' | 'rubric';
      quote: string; material_index?: number; // 附件下标从0开始
    }[];
  }[];
  total: number; max_score: number; disputes: string[];
}
```

绑定字段由第六步程序准备，评分模型不选择版本。`rubric_digest` 是按条目顺序将 `{id,criterion,max_score}` 数组 JSON.stringify 后的 SHA-256。传给评分模型的业务内容只包含题面、实际附件、rubric、匿名完整答案；绑定元数据由程序关联。

校验全部条目且无未知/重复 ID、分值范围、有效性/争议、评分理由、逐条原文证据、合计/满分和绑定版本。正分须有答案原文；零分须有答案反证或明确 `missing=true`。引文必须逐字存在于指定来源。返回 `{valid,total,max_score,issues,binding}`，有争议不发布有效成绩。

程序只能检查结构、算术和可追溯性，不能证明引文满足全部正向条件、rubric 与材料不存在语义冲突，或模型难度已达标。这些仍由独立评分/质检负责；不得把校验通过称为官方机标或闭环验收。
