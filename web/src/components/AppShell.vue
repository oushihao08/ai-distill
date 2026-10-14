<!--
职责：提供工作台侧栏、页面导航和路由出口。
关键方法与用法：根据当前路由计算页面区段并渲染 `RouterView`；由 `App.vue` 作为全局应用外壳使用。
-->

<script setup lang="ts">
const route = useRoute();
const navItems=[{label:'出题项目',to:'/',icon:'grid'},{label:'任务监控',to:'/monitor',icon:'activity'},{label:'成果库',to:'/results',icon:'file'},{label:'系统设置',to:'/settings',icon:'settings'}] as const;
const section = computed(() => route.path==='/monitor'?'任务监控':route.path==='/results'?'成果库':route.path==='/settings'?'系统设置':route.path.startsWith('/workflows/')?'材料包／题目详情':route.path.startsWith('/projects/')?'项目详情':'出题项目');
function isActive(path:string){return path==='/'?route.path==='/'||route.path.startsWith('/projects/')||route.path.startsWith('/workflows/'):route.path===path;}
</script>
<template>
 <Row stack-on-mobile y="stretch" class="app-shell" :gap="0">
  <aside class="app-sidebar"><Column :gap="24" class="lg:h-full">
   <RouterLink to="/" class="cursor-pointer"><Row :gap="12"><Row class="h-38 w-38 rounded-xl bg-primary text-surface p-8" x="center" y="center"><UiIcon name="layers" /></Row><Column :gap="0"><span class="text-lg font-bold tracking-tight text-ink-heading">ai-distill</span><span class="text-xs text-muted">出题与评测工作台</span></Column></Row></RouterLink>
   <Column :gap="8"><span class="eyebrow hidden lg:block px-8">工作空间</span><nav aria-label="主导航"><Row stack-on-desktop :gap="8" class="app-nav">
    <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="app-nav-link" :class="isActive(item.to)?'app-nav-active bg-primary-soft':''" :aria-current="isActive(item.to)?'page':undefined"><Row :gap="12" class="py-12"><UiIcon :name="item.icon" /><span>{{ item.label }}</span></Row></RouterLink>
   </Row></nav></Column>
   <Column :gap="12" class="mt-auto surface-panel hidden lg:flex"><Row :gap="8"><span class="w-8 h-8 rounded-full bg-secondary" /><span class="text-sm font-medium">本地工作空间</span></Row><p class="text-xs text-muted leading-relaxed">项目处理、任务监控与成果交付。</p></Column>
  </Column></aside>
  <Column :gap="0" class="min-w-0 flex-1">
   <header class="border-b border-line bg-surface"><Row x="between" wrap class="px-16 py-16 lg:px-24" :gap="8"><Row :gap="8" class="text-sm"><span class="text-muted">工作空间</span><span class="text-line-strong">/</span><span class="font-medium">{{ section }}</span></Row><v-chip color="secondary" variant="outlined">本地运行</v-chip></Row></header>
   <main class="mx-auto w-full max-w-content min-w-0 flex-1 px-16 py-24 lg:px-24"><RouterView :key="route.fullPath" /></main>
   <footer class="border-t border-line px-16 py-12 lg:px-24 text-xs text-muted">原件保留在本机 · 每一步结果可追溯</footer>
  </Column>
 </Row>
</template>
