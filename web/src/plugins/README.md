<!-- 文件职责：说明 Vuetify 等 Vue 插件的初始化位置。 -->
# Vuetify 插件

`vuetify.ts` 注册中文界面、MDI SVG 图标、亮色主题和表单控件默认值。颜色及按钮高度取自 `src/theme.ts`，输入控件内部尺寸由 `src/styles/vuetify.css` 适配。

插件由 `src/main.ts` 安装；组件自动导入由 Vite 插件负责。统一控件尺寸变更应遵循 `web/STYLE_GUIDE.md`。
