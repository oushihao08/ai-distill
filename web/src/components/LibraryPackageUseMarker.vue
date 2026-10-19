<!-- 文件职责：在材料包列表中显示永久使用状态，并按需展开主项目/期次明细。 -->
<script setup lang="ts">
import type {MaterialLibraryPackageUseSummary} from '@shared/material-library';

defineProps<{uses?:MaterialLibraryPackageUseSummary[]}>();

function phaseLabel(use:MaterialLibraryPackageUseSummary){
 return use.phase_name?.trim()||(use.phase_no?`第${use.phase_no}期`:`期次 ${use.owner_phase_id.slice(0,8)}`);
}
</script>

<template>
 <v-chip v-if="uses===undefined" size="x-small" variant="tonal">状态未读取</v-chip>
 <v-chip v-else-if="!uses.length" size="x-small" color="success" variant="tonal">未使用</v-chip>
 <v-menu v-else location="end">
  <template #activator="{props}">
   <v-btn v-bind="props" size="x-small" variant="tonal" color="info" @click.stop>
    {{ uses.length===1?'已使用 · 1个项目':`已使用 · ${uses.length}个项目` }}
   </v-btn>
  </template>
  <v-list density="compact" min-width="260" aria-label="材料包使用记录">
   <v-list-subheader>主项目与期次</v-list-subheader>
   <v-list-item v-for="use in uses" :key="use.id">
    <v-list-item-title>{{ use.project_name }}</v-list-item-title>
    <v-list-item-subtitle>{{ phaseLabel(use) }} · {{ use.status==='submitted'?'已提交':'使用中' }}</v-list-item-subtitle>
   </v-list-item>
  </v-list>
 </v-menu>
</template>
