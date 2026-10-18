<!--
职责：在 library_v1 项目中加载共享材料包、选择成功脱敏版本并从冻结来源创建题目。
关键入口与用法：`loadPackages()`读取全局材料库；`loadPackage()`管理项目引用；`createQuestion()`提交题目快照；由 ProjectDetail.vue 按材料后端模式挂载。
-->
<script setup lang="ts">
import {api} from '../api/client';
import type {MaterialLibraryPackageSummary} from '@shared/material-library';

interface RedactionChoice {id:string;output_digest:string;usable_for_question:boolean|string;created_at:string}
interface RevisionChoice {id:string;state:'pending'|'ready';redactions:RedactionChoice[]}
interface PackageRevisions {items:RevisionChoice[]}
interface LoadedPackage {id:string;project_id:string;package_id:string;package_name:string;selected_revision_id:string|null;selected_redaction_id:string|null;current_revision_id:string|null;position:number;lock_version:number}
const props=defineProps<{projectId:string;questionTags:string[]}>();
const emit=defineEmits<{refresh:[]}>();
const packages=shallowRef<MaterialLibraryPackageSummary[]>([]);
const loaded=shallowRef<LoadedPackage[]>([]);
const redactionsByPackage=reactive<Record<string,{title:string;value:string}[]>>({});
const selectedPackageId=shallowRef('');
const selectedRedactionId=shallowRef('');
const revisions=shallowRef<RevisionChoice[]>([]);
const questionTitles=reactive<Record<string,string>>({});
const busy=shallowRef(false);const error=shallowRef('');const notice=shallowRef('');
const selectableRedactions=computed(()=>revisions.value.flatMap(revision=>revision.redactions.filter(item=>item.usable_for_question===true||item.usable_for_question==='true').map(item=>({...item,revision_id:revision.id}))));
async function refresh(){
 try{const [catalog,projectMaterials]=await Promise.all([api<{items:MaterialLibraryPackageSummary[]}>('/material-library/packages?page=1&page_size=100&ready_only=true'),api<{items:LoadedPackage[]}>(`/projects/${props.projectId}/loaded-materials`)]);packages.value=catalog.items.filter(item=>item.available_redaction_count>0);loaded.value=projectMaterials.items;await Promise.all(loaded.value.map(async link=>{const result=await api<PackageRevisions>(`/material-library/packages/${link.package_id}/revisions`);redactionsByPackage[link.package_id]=result.items.flatMap(revision=>revision.redactions.filter(item=>item.usable_for_question===true||item.usable_for_question==='true').map(item=>({title:`${revision.id.slice(0,8)} · ${new Date(item.created_at).toLocaleString()}`,value:item.id})));}));}
 catch(cause){error.value=cause instanceof Error?cause.message:'材料库加载失败';}
}
async function inspectPackage(packageId:string){
 selectedPackageId.value=packageId;selectedRedactionId.value='';revisions.value=[];
 if(!packageId)return;
 try{const result=await api<PackageRevisions>(`/material-library/packages/${packageId}/revisions`);revisions.value=result.items;const latest=selectableRedactions.value[0];if(latest)selectedRedactionId.value=latest.id;}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取材料版本失败';}
}
async function loadPackage(){
 if(!selectedPackageId.value||!selectedRedactionId.value||busy.value)return;
 busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({package_id:selectedPackageId.value,redaction_id:selectedRedactionId.value})});notice.value='材料包已加载到本项目';await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'加载材料包失败';}
 finally{busy.value=false;}
}
async function chooseRedaction(link:LoadedPackage,redactionId:string){
 if(!redactionId||busy.value)return;
 busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials/${link.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':String(link.lock_version)},body:JSON.stringify({redaction_id:redactionId})});notice.value='项目已切换到所选脱敏版本；已有题目快照不变';await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'切换材料版本失败';}
 finally{busy.value=false;}
}
async function removePackage(link:LoadedPackage){
 if(busy.value)return;
 busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials/${link.id}`,{method:'DELETE',headers:{'If-Match':String(link.lock_version)}});notice.value='项目加载关系已移除；已创建题目的材料快照保留';await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'移除材料包失败';}
 finally{busy.value=false;}
}
async function createQuestion(link:LoadedPackage){
 const title=questionTitles[link.id]?.trim();if(!title||!link.selected_redaction_id||busy.value)return;
 busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials/${link.id}/questions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_key:crypto.randomUUID(),redaction_id:link.selected_redaction_id,expected_link_version:link.lock_version,title,question_tags:[]})});questionTitles[link.id]='';notice.value=`已从“${link.package_name}”创建题目；题目保存了独立材料快照`;emit('refresh');await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'从材料包创建题目失败';}
 finally{busy.value=false;}
}
watch(()=>props.projectId,refresh,{immediate:true});
</script>

<template><section class="surface-card p-16"><Column :gap="14">
 <Row x="between" wrap y="center" :gap="8"><Column :gap="4"><h2 class="section-title">本项目加载的标准材料</h2><p class="text-xs text-muted">材料包在全局材料库维护；本项目选择脱敏版本，建题时会冻结私有副本，后续归档可追溯到项目、题目和原始标准材料。</p></Column><v-btn size="small" variant="outlined" :loading="busy" @click="refresh">刷新</v-btn></Row>
 <v-alert v-if="error" type="error" density="compact" role="alert">{{ error }}</v-alert><v-alert v-if="notice" type="success" density="compact" role="status">{{ notice }}</v-alert>
 <Row stack-on-mobile y="start" :gap="8"><v-select v-model="selectedPackageId" :items="packages.map(item=>({title:`${item.name} · ${item.file_count}份材料 · 可用脱敏${item.available_redaction_count}个`,value:item.id}))" label="选择材料库中的标准材料包" item-title="title" item-value="value" clearable @update:model-value="inspectPackage"/><v-select v-model="selectedRedactionId" :items="selectableRedactions.map(item=>({title:`${item.revision_id.slice(0,8)} · ${new Date(item.created_at).toLocaleString()}`,value:item.id}))" label="选择已完成且校验可用的脱敏结果" item-title="title" item-value="value" clearable/><v-btn color="primary" :loading="busy" :disabled="busy||!selectedPackageId||!selectedRedactionId" @click="loadPackage">加载到本项目</v-btn></Row>
 <p class="text-xs text-muted">仅显示已完成脱敏并校验可用的材料包；尚未就绪的材料请先在材料库处理。</p>
 <p v-if="!loaded.length" class="text-sm text-muted">本项目还没有加载材料包。</p>
 <Column v-else :gap="10"><article v-for="link in loaded" :key="link.id" class="border border-line rounded-md p-12"><Column :gap="8"><Row x="between" wrap y="center" :gap="8"><Column :gap="4"><strong>{{ link.package_name }}</strong><span class="text-xs text-muted break-all">材料包 {{ link.package_id }} · 文件集合 {{ link.selected_revision_id??'未选择' }} · 脱敏结果 {{ link.selected_redaction_id??'未就绪' }}</span></Column><v-btn size="small" color="error" variant="text" :disabled="busy" @click="removePackage(link)">移除本项目引用</v-btn></Row>
 <v-select :model-value="link.selected_redaction_id" :items="redactionsByPackage[link.package_id]??[]" label="项目当前使用的脱敏版本" item-title="title" item-value="value" density="compact" hide-details :disabled="busy||!(redactionsByPackage[link.package_id]?.length)" @update:model-value="id=>chooseRedaction(link,id)"/>
 <Row stack-on-mobile y="center" :gap="8"><v-text-field v-model="questionTitles[link.id]" label="新题目名称" density="compact" hide-details/><v-btn color="secondary" :disabled="busy||!link.selected_redaction_id||!questionTitles[link.id]?.trim()" :loading="busy" @click="createQuestion(link)">从此材料建题</v-btn></Row>
 </Column></article></Column>
 <p v-if="questionTags.length" class="text-xs text-muted">当前项目已配置 {{ questionTags.length }} 个题目标签。可在题目详情中补充场景、角色和标签。</p>
</Column></section></template>
