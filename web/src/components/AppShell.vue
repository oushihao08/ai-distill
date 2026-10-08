<script setup lang="ts">
const route = useRoute();
const section = computed(() => route.path.startsWith('/workflows/') ? '工作流详情' : route.path.startsWith('/projects/') ? '项目详情' : '项目管理');
</script>
<template>
 <Row stack-on-mobile y="stretch" class="app-shell" :gap="0">
  <aside class="app-sidebar"><Column :gap="24" class="lg:h-full">
   <RouterLink to="/" class="cursor-pointer"><Row :gap="12"><Row class="h-38 w-38 rounded-xl bg-primary text-surface p-8" x="center" y="center"><UiIcon name="layers" /></Row><Column :gap="0"><span class="text-lg font-bold tracking-tight text-ink-heading">ai-distill</span><span class="text-xs text-muted">出题与评测工作台</span></Column></Row></RouterLink>
   <Column :gap="8"><span class="eyebrow hidden lg:block px-8">工作空间</span><nav aria-label="主导航"><Row stack-on-desktop :gap="8" class="app-nav">
    <RouterLink to="/" class="app-nav-link bg-primary-soft text-primary"><Row :gap="12" class="py-12"><UiIcon name="grid" /><span>出题项目</span></Row></RouterLink>
    <v-btn variant="text" color="secondary" disabled class="hidden lg:block" block><template #prepend><UiIcon name="activity" /></template>模型评测 · 待开放</v-btn>
    <v-btn variant="text" color="secondary" disabled class="hidden lg:block" block><template #prepend><UiIcon name="refresh" /></template>返修记录 · 待开放</v-btn>
    <v-btn variant="text" color="secondary" disabled class="hidden lg:block" block><template #prepend><UiIcon name="file" /></template>成果库 · 待开放</v-btn>
   </Row></nav></Column>
   <Column :gap="12" class="mt-auto surface-panel hidden lg:flex"><Row :gap="8"><span class="w-8 h-8 rounded-full bg-secondary" /><span class="text-sm font-medium">本地工作空间</span></Row><p class="text-xs text-muted leading-relaxed">材料入库、独立脱敏已开放。出题与评测将在后续接入。</p></Column>
  </Column></aside>
  <Column :gap="0" class="min-w-0 flex-1">
   <header class="border-b border-line bg-surface"><Row x="between" wrap class="px-16 py-16 lg:px-24" :gap="8"><Row :gap="8" class="text-sm"><span class="text-muted">工作空间</span><span class="text-line-strong">/</span><span class="font-medium">{{ section }}</span></Row><v-chip color="secondary" variant="outlined">材料处理版</v-chip></Row></header>
   <main class="mx-auto w-full max-w-content min-w-0 flex-1 px-16 py-24 lg:px-24"><RouterView :key="route.fullPath" /></main>
   <footer class="border-t border-line px-16 py-12 lg:px-24 text-xs text-muted">原件保留在本机 · 每一步结果可追溯</footer>
  </Column>
 </Row>
</template>
