<!-- 文件职责：说明全局样式、Vuetify 覆盖和样式入口。 -->
# 组件库样式适配

`vuetify.css` 只处理 Vuetify 按钮、字段字体与圆角、紧凑输入框高度，全部读取共享主题 CSS 变量；多行文本框不套用固定输入高度。

`src/style.css` 是全局基础样式，`src/theme.ts` 是 token 来源，`web/uno.config.ts` 提供原子类与语义 shortcuts。页面样式优先使用 UnoCSS，不在页面局部重复覆盖统一控件尺寸。
