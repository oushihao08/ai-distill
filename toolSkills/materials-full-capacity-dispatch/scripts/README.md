# 满载补位监控脚本（`toolSkills/materials-full-capacity-dispatch/scripts/`）

适用范围与读者：维护 `materials-full-capacity-dispatch` Skill 脱敏/整理批次看守与续作逻辑的开发者与 Agent。

## 职责与关键文件

配合上级 [`../SKILL.md`](../SKILL.md)，在同一把本地台账文件锁保护下监控材料库任务状态，按实时队列空槽补位或对明确中断的分段整理任务发起续作。

| 文件 | 用途与入口 |
| --- | --- |
| `watch_preparation.py` | 监控已授权脱敏与整理批次进度，复用本地台账锁与幂等请求回执按容量补位 |
| `test_watch_preparation.py` | 单元测试（`python3 -m unittest discover -s toolSkills/materials-full-capacity-dispatch/scripts`），使用临时目录验证对账、补位与续作边界 |

## 维护边界

- 脚本只通过本机 HTTP API / 既有派发入口提交已授权任务，不越过服务层直改数据库。
