<!--
职责：材料库列表与详情工作台；集中导入/更新文件，资料编辑和全库处理设置分别维护。
入口：/materials。关键词、项目多选和脱敏状态在服务端组合筛选；selectPackage读取文件版本和使用关系，runJob只派发明确步骤。
文件阅读、归档汇总和处理历史分别由子组件负责，技术编号不在主界面展开。
-->
<script setup lang="ts">
import {api} from '../api/client';
import {readMaterialFolderSelection} from '../utils/material-folder';
import {dateLabel} from '../utils/format';
import type {MaterialLibraryPackageSummary} from '@shared/material-library';
import type {LibraryRevision,LibraryUsage} from '../types/material-library';
const packages=shallowRef<MaterialLibraryPackageSummary[]>([]),total=shallowRef(0),page=shallowRef(1),search=shallowRef('');
const projectIds=shallowRef<string[]>([]),redactionState=shallowRef('all'),projectOptions=shallowRef<{id:string;name:string}[]>([]),filterError=shallowRef('');
const hasFilters=computed(()=>!!search.value?.trim()||projectIds.value.length>0||redactionState.value!=='all');
function resetFilters(){search.value='';projectIds.value=[];redactionState.value='all';}
const loading=shallowRef(false),error=shallowRef(''),selected=shallowRef<MaterialLibraryPackageSummary>();
const revisions=shallowRef<LibraryRevision[]>([]),usage=shallowRef<LibraryUsage>();
const detailLoading=shallowRef(false),detailError=shallowRef(''),usageError=shallowRef(''),usageLoading=shallowRef(false);
const panel=shallowRef('files'),packageDialog=shallowRef(false),metadataDialog=shallowRef(false),processingDialog=shallowRef(false);
const folderInput=shallowRef<HTMLInputElement>(),selectedFiles=shallowRef<File[]>([]),uploadKey=shallowRef('');
const busy=shallowRef(false),actionError=shallowRef(''),actionMessage=shallowRef('');
const totalJobs=computed(()=>revisions.value.reduce((sum,item)=>sum+item.jobs.length,0));
let selectionRequest=0,usageRequest=0,listRequest=0,searchTimer:ReturnType<typeof setTimeout>|undefined;
async function loadPackages(){
 const request=++listRequest;loading.value=true;error.value='';
 const query=new URLSearchParams({page:String(page.value),page_size:'30',q:String(search.value??'').trim(),redaction_state:redactionState.value});
 projectIds.value.forEach(id=>query.append('project_id',id));
 try{const result=await api<{items:MaterialLibraryPackageSummary[];total_count:number}>(`/material-library/packages?${query}`);if(request===listRequest){packages.value=result.items;total.value=result.total_count;const match=result.items.find(item=>item.id===selected.value?.id)??result.items[0];if(match){if(selected.value?.id!==match.id)void selectPackage(match);else selected.value=match;}else{selectionRequest++;usageRequest++;selected.value=undefined;revisions.value=[];usage.value=undefined;detailLoading.value=false;usageLoading.value=false;}}}
 catch(cause){if(request===listRequest)error.value=cause instanceof Error?cause.message:'读取材料包失败';}
 finally{if(request===listRequest)loading.value=false;}
}
async function selectPackage(item:MaterialLibraryPackageSummary){
 const request=++selectionRequest,changed=selected.value?.id!==item.id;
 selected.value=item;
 if(changed){revisions.value=[];usage.value=undefined;panel.value='files';selectedFiles.value=[];uploadKey.value='';actionError.value='';actionMessage.value='';}
 detailLoading.value=true;detailError.value='';usageError.value='';
 try{
  const files=await api<{items:LibraryRevision[]}>(`/material-library/packages/${item.id}/revisions`);
  if(request!==selectionRequest)return;
  revisions.value=files.items;
  if(panel.value==='usage')void loadUsage(item);

 }catch(cause){if(request===selectionRequest)detailError.value=cause instanceof Error?cause.message:'读取材料包失败';}
 finally{if(request===selectionRequest)detailLoading.value=false;}
}
async function loadUsage(item:MaterialLibraryPackageSummary){
 const request=++usageRequest;usageLoading.value=true;usageError.value='';
 try{const result=await api<LibraryUsage>(`/material-library/packages/${item.id}/usage`);if(request===usageRequest&&selected.value?.id===item.id)usage.value=result;}
 catch(cause){if(request===usageRequest&&selected.value?.id===item.id)usageError.value=cause instanceof Error?cause.message:'读取项目使用情况失败';}
 finally{if(request===usageRequest)usageLoading.value=false;}
}
async function refreshAll(){
 try{await loadPackages();if(selected.value)await selectPackage(packages.value.find(item=>item.id===selected.value?.id)??selected.value);}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'刷新失败';}
}
async function packageCreated(id:string,imported:boolean){
 try{resetFilters();page.value=1;await loadPackages();const item=packages.value.find(row=>row.id===id);if(item)await selectPackage(item);actionMessage.value=imported?'材料文件夹已导入，请开始入库。':'材料包已建立，文件尚未导入，请重新选择文件夹。';}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'刷新导入结果失败';}
}
function selectFolder(event:Event){
 actionError.value='';actionMessage.value='';selectedFiles.value=[];
 try{const result=readMaterialFolderSelection(Array.from((event.target as HTMLInputElement).files??[]));selectedFiles.value=result.files;uploadKey.value=crypto.randomUUID();if(result.ignoredCount)actionMessage.value=`已跳过 ${result.ignoredCount} 个不支持的文件。`;}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'读取文件夹失败';}
 finally{if(folderInput.value)folderInput.value.value='';}
}
async function uploadFiles(){
 const current=selected.value;if(!current||busy.value||!selectedFiles.value.length)return;
 busy.value=true;actionError.value='';
 try{const form=new FormData();form.set('request_key',uploadKey.value);selectedFiles.value.forEach(file=>form.append('files',file));await api(`/material-library/packages/${current.id}/revisions`,{method:'POST',headers:{'If-Match':String(current.lock_version)},body:form});selectedFiles.value=[];uploadKey.value='';await refreshAll();panel.value='files';actionMessage.value='新文件版本已保存，历史版本保留。请执行入库和识别。';}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'导入新版本失败，可重试原请求';}
 finally{busy.value=false;}
}
async function runJob(revision:LibraryRevision,kind:'intake'|'extract'|'redact'){
 if(!selected.value||busy.value)return;
 busy.value=true;actionError.value='';actionMessage.value='';
 try{const extraction=kind==='redact'?revision.jobs.find(job=>job.kind==='extract'&&job.status==='succeeded'):undefined;if(kind==='redact'&&!extraction)throw new Error('请先完成识别原文');await api(`/material-library/revisions/${revision.id}/jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,request_key:crypto.randomUUID(),execution_target:'local',...(extraction?{extraction_job_id:extraction.id}:{})})});actionMessage.value=`${kind==='intake'?'入库':kind==='extract'?'识别原文':'脱敏'}任务已派发。完成后点击刷新查看结果。`;await refreshAll();}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'派发处理任务失败';}
 finally{busy.value=false;}
}
async function changePage(value:number){page.value=value;await loadPackages();}
watch(panel,value=>{if(value==='usage'&&selected.value&&!usage.value)void loadUsage(selected.value);});
watch([search,redactionState,()=>projectIds.value.join(',')],()=>{listRequest++;selectionRequest++;usageRequest++;detailLoading.value=false;usageLoading.value=false;if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page.value=1;void loadPackages();},250);});
onMounted(async()=>{try{await loadPackages();try{projectOptions.value=(await api<{items:{id:string;name:string}[]}>('/material-library/project-options')).items;}catch(cause){filterError.value=cause instanceof Error?cause.message:'读取项目选项失败';}}catch(cause){error.value=cause instanceof Error?cause.message:'打开材料库失败';}});
onUnmounted(()=>{selectionRequest++;usageRequest++;listRequest++;if(searchTimer)clearTimeout(searchTimer);});
</script>
<template><Column :gap="12" class="min-w-0">
 <Row x="between" wrap :gap="16" y="center"><Column :gap="6"><h1 class="text-xl font-bold text-ink-heading">材料库</h1></Column><Row wrap :gap="8"><v-btn variant="outlined" @click="processingDialog=true"><template #prepend><UiIcon name="settings"/></template>共用处理设置</v-btn><v-btn color="primary" @click="packageDialog=true"><template #prepend><UiIcon name="plus"/></template>导入材料文件夹</v-btn></Row></Row>
 <v-alert v-if="actionError" type="error" closable @click:close="actionError=''">{{ actionError }}</v-alert><v-alert v-if="actionMessage" type="success" closable @click:close="actionMessage=''">{{ actionMessage }}</v-alert>
 <Row wrap y="center" :gap="12" class="surface-card p-12">
  <v-text-field v-model="search" label="搜索材料包" hide-details clearable :disabled="busy" class="w-full sm:w-200 flex-1 min-w-0"/>
  <v-autocomplete v-model="projectIds" :items="projectOptions" item-title="name" item-value="id" label="使用项目（多选）" multiple chips closable-chips clearable hide-details :disabled="busy" class="w-full sm:w-280 flex-1 min-w-0" @update:model-value="projectIds=$event??[]"/>
  <v-select v-model="redactionState" label="脱敏状态" :items="[{title:'全部',value:'all'},{title:'已脱敏',value:'ready'},{title:'未脱敏',value:'not_ready'}]" hide-details :disabled="busy" class="w-full sm:w-160 sm:max-w-180"/>
  <v-btn variant="text" :disabled="busy||!hasFilters" @click="resetFilters">重置</v-btn>
 </Row>
 <v-alert v-if="filterError||error" type="error">{{ filterError||error }}</v-alert>
 <Row stack-on-mobile y="start" :gap="12" class="min-w-0">
  <aside class="surface-card w-full lg:w-220 xl:w-240 shrink-0 overflow-hidden" aria-label="材料包列表"><Column :gap="0">
   <Row x="between" class="p-16 border-b border-line"><h2 class="text-base font-semibold">材料包</h2><span class="text-xs text-muted">{{ total }} 个</span></Row>
   <p v-if="loading&&!packages.length" class="p-16 text-sm text-muted">正在读取材料包…</p><p v-else-if="!packages.length" class="p-16 text-sm text-muted">{{ hasFilters?'没有匹配的材料包。':'暂无材料包' }}</p>
   <Column :gap="0" class="max-h-220 lg:max-h-[60vh] overflow-y-auto"><button v-for="item in packages" :key="item.id" type="button" :disabled="busy" :aria-pressed="selected?.id===item.id" class="w-full text-left cursor-pointer p-12 border-l-3 border-b border-line-subtle transition-colors duration-150 hover:bg-surface-soft focus-visible:outline-auto disabled:opacity-60" :class="selected?.id===item.id?'bg-primary-soft border-l-primary':'border-l-transparent'" @click="selectPackage(item)"><Column :gap="4"><strong class="text-sm leading-relaxed break-words">{{ item.name }}</strong><Row wrap :gap="8" class="text-xs text-muted"><span>{{ item.file_count }} 份文件</span><span :class="item.available_redaction_count>0?'text-success':''">{{ item.available_redaction_count>0?'脱敏可用':'待完成处理' }}</span><span>{{ item.loaded_project_count }} 个项目</span></Row></Column></button></Column>
   <Row v-if="total>30" x="between" class="p-12 border-t border-line" :gap="8"><v-btn size="small" :disabled="loading||page===1" @click="changePage(page-1)">上一页</v-btn><span class="text-xs">{{ page }} / {{ Math.ceil(total/30) }}</span><v-btn size="small" :disabled="loading||page*30>=total" @click="changePage(page+1)">下一页</v-btn></Row>
  </Column></aside>
  <section class="surface-card min-w-0 w-full flex-1 overflow-hidden" aria-label="材料包详情">
   <template v-if="selected"><Column :gap="0">
    <Row stack-on-mobile x="between" wrap y="start" :gap="12" class="p-12 border-b border-line"><Column :gap="6" class="min-w-0 w-full lg:w-auto flex-1"><h2 class="text-base font-semibold break-words">{{ selected.name }}</h2></Column><Row wrap :gap="8"><v-btn variant="text" :disabled="busy" @click="metadataDialog=true">编辑信息</v-btn><v-btn variant="outlined" :disabled="busy" @click="folderInput?.click()">更新文件</v-btn><v-btn variant="text" :loading="detailLoading" :disabled="detailLoading||busy" @click="refreshAll"><template #prepend><UiIcon name="refresh"/></template>刷新</v-btn></Row><input ref="folderInput" type="file" webkitdirectory multiple class="hidden" aria-label="选择更新后的材料文件夹" @change="selectFolder"/></Row>
    <Row v-if="selectedFiles.length" wrap x="between" :gap="12" class="px-20 py-12 bg-primary-soft"><p class="text-sm">已选择 {{ selectedFiles.length }} 份文件，将保存为新版本，保留历史文件。</p><Row :gap="8"><v-btn variant="text" :disabled="busy" @click="selectedFiles=[]">取消</v-btn><v-btn color="primary" :loading="busy" :disabled="busy" @click="uploadFiles">确认导入</v-btn></Row></Row>
    <v-tabs v-model="panel" color="primary" aria-label="材料包详情内容"><v-tab value="files">材料文件</v-tab><v-tab value="usage">项目使用</v-tab><v-tab value="history">处理记录<template v-if="totalJobs">（{{ totalJobs }}）</template></v-tab></v-tabs>
    <v-alert v-if="detailError" type="error" class="ma-16">{{ detailError }}</v-alert>
    <p v-if="detailLoading&&!revisions.length" class="p-24 text-sm text-muted">正在读取材料…</p>
    <LibraryPackageWorkspace v-else-if="panel==='files'" :key="`${selected.id}-${selected.current_revision_id}`" :revisions="revisions" :busy="busy" @run="runJob" @refresh="refreshAll"/>
    <template v-else-if="panel==='usage'"><p v-if="usageLoading&&!usage" class="p-20 text-sm text-muted">正在读取项目使用情况…</p><v-alert v-if="usageError" type="error" class="ma-16">{{ usageError }}</v-alert><LibraryUsageSummary v-else-if="usage" :usage="usage" :revisions="revisions"/></template>
    <Column v-else-if="panel==='history'" :gap="12" class="p-12"><p v-if="!totalJobs" class="text-sm text-muted">尚未执行处理任务。</p><details v-for="(revision,index) in revisions" :key="revision.id" :open="index===0" class="border border-line rounded-md p-12"><summary class="cursor-pointer text-sm font-medium focus-visible:outline-auto">文件第 {{ revisions.length-index }} 版 · {{ revision.jobs.length }} 次处理 · {{ dateLabel(revision.created_at) }}</summary><Column :gap="12" class="mt-16"><LibraryJobHistory :revision-id="revision.id" :jobs="revision.jobs" :disabled="busy" @refresh="refreshAll"/></Column></details></Column>
   </Column></template>
   <Column v-else x="center" y="center" :gap="16" class="min-h-400 p-32"><UiIcon name="file" class="text-muted"/><h2 class="text-base font-semibold">选择一个材料包</h2></Column>
  </section>
 </Row>
 <LibraryPackageCreateDialog v-model="packageDialog" @created="packageCreated"/>
 <v-dialog v-model="metadataDialog" max-width="600"><LibraryPackageSettings v-if="metadataDialog&&selected" :package-id="selected.id" @close="metadataDialog=false" @saved="refreshAll"/></v-dialog>
 <v-dialog v-model="processingDialog" max-width="900"><LibraryProcessingSettings v-if="processingDialog" @close="processingDialog=false" @saved="actionMessage='共用处理设置已保存，之后派发的新任务使用此配置。'"/></v-dialog>
</Column></template>
