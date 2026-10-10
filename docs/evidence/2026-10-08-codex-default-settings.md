<!-- 文件职责：保存 2026 10 08 codex default settings 的历史证据与检查记录；结论仅限文件注明的日期和范围。 -->
# Codex 默认模型与推理强度设置

日期：2026-10-08（北京时间）

## 实现

- 系统设置可保存默认 Codex 模型和推理强度；模型与能力列表来自当前 `CODEX_HOME/models_cache.json`，只暴露模型 ID 和支持的推理级别。
- 保存时按当前模型清单校验组合。Codex 连通性测试使用已保存的默认模型与推理强度。
- Codex 设置按步骤覆盖 > 项目默认 > 全局默认解析。第四步、脱敏、第六步、skill 生成及返修快照均读取同一优先级；新入队尝试保存完整配置快照，因此设置变化不会改写在途任务。
- Codex 凭证旁保留全局默认下拉框；项目执行页新增项目默认下拉框；第四、六、九步可选择本机模型清单并单独覆盖、恢复继承；项目 skill 生成初始值读取项目默认。推理强度选项随所选模型变化。
- 新增迁移 `022_codex_default_settings.sql` 和 `023_project_codex_defaults.sql`。本轮未执行迁移：当前 `.env` 指向 Neon 远程数据库，环境用途未核实。

## 验证

- 定向后端测试：37 项通过、0 失败、107 条断言，覆盖系统设置、路由队列默认继承、项目 skill 与返修快照。
- `bun test server/app.test.ts server/project-folders.test.ts -t 'Codex settings API|Codex|unsaved Codex'`：3 项通过、14 条断言。
- `bun run build`：Vue 类型检查与生产构建通过；Vite 提示现有主 bundle 超过 500 kB。
- `bun run check`：前端 `vue-tsc` 通过；后端全量类型检查被脚本、答案模型测试及材料测试夹具类型错误挡住，本次 Codex 变更文件未出现类型错误。
- `git diff --check`：通过。
- 完整运行 `bun test server/app.test.ts` 时 6 项通过、5 项既有材料目录接口用例返回 404；Codex 设置 API 用例通过。
- 未启动服务、未做浏览器验收、未发起真实 Codex 调用，也未执行 OCR。

## 运行中界面诊断

- 2026-10-08 用户反馈无法选择默认模型和推理强度。只读请求 `GET /api/codex/config` 到 3100 后端及 5173 Vite 代理，均返回 200 但响应仅含 `credential_home`，没有新接口应返回的 `model`、`reasoning_effort`、`model_options`。
- 本机 `/Users/jack/.codex/models_cache.json` 存在（423379 字节），包含 10 个模型；其中 `gpt-6.1-sol` 带有有效推理级别。因而当前界面空选项不是本机缓存缺失造成。
- 当前 API 进程为直接运行的 `bun server/index.ts`；`package.json` 的 `server` 命令没有文件监听，进程未加载新增接口代码。并且迁移 022 尚未应用，新接口读取的模型设置字段依赖该迁移。
- 未重启后端或修改 Neon 数据库；`.env` 指向的 Neon 实例用途尚未确认，等待用户确认目标环境。以上为本地只读诊断，未执行 OCR。
- 本机 Codex 独立验证：`codex --version` 为 `0.162.0-alpha.2`，`codex login status` 显示 `Logged in using ChatGPT`。使用 `gpt-6.1-sol`、`low` 推理、只读 sandbox 和 ephemeral 会话发起短请求，进程退出码 0，返回 `READY`；Codex CLI 可实际调用。启动时报告若干配置／状态警告，但没有阻止本次请求。
- 后端实际调用验证：对当前本机 3100 服务执行 `POST /api/codex/test`，返回 HTTP 200、`connected: true`、模型 `gpt-6.1-sol`，耗时 16628 ms。此处验证的是当前运行中的旧版后端测试路径，不证明新默认模型设置 API 已加载。

## 阶层默认配置更新（2026-10-08）

- 增加项目级 Codex 默认读写和恢复全局继承；项目步骤摘要返回 `config_source`，显示当前来自步骤、项目或全局。
- 入队和返修冻结配置时采用步骤 > 项目 > 全局。步骤恢复继承时删除模型与强度覆盖；脱敏步骤保留已编辑的提示词。
- 定向验证：项目默认 API 1 项通过；设置、出题、评分、skill 生成、返修快照相关测试 39 项通过，共 123 条断言。
- `git diff --check` 通过。新增前端改动尚未重新运行构建或类型检查；浏览器验收未做。
- 迁移 022、023 尚未应用，API 尚未重启；因此层级设置已进入源码，但当前本机运行界面还不能使用该功能。
- 本轮没有执行 OCR。
