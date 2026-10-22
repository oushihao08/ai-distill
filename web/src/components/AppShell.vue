<!--
职责：提供工作台侧栏、页面导航和路由出口。
关键方法与用法：根据当前路由计算页面区段并渲染 `RouterView`；由 `App.vue` 作为全局应用外壳使用。
-->

<script setup lang="ts">
import {pageBreadcrumbKey,type PageBreadcrumb} from '../composables/usePageBreadcrumbs';
const route = useRoute();
const pageBreadcrumbs=shallowRef<PageBreadcrumb[]>([]);
provide(pageBreadcrumbKey,items=>{pageBreadcrumbs.value=items;});
watch(()=>route.fullPath,()=>{pageBreadcrumbs.value=[];},{flush:'sync'});
const breadcrumbs=computed(()=>pageBreadcrumbs.value.length?pageBreadcrumbs.value:[{title:'工作空间',to:'/'},{title:section.value}]);
const navItems=[{label:'出题项目',to:'/',icon:'grid'},{label:'材料库',to:'/materials',icon:'file'},{label:'任务监控',to:'/monitor',icon:'activity'},{label:'成果库',to:'/results',icon:'file'},{label:'系统设置',to:'/settings',icon:'settings'}] as const;
const section = computed(() => route.path.startsWith('/materials')?'独立材料库':route.path==='/monitor'?'任务监控':route.path==='/results'?'成果库':route.path==='/settings'?'系统设置':route.path.startsWith('/workflows/')?'材料包／题目详情':route.path.startsWith('/projects/')?'期次工作区':route.path.startsWith('/project-groups/')?'主项目期次':'出题项目');
function isActive(path:string){return path==='/'?route.path==='/'||route.path.startsWith('/project-groups/')||route.path.startsWith('/projects/')||route.path.startsWith('/workflows/'):path==='/materials'?route.path.startsWith('/materials'):route.path===path;}
</script>
<template>
 <Row stack-on-mobile y="stretch" :class="route.path.startsWith('/materials')?'app-shell material-library-shell':'app-shell'" :gap="0">
  <aside class="app-sidebar"><Column :gap="24" class="lg:h-full">
   <RouterLink to="/" class="cursor-pointer"><Row :gap="12"><Row class="h-38 w-38 rounded-xl bg-primary text-surface p-8" x="center" y="center"><UiIcon name="layers" /></Row><Column :gap="0"><span class="text-lg font-bold tracking-tight text-ink-heading">ai-distill</span><span class="text-xs text-muted">出题与评测工作台</span></Column></Row></RouterLink>
   <Column :gap="8"><span class="eyebrow hidden lg:block px-8">工作空间</span><nav aria-label="主导航"><Row stack-on-desktop :gap="8" class="app-nav">
    <RouterLink v-for="item in navItems" :key="item.to" :to="item.to" class="app-nav-link" :class="isActive(item.to)?'app-nav-active bg-primary-soft':''" :aria-current="isActive(item.to)?'page':undefined"><Row :gap="12" class="py-12"><UiIcon :name="item.icon" /><span>{{ item.label }}</span></Row></RouterLink>
   </Row></nav></Column>
   <Column :gap="12" class="mt-auto surface-panel hidden lg:flex"><Row :gap="8"><span class="w-8 h-8 rounded-full bg-secondary" /><span class="text-sm font-medium">本地工作空间</span></Row><p class="text-xs text-muted leading-relaxed">项目处理、任务监控与成果交付。</p></Column>
  </Column></aside>
  <Column :gap="0" class="min-w-0 flex-1" :class="route.path.startsWith('/materials')?'min-h-0':''">
   <header class="border-b border-line bg-surface"><Row x="between" wrap class="px-16 py-16 lg:px-24" :gap="8"><nav aria-label="面包屑" class="min-w-0"><Row wrap :gap="8" class="text-sm"><template v-for="(item,index) in breadcrumbs" :key="`${index}-${item.to??item.title}`"><span v-if="index" aria-hidden="true" class="text-line-strong">/</span><RouterLink v-if="item.to&&index<breadcrumbs.length-1" :to="item.to" class="link-text break-words">{{ item.title }}</RouterLink><span v-else aria-current="page" class="font-medium break-words">{{ item.title }}</span></template></Row></nav><v-chip color="secondary" variant="outlined">本地运行</v-chip></Row></header>
   <main class="mx-auto w-full max-w-content min-w-0 flex-1 px-16 py-24 lg:px-24" :class="route.path.startsWith('/materials')?'flex flex-col min-h-0':''"><RouterView :key="route.path.startsWith('/materials')?'/materials':route.fullPath" /></main>
  </Column>
 </Row>
</template>
<style scoped>
@media (min-width: 1024px) {
 .material-library-shell { height: 100vh; min-height: 0; overflow: hidden; }
}
</style>
