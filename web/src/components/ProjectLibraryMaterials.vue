<!--
职责：管理期次与全局材料包的加载关系，并按本期设置从已选脱敏或原文快照创建题目。
关键入口：`refresh()`只读本期加载关系和使用摘要；候选、版本、历史均在弹窗或交互中按需读取。
使用场景：由 ProjectDetail.vue 挂载；不在这里处理原件、入库或脱敏任务。
-->
<script setup lang="ts">
import {api} from '../api/client';
import {redactionProcessingMode,type MaterialProcessingMode} from '@shared/material-library';
import type {CreateLibraryQuestionRequest,MaterialLibraryPackageSummary,MaterialUseRecord} from '@shared/material-library';

interface RedactionChoice {redaction_template_id?:string|null;redaction_template_workflow?:string|null;id:string;output_digest:string;usable_for_question:boolean|string;created_at:string;revision_id:string}
interface RevisionChoice {id:string;state:'pending'|'ready';redactions:Omit<RedactionChoice,'revision_id'>[];jobs?:{kind:string;status:string}[]}
interface PackageRevisions {items:RevisionChoice[]}
interface LoadedPackage {selected_processing_mode?:MaterialProcessingMode;id:string;project_id:string;package_id:string;package_name:string;selected_revision_id:string|null;selected_redaction_id:string|null;current_revision_id:string|null;position:number;lock_version:number;removed_at:string|null;usage_status?:'in_use'|'submitted';use_lock_version?:number}
interface CandidatePage {items:Candidate[];page:number;page_size:number;total_count:number}
type Candidate=MaterialLibraryPackageSummary&{used_in_project?:boolean;used_phase_name?:string;usage_status?:'in_use'|'submitted'};

const props=defineProps<{projectId:string;questionTags:string[];materialSourceMode:'redacted'|'original';materialProcessingMode:MaterialProcessingMode}>();
const emit=defineEmits<{refresh:[]} >();
const loaded=shallowRef<LoadedPackage[]>([]),materialUses=shallowRef<MaterialUseRecord[]>([]);
const activeLinks=computed(()=>loaded.value.filter(item=>!item.removed_at));
const removedLinks=computed(()=>loaded.value.filter(item=>!!item.removed_at));
const useByPackage=computed(()=>Object.fromEntries(materialUses.value.map(item=>[item.package_id,item])));
const phasePage=shallowRef(1),phasePageSize=20;
const phasePageCount=computed(()=>Math.max(1,Math.ceil(activeLinks.value.length/phasePageSize)));
const visibleActiveLinks=computed(()=>activeLinks.value.slice((phasePage.value-1)*phasePageSize,phasePage.value*phasePageSize));
const submittedPackageCount=computed(()=>activeLinks.value.filter(link=>(useByPackage.value[link.package_id]?.status??link.usage_status)==='submitted').length);
const inUsePackageCount=computed(()=>activeLinks.value.length-submittedPackageCount.value);
const redactionsByPackage=reactive<Record<string,{title:string;value:string}[]>>({});
const revisionsByPackage=reactive<Record<string,{title:string;value:string}[]>>({});
const loadedVersionIds=new Set<string>(),loadingVersionIds=new Set<string>();
const busy=shallowRef(false),error=shallowRef(''),notice=shallowRef('');
const loadDialog=shallowRef(false),candidateQuery=shallowRef(''),candidatePage=shallowRef(1),candidateTotal=shallowRef(0),candidates=shallowRef<Candidate[]>([]),candidateLoading=shallowRef(false);
const selectedPackageId=shallowRef(''),selectedRedactionId=shallowRef(''),selectedRevisionId=shallowRef(''),revisions=shallowRef<RevisionChoice[]>([]);
const candidateRedactions=computed<RedactionChoice[]>(()=>revisions.value.flatMap(revision=>revision.redactions.filter(item=>(item.usable_for_question===true||item.usable_for_question==='true')&&redactionProcessingMode(item)===props.materialProcessingMode).map(item=>({...item,revision_id:revision.id}))));
const candidatePageCount=computed(()=>Math.max(1,Math.ceil(candidateTotal.value/30)));
const selectedCandidate=computed(()=>candidates.value.find(item=>item.id===selectedPackageId.value));
const questionDialog=shallowRef(false),questionLink=shallowRef<LoadedPackage|null>(null);
const questionForm=reactive({title:'',scenario:'',role_perspective:'',authoring_direction:'',target_level:'' as ''|'L2'|'L3'|'L4'|'L5',question_tags:[] as string[]});
function levelFromPackageName(name:string):''|'L2'|'L3'|'L4'|'L5'{const level=/(?:^|[-_\s])(L[2-5])(?=$|[-_\s])/i.exec(name)?.[1]?.toUpperCase();return level==='L2'||level==='L3'||level==='L4'||level==='L5'?level:'';}
const questionPackageLevel=computed(()=>questionLink.value?levelFromPackageName(questionLink.value.package_name):'');

