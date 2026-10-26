# 唯一对账台

供定时执行Agent恢复、派发和交接使用。`state.json`是本次调度记录，业务事实仍以API为准；不把服务端状态写回数据库。可从已有台账兼容扩充字段，不要求迁移历史文件。

| 字段 | 内容 |
| --- | --- |
| run_id / automation_id | 本次运行身份、当前heartbeat ID |
| scope | repo、api_base、project/group/phase、executor、固定来源和workflow ID；新增workflow只能来自已固定来源 |
| policy | interval、终点、优先级、repair_limit、材料模式、交接thread；引用用户授权，不硬编码项目、等级或次数 |
| authorizations | 已授权动作、目标/进程范围、依据；未授权操作不默认为允许 |
| checked_at / next_action | 最近核实时间、下一步及条件 |
| capacity | 各池C/R/Q、本轮预留、观测时间、消费者证据、空闲原因 |
| items | 下表逐来源/逐题观察 |
| operations | 写前意图、写后结果及unknown恢复依据 |
| pending_decisions | 问题、证据、所需最小决定、是否已通知；收到答案后更新授权 |
| completion | 终态统计、剩余阻塞、交接和停用回执 |

每个item保留：本地ID、来源路径/package/revision/job、workflow、目标等级、当前输入版本、下一ready步骤与原因、各阶段全部attempt、实际状态和时间、repair_used/reserved、轮次记录、blocking及证据、交接状态/回执。阶段观察分开，不能只放一个completed布尔值。

每个operation保留：operation_id、item/stage/version、命令参数（无凭证）、request_key（命令支持时）、planned_at、response/outcome、全部服务端ID、checked_at、evidence。outcome至少区分planned、unknown、not_dispatched、active、succeeded、failed。planned写入后崩溃也需先核服务端，不能当作未执行。

每轮在持有本次run锁时：读台账→核API→保存观察→保存派发意图→调用CLI→立即保存响应→回读。锁存在时不并发改台账。Markdown地图如用户要求，只从台账生成，不能成为第二份人工维护状态。

保留旧轮次分数、原因、版本和attempt；纠正观察新增依据，不能抹掉历史失败。只存恢复和判断必要信息，不复制完整材料、答案、提示词或凭证。输出统计区分已提取、已出题、已作答、已评分、达标、已交接与已提交。
