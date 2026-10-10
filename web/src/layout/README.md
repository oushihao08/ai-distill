<!-- 文件职责：说明 Row、Column 等基础布局组件及使用约束。 -->
# 布局组件

`Row.vue` 负责横向布局，`Column.vue` 负责纵向布局。二者接受 `x`、`y` 对齐、像素 `gap`、`wrap` 和 `fill`，通过默认插槽承载内容；`fill` 才启用满宽满高。

Row 另外支持移动端或桌面端切换主轴。动态对齐类由 `web/uno.config.ts` 的 safelist 覆盖。页面遵循 `web/STYLE_GUIDE.md`，不另建重复 flex 布局规则。
