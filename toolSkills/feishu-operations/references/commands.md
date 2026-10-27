# CLI命令与输入

面向Agent与维护者；帮助由 `scripts/commands.ts` 的HELP维护。以下命令均以 `bun toolSkills/feishu-operations/scripts/cli.ts` 为前缀。应用身份读取当前进程 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，Bun正常加载环境；不另存凭证、不依赖业务API或数据库。`auth status`仅验证认证，资源权限以实际操作为准。

| 命令 | 坐标 | stdin原生JSON示例 |
| --- | --- | --- |
| base create | 无 | `{"name":"独立测试多维表格"}` |
| base get/update | --base | update：`{"name":"新名称"}` |
| table list/create | --base | create：`{"table":{"name":"数据","fields":[{"field_name":"名称","type":1}]}}` |
| table update/delete | --base、--id | update：`{"name":"新表名"}` |
| field list/create/update/delete | --base、--table；修改/删除加--id | create/update：`{"field_name":"备注","type":1}` |
| record list/get/create/update/delete | --base、--table；单项操作加--id | create/update：`{"fields":{"名称":"样例","备注":"文本"}}` |
| record batch-create/batch-update/batch-delete | --base、--table | 原生records清单；修改含record_id，删除为ID数组 |
| view list/get/create/update/delete | --base、--table；单项操作加--id | create：`{"view_name":"测试视图","view_type":"grid"}` |
| file upload | --file、--parent，可选--name | 无；parent是base_token，返回file_token |
| file download | --id、--output | 无；id是media file_token，output须未存在 |
| api METHOD /资源路径 | 不含/open-apis前缀 | 原生OpenAPI正文 |
| project show/sync --project 项目key | projects/<key>/config.json | 无；show读登记，sync只读远端并更新本机私有快照，stdout仅返回摘要 |

先list再按准确ID执行；field/table元信息可从list取得。字段type、选项、人员、日期、附件结构遵守OpenAPI，不推测类型。批量沿用官方条数限制，按固定目标清单分批，不无限拆分重试。

正文来自stdin或 `--input <文件>`，两者选一。`--dry-run`返回 `dispatched:false` 请求计划，不读取凭证或发请求，也不等于服务端校验。命名写操作缺正文拒绝执行；DELETE必须指定ID。

成功stdout `{"ok":true,"data":…}`；失败stderr `{"ok":false,"error":{"code":"…"}}`，退出码1。结果可能含私有数据，不复制到普通日志。错误不透传原始供应商正文/凭证。

## 身份与官方CLI

默认应用身份适合后台，仅能访问被授予的资源。`--as bot`可显式标记，用户身份转官方通道：

```sh
bun toolSkills/feishu-operations/scripts/cli.ts official -- auth status --json --verify
bun toolSkills/feishu-operations/scripts/cli.ts official -- base --help
```

透传到已安装的 `lark-cli`；非认证操作须指定 `--as user` 或 `--as bot`。`LARK_CLI_BIN`可指定受信任的可执行文件；不拼shell、不传密钥参数。用户登录、二维码与高风险确认按当前官方lark-shared执行。提取工具不自动安装官方CLI、不改登录或创建OAuth账号。

## 其他官方能力

云文档从 `official -- docs --help` 进入，按当前lark-doc reference选择fetch/create/update；文件夹和文件管理从 `official -- drive --help` 进入。电子表格从 `official -- sheets --help` 进入，用spreadsheet token、sheet ID和A1范围定位；不是Base记录。

应用身份也可用 `api` 调用这些业务API，共用认证和90秒预算。禁止通过认证路径输出token。字段与权限见[飞书开放平台](https://open.feishu.cn/document/)，不要猜新版参数。

## 工具包与后台协议

- client.ts：`createAppClient()`提供call/list/download，不含业务数据库。
- commands.ts：命令解析与执行，不含豆包字段或目标。
- process-client.ts：`createCliClient()`启动同目录 `cli.ts --rpc`，提供call/list/close；调用方必须finally关闭。每会话一次认证、一个子进程，远端共用90秒截止，父进程95秒终止兜底；不自动重试。
- NDJSON请求为 `{"id":1,"operation":{"kind":"call","path":"/bitable/v1/apps/BASE/tables","method":"GET"}}`，一行对应一行带id的结果。kind仅call/list/upload/download/status；只用于私有stdio，不对外开放网络服务。
- 附件经0700临时目录中的0600文件传递，完成或失败后删除，不编码成base64或放argv。进程客户端只接受bitable附件multipart，其余使用显式命令或官方通道。
- `FEISHU_API_BASE_URL`默认官方HTTPS，仅允许官方域名或HTTP回环测试地址；真实使用不设覆盖。

## 恢复与业务边界

保存每次创建ID、稳定业务键及目标。认证/权限失败修复原身份；写超时先查原记录，不能当作未执行。通用CLI不自动清空行或批量删表，业务防重由调用方定义。

豆包通过server/publishing/feishu-api.ts调用进程客户端，保留目标选择、业务字段、空行备份清理、附件/正文核对及逐目标回执；工具包不依赖这些模块。官方透传和应用通道的认证互相独立。
