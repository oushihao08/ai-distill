<!-- 文件职责：说明前端路由映射及页面导航入口。 -->
# 页面路由

`index.ts` 使用 Vue Router 的浏览器 history，当前注册 8 条路由：`/` 为主项目列表，`/project-groups/:groupId` 为指定主项目的期次列表，`/materials/:packageId?` 为材料库（可选包 ID 支持详情直达），`/monitor` 为任务监控，`/results` 为跨项目成果库，`/settings` 为系统设置，`/projects/:id` 为期次详情，`/workflows/:id` 为工作流详情。侧栏活动状态覆盖主项目、期次及工作流详情路由；材料库详情仍属于 `/materials/:packageId?` 路由。

路由只负责页面映射，当前没有登录守卫或权限控制。若新增部署方式，需要独立确认 history 路径回退与 `/api` 转发。
