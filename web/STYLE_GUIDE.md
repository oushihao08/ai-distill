# 样式与主题约定

沿用 ai-news/web 的主题架构：`src/theme.ts` 是唯一 token 来源，`uno.config.ts` 和 `src/plugins/vuetify.ts` 读取该主题。页面布局使用 Row/Column，样式使用 UnoCSS 原子类及语义 shortcuts。

本项目输入控件与操作按钮统一为 36px 高、14px 字号、8px 圆角；尺寸定义在 `appTheme.control`。按钮通过 Vuetify defaults 设置高度，输入框内部样式仅在 `src/styles/vuetify.css` 适配并读取主题变量。多行文本框和多文件内容允许自然增高，状态 chip 不套用表单控件高度。

同组操作采用 8px 间距并垂直居中，窄屏允许换行。页面不得通过任意像素、局部 density 或 padding 单独改变控件尺寸。颜色沿用共享主题，标准交互使用 Vuetify。
