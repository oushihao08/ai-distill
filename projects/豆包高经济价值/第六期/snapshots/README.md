<!-- 文件职责：说明冻结规则快照的版本目录及不可修改的指纹约束。 -->
# 冻结规则快照

每个 `v1`、`v2`、`v3` 子目录是完整规则版本的不可变副本，文件集合及 SHA-256 必须与冻结清单一致。根目录的 `.gitkeep` 只用于保留快照父目录。服务端逐文件核验；在冻结版本内部添加 README、注释或其他文件会导致版本校验失败。因此由本说明集中描述子目录结构，不能直接编辑冻结版本。

`skill-copies/` 保存目录调整前的 skill 副本，仅用于追溯与比较，不是当前 skill 来源。当前各期统一读取主项目根目录的 `../skill/`；不得将归档副本重新绑定为运行目录。

| 快照目录 | 版本内容 | 结构 |
| --- | --- | --- |
| `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/` | v1 冻结规则包 | `project.json`、`materials/` 规则原文、`skill/SKILL.md` 及 `skill/references/` |
| `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/` | v2 冻结规则包 | `project.json`、`materials/` 规则原文、`skill/SKILL.md` 及 `skill/references/` |
| `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/` | v3 冻结规则包 | `project.json`、`materials/` 规则原文、`skill/SKILL.md` 及 `skill/references/` |

快照文件应通过规则版本流程生成，不在此目录手工修订。恢复或审计规则时对照数据库保存的文件清单和版本指纹。


## 各快照文件路径

以下路径是只读快照内部文件清单，列出用于定位和理解，不授权修改。二进制模板同样按 SHA-256 纳入快照；JSON 清单不支持行内注释。

各版本内 `project.json` 是当版规则元数据及来源文件指纹；`materials/*.md` 的文件职责见项目根 README「材料说明」表；`skill/SKILL.md`、`skill/references/*.md` 和 `skill/assets/*.docx` 的职责见项目根 README「skill」表。快照中这些文件保留当时原始字节，目录表只解释用途，不代表快照可编辑。

### `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/`

- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/C端任务全流程操作指南.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/优秀案例讲解会-程前AA录播纪要.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/公司法务出题准则.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/官方评分标准.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/材料目录与重要程度.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/附件脱敏不可使用AI.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/难度提升会议纪要.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/题目规范.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/materials/高经济价值五期任务说明文档.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/project.json`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/skill/SKILL.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/skill/assets/案例模板集.docx`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/skill/assets/题目模板.docx`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/skill/references/出题设计方法.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/skill/references/失败模式与自检清单.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/skill/references/评分与难度验证.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/skill/references/资料索引.md`
- `v1-7c167af3-49d2-4e33-88c9-ef14dc11ddc8-a8f30afd/skill/references/题目格式与交付.md`

### `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/`

- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/materials/C端任务全流程操作指南.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/materials/优秀案例讲解会-程前AA录播纪要.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/materials/公司法务出题准则.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/materials/官方评分标准.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/materials/材料目录与重要程度.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/materials/难度提升会议纪要.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/materials/题目规范.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/materials/高经济价值五期任务说明文档.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/project.json`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/skill/SKILL.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/skill/assets/案例模板集.docx`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/skill/assets/题目模板.docx`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/skill/references/出题设计方法.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/skill/references/失败模式与自检清单.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/skill/references/评分与难度验证.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/skill/references/资料索引.md`
- `v2-5d91eb1e-985b-4681-9a42-038319b1ad21-5ae23a81/skill/references/题目格式与交付.md`

### `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/`

- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/C端任务全流程操作指南.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/优秀案例讲解会-程前AA录播纪要.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/公司法务出题准则.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/官方评分标准.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/本地成稿交付覆盖.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/材料目录与重要程度.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/难度提升会议纪要.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/题目规范.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/materials/高经济价值五期任务说明文档.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/project.json`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/skill/SKILL.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/skill/assets/案例模板集.docx`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/skill/assets/题目模板.docx`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/skill/references/出题设计方法.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/skill/references/失败模式与自检清单.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/skill/references/评分与难度验证.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/skill/references/资料索引.md`
- `v3-fd486191-30e4-4849-958c-3058a1506ce1-ca42c75f/skill/references/题目格式与交付.md`
