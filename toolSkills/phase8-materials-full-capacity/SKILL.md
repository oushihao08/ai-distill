---
name: phase8-materials-full-capacity
description: 定时推进高经第八期八个固定来源目录的材料入库、aliases 脱敏和材料整理；逐轮按 Agent/API 两条队列的运行层与等待层真实容量持续补位。仅用于本批 132 个逻辑包。
---

# 第八期材料满载执行

适用范围：`/Users/jack/Documents/codes/lvgou/ai-distill` 的八个固定来源目录和 `执行观察/phase8-three-roots-materials-20261105/逐包状态表.csv` 中 132 个逻辑包。每个非重复包依次完成 MinerU 原子提取入库、`aliases` Agent 整包脱敏、材料整理。不同来源目录同号 case 独立；同一来源目录的同号子目录合成一包。不得扩大范围或处理出题、作答、评分。

## 每轮执行

1. 重新完整读取仓库 `AGENTS.md`、本 Skill、`skill/SKILL.md`、`.storage/automation-runs/phase8-three-roots-materials-20261105/state.json` 和逐包状态表。重新扫描八个来源的完整文件清单与 SHA256。经 `ai-distill` CLI 和本机 HTTP API 回读 imports、当前 package/revision、redaction、preparation、monitor、queue diagnose/show 与并发设置；不直连数据库。实时 API 优先于旧台账。完整原件 SHA256 集合与全库某当前 revision 完全相同的包标记重复并排除。
2. 遍历全部 132 行，推导每包当前唯一的下一阶段。已有活动、排队、成功或原请求回执未知的任务不重派。只有取得正式 `package_id/revision_id` 才派 aliases；只有成功且取得 `redaction_id` 才派材料整理。按 `queue show` 的当前 `running`、`queued`、`reserved`、`waiting`、`available`、`limit` 分别计算 Agent 与 API 的运行层和等待层空位。历史配置数字不是容量事实。
3. **强制持续补位**：对每条 lane，只要运行层或等待层有空位且仍有合规 ready 包，就逐个提交；每提交一个，立即保存完整回执、回读任务与队列并重算，再寻找下一个。继续到该 lane 的运行层与等待层都满，或遍历完整张表后确实没有该 lane 的 ready 包。不得固定每轮派发数量，不得因一个包阻塞、413、文件名拒绝或 `outcome_unknown` 停止其他独立包。未知回执只锁定原包和原 request-key；服务整体不可用或容量读数不可靠时停止该 lane 写入并留证。
4. 若空位仍在，明确记录 Agent/API 各自的运行与等待占用、空位数、已检查的全部候选、每个未派发原因和下一步。不能把 `running`、队列健康或“本轮已派发”当成满载。一个包完成上游阶段时，立即将其下游任务纳入本轮 ready 集合；还有槽位就继续补。

## 原子性与追溯

- PNG/JPG/JPEG 走 MinerU；DOC/WPS/OFD 用现有 `library files prepare` 可追溯预处理。保留原件 SHA256、转换器、分片和页码映射、输出摘要及 provenance。技术分片仍归属原逻辑 case，以完整原件集合作为一个正式包原子发布。不删文件、不漏文件、不改名覆盖。JPG 签名不符、XLSX、重复上传名或转换失败的包保持阻塞。
- 写前落盘来源、case、阶段、实际命令、request-key；写后立即落盘完整响应、任务 ID 和业务 ID，并回读。`provider_timeout`、`deadline_exceeded`、`heartbeat_unavailable`、截断、失败或未知结果不在同轮重试；历史失败只有逐包账本已有明确新 attempt 授权才可重试。
- 状态变化写入逐包状态表及 ledger 的 `task.json`、`attempts/`、`observations/`，随后运行 `/Users/jack/.agents/skills/ledger/scripts/view.py` 重新生成对账台。无变化不制造记录。遵守项目协作规则；不改源材料、代码、模型、并发或配置，不运行测试、lint、迁移，不自行重启服务或取消未知任务。

按用户设定的 4.5 分钟 heartbeat 执行。正常运行保持安静；只在失败、阻塞、需用户决定或全部完成时通知。全部非重复包三阶段完成后停用本 heartbeat。
