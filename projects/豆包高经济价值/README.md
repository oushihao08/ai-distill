<!-- 文件职责：说明“豆包高经济价值”主项目共享资料、skill 与各期目录边界。 -->
# 豆包高经济价值

此目录是“豆包高经济价值”主项目根。`materials/` 保存跨期共用的规则资料；`skill/` 保存跨期共用的出题 skill，入口为 `skill/SKILL.md`，完整引用与模板位于 `skill/references/` 和 `skill/assets/`。

`delivery.ts` 是各期共用的归档交付入口。当前为空函数；归档前由服务端按当前题目快照执行，不参与出题、评分或题目附件扫描。

## 目录约定

```text
豆包高经济价值/
├── materials/          # 主项目各期共用的规则资料
├── skill/              # 主项目各期共用的出题 skill
├── 第五期/             # 第五期独立工作内容
│   ├── questions/      # 本期题目来源，工作流 material_root 指向此处
│   ├── reports/        # 本期规则更新分析
│   ├── updates/         # 本期待核来源
│   ├── outputs/        # 本期本地成果
│   ├── snapshots/      # 本期历史快照与归档副本
│   └── project.json    # 本期来源清单及登记信息
└── <其他期数>/         # 各期自己的题目、更新记录和成果
```

规则资料和 skill 是主项目级共享输入。编辑或替换 `materials/` 中的文件会影响该主项目后续各期的新任务；已创建任务仍按各自冻结的文件清单校验。`questions/` 只放案件来源文件，由期次工作流单独扫描；`reports/`、`updates/`、`outputs/` 和 `snapshots/` 不作为案件附件输入。

## 第五期当前目录

第五期的题目来源、成果、更新记录、历史快照和 `project.json` 均位于 `第五期/`。共享规则资料已放在本目录的 `materials/`，共享 skill 已放在 `skill/`。第五期 `project.json` 中的 `materials_dir` 与 `skill_dir` 相对指向 `../materials` 和 `../skill`。

本期未核事项、来源说明和具体文件清单见[第五期说明](第五期/README.md)。工作流状态、已入库附件和运行结果以数据库当前记录为准；本地文件清单不代表入库状态。