let candidateRequestVersion=0;
async function refresh(){
 try{
  const [projectMaterials,uses]=await Promise.all([
   api<{items:LoadedPackage[]}>(`/projects/${props.projectId}/loaded-materials?include_removed=true`),
   api<{items:MaterialUseRecord[]}>(`/projects/${props.projectId}/material-uses`),
  ]);
  loaded.value=projectMaterials.items;materialUses.value=uses.items;loadedVersionIds.clear();
  if(phasePage.value>phasePageCount.value)phasePage.value=phasePageCount.value;
  for(const link of loaded.value)if(link.selected_redaction_id&&!redactionsByPackage[link.package_id])redactionsByPackage[link.package_id]=[{title:'当前选用的脱敏版本',value:link.selected_redaction_id}];
 }catch(cause){error.value=cause instanceof Error?cause.message:'本期材料加载失败';}
}
async function loadCandidates(){
 const requestVersion=++candidateRequestVersion,page=candidatePage.value,query=candidateQuery.value.trim();candidateLoading.value=true;
 try{
  const result=await api<CandidatePage>(`/projects/${props.projectId}/material-candidates?q=${encodeURIComponent(query)}&page=${page}&page_size=30&source_mode=original`);
  if(requestVersion!==candidateRequestVersion||page!==candidatePage.value||query!==candidateQuery.value.trim())return;
  candidates.value=result.items;candidateTotal.value=result.total_count;
  if(selectedPackageId.value&&!candidates.value.some(item=>item.id===selectedPackageId.value)){selectedPackageId.value='';selectedRedactionId.value='';selectedRevisionId.value='';revisions.value=[];}
 }catch(cause){if(requestVersion===candidateRequestVersion)error.value=cause instanceof Error?cause.message:'读取可用材料失败';}
 finally{if(requestVersion===candidateRequestVersion)candidateLoading.value=false;}
}
function openLoadDialog(){error.value='';notice.value='';loadDialog.value=true;candidatePage.value=1;void loadCandidates();}
let searchTimer:ReturnType<typeof setTimeout>|undefined;
watch(candidateQuery,()=>{candidatePage.value=1;if(!loadDialog.value)return;if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(()=>void loadCandidates(),250);});
watch(candidatePage,()=>{if(loadDialog.value)void loadCandidates();});
watch(loadDialog,open=>{if(!open){selectedPackageId.value='';selectedRedactionId.value='';selectedRevisionId.value='';revisions.value=[];}});
async function inspectCandidate(packageId:string){
 selectedPackageId.value=packageId;selectedRedactionId.value='';selectedRevisionId.value='';revisions.value=[];if(!packageId)return;
 try{const result=await api<PackageRevisions>(`/material-library/packages/${packageId}/revisions`);if(selectedPackageId.value!==packageId)return;revisions.value=result.items;selectedRedactionId.value=candidateRedactions.value[0]?.id??'';selectedRevisionId.value=result.items.find(revision=>revision.state==='ready'&&revision.jobs?.some((job:any)=>job.kind==='extract'&&job.status==='succeeded'))?.id??'';}
 catch(cause){error.value=cause instanceof Error?cause.message:'读取材料版本失败';}
}
async function inspectLoadedPackage(packageId:string){
 if(loadedVersionIds.has(packageId)||loadingVersionIds.has(packageId))return;
 loadingVersionIds.add(packageId);
 try{const result=await api<PackageRevisions>(`/material-library/packages/${packageId}/revisions`);redactionsByPackage[packageId]=result.items.flatMap(revision=>revision.redactions.filter(item=>(item.usable_for_question===true||item.usable_for_question==='true')&&redactionProcessingMode(item)===props.materialProcessingMode).map(item=>({title:`${revision.id.slice(0,8)} · ${new Date(item.created_at).toLocaleString()}`,value:item.id})));revisionsByPackage[packageId]=result.items.filter(revision=>revision.state==='ready'&&revision.jobs?.some(job=>job.kind==='extract'&&job.status==='succeeded')).map(revision=>({title:`${revision.id.slice(0,8)} · 提取完成`,value:revision.id}));loadedVersionIds.add(packageId);}
 catch(cause){error.value=cause instanceof Error?cause.message:`读取${props.materialSourceMode==='original'?'提取':'脱敏'}版本失败`;}
 finally{loadingVersionIds.delete(packageId);}
}
async function loadPackage(){
 if(!selectedPackageId.value||(!selectedRevisionId.value&&!selectedRedactionId.value)||busy.value)return;
 busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(props.materialSourceMode==='original'||!selectedRedactionId.value?{package_id:selectedPackageId.value,revision_id:selectedRevisionId.value}:{package_id:selectedPackageId.value,redaction_id:selectedRedactionId.value})});notice.value='材料包已加载到本期';loadDialog.value=false;await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'加载材料包失败';}
 finally{busy.value=false;}
}
async function chooseRedaction(link:LoadedPackage,redactionId:string){
 if(!redactionId||busy.value)return;
 busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials/${link.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':String(link.lock_version)},body:JSON.stringify({redaction_id:redactionId})});notice.value='本期已切换脱敏版本；已创建题目的材料快照不变';await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'切换材料版本失败';}
 finally{busy.value=false;}
}
async function chooseRevision(link:LoadedPackage,revisionId:string){
 if(!revisionId||busy.value)return;busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials/${link.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':String(link.lock_version)},body:JSON.stringify({revision_id:revisionId})});notice.value='本期切换到未脱敏提取版本；已创建题目的材料快照不变';await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'切换材料版本失败';}
 finally{busy.value=false;}
}
async function removePackage(link:LoadedPackage){
 if(busy.value)return;busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials/${link.id}`,{method:'DELETE',headers:{'If-Match':String(link.lock_version)}});notice.value='本期引用已移除；主项目材料使用记录保留';await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'移除材料引用失败';}
 finally{busy.value=false;}
}
async function restorePackage(link:LoadedPackage){
 if(busy.value)return;busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials/${link.id}/restore`,{method:'POST',headers:{'If-Match':String(link.lock_version)}});notice.value='已恢复本期原材料引用';await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'恢复材料引用失败';}
 finally{busy.value=false;}
}
function canCreateQuestion(link:LoadedPackage){return link.usage_status!=='submitted'&&link.selected_processing_mode===props.materialProcessingMode&&(props.materialSourceMode==='original'?!!link.selected_revision_id:!!link.selected_redaction_id);}
function openQuestionDialog(link:LoadedPackage){
 if(!canCreateQuestion(link))return;
 questionLink.value=link;Object.assign(questionForm,{title:'',scenario:'',role_perspective:'',authoring_direction:'',target_level:levelFromPackageName(link.package_name),question_tags:[]});error.value='';questionDialog.value=true;
}
async function createQuestion(){
 const link=questionLink.value,title=questionForm.title.trim();if(!link||!title||!canCreateQuestion(link)||busy.value)return;
 const body:CreateLibraryQuestionRequest={request_key:crypto.randomUUID(),...(props.materialSourceMode==='original'?{revision_id:link.selected_revision_id!}:{redaction_id:link.selected_redaction_id!}),expected_link_version:link.lock_version,title,
  ...(questionForm.scenario.trim()?{scenario:questionForm.scenario.trim()}:{}),...(questionForm.role_perspective.trim()?{role_perspective:questionForm.role_perspective.trim()}:{}),
  ...(questionForm.authoring_direction.trim()?{authoring_direction:questionForm.authoring_direction.trim()}:{}),...(questionForm.target_level?{target_level:questionForm.target_level}:{}),question_tags:[...questionForm.question_tags]};
 busy.value=true;error.value='';notice.value='';
 try{await api(`/projects/${props.projectId}/loaded-materials/${link.id}/questions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});questionDialog.value=false;notice.value=`已从“${link.package_name}”创建题目，题目保存独立材料快照`;emit('refresh');await refresh();}
 catch(cause){error.value=cause instanceof Error?cause.message:'从材料包创建题目失败';}
 finally{busy.value=false;}
}
watch(()=>props.materialProcessingMode,()=>{loadedVersionIds.clear();for(const key of Object.keys(redactionsByPackage))delete redactionsByPackage[key];void refresh();});
watch(()=>props.projectId,()=>{phasePage.value=1;void refresh();},{immediate:true});
onBeforeUnmount(()=>{if(searchTimer)clearTimeout(searchTimer);});
</script>

<template><section class="surface-card p-16"><Column :gap="14">
 <Row x="between" wrap y="center" :gap="8"><Column :gap="4"><h2 class="section-title">本期材料</h2></Column><Row :gap="8"><v-btn size="small" variant="outlined" :loading="busy" @click="refresh">刷新</v-btn><v-btn size="small" color="primary" @click="openLoadDialog">加载材料包</v-btn></Row></Row>
 <v-alert v-if="error" type="error" density="compact" role="alert">{{ error }}</v-alert><v-alert v-if="notice" type="success" density="compact" role="status">{{ notice }}</v-alert>
 <Row v-if="activeLinks.length" wrap y="center" :gap="8" class="text-sm"><v-chip size="small" variant="tonal">材料包 {{ activeLinks.length }}</v-chip><v-chip size="small" color="primary" variant="tonal">使用中 {{ inUsePackageCount }}</v-chip><v-chip size="small" color="success" variant="tonal">已提交 {{ submittedPackageCount }}</v-chip></Row>
 <p v-if="!activeLinks.length" class="text-sm text-muted">本期尚未加载材料包。</p>
 <Column v-else class="w-full overflow-x-auto" :gap="0"><v-table density="comfortable" class="min-w-1000px" aria-label="本期已加载材料包"><thead><tr><th scope="col">材料包</th><th scope="col">主项目状态</th><th scope="col">本期材料版本</th><th scope="col">题目设置</th><th scope="col">操作</th></tr></thead><tbody>
  <tr v-for="link in visibleActiveLinks" :key="link.id"><td class="min-w-220"><Column :gap="4"><RouterLink :to="{path:`/materials/${link.package_id}`,query:{projectId:props.projectId}}" class="link-text font-medium">{{ link.package_name }} · 材料详情</RouterLink><span class="text-xs text-muted">版本 {{ link.selected_revision_id?.slice(0,8)??'未选择' }}</span></Column></td>
   <td class="min-w-180"><MaterialUsePanel v-if="useByPackage[link.package_id]" :project-id="projectId" :item="useByPackage[link.package_id]!" @updated="refresh"/><v-chip v-else color="primary">使用中</v-chip></td>
   <td class="min-w-230"><v-select v-if="props.materialSourceMode==='original'" :model-value="link.selected_revision_id" :items="revisionsByPackage[link.package_id]??(link.selected_revision_id?[{title:`当前版本 ${link.selected_revision_id.slice(0,8)}`,value:link.selected_revision_id}]:[])" label="未脱敏提取版本" item-title="title" item-value="value" density="compact" hide-details :disabled="busy||link.usage_status==='submitted'" @update:menu="open=>{if(open)void inspectLoadedPackage(link.package_id)}" @update:model-value="id=>chooseRevision(link,id)"/><v-select v-else :model-value="link.selected_redaction_id" :items="redactionsByPackage[link.package_id]??[]" label="脱敏版本" item-title="title" item-value="value" density="compact" hide-details :disabled="busy||link.usage_status==='submitted'" @update:menu="open=>{if(open)void inspectLoadedPackage(link.package_id)}" @update:model-value="id=>chooseRedaction(link,id)"/></td>
   <td><v-btn v-if="props.materialProcessingMode!=='original'" size="small" variant="text" :to="{path:`/materials/${link.package_id}`,query:{projectId:props.projectId}}">处理材料</v-btn><v-btn v-if="props.materialSourceMode==='original'&&link.selected_redaction_id&&link.selected_revision_id" size="small" variant="text" @click="chooseRevision(link,link.selected_revision_id)">使用原文</v-btn><v-btn size="small" variant="outlined" :disabled="busy||!canCreateQuestion(link)" @click="openQuestionDialog(link)">创建题目</v-btn></td>
   <td><v-btn size="small" color="error" variant="text" :disabled="busy" @click="removePackage(link)">移除引用</v-btn></td></tr>
 </tbody></v-table><Row v-if="phasePageCount>1" wrap x="between" y="center" class="px-12 py-8"><span class="text-xs text-muted">第 {{ phasePage }} / {{ phasePageCount }} 页，每页最多 {{ phasePageSize }} 条</span><v-pagination v-model="phasePage" :length="phasePageCount" :total-visible="5" density="compact" aria-label="本期材料分页"/></Row></Column>
 <details v-if="removedLinks.length"><summary class="text-sm text-muted cursor-pointer">已移除的本期引用（{{ removedLinks.length }}）</summary><v-table density="compact" class="min-w-700"><thead><tr><th scope="col">材料包</th><th scope="col">提交状态</th><th scope="col">操作</th></tr></thead><tbody><tr v-for="link in removedLinks" :key="link.id"><td><RouterLink :to="{path:`/materials/${link.package_id}`,query:{projectId:props.projectId}}" class="link-text">{{ link.package_name }}</RouterLink></td><td><MaterialUsePanel v-if="useByPackage[link.package_id]" :project-id="projectId" :item="useByPackage[link.package_id]!" @updated="refresh"/><span v-else class="text-muted">使用中</span></td><td><v-btn size="small" variant="text" :disabled="busy" @click="restorePackage(link)">恢复引用</v-btn></td></tr></tbody></v-table></details>
 <v-dialog v-model="loadDialog" max-width="980" scrollable><Column class="surface-card p-20" :gap="14"><Row x="between" y="center" :gap="8"><Column :gap="4"><h2 class="section-title">加载全局材料包</h2><p class="text-xs text-muted">按本期设置只显示有可用{{ props.materialSourceMode==='original'?'MinerU提取原文':'脱敏结果' }}的材料包；同主项目已使用的材料不能再次加载。</p></Column><v-btn icon="$close" variant="text" aria-label="关闭" @click="loadDialog=false"/></Row>
  <v-text-field v-model="candidateQuery" label="搜索材料包" placeholder="输入材料名称" prepend-inner-icon="$search" hide-details clearable @keyup.enter="loadCandidates"/>
  <p v-if="candidateLoading" class="text-sm text-muted" role="status">正在读取材料候选…</p><p v-else-if="!candidates.length" class="text-sm text-muted">没有找到可加载的材料包。</p>
  <v-table v-else density="compact"><thead><tr><th scope="col">材料包</th><th scope="col">可用提取版本</th><th scope="col">主项目使用状态</th><th scope="col">操作</th></tr></thead><tbody><tr v-for="item in candidates" :key="item.id"><td><RouterLink :to="`/materials/${item.id}`" class="link-text">{{ item.name }}</RouterLink></td><td>{{ item.available_extraction_count??0 }}</td><td>{{ item.used_in_project?`${item.used_phase_name??'其他期次'} · ${item.usage_status==='submitted'?'已提交':'使用中'}`:'未使用' }}</td><td><v-btn size="small" variant="text" :disabled="item.used_in_project" @click="inspectCandidate(item.id)">{{ selectedPackageId===item.id?'已选择':'选择' }}</v-btn></td></tr></tbody></v-table>
  <v-pagination v-model="candidatePage" :length="candidatePageCount" :total-visible="5" :disabled="candidateLoading||candidatePageCount<=1" aria-label="材料候选分页"/>
  <v-select v-if="selectedCandidate&&props.materialSourceMode==='redacted'" v-model="selectedRedactionId" :items="candidateRedactions.map(item=>({title:`${item.revision_id.slice(0,8)} · ${new Date(item.created_at).toLocaleString()}`,value:item.id}))" label="选择可用脱敏版本" item-title="title" item-value="value" :loading="candidateLoading"/>
  <v-select v-if="selectedCandidate&&(props.materialSourceMode==='original'||!candidateRedactions.length)" v-model="selectedRevisionId" :items="revisions.filter(revision=>revision.state==='ready'&&revision.jobs?.some((job:any)=>job.kind==='extract'&&job.status==='succeeded')).map(revision=>({title:`${revision.id.slice(0,8)} · 提取完成`,value:revision.id}))" label="选择已提取版本（待脱敏材料可先加载）" item-title="title" item-value="value" :loading="candidateLoading"/>
  <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert><Row x="end" :gap="8"><v-btn @click="loadDialog=false">取消</v-btn><v-btn color="primary" :loading="busy" :disabled="busy||!selectedPackageId||(!selectedRevisionId&&!selectedRedactionId)||selectedCandidate?.used_in_project" @click="loadPackage">加载到本期</v-btn></Row>
 </Column></v-dialog>
 <v-dialog v-model="questionDialog" max-width="760" scrollable><v-form class="surface-card p-20" @submit.prevent="createQuestion"><Column :gap="12"><Row x="between" y="center" :gap="8"><Column :gap="4"><h2 class="section-title">创建题目</h2><span class="text-xs text-muted">来源：{{ questionLink?.package_name }}</span></Column><v-btn icon="$close" variant="text" aria-label="关闭" @click="questionDialog=false"/></Row>
  <v-text-field v-model="questionForm.title" label="题目名称" required maxlength="240"/>
  <v-text-field v-model="questionForm.scenario" label="出题场景" placeholder="按材料实际内容填写；没有可留空"/>
  <v-text-field v-model="questionForm.role_perspective" label="出题角色 / 视角" placeholder="按材料实际委托关系填写；没有可留空"/>
  <v-textarea v-model="questionForm.authoring_direction" label="出题方向" placeholder="填写希望考察的任务方向" rows="3" auto-grow/>
  <Row stack-on-mobile :gap="12"><v-select v-model="questionForm.target_level" :items="['L2','L3','L4','L5']" label="难度等级" clearable :disabled="Boolean(questionPackageLevel)" :hint="questionPackageLevel?`按材料包标题等级 ${questionPackageLevel} 创建`:''" :persistent-hint="Boolean(questionPackageLevel)"/><v-select v-model="questionForm.question_tags" :items="questionTags" label="题目标签" multiple chips clearable/></Row>
  <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert><Row x="end" :gap="8"><v-btn :disabled="busy" @click="questionDialog=false">取消</v-btn><v-btn type="submit" color="primary" :loading="busy" :disabled="busy||!questionForm.title.trim()">创建题目</v-btn></Row>
 </Column></v-form></v-dialog>
</Column></section></template>
