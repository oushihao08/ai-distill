<!--
职责：提供工作台固定名称集合对应的轻量 SVG 图标。
关键方法与用法：按 `name` 选择内置路径，不请求外部图标包；导航、按钮和状态控件通过组件属性复用。
-->

<script setup lang="ts">
const props = defineProps<{ name: 'grid' | 'plus' | 'file' | 'activity' | 'refresh' | 'arrow' | 'search' | 'check' | 'layers' | 'clock' | 'settings' }>();
const paths = {
 grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 plus: 'M12 5v14 M5 12h14',
 file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
 activity: 'M3 12h4l3-8 4 16 3-8h4',
 refresh: 'M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.6-2L20 8 M4 16l2.3 3A7 7 0 0 0 18 17',
 arrow: 'M5 12h14 M13 6l6 6-6 6',
 search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
 check: 'M5 12l4 4L19 6',
 layers: 'M12 3 2 8l10 5 10-5-10-5 M2 12l10 5 10-5 M2 16l10 5 10-5',
 clock: 'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 2.94-.08-.03a1.7 1.7 0 0 0-1.84.33l-.06.06h-3.4l-.03-.08a1.7 1.7 0 0 0-1.36-1.2 1.7 1.7 0 0 0-1.42.56l-.06.06-2.94-1.7.03-.08a1.7 1.7 0 0 0-.33-1.84l-.06-.06v-3.4l.08-.03a1.7 1.7 0 0 0 1.2-1.36 1.7 1.7 0 0 0-.56-1.42l-.06-.06 1.7-2.94.08.03a1.7 1.7 0 0 0 1.84-.33l.06-.06h3.4l.03.08a1.7 1.7 0 0 0 1.36 1.2 1.7 1.7 0 0 0 1.42-.56l.06-.06 2.94 1.7-.03.08a1.7 1.7 0 0 0 .33 1.84l.06.06v3.4z',
};
</script>
<template><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="w-20 h-20 shrink-0" aria-hidden="true"><path :d="paths[props.name]" /></svg></template>
