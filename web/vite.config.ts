import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify, { transformAssetUrls } from 'vite-plugin-vuetify';
import UnoCSS from 'unocss/vite';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
export default defineConfig({
 plugins: [vue({ template: { transformAssetUrls } }), vuetify({ autoImport: true }), UnoCSS(), AutoImport({ imports: ['vue', 'vue-router'], dts: 'src/auto-imports.d.ts' }), Components({ dirs: ['src/components', 'src/layout'], dts: 'src/components.d.ts' })],
 server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3100' } },
});
