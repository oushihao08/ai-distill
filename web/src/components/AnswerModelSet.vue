<script setup lang="ts">
import {api} from '../api/client';

const props=defineProps<{projectId:string}>();
interface CatalogModel{id:string;name:string;provider:string;base_url:string;model:string;enabled:boolean}
interface SelectedModel{model_id:string;name:string;minimum_score:number|null;config:{provider:string;base_url:string;model:string}}
const catalog=shallowRef<CatalogModel[]>([]);const selected=shallowRef<SelectedModel[]>([]);
const modelName=shallowRef('');const provider=shallowRef('deepseek');const endpoint=shallowRef('https://api.deepseek.com');const model=shallowRef('deepseek-chat');
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
function updateMinimumScore(modelId:string,raw:unknown){const value=raw===''||raw===null?null:Number(raw);if(value!==null&&(!Number.isFinite(value)||value<0))return;selected.value=selected.value.map(item=>item.model_id===modelId?{...item,minimum_score:value}:item);}
async function register(){
 try{error.value='';message.value='';saving.value=true;const saved=await api<CatalogModel>('/answer-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:modelName.value,config:{provider:provider.value,base_url:endpoint.value,model:model.value}})});catalog.value=[...catalog.value,saved];modelName.value='';message.value='模型已加入系统目录';}
 catch(cause){error.value=cause instanceof Error?cause.message:'模型登记失败';}finally{saving.value=false;}
}
async function save(){
 try{error.value='';message.value='';saving.value=true;const result=await api<{models:SelectedModel[]}>(`/projects/${props.projectId}/answer-models`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({models:selected.value.map(({model_id,minimum_score})=>({model_id,minimum_score}))})});selected.value=result.models;message.value='项目作答模型集合已保存';}
 catch(cause){error.value=cause instanceof Error?cause.message:'项目模型设置保存失败';}finally{saving.value=false;}
}
watch(provider,value=>{endpoint.value=value==='qwen'||value==='openrouter'?'https://openrouter.ai/api/v1':value==='kimi'?'https://api.moonshot.ai/v1':value==='doubao'?'https://ark.cn-beijing.volces.com/api/v3':'https://api.deepseek.com';model.value=value==='qwen'?'qwen/qwen-plus':value==='openrouter'?'z-ai/glm-5.3-flash':value==='kimi'?'moonshot-v1-8k':value==='doubao'?'doubao-pro-32k':'deepseek-chat';});
onMounted(refresh);
</script>

<template>
 <Column class="surface-card p-16" :gap="16">
  <Row x="between" wrap :gap="8"><Column :gap="4"><h2 class="section-title">作答模型</h2><p class="text-xs text-muted">项目会对所选模型分别作答、评分，并按各自达标线判定。</p></Column><v-btn :loading="loading" @click="refresh">刷新</v-btn></Row>
  <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert><v-alert v-if="message" type="success" density="compact">{{ message }}</v-alert>
  <Column :gap="8"><h3 class="text-sm font-semibold">系统模型目录</h3><p v-if="!catalog.length" class="text-sm text-muted">还没有登记模型。</p>
   <Row v-for="item in catalog" :key="item.id" wrap x="between" :gap="8" class="border-t border-line-subtle pt-8">
    <v-checkbox :model-value="selected.some(row=>row.model_id===item.id)" :disabled="!item.enabled||(!selected.some(row=>row.model_id===item.id)&&selected.length>=8)" :label="`${item.name} · ${item.provider} · ${item.model}${item.enabled?'':' · 已停用'}`" hide-details @update:model-value="toggle(item)" />
   </Row>
  </Column>
  <Column v-for="item in selected" :key="item.model_id" :gap="4" class="border-t border-line-subtle pt-8"><span class="text-sm font-medium">{{ item.name }} 达标线</span><v-text-field :model-value="item.minimum_score??''" type="number" min="0" step="0.5" label="最低分（未确定可留空）" hide-details @update:model-value="updateMinimumScore(item.model_id,$event)" /></Column>
  <Row x="end"><v-btn color="primary" variant="flat" :loading="saving" :disabled="saving||!selected.length" @click="save">保存项目模型集合</v-btn></Row>
  <v-divider />
  <Column :gap="8"><h3 class="text-sm font-semibold">登记系统模型</h3><v-text-field v-model="modelName" label="显示名称" maxlength="80" hide-details /><v-select v-model="provider" :items="[{title:'Qwen（OpenRouter）',value:'qwen'},{title:'OpenRouter（GLM / Kimi 等）',value:'openrouter'},{title:'Kimi原生',value:'kimi'},{title:'DeepSeek原生',value:'deepseek'},{title:'豆包原生',value:'doubao'}]" label="供应商" hide-details /><v-text-field v-model="endpoint" label="API 地址" hide-details /><v-text-field v-model="model" label="模型 ID" hide-details /><v-btn :disabled="saving||!modelName.trim()" :loading="saving" @click="register">登记模型</v-btn></Column>
 </Column>
</template>
