# 豆包高经·飞书资料

适用于本项目飞书操作、人员对应及后续领取/填报程序。按用户2026-10-27提供的两个链接登记，2026-11-10 补登记医疗主项目第九期目标；[config.json](config.json)保存坐标与映射，不含密钥、名单明细或自动分配规则。医疗目标只共用人员名单与字段对应，所属主项目与法律项目隔离，见下文。

## 存储位置

```text
doubao-high-value/
├── README.md              用途、字段对应及流程说明
├── config.json            Base/table/view ID、应用身份、映射和一人多题规则
├── .gitignore             只忽略本项目private目录
└── private/
    └── snapshot.json      CLI最新完整只读快照：字段结构、人员、现有题目归属和待处理事项
```

快照具有checked_at时间，文件0600、目录0700；失败不覆盖上一份快照。远端数据才是当前事实，快照不是数据库备份，也不是新的业务认领系统。新同步只覆盖本登记的三张名单表和题目身份字段，不读取题面、标答或附件正文。App Secret、access token、Cookie不保存在这里。

## 资源与用途

| 资源 | 入口 | 用途 |
| --- | --- | --- |
| 内部有资质名单 | [人员名单主表](https://ncn9ze979yuh.feishu.cn/base/Xl6lb8KvTaESHjsPze0ctsBunvh?table=tblxzjHeQIzYoJ78&view=vewjWyh7OC) | 用户本次指定的人员对应来源 |
| 久盈提供名单 | [数据表](https://ncn9ze979yuh.feishu.cn/base/Xl6lb8KvTaESHjsPze0ctsBunvh?table=tblsdZJZnxcFdjlg) | 同一人员Base中的名单分类；不因表名自动推导资格 |
| 关联久盈名单 | [数据表](https://ncn9ze979yuh.feishu.cn/base/Xl6lb8KvTaESHjsPze0ctsBunvh?table=tblx2EtDTrr7FOwu) | 同上，保留独立来源记录 |
| 模仿项目方填写题目·第六期 | [题目填写表](https://ncn9ze979yuh.feishu.cn/base/DuizblJJwavfGjsB4KJcPH0TnRg?table=tblbT3gCovrk5lf0&view=vewzZJYBEu) | 后续按领取人填写身份的目标；这是模拟填写表，不据此声称项目方已接收 |
| 七期-久盈 | [第七期题目表](https://ncn9ze979yuh.feishu.cn/base/DuizblJJwavfGjsB4KJcPH0TnRg?table=tblG6Bjofil7NoLS&view=vewRgfQZS9) | 用户指定的第七期同步更新目标；按稳定系统同步ID更新现有记录，不以表内行号替代题目身份 |
| 第八期-久盈 | [第八期久盈表](https://ncn9ze979yuh.feishu.cn/base/DuizblJJwavfGjsB4KJcPH0TnRg?table=tbl5Y22Kleq8Ade6&view=vewE0zskag) | 第八期久盈交付目标；表名、table ID 和 view ID 冻结，交付不按名称重新定位 |
| 第八期-内部 | [第八期内部表](https://ncn9ze979yuh.feishu.cn/base/DuizblJJwavfGjsB4KJcPH0TnRg?table=tblERmxMpoWIDKAi&view=vewFVqBCuB) | 第八期内部交付目标；表名、table ID 和 view ID 冻结，为本期系统默认目标 |
| 第九期-医疗 | [医疗第九期题目表](https://ncn9ze979yuh.feishu.cn/base/DuizblJJwavfGjsB4KJcPH0TnRg?table=tblDxEX3XN2uYGxV&view=vewyxvmiay) | 医疗主项目第九期交付目标，并按用户2026-11-10指定同时承接医疗第一期的题目草稿；表结构与「第八期-内部」一致，身份字段同为「姓名／ID」；表名、table ID 和 view ID 冻结 |
| 工具测试Base | [验收多维表格](https://ncn9ze979yuh.feishu.cn/base/XWf6bPBDpakcAasqavJc6BzOn7e) | 合成测试专用；不与人员名单、真实题目混用 |

「第九期-医疗」属于另一主项目 `豆包高经济价值-医疗`（project_group_id `e23bfcec-5403-42df-ad92-ea071f6ab24a`），与本 config 顶部登记的法律主项目 group 不同。它沿用同一人员名单与三项身份字段对应，仅作为交付/领题的目标登记；服务端按主项目分别冻结默认目标，法律第八期的两个目标不受影响。2026-11-10 医疗第一期 6 道已出题题目以草稿形态（`题目是否完成`=未完成）写入此表，医疗第一期的显式默认目标也指向此表；这不是第九期期次记录，也不代表已完成验收或归档。`project sync` 会把这张表纳入只读身份快照，不因此把医疗期次当作法律期次，也不自动分配题目。

view ID只决定查看入口，不是数据表或某个人的ID。名单行record_id、专家平台ID、飞书用户open_id、题目workflow UUID、题目表record_id是不同身份，不能相互替代。

## 三个填报字段的对应

| 人员名单 | 题目表 | 已核对类型及处理 |
| --- | --- | --- |
| ID | xpert uid | 文本→文本。保持完整字符串，不转JS Number或按姓名猜ID |
| 飞书号（手机号码） | 飞书账号 | 文本→飞书人员字段(type=11，可多选)。先对应同一应用下的open_id，再写`[{"id":"ou_…"}]`；写入时使用一致的user_id_type=open_id |
| 专家来源 | 专家来源 | 文本→单选(type=3)。按名单实际值填写；如需别名映射，先有明确业务决定再写入config.identity_mapping.expert_source_aliases |

姓名供人工辨认，备注供上下文，不是唯一匹配键。一个人同时出现在多张名单时保留各table/record引用；相同ID但姓名、手机号或来源不同，快照报告冲突，不默默合并成已确认身份。

如旧题目已经有同一xpert uid和唯一的飞书用户ID，快照会记录这个“已有填报观察”；这不是手机号与账号已验证一致的证明。需要回读人员信息或通过已授权的用户查询对应后，才能作为后续可靠映射。找不到账号时保留未解析，不编造ID、不把手机号直接写进人员字段。

飞书用户open_id绑定应用；未来保存的手机号→open_id对应须同时保存app_id，切换应用后重新对应，不跨应用直接复用。

## 一个人领取n道题

人员与题目是**一对多**：同一专家ID可以对应多个不同题目。用户已指定按上限顺序分配；上限数值、人员及题目范围在每次任务中确定。config中的null表示未登记固定数值，不表示禁止执行用户授权的分配；automatic_allocation_enabled=false表示未开启后台自动分配，不阻止Agent按本流程操作。

后续领取/填报流程：

1. 读取最新名单，明确本次领取人和题目清单；人员使用专家ID并保留来源Base/table/record引用。
2. 对每道题保存领取关系：题目workflow UUID或稳定题目ID、目标Base/table、目标record_id、领取人的专家ID、来源record引用、当次确认的账号和专家来源。领取关系不能只存在于一次对话。
3. 一个人可关联多个题目；题目归属变更单独记录，不把名单手机号或排列顺序当作领取记录。
4. 写入前重新核对名单/领取关系与目标；只更新该题的xpert uid、飞书账号、专家来源三项，不改题面、评分或其他人员的题目。已有不同归属需明确处理，不默认覆写。
5. 回读这三个字段，与本次身份对应核对；保存远端record_id和字段回执。飞书填报成功不等于正式提交或项目方验收。

### 按上限顺序分配与身份回填

触发：用户要求将达标题目提交到表格并按每人上限分配，或对已交付记录补填领取人。执行规则：

1. 确定本次目标表、达标题目清单、人员清单、每人总上限及计数范围。沿用当前任务已明确的信息；缺少关键上限或范围时只问缺失项，不把示例数值当默认值。默认计数范围为本次明确的目标题目表；若用户指定跨表或跨期累计，则读取完整指定范围。
2. 按用户指定顺序排列。未指定时采用指定人员视图与题目视图的当前顺序，保存有序record_id/专家ID/稳定题目ID清单；行号只用于本次排序，不作为身份或恢复依据。读取全量分页记录，不能把API默认返回顺序当作视图顺序。工具无法取得视图排序时明确此缺口，不自行声称已按“前n题”分配。
3. 统计每人的已有领取数，按稳定题目ID去重；剩余额度=max(0,上限−已有领取数)。已完整分配的题目保留并计数；已分配但身份字段缺失时按原专家补齐，不当成新题重分。身份冲突单列处理，不覆盖不同领取人。
4. 按题目顺序，把未分配题依次分给第一个有剩余额度的人；填满后换下一人，最后一人可不足上限。所有人额度用尽则保留余题未分配并报告，不超额、不擅自添加人员。
5. 写入前按前文身份规则解析open_id、核对专家来源选项；保存本批次私有分配清单及执行回执（题目稳定ID、目标record_id、专家ID、名单record引用、身份字段、顺序、上限、计数范围和执行状态），不能只留在对话里。当前没有系统领取关系专用接口，不声称清单已保存到业务数据库。
6. 达标题目尚未交付时，先走系统已有交付入口并取得远端record_id；不得裸建题目绕过业务回执。已存在的题目用record更新或batch-update，仅填写xpert uid、飞书账号、专家来源。每批写前重读归属和额度，执行后回读三项身份字段；发现并发变化时重新计算，不覆盖。该方式不是跨会话原子锁，同一目标避免同时分配。
7. 超时或中断后按原清单和远端实际结果恢复：已正确写入的跳过，结果未知的先查后写。报告本次成功数量、每人已有/新增/合计、剩余未分配及失败原因；不把模拟填表称为项目方正式接收。

示例（仅演示）：上限为6、人员原先均未领取时，第1–6题分给第一人，第7–12题分给第二人；第一人已有2题时，本次先分4题给第一人，再分给第二人。

这是Agent执行说明，复用现有通用CLI；没有新增专用分配命令或后台自动分配。写入前的身份问题按下节处理，不因已有分配说明就忽略未解析账号或来源差异。

## 当前实现与待处理项

现有豆包同步仍由server/publishing/feishu.ts调用通用CLI，负责题面等字段、防重、附件与回执；feishuTextFields目前不自动生成上述三项身份字段。本资料登记不会自动修改现有交付逻辑或历史记录。

2026-10-27读取目标字段时，“专家来源”选项只有“九盈”。若名单中来源为EGV或其他值，记录在快照issues中，不能把它擅自替换成九盈，也不能仅因表名叫久盈就改来源。用户后续确认新增目标选项或别名映射后再执行；这不影响资料同步。

账号解析、名单冲突、来源选项差异和未在名单出现的已填专家ID由snapshot.issues报告。它们是填报资料的待处理事项，不改变出题、作答、评分或归档门槛。

## 查询与刷新

仓库根目录执行：

```sh
bun toolSkills/feishu-operations/scripts/cli.ts project show --project doubao-high-value
bun toolSkills/feishu-operations/scripts/cli.ts project sync --project doubao-high-value
```

show读取登记，不登录；sync通过现有应用身份只读远端、更新本机private/snapshot.json，stdout只返回数量、路径和问题摘要，不打印姓名/手机号。原始名单和题目身份字段保存在私有快照，排查时按所需记录读取，不整份复制进日志。

应用ai已于本会话加入“人员名单”为可编辑文档应用；认证成功与目标权限仍分开核对。原始名单的拥有者是用户账号，工具测试Base由应用创建。实际权限可能变化，不能把这些历史观察当作永久授权。
