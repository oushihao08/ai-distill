<!-- 文件职责：说明前端源码入口及组件、页面、API 和工具目录关系。 -->
# 前端源码

`main.ts` 初始化应用，`App.vue` 提供 Vuetify 根容器，`AppShell` 承载路由页面。`theme.ts` 是主题 token 唯一来源；`style.css` 负责全局重置与基础排版。

| 目录 | 职责 |
| --- | --- |
| [views](views/README.md) | 路由页面与业务操作编排 |
| [components](components/README.md) | 项目、材料、步骤与历史交互 |
| [layout](layout/README.md) | Row/Column 布局 |
| [api](api/README.md) | JSON 请求与错误转换 |
| [composables](composables/README.md) | 资源加载与生命周期 |
| [router](router/README.md) | 三个页面路由 |
| [plugins](plugins/README.md) | Vuetify 初始化 |
| [types](types/README.md) | 共享业务契约出口 |
| [utils](utils/README.md) | 展示格式工具 |
| [styles](styles/README.md) | 组件库样式适配 |

数据由 API 读取并保存在页面或组件局部响应式状态中。`auto-imports.d.ts` 与 `components.d.ts` 由 Vite 插件维护，不能把生成声明当业务实现。
