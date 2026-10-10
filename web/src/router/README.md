<!-- 文件职责：说明前端路由映射及页面导航入口。 -->
# 页面路由

`index.ts` 使用 Vue Router 的浏览器 history：`/` 为项目列表、`/monitor` 为任务监控、`/results` 为跨项目成果库、`/settings` 为系统设置、`/projects/:id` 为项目详情、`/workflows/:id` 为单题详情。侧栏活动状态覆盖项目与题目详情路由。

路由只负责页面映射，当前没有登录守卫或权限控制。若新增部署方式，需要独立确认 history 路径回退与 `/api` 转发。
