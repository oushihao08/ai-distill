<!-- 职责：只编辑材料包名称、说明和标签。props.packageId指定包，saved/close通知材料库刷新和关闭。 -->
<script setup lang="ts">
import {api} from '../api/client';
const props=defineProps<{packageId:string}>();
const emit=defineEmits<{saved:[];close:[]}>();
const name=shallowRef(''),description=shallowRef(''),tags=shallowRef<string[]>([]),version=shallowRef(0);
const busy=shallowRef(false),loading=shallowRef(true),error=shallowRef('');
async function load(){
 try{const value=await api<{name:string;description:string;tags:string[];lock_version:number}>(`/material-library/packages/${props.packageId}`);name.value=value.name;description.value=value.description;tags.value=value.tags;version.value=value.lock_version;}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取材料包信息失败';}finally{loading.value=false;}
}
async function save(){
 if(busy.value||loading.value||!name.value.trim())return;
 try{busy.value=true;error.value='';await api(`/material-library/packages/${props.packageId}`,{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':String(version.value)},body:JSON.stringify({name:name.value,description:description.value,tags:tags.value})});emit('saved');emit('close');}
 catch(cause){error.value=cause instanceof Error?cause.message:'保存材料包信息失败';}finally{busy.value=false;}
}
onMounted(load);
</script>
<template><v-form class="surface-card p-20" @submit.prevent="save"><Column :gap="16">
 <Row x="between" y="center"><h2 class="section-title">编辑材料包信息</h2><v-btn :disabled="busy" @click="emit('close')">关闭</v-btn></Row>
 <v-alert v-if="error" type="error">{{ error }}</v-alert><p v-if="loading" class="text-muted">正在读取…</p>
 <v-text-field v-model="name" label="材料包名称" maxlength="180" :disabled="busy||loading"/>
 <v-textarea v-model="description" label="说明" rows="3" :disabled="busy||loading"/>
 <v-combobox v-model="tags" label="标签" multiple chips :disabled="busy||loading"/>
 <Row x="end"><v-btn type="submit" color="primary" :disabled="busy||loading||!name.trim()" :loading="busy">保存信息</v-btn></Row>
</Column></v-form></template>
