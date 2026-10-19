<!-- 职责：按题目汇总材料包的项目使用状态，并将归档/撤回事件放入可展开时间线。
props.usage与revisions由材料库提供；只展示业务名称、版本和时间，不把每条历史事件重复显示为当前题目。 -->
<script setup lang="ts">
import type {LibraryUsage,LibraryRevision,PublicationEvent} from '../types/material-library';
import {dateLabel} from '../utils/format';
const props=defineProps<{usage:LibraryUsage;revisions:LibraryRevision[]}>();
const questions=computed(()=>{
 const groups=new Map<string,PublicationEvent[]>();
 for(const event of props.usage.publication_events){const rows=groups.get(event.workflow_id)??[];rows.push(event);groups.set(event.workflow_id,rows);}
 return Array.from(groups.values()).map(events=>{
  events.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
  const latest=events[events.length-1]!;
  const current=[...events].reverse().find(item=>item.current_publication_event!=='superseded')??latest;
  return{latest,current,events};
 }).sort((a,b)=>b.latest.created_at.localeCompare(a.latest.created_at));
});
const states={archived:'已归档',withdrawn:'已撤回',superseded:'历史使用（已更换材料）',workflow_deleted:'题目已删除'};
function versionLabel(id?:string){const index=props.revisions.findIndex(item=>item.id===id);return index>=0?`第 ${props.revisions.length-index} 版`:'历史版本';}
function eventLabel(events:PublicationEvent[],index:number){return events[index]?.event_type==='withdrawn'?'撤回归档':events.slice(0,index).some(item=>item.event_type==='archived')?'再次归档':'归档';}
</script>
<template><Column :gap="16" class="p-12">
 <Column :gap="8"><h3 class="section-title">本项目材料使用与提交状态</h3><p v-if="!usage.material_uses?.length" class="text-sm text-muted">暂无主项目材料使用记录。</p><article v-for="use in usage.material_uses??[]" :key="use.id" class="border border-line rounded-md p-12"><Column :gap="8"><Row x="between" wrap y="center" :gap="12"><RouterLink :to="`/projects/${use.owner_phase_id}`" class="link-text">{{ use.project_name }} · {{ use.phase_name }}</RouterLink><v-chip :color="use.status==='submitted'?'success':'primary'">{{ use.status==='submitted'?'已提交':'使用中' }}</v-chip></Row><p class="text-xs text-muted">首次使用 {{ dateLabel(use.first_used_at) }} · {{ (use.events??[]).length }} 条状态记录</p><details v-if="use.events?.length"><summary class="cursor-pointer text-xs link-text">查看使用、提交与返修历史</summary><ol class="mt-8 pl-20 border-l border-line space-y-8 list-none"><li v-for="event in use.events" :key="event.id"><p class="text-xs">{{ dateLabel(event.created_at) }} · {{ event.status==='submitted'?'已提交':'使用中' }}<span v-if="event.reason"> · {{ event.reason }}</span></p><p v-if="event.evidence?.platform||event.evidence?.task_id||event.evidence?.project_id||event.evidence?.submitted_at" class="text-xs text-muted">{{ [event.evidence.platform,event.evidence.project_id&&`项目 ${event.evidence.project_id}`,event.evidence.task_id&&`任务 ${event.evidence.task_id}`,event.evidence.submitted_at].filter(Boolean).join(' · ') }}</p><p v-if="event.evidence?.receipt" class="text-xs text-muted break-all">回执：{{ event.evidence.receipt }}</p></li></ol></details></Column></article><p class="text-xs text-muted">记录不随题目删除或引用移除而清除；该主项目后续期次不能重复加载。</p></Column>
 <Column :gap="12"><h3 class="section-title">加载此材料包的项目</h3><p v-if="!usage.loaded_projects.length" class="text-sm text-muted">尚未加载到项目。完成脱敏后，可在项目中选择“加入材料包”。</p>
  <Row v-for="project in usage.loaded_projects" :key="`${project.project_id}-${project.created_at}`" x="between" wrap :gap="12" class="border-b border-line-subtle pb-12">
   <RouterLink v-if="!project.removed_at" :to="`/projects/${project.project_id}`" class="link-text">{{ project.project_name }}</RouterLink><span v-else class="text-sm text-muted">{{ project.project_name }}</span>
   <span class="text-xs text-muted">{{ project.removed_at?'已移除':'使用中' }} · {{ dateLabel(project.created_at) }}</span>
  </Row>
 </Column>
 <Column :gap="12"><Row x="between" y="center"><h3 class="section-title">使用此材料归档的题目</h3><span class="text-sm text-muted">{{ questions.length }} 道题目</span></Row>
  <p v-if="!questions.length" class="text-sm text-muted">还没有题目使用此材料完成归档。</p>
  <article v-for="question in questions" :key="question.latest.workflow_id" class="border border-line rounded-lg p-12"><Column :gap="12">
   <Row x="between" wrap y="start" :gap="12"><Column :gap="4" class="min-w-0"><RouterLink v-if="question.latest.workflow_exists" :to="`/workflows/${question.latest.workflow_id}`" class="link-text font-semibold break-words">{{ question.latest.provenance.workflow_title??question.latest.workflow_title??'未命名题目' }}</RouterLink><strong v-else class="text-sm">{{ question.latest.provenance.workflow_title??question.latest.workflow_title??'历史题目' }}</strong><p class="text-sm text-muted">{{ question.latest.provenance.project_name??question.latest.project_name }}</p></Column><span class="text-sm font-medium" :class="question.current.current_publication_event==='archived'?'text-success':'text-muted'">{{ states[question.current.current_publication_event] }}</span></Row>
   <p class="text-xs text-muted">使用{{ versionLabel(question.latest.provenance.material_origin.revision_id) }} · {{ question.latest.provenance.materials.length }} 份脱敏附件 · 最近操作 {{ dateLabel(question.latest.created_at) }}</p>
   <details><summary class="cursor-pointer text-sm link-text focus-visible:outline-auto">查看归档与撤回历史（{{ question.events.length }} 条）</summary><ol class="mt-12 pl-20 border-l border-line space-y-12 list-none"><li v-for="(event,index) in question.events" :key="event.id"><Row wrap :gap="12"><strong class="text-sm">{{ eventLabel(question.events,index) }}</strong><span class="text-xs text-muted">{{ dateLabel(event.created_at) }}</span></Row><p class="text-xs text-muted mt-4">{{ versionLabel(event.provenance.material_origin.revision_id) }} · {{ event.provenance.materials.length }} 份脱敏附件</p></li></ol></details>
  </Column></article>
 </Column>
</Column></template>
