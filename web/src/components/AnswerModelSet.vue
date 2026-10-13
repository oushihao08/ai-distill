<!--
职责：管理系统作答模型目录及项目所选模型和各模型的百分制分数上限。
关键方法与用法：`refresh()` 读取两类模型设置，`toggle()` 与 `updateMinimumScore()` 编辑集合，`register()` 和 `save()` 写入接口；项目详情页传入 `projectId` 使用。
-->

<script setup lang="ts">
import {api} from '../api/client';

const props=defineProps<{projectId:string}>();
interface CatalogModel{id:string;name:string;provider:string;base_url:string;model:string;enabled:boolean}
interface SelectedModel{model_id:string;name:string;minimum_score:number|null;config:{provider:string;base_url:string;model:string}}
const catalog=shallowRef<CatalogModel[]>([]);const selected=shallowRef<SelectedModel[]>([]);
const model=shallowRef('');
const loading=shallowRef(false);const saving=shallowRef(false);const error=shallowRef('');const message=shallowRef('');
async function refresh(){
 try{loading.value=true;error.value='';const [all,current]=await Promise.all([api<CatalogModel[]>('/answer-models'),api<SelectedModel[]>(`/projects/${props.projectId}/answer-models`)]);catalog.value=all;selected.value=current;}
 catch(cause){error.value=cause instanceof Error?cause.message:'模型设置读取失败';}finally{loading.value=false;}
}
function toggle(item:CatalogModel){
 if(!item.enabled)return;
 if(selected.value.some(row=>row.model_id===item.id))selected.value=selected.value.filter(row=>row.model_id!==item.id);
 else if(selected.value.length<8)selected.value=[...selected.value,{model_id:item.id,name:item.name,minimum_score:null,config:{provider:item.provider,base_url:item.base_url,model:item.model}}];
}
function updateMinimumScore(modelId:string,raw:unknown){const value=raw===''||raw===null?null:Number(raw);if(value!==null&&(!Number.isFinite(value)||value<0||value>100))return;selected.value=selected.value.map(item=>item.model_id===modelId?{...item,minimum_score:value}:item);}
async function register(){
 try{error.value='';message.value='';saving.value=true;const saved=await api<CatalogModel>('/answer-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_id:model.value.trim()})});catalog.value=[...catalog.value,saved];model.value='';message.value='模型已加入系统目录';}
 catch(cause){error.value=cause instanceof Error?cause.message:'模型登记失败';}finally{saving.value=false;}
}
async function save(){
 try{error.value='';message.value='';saving.value=true;const result=await api<{models:SelectedModel[]}>(`/projects/${props.projectId}/answer-models`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({models:selected.value.map(({model_id,minimum_score})=>({model_id,minimum_score}))})});selected.value=result.models;message.value='项目作答模型集合已保存';}
 catch(cause){error.value=cause instanceof Error?cause.message:'项目模型设置保存失败';}finally{saving.value=false;}
}
onMounted(refresh);
</script>

<template>
 <Column :gap="16">
  <Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">作答模型</h2><p class="text-xs text-muted">项目会对所选模型分别作答、评分；每个模型的百分制得分低于各自分数上限，题目才算达标，达到或超过则题目未达标。</p></Column><v-btn :loading="loading" @click="refresh">刷新</v-btn></Row>
  <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert><v-alert v-if="message" type="success" density="compact">{{ message }}</v-alert>
  <Column :gap="8"><h3 class="text-sm font-semibold">系统模型目录</h3><p v-if="!catalog.length" class="text-sm text-muted">还没有登记模型。</p>
   <Row v-for="item in catalog" :key="item.id" wrap x="between" :gap="8" class="border-t border-line-subtle pt-8">
    <v-checkbox :model-value="selected.some(row=>row.model_id===item.id)" :disabled="!item.enabled||(!selected.some(row=>row.model_id===item.id)&&selected.length>=8)" :label="`${item.name} · ${item.provider} · ${item.model}${item.enabled?'':' · 已停用'}`" hide-details @update:model-value="toggle(item)" />
   </Row>
  </Column>
  <Column v-for="item in selected" :key="item.model_id" :gap="4" class="border-t border-line-subtle pt-8"><span class="text-sm font-medium">{{ item.name }} · 分数上限（百分制）</span><v-text-field :model-value="item.minimum_score??''" type="number" min="0" max="100" step="0.5" label="低于此分通过，等于或超过则未达标（可留空）" hide-details @update:model-value="updateMinimumScore(item.model_id,$event)" /></Column>
  <Row x="end"><v-btn color="primary" variant="flat" :loading="saving" :disabled="saving||!selected.length" @click="save">保存项目模型集合</v-btn></Row>
  <v-divider />
  <Column :gap="8"><h3 class="text-sm font-semibold">登记系统模型</h3><v-text-field v-model="model" label="OpenRouter 模型 ID" placeholder="例如：deepseek/deepseek-v4.1-flash" hide-details /><v-btn :disabled="saving||!model.trim()" :loading="saving" @click="register">登记模型</v-btn></Column>
 </Column>
</template>
