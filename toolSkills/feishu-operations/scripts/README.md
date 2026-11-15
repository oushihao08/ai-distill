# 飞书工具实现

维护入口为上级[README](../README.md)，CLI契约见[命令说明](../references/commands.md)。client.ts负责应用HTTP，commands.ts负责命名操作，cli.ts是唯一命令/NDJSON入口，process-client.ts供服务端调用该CLI；toolkit.test.ts仅连接回环替身。修改远端调用时同步验证命令模式和持久会话，避免只测直接导入函数而遗漏子进程协议。

project-registry.ts读取projects中的明确登记，只读收集字段、人员、已有题目归属，生成本机私有快照和问题摘要；不写远端、不新增业务领取系统。toolkit.test.ts同时验证专家ID精度、一人多题、人员字段解析状态、选择性读取、私有权限及失败不覆盖旧快照。

`commands.ts`的upload操作按实际文件大小选择素材上传：不超过20MiB使用upload_all，超过则按upload_prepare返回的块大小及块数顺序上传，最后upload_finish。不压缩或拆分业务附件，不自动重试失败分片；直调CLI与NDJSON会话共用同一实现和截止时间。

