/** 文件职责：配置 Vue 工作台的开发与构建插件。
 * 关键配置与用法：注册 Vue、Vuetify、UnoCSS 和自动导入插件，并把开发请求 /api 代理到本地 Hono 服务；由 Vite 启动或构建命令读取。
 */
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import vuetify, { transformAssetUrls } from 'vite-plugin-vuetify';
import UnoCSS from 'unocss/vite';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
export default defineConfig(({mode})=>{
 const rootEnv=loadEnv(mode,fileURLToPath(new URL('../',import.meta.url)),'');
 const apiPort=process.env.PORT??rootEnv.PORT??'3700';
 return {
 resolve: { alias: [
  { find: '@shared', replacement: fileURLToPath(new URL('../shared', import.meta.url)) },
  { find: '@server', replacement: fileURLToPath(new URL('../server', import.meta.url)) },
  { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
 ] },
 plugins: [vue({ template: { transformAssetUrls } }), vuetify({ autoImport: true }), UnoCSS(), AutoImport({ imports: ['vue', 'vue-router'], dts: 'src/auto-imports.d.ts' }), Components({ dirs: ['src/components', 'src/layout'], dts: 'src/components.d.ts' })],
 server: { port: 3800, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
 };
});
