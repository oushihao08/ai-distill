<!-- 文件职责：保存 rule workspace verification 的历史证据与检查记录；结论仅限文件注明的日期和范围。 -->
# 本地规则资料与版本验收

2026-10-08。完整目标仍为第四阶段自动出题、评测、返修与导出。本次只完成第三阶段的本地规则资料、现有完整skill导入和固定版本管理，不宣称第三阶段闭环完成。

## 已实现及证据

- 项目“资料与 skill”页签显示工作目录、materials清单、整个skill目录、问题及版本。资料支持新增、文字编辑、上传替换及删除；skill在页面只读，本地修改后刷新。
- 本地保存正文和二进制资源，数据库只存相对路径、大小、SHA-256、工作区及规则元数据。检查入口、相对引用、目录边界和符号链接；旧指纹编辑或旧工作目录指纹冻结返回409。
- 冻结包含完整references/assets与project.json。同项目并发请求复用相同版本，工作文件修改后产生下一版草稿，旧快照保留；快照缺失、被修改或加入额外文件时拒绝复用。
- `bun scripts/verify-rule-versions.ts`已完成25项真实PostgreSQL、接口与文件检查，两个项目彼此独立，没有模型调用。结果见[rule-version-results.json](rule-version-results.json)。
- 首期项目通过浏览器登记与冻结内部v1；9份规则、8个skill文件及project.json共18文件。原件及原skill未修改。正式资格为unverified，三个待核事项继续保存；主业务仍为一个项目、零题目。再次从数据库读取并逐项核验快照，结果见[first-project-rule-freeze.json](first-project-rule-freeze.json)。
- 浏览器已核对资料页、9/8文件列表、18项版本、登记及冻结状态，以及只读SKILL正文弹窗。增删改的完整浏览器交互、上传和移动端未验收；其接口与文件结果由集成验证证明。
- 后端100项测试、前后端类型检查及构建通过。前端没有新增测试，按项目约定使用真实页面核对。

## Codex接入前置验证

依据[官方非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[CLI参数](https://learn.chatgpt.com/docs/cli/reference)和[权限配置](https://learn.chatgpt.com/docs/permissions)核对当前本机CLI。实际版本为0.162.0-alpha.2，sandbox入口是`codex sandbox`，不能直接照抄网页中的平台子命令。

`bun scripts/verify-codex-isolation.ts`完成7项本机CLI沙箱检查：受控输入可读、输出可写、另一个角色材料不可读、输入及非输出目录不可写、子进程不继承数据库或API密钥。只运行沙箱内的本地命令，不调用模型、不复制auth.json。结果见[codex-isolation-results.json](codex-isolation-results.json)。这不证明模型原生文件工具、认证刷新、超时取消或Codex执行器已经可用。

## 剩余范围与行为边界

第3步规则版本绑定、项目skill生成、Codex执行、Qwen作答、独立评分及第四阶段仍待实现。冻结记录内部准备资料，不代替语义冲突审查或正式提交批准。

文件编辑先落盘再更新数据库草稿；数据库失败时保留已写文件，刷新页面可发现草稿指纹过期并重新登记。版本冻结在提交不确定时保留快照，以免删掉数据库已引用的文件。数据库备份仍必须同时保留本地资料与快照。
