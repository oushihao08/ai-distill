---
name: feishu-operations
description: 创建和管理飞书多维表格、字段、记录和附件；执行豆包达标题目提交及按人员领题上限顺序分配、回填专家身份。通过通用CLI操作，不定义出题、评分或达标规则。
---

# 飞书操作

入口（仓库根目录）：`bun toolSkills/feishu-operations/scripts/cli.ts --help`。参数、JSON正文与恢复见[命令说明](references/commands.md)。

## 身份与目标

- 后台交付沿用应用身份：`FEISHU_APP_ID` / `FEISHU_APP_SECRET`，先执行 `auth status`；不输出凭证。认证成功不证明目标表权限。
- 用户本人资源使用 `official -- … --as user`，调用已安装的官方 `lark-cli`；认证不足按原身份修复，不自动换身份。未安装/登录应报告，不回退到另一账号。
- 从用户链接或明确配置确定目标：`/base/<base_token>?table=<table_id>&view=<view_id>`；view只控制视图。知识库链接先解析节点，不能把wiki token当Base token。不继承豆包或历史任务ID。
- 创建新的多维表格用 `base create`；在已有Base新增表用 `table create`。先查字段/记录，再决定新增、修改或删除；不清空其他表和数据。

## 执行与核对

1. 用 `--help` 和原生OpenAPI字段结构准备请求；写入JSON从stdin或私有JSON文件传入，不把材料正文或密钥放进参数。
2. 按授权操作指定ID。多维表格单元格通过record的 `fields` 写入；电子表格A1范围按[其他官方能力](references/commands.md#其他官方能力)执行，不混用。
3. 附件先 `file upload`，再把 `file_token` 填到附件字段；人员字段用该应用下有效的用户ID，手机号/外部专家ID不是 `open_id`。
4. 创建后立即保存Base/table/field/record ID，写入后回读；附件核对token和数量，HTTP成功不代替内容一致。
5. 写请求超时或断连先按原ID、稳定业务键查询，不自动换ID重发。删除只针对明确授权对象，不因空行擅自清理。

## 交付、复制与跨表防重

- 新建、复制、迁移或批量交付前，先确定本次唯一性范围。至少覆盖目标表；多表被用作同一批次的互补分区时，范围必须覆盖所有分区表。对每张表读取全量分页记录，建立写入前集合和表间交集；不把两张表想当然当作互补数据直接相加。
- 题目按workflow UUID、“题目ID”或“系统同步ID”对账；其他业务使用本次已确认的稳定键。record_id只定位当前表记录；行号、标题、prompt或显示顺序只用于辅助差异检查，不作唯一身份。
- 写入前启用已安装的`ledger` Skill，一个业务对象对应一个item；记录稳定业务ID、来源Base/table/record、目标Base/table、操作类型、请求及远端record ID。阶段至少区分写前查重、写入回执、远端回读和终局对账；结果未知记unknown，不换ID重发。对账台无法持久化时，停止新的有副作用写入。
- 稳定ID已在同一目标表时，走现有业务同步入口的复用或更新语义，不另建记录。已在同一互补分区集合的其他表时，默认跳过并在ledger标记重复；只有用户明确要求同题多目标保留时才允许跨表重复。
- 复制或迁移先完成目标回读，再根据明确授权删除来源。删除前读取表的层级配置、父子关系和实际受影响后代；父记录删除可能级联影响多条记录，不能用所选父记录数量代替影响总数。
- 写入后再次全量分页回读本次范围，核对记录数、唯一ID数、表内重复、表间交集、应交付集合与缺失/多出集合。只有该终局对账通过才把ledger item验收为accepted并宣称无重复；并发外部修改使结果不可确认时，报告未核实而不宣称完成。

## 官方Skill分工

| 官方Skill | 场景 | 本工具路径 |
| --- | --- | --- |
| lark-base | Base、表、字段、记录、视图 | 默认应用CLI；用户资源走official |
| lark-drive | 文件/附件 | file命令；其他文件操作走official |
| lark-shared | 配置、登录、身份、权限 | auth status；用户登录走official |
| lark-doc | 独立云文档读取/创建/修改 | official docs命令 |

官方入口：[larksuite/cli](https://github.com/larksuite/cli/tree/main/skills)。不复制官方Skill；命令按当前安装版本的帮助和对应reference执行。`official`保留官方退出码及确认要求，不静默追加高风险确认参数。

## 豆包交付

操作项目信息时先读[项目资料目录](projects/README.md)。豆包的人员名单、题目填写表及身份对应见[豆包资料](projects/doubao-high-value/README.md)；机器登记见该目录config.json。用 `project sync --project doubao-high-value`只读刷新本机私有快照，不把手机号当open_id。private快照不提交Git或注入出题/评分。

用户要求“提交达标题目到表格”“每人领n题”“按上限分配并填写账号/ID”时，读取并执行[按上限顺序分配](projects/doubao-high-value/README.md#按上限顺序分配与身份回填)。按本次指定上限、人员和题目顺序依次填满后换下一人，计入范围内已有领取量；不随机或平均分配。先保存稳定ID分配清单，再通过现有record更新命令回填身份并回读。`project sync`本身不分题，没有专用自动分配命令。

使用系统已有归档/飞书补传入口，由服务端调用此CLI。系统负责达标归档资格、单目标防重、字段映射、版本核对与回执；Agent仍须按上述规则确认本次多表唯一性范围并维护ledger。不要用裸record create代替系统交付，否则不保存业务回执。管理其他飞书表可直接用本通用CLI，不需要豆包项目。
