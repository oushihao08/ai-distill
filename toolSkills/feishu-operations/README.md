# 飞书操作工具包

面向维护者；Agent入口为[SKILL.md](SKILL.md)，命令与数据契约以[commands.md](references/commands.md)和CLI帮助为准。

scripts/client.ts维护认证、截止、分页和媒体下载；commands.ts维护操作；cli.ts提供一次命令、官方CLI透传和NDJSON会话；process-client.ts供后台使用同一CLI并管理子进程/附件临时文件；toolkit.test.ts通过回环HTTP和真实子进程验收，不写真实飞书。

通用传输和命令路由不含业务数据库、豆包字段或默认项目目标。豆包交付/目标配置调用此CLI，项目模块维护资格、防重和回执。应用凭证与官方用户登录不同，不自动切换。

通用操作不内置项目目标；[projects/](projects/README.md)单独保存各项目的资源登记、字段对应和业务约定。project-registry.ts由CLI的project show/sync调用，只读同步名单与现有题目归属到各项目private目录；不分配题目、不回填身份字段、不读取题目正文。

入口：`bun toolSkills/feishu-operations/scripts/cli.ts --help`。写操作会改变飞书资源，验收须明确目标。常驻API/worker加载新源码后才影响交付；文件存在不代表已重载或远端验收。
