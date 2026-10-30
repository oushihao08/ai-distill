# 题目与交付痕迹审查工具

供本仓库AI审查题目字段、附件及批量命名质量。入口见[SKILL.md](SKILL.md)，由`.agents/skills/ai-trace-review`发现。

`scripts/task_names.py`通过现有飞书CLI按稳定记录ID只修改“任务名称”。不读取凭证、不连接数据库、不同步业务题包，不替代归档交付接口；题包task_name暂无编辑API。正式交付一致性检查可能把飞书单独改名判为与业务源不同。

## 改名工具

输入JSON为`{"items":[{"record_id":"rec…","workflow_id":"题目UUID","before":"准确原名","after":"新名称"}]}`。工作流ID须与飞书“题目ID”或“系统同步ID”一致；重复ID、空名称、旧值冲突拒绝。实际ID从本次读取获得，不使用示例ID。

```sh
python3 toolSkills/ai-trace-review/scripts/task_names.py plan --base <BaseToken> --table <TableID> --input <改名JSON> --out <新计划文件>
python3 toolSkills/ai-trace-review/scripts/task_names.py apply --plan <计划文件> --scope feishu-only
```

plan只读完整记录，生成绑定目标及旧字段的私有计划。apply逐题重新核对身份和全部字段，写前落盘意图，调用现有record update只写名称，保存回执并回读全字段。检测到无关字段变化时记录冲突并停止；网络不明时停止，不自动重发。计划、进度和备份含私有记录，存于`.storage/`等非输入目录，文件权限0600；不提交Git。

同计划存在意图未结算时，apply只读对账：仅任务名称已变为目标且其他字段相同才记为已对账；仍是旧值或其他值则标未知/冲突并停止，不假定失败。已有确认成功项也须回读；文件锁防止同计划多写者，不能阻止飞书用户并发编辑，飞书接口不提供跨客户端原子比较交换。

只支持显式的飞书单独改名。不得用本工具改其他业务字段或宣称数据库同步。脚本帮助及结构验证不证明真实写入已验收；本次创建不修改任何远端记录。
