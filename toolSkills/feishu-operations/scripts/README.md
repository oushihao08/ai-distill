# 飞书工具实现

维护入口为上级[README](../README.md)，CLI契约见[命令说明](../references/commands.md)。client.ts负责应用HTTP，commands.ts负责命名操作，cli.ts是唯一命令/NDJSON入口，process-client.ts供服务端调用该CLI；toolkit.test.ts仅连接回环替身。修改远端调用时同步验证命令模式和持久会话，避免只测直接导入函数而遗漏子进程协议。

project-registry.ts读取projects中的明确登记，只读收集字段、人员、已有题目归属，生成本机私有快照和问题摘要；不写远端、不新增业务领取系统。toolkit.test.ts同时验证专家ID精度、一人多题、人员字段解析状态、选择性读取、私有权限及失败不覆盖旧快照。
