# 2026-10-14 交付相关会话记录

范围：同一次对话里已经做过的修改和已经说过的判断。对照材料是「豆包高经济价值 - 第五期」题目7、`projects/Work法律全场景/materials/交付规范.md` 和同目录《原文-Work法律全场景评测题包交付规范-页面转录.md》。没有重查数据库，没有跑 Oracle、Judge 或三个被测模型，没有向钉钉或出题平台提交。

## 做过的事

1. 查了上一会话。那个目标是用题目7已保存的数据，经 `projects/豆包高经济价值/delivery.ts` 的 `runProjectDelivery` 写出 `成果/交付成果.json`。当时同一入口跑了两次，文件都是 434 字节且内容相同；同目录四份脱敏 DOCX 的 SHA-256 没变。整段归档没跑，因为数据库主机解析不了。改动当时留在本地工作区，没有提交。
2. 读了那份 `交付成果.json`。内容只有题名、任务名、项目 ID、工作流 ID 和四个附件 ID。
3. 对照 Work 两份规范，写了复判：`docs/evidence/2026-10-14-delivery-vs-work-spec-rejudge.md`，并在 `docs/README.md` 加了索引。
4. 按该复判的边界改了豆包归档入口。`delivery.ts` 不再写 `交付成果.json`，只在达标调用时写 `成果/交付缺口.md`。题面、考点、思路和标答不写入该目录。若目录里已有仅含身份字段的 `交付成果.json`，运行时删除。题目7成果目录里的那份短 JSON 已删除，四份脱敏 DOCX 保留。`projects/豆包高经济价值/README.md` 已改成这个口径。`bun test projects/豆包高经济价值/delivery.test.ts` 当时 1 项通过。
5. 新增 `projects/Work法律全场景/export-accepted-task.ts` 和 `export-accepted-task.test.ts`。入口 `exportSavedQuestionSeven()` 读取题目7已保存的出题快照和四份脱敏 DOCX。只有调用方同时提供已核验的官方 `tests/test.sh`、`tests/finalize.py` 以及已有专家文件时，才组装 Harbor 六件套。页面转录路径会被拒绝。缺少官方脚本或专家文件时失败，不留下完整题包。`验收状态.json` 把 Oracle、三模型均分和平台验收记为空值，并写明空值不是通过。`projects/Work法律全场景/README.md` 和 `docs/architecture.md` 加了这个边界。
6. 用题目7数据连续调用了两次 `exportSavedQuestionSeven()`。两次都是 `缺少官方固定脚本：tests/test.sh`，目标目录为空。当时的失败原文和测试输出写在会话临时目录，目标结束后该目录已删除，现在仓库里没有这份运行日志，也没有 `LAW-007` 或 `instruction.md`。
7. `bun test projects/Work法律全场景/export-accepted-task.test.ts` 最后一次完整结果是 3 项通过、0 失败、28 个断言：题目7缺官方脚本时失败；有夹具脚本但无专家文件时失败；两者都用夹具齐备时写出六件套，且不把未跑成绩写成通过。

## 说过的判断

1. 上一会话那个窄目标完成了：文件来自交付入口，DOCX 还在，内容按当时授权可以是错的。这不等于题目合格，也不等于 Work 题包。
2. 脚本退出码 0 和归档接口里的 `delivery.status: succeeded` 只表示文件写上了。题目合格仍看第七步达标。第八步归档要在达标通过后由 `publishWorkflow` 调用。上次题目7没有这条归档成功记录。
3. 生产归档的 `DeliveryInput` 含表头、任务类型、题面、考点、思路、标答、达标结果和附件指纹。当时的豆包脚本把其中大部分丢掉，所以短 JSON 不是因为归档没有这些字段。上次那次直接调用是否传入了完整对象，没有再对调用参数。
4. 把这七项直接写进 `成果/交付成果.json` 不能当作合格修复。`成果/` 与脱敏 DOCX 同目录，标答和思路能否放在这里没有依据。即便写上，也不是 Harbor 六件套。
5. 出题 skill 的七项题目包、第七步达标、脚本落盘成功是三层状态，不能合成一个“交付成功”。
6. 对照 Work 规范，题目7那份短 JSON 按正式交付是空的。确认稿五项和 Harbor 六件套都不存在。四份脱敏 DOCX 不是 `environment/input_files/`，也不是两份一致的专家 golden。
7. Work 自己的 `delivery.ts` 也不生产六件套。它只写 `题目快照.json` 和 `交付缺口.md`，并写明不是平台提交凭据。`batch-package.ts` 成功只表示目录和 ZIP 通过预检。
8. 固定 `tests/test.sh`、`tests/finalize.py` 必须逐字复制项目方正式文件。本地《页面转录》能看到附录代码，钉钉“下载到本地”不可用，转录不能当成已逐字节核验的原件。
9. 页面转录规定的是供应商要交哪些文件，不是这些文件都由导出程序生成。`instruction.md` 由供应商按该题撰写。`task.toml`、`rubrics.json`、`prompt.md`、`Dockerfile` 按规范格式为该题编制，转录示例不是本题正文。`input_files` 用已有真实材料。两份 golden 用专家已经做好的同一批文件，`solve.sh` 只复制。`test.sh` 和 `finalize.py` 不生成。
10. 题目7现在不能导出规范题包。下一步是向项目方取得正式 `tests/test.sh` 和 `tests/finalize.py`，放到 `projects/Work法律全场景/official/tests/`。专家交付文件也要先有。齐了之后再写该题的任务书、配置、Rubric、评分提示词和 Dockerfile。Oracle、三模型分数和平台验收要单独发生，不能写进导出结果。

## 当前仓库里能看到的结果

| 路径 | 状态 |
| --- | --- |
| `assets/out/附件库/豆包高经济价值/第五期/题目7/成果/` | 短 JSON 已删除；四份脱敏 DOCX 仍在。没有 Harbor 题包 |
| `projects/豆包高经济价值/delivery.ts` | 只写 `交付缺口.md` |
| `projects/Work法律全场景/export-accepted-task.ts` | 单题导出入口；缺官方脚本或专家文件时失败 |
| `projects/Work法律全场景/official/tests/` | 没有项目方正式脚本 |
| `docs/evidence/2026-10-14-delivery-vs-work-spec-rejudge.md` | 当时的复判表 |
