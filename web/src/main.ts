/** 文件职责：前端应用启动入口。
 * 关键方法与用法：读取主题变量并注册 Vuetify、路由和全局样式，最后挂载 App.vue；由 Vite 页面入口自动执行。
 */
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import vuetify from './plugins/vuetify';
import { appThemeCssVariables } from './theme';
import 'vuetify/styles';
import 'virtual:uno.css';
import './style.css';
import './styles/vuetify.css';
for (const [name, value] of Object.entries(appThemeCssVariables)) document.documentElement.style.setProperty(name, value);
createApp(App).use(vuetify).use(router).mount('#app');
