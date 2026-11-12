<!-- 文件职责：说明豆包高经济价值-医疗项目脚本入口和维护边界。 -->
# 豆包高经济价值-医疗项目脚本

此目录按用户要求与 `豆包高经济价值` 法律主项目同构，集中管理医疗主项目各期共用的脚本。

| 文件 | 用途 | 调用方式 |
| --- | --- | --- |
| `delivery.ts` | 归档输入必须已达标；写入 `交付缺口.md`，不生成 Harbor 文件或题目正文。若 `交付成果.json` 恰好只含指定身份摘要字段，会删除该摘要；含其他字段则拒绝覆盖。保留同目录 DOCX | 由服务端归档流程调用 |

`delivery.ts` 与法律主项目 `scripts/delivery.ts` 逻辑一致，仅标题标识医疗主项目；其中的确认稿与 Harbor 缺口文案沿用同一模板，不构成医疗专业验收结论。医疗专家校准、患者材料处理和去标识化边界见[项目 README](../README.md) 的「数据与专业边界」，实际验收以当期项目方规则为准。

服务端由 `server/publishing/project-delivery.ts` 解析 `delivery.ts`，在独立进程中运行；脚本文件及整个 `scripts/` 内容会参与归档指纹。归档脚本不持有凭证、不启动飞书 CLI。项目交付的生命周期注册见 `server/lifecycle/projects/doubao.ts`，两个主项目共用同一回调；飞书目标由 `server/publishing/feishu-targets.ts` 按主项目分别冻结，医疗主项目只对已登记期次启用。

## 按期次提交飞书

飞书同步由服务端 `publishing/feishu.ts` 在本地归档提交后执行，不由无凭证的交付子进程调用；达标且归档成功才可提交。同步失败可独立补传，不重做题目；以归档结果 `feishu_sync` 中的远端 record_id 及链接为提交回执。

医疗主项目当前只登记「第九期」→[第九期-医疗](https://ncn9ze979yuh.feishu.cn/base/DuizblJJwavfGjsB4KJcPH0TnRg?table=tblDxEX3XN2uYGxV&view=vewyxvmiay)（`tblDxEX3XN2uYGxV`），表结构与「第八期-内部」一致。未登记期次返回 `not_applicable`，不按名称临时找表或建表。通用表格/字段/记录/附件操作复用[飞书操作工具](../../../toolSkills/feishu-operations/SKILL.md)的 CLI；正式补传仍走原工作流入口以保留版本核对和业务回执。

源码修改须经常驻 API/worker 授权重载后才生效；本目录的脚本与文档不代表运行进程已加载，也不代表已完成真实出题、归档或远端交付验收。
