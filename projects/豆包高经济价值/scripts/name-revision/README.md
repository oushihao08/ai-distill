<!-- 文件职责：说明第七期主体名称修订的私有差异候选工具；不定义通用脱敏规则。 -->
# 主体名称修订候选

`build-diff-candidates.ts` 只读取已经通过材料库只读接口冻结的原件与题目快照，按文件、页、块和文本字段对齐原文与现有脱敏结果，生成供人工或指定 Agent 复核的差异候选。可选第三参数用于按每批最多 6 包生成复核接口请求，并固定本次指定的 `gpt-5.6-sol / medium`；脚本本身不调用模型、不写数据库、不应用替换。

`run-review-batches.ts`只向本机3700的正式复核HTTP接口提交上述私有批次，顺序执行并原子保存响应；已有结构完整的响应不会重复调用模型。它不预览或应用名称替换，调用中断时须先检查响应目录和服务端`name-revision-reviews`私有回执，不能直接重发未知结果。

`recover-review-responses.ts`用于HTTP客户端中断但服务端已经完整保存`result.private.json`的单包首轮或续审任务。它同时核对冻结请求、服务端私有请求、规范化请求摘要、模型与推理强度、package／redaction／workflow身份、call ID、可选`parent_review_call_id`及完整分流，再原子补写缺失响应；续审摘要严格按`{format,parent_review_call_id,packages}`绑定，首轮保持`{format,packages}`兼容。没有完整回执时只报告`missing`，同一请求存在多个完整回执时拒绝任选。该工具不调用API、模型或数据库：

```sh
bun projects/豆包高经济价值/scripts/name-revision/recover-review-responses.ts \
  .storage/verification/phase7-name-mapping-review-single-requests-20261030 \
  .storage/name-revision-reviews \
  .storage/verification/phase7-name-mapping-review-single-results-20261030 \
  11,12
```

`build-unresolved-review-requests.ts`可在任一轮单包复核进行中或完成后，纯本地提取每包`unresolved`并按原`original + before`恢复完整候选证据，生成下一轮单包请求。它按本轮冻结请求的实际格式计算摘要：首轮只绑定候选包，续审轮同时绑定已有`parent_review_call_id`；响应的父指针必须与本轮请求一致，下一轮父指针再指向本轮响应`call_id`。请求固定为`gpt-5.6-sol / medium`；服务端只接受与父回执当前未决集合逐项一致的候选，最终读取末轮回执时沿父链合并此前已确认映射与续审决定。同批`.binding.json`保留本轮父指针、回执摘要、未决理由和下一轮候选摘要。脚本不调用模型/API、不写业务数据库；本轮响应未齐时清单`complete=false`，已完成包仍可提前生成：

```sh
bun projects/豆包高经济价值/scripts/name-revision/build-unresolved-review-requests.ts \
  .storage/verification/phase7-name-mapping-review-single-requests-20261030 \
  .storage/verification/phase7-name-mapping-review-single-results-20261030 \
  .storage/verification/phase7-name-mapping-unresolved-requests-20261030
```

每次运行会清理输出目录中旧的编号请求和绑定文件，`manifest.json`是当前有效索引。公开清单只保留数量和回执标识；请求与绑定包含真实主体候选及上下文，只能留在`.storage`私有目录。

`build-preview-requests.ts`纯本地汇总请求与响应，强制校验`gpt-5.6-sol / medium`、固定54包范围、复核批次身份、请求摘要和每个候选的唯一分流，再生成只携带服务端私有`review_call_id`的逐包 preview 请求及不含主体名称的汇总清单，不把模型映射重新作为调用方输入。同一旧名称对应多个原名、跨映射／未决／忽略分流，或新化名与本包其他候选名称冲突时，该包标记为`blocked_by_ambiguity`且不会生成请求。只为“有映射且没有未决项”的包生成请求；有未决项的包进入阻断清单，零映射包标记为无需修改。它不调用模型或 API，不写业务数据库，也不应用替换：

```sh
bun projects/豆包高经济价值/scripts/name-revision/build-preview-requests.ts \
  .storage/verification/phase7-name-mapping-review-batches-20261030 \
  .storage/verification/phase7-name-mapping-review-results-20261030 \
  .storage/verification/phase7-name-preview-requests-20261030 \
  <project_id> \
  执行观察/phase7-name-replacement-20261030/scope.json
```

输出目录的 `manifest.json` 是当前有效索引；只有其中 `state=ready_for_preview` 且 `preview_file` 被列出的请求可进入后续逐包预览。每次汇总会先删除输出目录内旧的 `*.preview.json`，避免状态变化后误用旧请求；每个新请求和清单都保存固定范围摘要、复核调用ID及请求摘要。`complete=false` 表示仍有响应批次缺失，不能据此宣称全包复核完成。

输入目录中的每个 JSON 必须同时包含 `original_pages` 与 `frozen_index`。输出写入调用方指定的 `.storage/` 私有路径，权限设为 `0600`；其中可能含真实主体名称，不能提交或复制到公开交付物。候选只代表同坐标文本不同，不等于已经确认的主体映射。
