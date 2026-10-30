<!--
职责：材料库列表与详情工作台；集中导入/更新文件，资料编辑、逻辑删除/恢复和全库处理设置分别维护。
入口：/materials 与 /materials/:packageId。关键词、项目多选、脱敏及归档状态在服务端组合筛选；列表一次返回当前页的轻量项目/期次使用摘要，selectPackage读取文件版本，打开“使用与提交”弹窗时才读取完整事件，runJob只派发明确步骤。
文件阅读、归档汇总和处理历史分别由子组件负责，技术编号不在主界面展开。
-->
<script setup lang="ts">
import {api,apiPostIntent} from '../api/client';
import {readMaterialFolderSelection} from '../utils/material-folder';
import {dateLabel} from '../utils/format';
import LibraryPackageUseMarker from '../components/LibraryPackageUseMarker.vue';
import type {MaterialProcessingMode,MaterialLibraryPackageSummary} from '@shared/material-library';
import type {LibraryRevision,LibraryUsage,LibraryPreparationSummary} from '../types/material-library';
const route=useRoute(),router=useRouter();
const contextProjectId=computed(()=>typeof route.query.projectId==='string'?route.query.projectId:'');
const contextProcessingMode=shallowRef<MaterialProcessingMode>();
const routePackageId=computed(()=>typeof route.params.packageId==='string'?route.params.packageId:typeof route.query.packageId==='string'?route.query.packageId:'');
const packages=shallowRef<MaterialLibraryPackageSummary[]>([]),total=shallowRef(0),page=shallowRef(1),search=shallowRef('');
const projectIds=shallowRef<string[]>([]),redactionState=shallowRef('all'),preparationState=shallowRef('all'),packageState=shallowRef('active'),projectOptions=shallowRef<{id:string;name:string}[]>([]),filterError=shallowRef('');
const hasFilters=computed(()=>!!search.value?.trim()||projectIds.value.length>0||redactionState.value!=='all'||preparationState.value!=='all'||packageState.value!=='active');
function resetFilters(){search.value='';projectIds.value=[];redactionState.value='all';preparationState.value='all';packageState.value='active';}
const loading=shallowRef(false),error=shallowRef(''),selected=shallowRef<MaterialLibraryPackageSummary>();
const revisions=shallowRef<LibraryRevision[]>([]),usage=shallowRef<LibraryUsage>();
const detailLoading=shallowRef(false),detailError=shallowRef(''),usageError=shallowRef(''),usageLoading=shallowRef(false);
type ImportTask={id:string;name:string;status:string;package_id:string|null;error_message:string|null;execution?:{label:string};progress:Record<string,unknown>};
const importTasks=shallowRef<ImportTask[]>([]),importError=shallowRef('');
let importTimer:ReturnType<typeof setTimeout>|undefined,importsDisposed=false,importsReading=false;
function scheduleImportPoll(){
 clearTimeout(importTimer);
 if(importsDisposed||!importTasks.value.some(task=>['queued','running'].includes(task.status)))return;
 importTimer=setTimeout(()=>{if(document.hidden)scheduleImportPoll();else void loadImports();},10000);
}
async function loadImports(){
 if(importsDisposed||importsReading)return;importsReading=true;clearTimeout(importTimer);
 try{
  const previous=new Map(importTasks.value.map(task=>[task.id,task.status]));
  const result=await api<{items:ImportTask[]}>('/material-library/imports');
  if(importsDisposed)return;importTasks.value=result.items;importError.value='';
  if(result.items.some(task=>task.status==='succeeded'&&previous.has(task.id)&&previous.get(task.id)!=='succeeded'))await refreshAll();
 }catch(cause){if(!importsDisposed)importError.value=cause instanceof Error?cause.message:'读取导入任务失败';}
 finally{importsReading=false;scheduleImportPoll();}
}
async function importSubmitted(id:string){actionMessage.value=`已提交提取入库任务 ${id}；成功前不会建立材料记录。`;await loadImports();}
const preparations=shallowRef<LibraryPreparationSummary[]>([]),preparationStatus=shallowRef<'loading'|'error'|'unavailable'|'ready'>('loading');
const detailDialog=shallowRef<'usage'|'history'|'preparation'|null>(null),packageDialog=shallowRef(false),metadataDialog=shallowRef(false),processingDialog=shallowRef(false),archiveDialog=shallowRef(false);
const folderInput=shallowRef<HTMLInputElement>(),selectedFiles=shallowRef<File[]>([]),uploadKey=shallowRef('');
const busy=shallowRef(false),actionError=shallowRef(''),actionMessage=shallowRef('');
const totalJobs=computed(()=>revisions.value.reduce((sum,item)=>sum+item.jobs.length,0));
let selectionRequest=0,usageRequest=0,listRequest=0,searchTimer:ReturnType<typeof setTimeout>|undefined;
async function loadPackages(){
 const request=++listRequest;loading.value=true;error.value='';
 const query=new URLSearchParams({page:String(page.value),page_size:'30',q:String(search.value??'').trim(),redaction_state:redactionState.value,preparation_state:preparationState.value,archived_only:String(packageState.value==='archived')});
 projectIds.value.forEach(id=>query.append('project_id',id));
 try{const result=await api<{items:MaterialLibraryPackageSummary[];total_count:number}>(`/material-library/packages?${query}`);if(request===listRequest){packages.value=result.items;total.value=result.total_count;if(!routePackageId.value){const activeItems=result.items.filter(item=>!item.deleted_at),match=activeItems.find(item=>item.id===selected.value?.id)??(packageState.value==='active'?activeItems[0]:undefined);if(match){if(selected.value?.id!==match.id)void selectPackage(match);else selected.value=match;}else{selectionRequest++;usageRequest++;selected.value=undefined;revisions.value=[];usage.value=undefined;detailLoading.value=false;usageLoading.value=false;}}}}
 catch(cause){if(request===listRequest)error.value=cause instanceof Error?cause.message:'读取材料包失败';}
 finally{if(request===listRequest)loading.value=false;}
}
async function selectPackage(item:MaterialLibraryPackageSummary){
 const request=++selectionRequest,changed=selected.value?.id!==item.id;
 selected.value=item;
 const query={...route.query};delete query.packageId;
 if(route.path!==`/materials/${item.id}`||route.query.packageId)await router.replace({path:`/materials/${item.id}`,query});
 if(changed){revisions.value=[];usage.value=undefined;preparations.value=[];preparationStatus.value='loading';detailDialog.value=null;selectedFiles.value=[];uploadKey.value='';actionError.value='';actionMessage.value='';}
 detailLoading.value=true;detailError.value='';usageError.value='';
 try{
  const files=await api<{items:LibraryRevision[]}>(`/material-library/packages/${item.id}/revisions`);
  if(request!==selectionRequest)return;
  revisions.value=files.items;
  void loadPreparationStatus(item,request);
  if(detailDialog.value==='usage')void loadUsage(item);

 }catch(cause){if(request===selectionRequest)detailError.value=cause instanceof Error?cause.message:'读取材料包失败';}
 finally{if(request===selectionRequest)detailLoading.value=false;}
}
async function openPackageFromRoute(id:string){
 if(selected.value?.id===id)return;
 const fromList=packages.value.find(item=>item.id===id);
 if(fromList){await selectPackage(fromList);return;}
 const request=++selectionRequest;detailLoading.value=true;detailError.value='';
 try{
  const detail=await api<{id:string;name:string;description:string;tags:string[];current_revision_id:string|null;lock_version:number;created_at:string;updated_at:string;loaded_project_count:number;revisions:{id:string;state:'pending'|'ready';file_count:number}[]}>(`/material-library/packages/${id}`);
  if(request!==selectionRequest||routePackageId.value!==id)return;
  const current=detail.revisions.find(item=>item.id===detail.current_revision_id);
  await selectPackage({id:detail.id,name:detail.name,description:detail.description,tags:detail.tags,current_revision_id:detail.current_revision_id,file_count:current?.file_count??0,revision_state:current?.state??null,intake_status:'not_started',extraction_status:'not_started',redaction_status:'not_started',available_redaction_count:0,loaded_project_count:detail.loaded_project_count,lock_version:detail.lock_version,deleted_at:null,created_at:detail.created_at,updated_at:detail.updated_at});
 }catch(cause){if(request===selectionRequest)detailError.value=cause instanceof Error?cause.message:'打开材料详情失败';}
 finally{if(request===selectionRequest)detailLoading.value=false;}
}
async function loadPreparationStatus(item:MaterialLibraryPackageSummary,request:number){
 preparationStatus.value='loading';
 try{const result=await api<{available:boolean;items:LibraryPreparationSummary[]}>(`/material-library/packages/${item.id}/preparations`);if(request!==selectionRequest||selected.value?.id!==item.id)return;preparations.value=result.items;preparationStatus.value=result.available?'ready':'unavailable';}
 catch{if(request===selectionRequest&&selected.value?.id===item.id)preparationStatus.value='error';}
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
async function archivePackage(){
 const current=selected.value;if(!current||busy.value)return;
 busy.value=true;actionError.value='';actionMessage.value='';
 try{await api(`/material-library/packages/${current.id}`,{method:'DELETE',headers:{'If-Match':String(current.lock_version)}});archiveDialog.value=false;selected.value=undefined;const query={...route.query};delete query.packageId;await router.replace({path:'/materials',query});actionMessage.value='材料包已从活动列表移除；题目快照和使用历史保留，可在“已归档”中恢复。';await loadPackages();}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'归档材料包失败';}
 finally{busy.value=false;}
}
async function restorePackage(item:MaterialLibraryPackageSummary){
 if(busy.value)return;
 busy.value=true;actionError.value='';actionMessage.value='';
 try{await api(`/material-library/packages/${item.id}/restore`,{method:'POST',headers:{'If-Match':String(item.lock_version)}});actionMessage.value=`材料包“${item.name}”已恢复。`;await loadPackages();}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'恢复材料包失败';}
 finally{busy.value=false;}
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
 try{const form=new FormData();form.set('request_key',uploadKey.value);selectedFiles.value.forEach(file=>form.append('files',file));const job=await api<{id:string}>(`/material-library/packages/${current.id}/revisions`,{method:'POST',headers:{'If-Match':String(current.lock_version)},body:form});selectedFiles.value=[];uploadKey.value='';await refreshAll();detailDialog.value=null;await importSubmitted(job.id);}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'导入新版本失败，可重试原请求';}
 finally{busy.value=false;}
}
async function runJob(revision:LibraryRevision,kind:'intake'|'extract'|'redact',templateId?:string){
 if(!selected.value||busy.value)return;
 busy.value=true;actionError.value='';actionMessage.value='';
 try{const extraction=kind==='redact'?revision.jobs.find(job=>job.kind==='extract'&&job.status==='succeeded'):undefined;if(kind==='redact'&&!extraction)throw new Error('请先完成识别原文');await apiPostIntent(`/material-library/revisions/${revision.id}/jobs`,{kind,...(contextProjectId.value?{project_id:contextProjectId.value}:{}),...(kind==='redact'&&templateId?{template_id:templateId}:{}),execution_target:'local',...(extraction?{extraction_job_id:extraction.id}:{})});actionMessage.value=`${kind==='intake'?'入库':kind==='extract'?'识别原文':'脱敏'}任务已派发。完成后点击刷新查看结果。`;await refreshAll();}
 catch(cause){actionError.value=cause instanceof Error?cause.message:'派发处理任务失败';}
 finally{busy.value=false;}
}
type BatchStage='intake'|'extract'|'redact'|'prepare';
const batchStage=shallowRef<BatchStage>('extract'),batchRunning=shallowRef(false);
const batchRows=shallowRef<{id:string;name:string;status:string;jobId?:string;reason:string}[]>([]);
const batchStages=[{title:'入库',value:'intake'},{title:'文本提取',value:'extract'},{title:'脱敏',value:'redact'},{title:'材料整理',value:'prepare'}];
async function runSearchBatch(){
 if(busy.value||loading.value||packageState.value==='archived')return;
 busy.value=true;batchRunning.value=true;batchRows.value=[];actionError.value='';actionMessage.value='';
 const stage=batchStage.value,projectId=contextProjectId.value;
 const query=new URLSearchParams({page_size:'100',q:String(search.value??'').trim(),redaction_state:redactionState.value,preparation_state:preparationState.value,archived_only:'false'});
 projectIds.value.forEach(id=>query.append('project_id',id));
 try{
  // 派发前固定完整搜索集合；写入改变筛选结果时不再翻页，避免漏包或带入新包。
  const matches=new Map<string,MaterialLibraryPackageSummary>();
  for(let next=1;;next++){
   query.set('page',String(next));const result=await api<{items:MaterialLibraryPackageSummary[];total_count:number}>(`/material-library/packages?${query}`);
   result.items.forEach(item=>{if(!item.deleted_at)matches.set(item.id,item);});
   if(next*100>=result.total_count)break;
   if(!result.items.length)throw new Error('搜索结果分页发生变化，请刷新后重新派发');
  }
  batchRows.value=[...matches.values()].map(item=>({id:item.id,name:item.name,status:'待核对',reason:''}));
  if(stage==='redact'&&contextProcessingMode.value==='original')throw new Error('当前期次使用原文，无需脱敏');
  for(const row of batchRows.value){
   try{
    const item=matches.get(row.id)!;
    const revision=(await api<{items:LibraryRevision[]}>(`/material-library/packages/${row.id}/revisions`)).items.find(value=>value.id===item.current_revision_id);
    const skip=(reason:string)=>{row.status='跳过';row.reason=reason;};
    if(!revision){skip('没有当前文件版本');continue;}
    if(revision.jobs.some(job=>['queued','running'].includes(job.status))){skip('已有活动任务');continue;}
    const extraction=revision.jobs.find(job=>job.kind==='extract'&&job.status==='succeeded');
    const redaction=revision.redactions.find(value=>value.usable_for_question===true||value.usable_for_question==='true');
    if(stage==='intake'&&revision.state==='ready'){skip('已入库');continue;}
    if(stage!=='intake'&&revision.state!=='ready'){skip('尚未入库');continue;}
    if(stage==='extract'&&extraction){skip('已提取成功');continue;}
    if((stage==='redact'||stage==='prepare')&&!extraction){skip('尚未提取成功');continue;}
    if(stage==='redact'&&redaction){skip('已有可用脱敏结果');continue;}
    let receipt:{id:string;reused?:boolean};
    if(stage==='prepare'){
     const source=contextProcessingMode.value==='original'?undefined:redaction;
     if(contextProcessingMode.value!=='original'&&!source){skip('尚无可用脱敏结果');continue;}
     const preparationQuery=new URLSearchParams({revision_id:revision.id,redaction_id:source?.id??'',...(projectId?{project_id:projectId}:{})});
     const existing=await api<{available:boolean;items:LibraryPreparationSummary[]}>(`/material-library/packages/${row.id}/preparations?${preparationQuery}`);
     if(!existing.available){skip('材料整理尚未启用');continue;}
     if(existing.items.some(value=>value.revision_id===revision.id&&value.redaction_id===(source?.id??null)&&(!projectId||!value.project_id||value.project_id===projectId))){skip('已有整理成果');continue;}
     receipt=await apiPostIntent<{id:string;reused?:boolean}>(`/material-library/revisions/${revision.id}/prepare`,{...(source?{redaction_id:source.id}:{extraction_job_id:extraction!.id}),...(projectId?{project_id:projectId}:{})});
    }else{
     receipt=await apiPostIntent<{id:string;reused?:boolean}>(`/material-library/revisions/${revision.id}/jobs`,{kind:stage,execution_target:'local',...(projectId?{project_id:projectId}:{}),...(stage==='redact'?{extraction_job_id:extraction!.id,template_id:'aliases'}:{})});
    }
    row.status=receipt.reused?'已复用':'已派发';row.jobId=receipt.id;
   }catch(cause){row.status='已停止';row.reason=cause instanceof Error?cause.message:'派发失败';actionError.value='批量派发已停止，请查看下方原因；已提交任务继续执行。';break;}
   finally{batchRows.value=[...batchRows.value];}
  }
  const sent=batchRows.value.filter(row=>row.status==='已派发'||row.status==='已复用').length;
  actionMessage.value=`本批搜索命中 ${batchRows.value.length} 个包，已提交/复用 ${sent} 个，跳过 ${batchRows.value.filter(row=>row.status==='跳过').length} 个，未派发 ${batchRows.value.filter(row=>row.status==='待核对').length} 个。`;
 }catch(cause){actionError.value=cause instanceof Error?cause.message:'批量派发失败';}
 finally{batchRunning.value=false;busy.value=false;await loadPackages();}
}
async function changePage(value:number){page.value=value;await loadPackages();}
watch(contextProjectId,async id=>{contextProcessingMode.value=undefined;if(!id)return;try{contextProcessingMode.value=(await api<{material_processing_mode:MaterialProcessingMode}>(`/projects/${id}/material-processing`)).material_processing_mode;}catch(cause){actionError.value=cause instanceof Error?cause.message:'读取本期材料处理设置失败';}},{immediate:true});
watch(detailDialog,value=>{if(value==='usage'&&selected.value&&!usage.value)void loadUsage(selected.value);});
watch([search,redactionState,preparationState,packageState,()=>projectIds.value.join(',')],()=>{listRequest++;selectionRequest++;usageRequest++;detailLoading.value=false;usageLoading.value=false;if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page.value=1;void loadPackages();},250);});
watch(routePackageId,(id,previous)=>{detailDialog.value=null;if(id){void openPackageFromRoute(id);return;}if(previous){selectionRequest++;usageRequest++;selected.value=undefined;revisions.value=[];usage.value=undefined;detailLoading.value=false;usageLoading.value=false;void loadPackages();}});
onMounted(async()=>{void loadImports();try{const packageId=routePackageId.value;await Promise.all([loadPackages(),packageId?openPackageFromRoute(packageId):Promise.resolve()]);try{projectOptions.value=(await api<{items:{id:string;name:string}[]}>('/material-library/project-options')).items;}catch(cause){filterError.value=cause instanceof Error?cause.message:'读取项目选项失败';}}catch(cause){error.value=cause instanceof Error?cause.message:'打开材料库失败';}});
onUnmounted(()=>{importsDisposed=true;clearTimeout(importTimer);selectionRequest++;usageRequest++;listRequest++;if(searchTimer)clearTimeout(searchTimer);});
</script>
<template><Column :gap="12" class="min-w-0 lg:flex-1 min-h-0">
 <Row x="between" wrap :gap="16" y="center"><Column :gap="6"><h1 class="text-xl font-bold text-ink-heading">材料库</h1></Column><Row wrap :gap="8"><v-btn variant="outlined" @click="processingDialog=true"><template #prepend><UiIcon name="settings"/></template>共用处理设置</v-btn><v-btn color="primary" @click="packageDialog=true"><template #prepend><UiIcon name="plus"/></template>导入材料文件夹</v-btn></Row></Row>
 <Column v-if="importTasks.length||importError" class="surface-card p-12" :gap="8">
  <Row x="between"><strong class="text-sm">提取入库任务（最近50条，非材料记录）</strong><v-btn size="small" @click="loadImports">刷新任务</v-btn></Row>
  <v-alert v-if="importError" type="error" density="compact">{{ importError }}</v-alert>
  <table class="w-full text-sm"><thead><tr><th class="text-left">材料名称</th><th class="text-left">状态</th><th class="text-left">结果</th></tr></thead><tbody><tr v-for="task in importTasks" :key="task.id"><td>{{ task.name }}</td><td>{{ task.execution?.label??({queued:'排队中',running:'提取中',succeeded:'已提取并入库',failed:'失败，未新增材料',cancelled:'已取消，未新增材料'} as Record<string,string>)[task.status]??task.status }}</td><td><RouterLink v-if="task.status==='succeeded'&&task.package_id" :to="`/materials/${task.package_id}`">查看材料</RouterLink><span v-else>{{ task.error_message||'成功后才建立正式材料记录' }}</span></td></tr></tbody></table>
 </Column>
 <v-alert v-if="actionError" type="error" closable @click:close="actionError=''">{{ actionError }}</v-alert><v-alert v-if="actionMessage" type="success" closable @click:close="actionMessage=''">{{ actionMessage }}</v-alert>
 <Row wrap y="center" :gap="12" class="surface-card p-12">
  <v-text-field v-model="search" label="搜索材料包" hide-details clearable :disabled="busy" class="w-full sm:w-200 flex-1 min-w-0"/>
  <v-autocomplete v-model="projectIds" variant="outlined" density="compact" :items="projectOptions" item-title="name" item-value="id" label="使用项目（多选）" multiple chips closable-chips clearable hide-details :disabled="busy" class="w-full sm:w-280 flex-1 min-w-0" @update:model-value="projectIds=$event??[]"/>
  <v-select v-model="redactionState" label="脱敏状态" :items="[{title:'全部',value:'all'},{title:'已脱敏',value:'ready'},{title:'未脱敏',value:'not_ready'}]" hide-details :disabled="busy" class="w-full sm:w-160 sm:max-w-180"/>
  <v-select v-model="preparationState" label="是否整理" :items="[{title:'全部',value:'all'},{title:'已整理',value:'ready'},{title:'未整理',value:'not_ready'}]" hide-details :disabled="busy" class="w-full sm:w-160 sm:max-w-180"/>
  <v-select v-model="packageState" label="材料包状态" :items="[{title:'使用中',value:'active'},{title:'已归档',value:'archived'}]" hide-details :disabled="busy" class="w-full sm:w-140" @update:model-value="selected=undefined"/>
  <v-btn variant="text" :disabled="busy||!hasFilters" @click="resetFilters">重置</v-btn>
 </Row>
 <Column :gap="8" class="surface-card p-12">
  <Row wrap y="center" :gap="12">
   <span class="text-sm">对全部搜索结果批量派发（{{ total }} 个包）</span>
   <v-select v-model="batchStage" :items="batchStages" label="处理阶段" hide-details :disabled="busy" class="w-full sm:w-180 sm:max-w-220"/>
   <v-btn color="primary" :loading="batchRunning" :disabled="busy||loading||!total||packageState==='archived'" @click="runSearchBatch">批量派发</v-btn>
  </Row>
  <p class="text-xs text-muted">包含所有分页；跳过已完成、有活动任务和前置条件未满足的包。容量不足或请求异常时停止，不自动推进下一阶段。</p>
  <Column v-if="batchRows.length" :gap="0" class="max-h-240 overflow-auto">
   <table class="w-full text-sm"><thead><tr><th scope="col">材料包</th><th scope="col">派发状态</th><th scope="col">任务 / 原因</th></tr></thead><tbody><tr v-for="row in batchRows" :key="row.id"><td>{{ row.name }}</td><td>{{ row.status }}</td><td class="break-all">{{ row.reason||row.jobId||'—' }}</td></tr></tbody></table>
  </Column>
 </Column>
 <v-alert v-if="filterError||error" type="error">{{ filterError||error }}</v-alert>
 <Row stack-on-mobile y="stretch" :gap="12" class="min-w-0 lg:flex-1 min-h-0">
  <aside class="surface-card w-full lg:w-220 xl:w-240 shrink-0 overflow-hidden lg:h-full min-h-0" aria-label="材料包列表"><Column :gap="0" class="lg:h-full min-h-0">
   <Row x="between" class="p-16 border-b border-line"><h2 class="text-base font-semibold">材料包</h2><span class="text-xs text-muted">{{ total }} 个</span></Row>
   <p v-if="loading&&!packages.length" class="p-16 text-sm text-muted">正在读取材料包…</p><p v-else-if="!packages.length" class="p-16 text-sm text-muted">{{ hasFilters?'没有匹配的材料包。':'暂无材料包' }}</p>
   <Column :gap="0" class="max-h-220 overflow-y-auto flex-1 min-h-0 lg:max-h-none"><template v-for="item in packages" :key="item.id"><Column v-if="item.deleted_at" :gap="8" class="p-12 border-b border-line-subtle"><Column :gap="4" class="min-w-0"><strong class="text-sm leading-relaxed break-words">{{ item.name }}</strong><span class="text-xs text-muted">已归档 · {{ item.file_count }} 份文件</span></Column><Row x="between" y="center"><LibraryPackageUseMarker :uses="item.material_uses"/><v-btn size="small" variant="text" :disabled="busy" @click="restorePackage(item)">恢复</v-btn></Row></Column><Column v-else :gap="4" class="border-l-3 border-b border-line-subtle transition-colors duration-150 hover:bg-surface-soft" :class="selected?.id===item.id?'bg-primary-soft border-l-primary':'border-l-transparent'"><button type="button" :disabled="busy" :aria-pressed="selected?.id===item.id" class="w-full min-w-0 appearance-none border-0 bg-transparent p-12 text-left font-sans text-ink-body cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60" @click="selectPackage(item)"><Column :gap="4"><strong class="text-sm leading-relaxed break-words">{{ item.name }}</strong><Row wrap :gap="8" class="text-xs text-muted"><span>{{ item.file_count }} 份文件</span><span :class="item.available_redaction_count>0?'text-success':''">{{ item.available_redaction_count>0?'脱敏可用':'待完成处理' }}</span></Row></Column></button><Row class="px-12 pb-8"><LibraryPackageUseMarker :uses="item.material_uses"/></Row></Column></template></Column>
   <Row v-if="total>30" x="between" class="p-12 border-t border-line" :gap="8"><v-btn size="small" :disabled="loading||page===1" @click="changePage(page-1)">上一页</v-btn><span class="text-xs">{{ page }} / {{ Math.ceil(total/30) }}</span><v-btn size="small" :disabled="loading||page*30>=total" @click="changePage(page+1)">下一页</v-btn></Row>
  </Column></aside>
  <section class="surface-card min-w-0 w-full flex-1 overflow-hidden lg:h-full min-h-0" aria-label="材料包详情">
   <template v-if="selected"><Column :gap="0" class="lg:h-full min-h-0">
    <Row stack-on-mobile x="between" wrap y="start" :gap="12" class="p-12 border-b border-line"><Column :gap="6" class="min-w-0 w-full lg:w-auto flex-1"><h2 class="text-base font-semibold break-words">{{ selected.name }}</h2></Column><Row wrap :gap="8"><v-btn variant="outlined" :disabled="!selected.current_revision_id" aria-haspopup="dialog" @click="detailDialog='preparation'">材料整理</v-btn><v-btn variant="outlined" aria-haspopup="dialog" @click="detailDialog='usage'">使用与提交</v-btn><v-btn variant="outlined" aria-haspopup="dialog" @click="detailDialog='history'">处理记录<template v-if="totalJobs">（{{ totalJobs }}）</template></v-btn><v-btn variant="text" :disabled="busy" @click="metadataDialog=true">编辑信息</v-btn><v-btn variant="outlined" :disabled="busy" @click="folderInput?.click()">更新文件</v-btn><v-btn variant="text" :loading="detailLoading" :disabled="detailLoading||busy" @click="refreshAll"><template #prepend><UiIcon name="refresh"/></template>刷新</v-btn><v-btn color="error" variant="text" :disabled="busy" @click="archiveDialog=true">删除材料包</v-btn></Row><input ref="folderInput" type="file" webkitdirectory multiple class="hidden" aria-label="选择更新后的材料文件夹" @change="selectFolder"/></Row>
    <Row v-if="selectedFiles.length" wrap x="between" :gap="12" class="px-20 py-12 bg-primary-soft"><p class="text-sm">已选择 {{ selectedFiles.length }} 份文件，将保存为新版本，保留历史文件。</p><Row :gap="8"><v-btn variant="text" :disabled="busy" @click="selectedFiles=[]">取消</v-btn><v-btn color="primary" :loading="busy" :disabled="busy" @click="uploadFiles">确认导入</v-btn></Row></Row>
    <Column :gap="0" class="min-h-0 flex-1 lg:overflow-y-auto">
     <v-alert v-if="detailError" type="error" class="ma-16">{{ detailError }}</v-alert>
     <p v-if="detailLoading&&!revisions.length" class="p-24 text-sm text-muted">正在读取材料…</p>
     <template v-else><LibraryPackageWorkspace :key="`${selected.id}-${selected.current_revision_id}`" :revisions="revisions" :preparations="preparations" :preparation-status="preparationStatus" :project-id="contextProjectId||undefined" :busy="busy||!!contextProjectId&&!contextProcessingMode" :processing-mode="contextProcessingMode" @run="runJob" @refresh="refreshAll"/></template>
    </Column>
   </Column></template>
   <Column v-else-if="detailLoading&&routePackageId" x="center" y="center" :gap="16" class="min-h-400 p-32" role="status"><v-progress-circular indeterminate color="primary"/><h2 class="text-base font-semibold">正在打开材料详情…</h2></Column>
   <Column v-else-if="detailError" :gap="12" class="min-h-400 p-24" role="alert"><v-alert type="error">{{ detailError }}</v-alert><v-btn variant="outlined" @click="routePackageId?openPackageFromRoute(routePackageId):loadPackages()">重试</v-btn></Column>
   <Column v-else x="center" y="center" :gap="16" class="min-h-400 p-32"><UiIcon name="file" class="text-muted"/><h2 class="text-base font-semibold">选择一个材料包</h2></Column>
  </section>
 </Row>
 <v-dialog :model-value="detailDialog!==null" max-width="1100" scrollable aria-labelledby="material-detail-dialog-title" @update:model-value="!$event&&(detailDialog=null)">
  <v-card class="max-h-[85vh] overflow-hidden">
   <v-card-title><Row x="between" y="center" :gap="12"><Column :gap="4" class="min-w-0"><h2 id="material-detail-dialog-title" class="text-base font-semibold">{{ detailDialog==='usage'?'使用与提交':detailDialog==='history'?'处理记录':'材料整理与使用范围' }}</h2><p class="text-sm text-muted truncate">{{ selected?.name }}</p></Column><v-btn icon="$close" variant="text" aria-label="关闭弹窗" @click="detailDialog=null"/></Row></v-card-title>
   <v-card-text class="min-h-0 overflow-y-auto">
     <template v-if="detailDialog==='usage'"><p v-if="usageLoading&&!usage" class="p-20 text-sm text-muted">正在读取项目使用情况…</p><v-alert v-if="usageError" type="error" class="ma-16">{{ usageError }}</v-alert><LibraryUsageSummary v-else-if="usage" :usage="usage" :revisions="revisions"/></template>
     <Column v-else-if="detailDialog==='history'" :gap="12" class="p-12"><p v-if="!totalJobs" class="text-sm text-muted">尚未执行处理任务。</p><details v-for="(revision,index) in revisions" :key="revision.id" :open="index===0" class="border border-line rounded-md p-12"><summary class="cursor-pointer text-sm font-medium focus-visible:outline-auto">文件第 {{ revisions.length-index }} 版 · {{ revision.jobs.length }} 次处理 · {{ dateLabel(revision.created_at) }}</summary><Column :gap="12" class="mt-16"><LibraryJobHistory :revision-id="revision.id" :jobs="revision.jobs" :disabled="busy" @refresh="refreshAll"/></Column></details></Column>
     <template v-else-if="detailDialog==='preparation'"><LibraryPreparationPanel v-if="selected?.current_revision_id" :key="`prep-${selected.id}-${selected.current_revision_id}`" :package-id="selected.id" :revision-id="selected.current_revision_id" :redaction-id="contextProcessingMode==='original'?undefined:revisions.find(r=>r.id===selected?.current_revision_id)?.redactions.find(r=>r.usable_for_question===true||r.usable_for_question==='true')?.id" :project-id="contextProjectId||undefined" @refresh="refreshAll"/></template>
   </v-card-text>
  </v-card>
 </v-dialog>
 <LibraryPackageCreateDialog v-model="packageDialog" @submitted="importSubmitted"/>
 <v-dialog v-model="metadataDialog" max-width="600"><LibraryPackageSettings v-if="metadataDialog&&selected" :package-id="selected.id" @close="metadataDialog=false" @saved="refreshAll"/></v-dialog>
 <v-dialog v-model="processingDialog" max-width="900"><LibraryProcessingSettings v-if="processingDialog" @close="processingDialog=false" @saved="actionMessage='共用处理设置已保存，之后派发的新任务使用此配置。'"/></v-dialog>
 <v-dialog v-model="archiveDialog" max-width="520"><v-card><v-card-title>删除这个材料包？</v-card-title><v-card-text><v-alert type="info" density="compact">这里执行可恢复的逻辑删除：材料包会从使用中列表隐藏，原件、处理记录、已加载项目关系、已创建题目的冻结附件和归档历史都会保留。可在“已归档”筛选中恢复；有入库、识别或脱敏任务正在运行时不能删除。</v-alert><p class="mt-12">材料包：{{ selected?.name }}</p></v-card-text><v-card-actions><v-spacer/><v-btn :disabled="busy" @click="archiveDialog=false">取消</v-btn><v-btn color="error" variant="flat" :loading="busy" :disabled="!selected" @click="archivePackage">删除材料包</v-btn></v-card-actions></v-card></v-dialog>
</Column></template>
