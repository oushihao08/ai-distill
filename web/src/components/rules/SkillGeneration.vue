<!--
职责：生成项目 skill 候选、显示异步尝试并将候选采用为当前项目 skill。
关键方法与用法：`loadCodexConfig()` 读取模型选项，`generate()` 创建任务，`adopt()` 更新项目当前 skill；接收 `projectId` 并通过 `adopted` 通知项目面板刷新。
-->

<script setup lang="ts">
import {api} from '@/api/client';
import {useResource} from '@/composables/useResource';
import {dateLabel} from '@/utils/format';
interface CodexModelOption {slug:string;supported_reasoning_levels:{effort:string}[]}
interface CodexConfig {model_options:CodexModelOption[]}
interface ProjectCodexSettings {model:string;reasoning_effort:string;source:'project'|'system'}
const props=defineProps<{projectId:string;phaseCapable?:boolean}>();
const emit=defineEmits<{adopted:[]}>();
interface Generation {id:string;status:string;error:string|null;created_at:string;config:{model:string;reasoning_effort:string};result:{candidate_path:string;publishable:boolean;issues:string[];unresolved:{id:string;detail:string;blocking?:boolean}[];summary:string}|null}
const {data,error,loading,refresh}=useResource<Generation[]>(`/projects/${props.projectId}/skill/attempts`);
const model=shallowRef(''),effort=shallowRef('medium'),busy=shallowRef(false),loadingCodex=shallowRef(true);
const availableModels=shallowRef<CodexModelOption[]>([]);
const defaultSource=shallowRef<'project'|'system'>('system');
const modelItems=computed(()=>availableModels.value.map(item=>({title:item.slug,value:item.slug})));
const effortItems=computed(()=>availableModels.value.find(item=>item.slug===model.value)?.supported_reasoning_levels.map(level=>level.effort)??[]);
const active=computed(()=>data.value?.some(a=>['waiting','running'].includes(a.status))??false);
const labels:Record<string,string>={waiting:'排队',running:'生成中',succeeded:'候选已生成',failed:'失败',skipped:'已失效'};
async function loadCodexConfig(){
 try{
  loadingCodex.value=true;
  const [config,defaults]=await Promise.all([api<CodexConfig>('/agent/config'),api<ProjectCodexSettings>(`/projects/${props.projectId}/agent-settings`)]);
  availableModels.value=config.model_options??[];
  defaultSource.value=defaults.source;
  model.value=defaults.model||availableModels.value[0]?.slug||'';
  effort.value=defaults.reasoning_effort||'medium';
 }catch(cause){error.value=cause instanceof Error?cause.message:'读取Codex模型清单失败';}
 finally{loadingCodex.value=false;}
}
async function generate(){try{busy.value=true;await api(`/projects/${props.projectId}/skill/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model.value,reasoning_effort:effort.value})});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'生成提交失败';}finally{busy.value=false;}}
async function adopt(id:string){try{busy.value=true;await api(`/projects/${props.projectId}/skill/attempts/${id}/adopt`,{method:'POST'});emit('adopted');await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'采用失败';}finally{busy.value=false;}}
let timer:ReturnType<typeof setInterval>|undefined;
onMounted(()=>{loadCodexConfig();timer=setInterval(()=>{if(active.value&&!loading.value&&!document.hidden)void refresh();},10000);});onUnmounted(()=>clearInterval(timer));
</script>
<template><Column class="border-b border-line-subtle pb-16" :gap="12"><h3 class="text-sm font-medium">{{ phaseCapable?'为本期生成 Skill':'生成 Skill' }}</h3><p class="text-sm text-muted">{{ phaseCapable?'以主项目当前 Skill 和共享规则资料为基础生成本期候选；采用后仅覆盖本期，新建任务优先读取本期 Skill。':'以基础模板和共享规则资料生成候选；采用后供本项目后续任务读取。' }}保留 references/assets。</p><Row wrap :gap="12"><v-combobox :return-object="false" v-model="model" label="Codex 模型" :items="modelItems" hide-details :disabled="busy||active||loadingCodex" /><v-combobox :return-object="false" v-model="effort" label="推理强度" :items="effortItems" hide-details :disabled="busy||active||loadingCodex" /><v-btn color="primary" :loading="busy" :disabled="busy||active||loadingCodex||!model||!(effort??'').trim()" @click="generate">生成候选</v-btn></Row><p class="text-xs text-muted">初始值来自{{ defaultSource==='project'?'项目 Codex 默认':'Codex 全局默认' }}；本次生成可单独调整。</p><p v-if="!loadingCodex&&!modelItems.length" class="text-xs text-warning">本机模型建议暂不可用，可直接输入；执行前仍需完成 Codex 登录。</p><v-alert v-if="error" type="error">{{ error }}</v-alert><Column v-for="attempt in data" :key="attempt.id" class="border-t border-line-subtle pt-12" :gap="8"><Row wrap :gap="8"><strong class="text-sm">{{ labels[attempt.status]??attempt.status }}</strong><span class="text-xs text-muted">{{ dateLabel(attempt.created_at) }} · {{ attempt.config.model }}</span></Row><p v-if="attempt.error" class="text-sm text-danger">{{ attempt.error }}</p><template v-if="attempt.result"><p class="text-sm text-muted">{{ attempt.result.summary }}</p><code class="text-xs text-muted break-all">{{ attempt.result.candidate_path }}</code><p class="text-xs text-muted">{{ attempt.result.publishable?'入口和引用检查通过，可采用。':'存在未决规则或引用问题，暂不能采用。' }}</p><v-btn v-if="attempt.result.publishable" color="primary" :loading="busy" :disabled="busy||active" @click="adopt(attempt.id)">{{ phaseCapable?'设为本期 Skill':'采用为当前 Skill' }}</v-btn><p v-for="issue in attempt.result.issues" :key="issue" class="text-sm text-danger">{{ issue }}</p><p v-for="issue in attempt.result.unresolved" :key="issue.id" class="text-sm text-danger">{{ issue.blocking===false?'待确认':'阻断' }} · {{ issue.id }}：{{ issue.detail }}</p></template></Column></Column></template>
