<!-- 职责：选择本机材料文件夹，以文件夹名称提交独立提取入库任务，成功后才创建材料包。
入口：modelValue 控制弹窗；submitted 返回独立任务ID，材料库页面展示任务状态。
提交未知保留同一请求标识，由服务端对账；不会预先创建空材料包；不读取或输入材料正文。 -->
<script setup lang="ts">
import {api} from '../api/client';
import {readMaterialFolderSelection} from '../utils/material-folder';
const props=defineProps<{modelValue:boolean}>();
const emit=defineEmits<{'update:modelValue':[value:boolean];submitted:[id:string]}>();
const folderInput=shallowRef<HTMLInputElement>();
const files=shallowRef<File[]>([]);
const folderName=shallowRef('');
const ignoredCount=shallowRef(0);
const busy=shallowRef(false);
const error=shallowRef('');
const requestKey=shallowRef('');
const preserveImages=shallowRef(false);
const imageReviewFiles=shallowRef<boolean[]>([]);
const reviewCount=computed(()=>imageReviewFiles.value.filter(Boolean).length);
function canReview(file:File){return /\.(?:pdf|docx|png|jpe?g)$/i.test(file.name);}
function setImageReview(index:number,value:boolean){imageReviewFiles.value=imageReviewFiles.value.map((marked,i)=>i===index?value:marked);requestKey.value=crypto.randomUUID();}
function setPreserveImages(value:boolean){preserveImages.value=value;if(!value)imageReviewFiles.value=files.value.map(()=>false);requestKey.value=crypto.randomUUID();}
function selectFolder(event:Event){
 const incoming=Array.from((event.target as HTMLInputElement).files??[]);
 error.value='';files.value=[];folderName.value='';ignoredCount.value=0;
 try{const selection=readMaterialFolderSelection(incoming);folderName.value=selection.name;files.value=selection.files;imageReviewFiles.value=selection.files.map(()=>false);preserveImages.value=false;ignoredCount.value=selection.ignoredCount;requestKey.value=crypto.randomUUID();}
 catch(cause){error.value=cause instanceof Error?cause.message:'无法读取材料文件夹';}
}
function close(){
 if(busy.value)return;

 emit('update:modelValue',false);
}
async function importFolder(){
 if(busy.value||!files.value.length||preserveImages.value&&!reviewCount.value)return;
 busy.value=true;error.value='';
 try{
  const form=new FormData();form.set('request_key',requestKey.value);form.set('name',folderName.value);files.value.forEach(file=>form.append('files',file));
  if(preserveImages.value){form.set('preserve_images','true');form.set('image_review_files',JSON.stringify(imageReviewFiles.value));}
  const job=await api<{id:string}>('/material-library/imports',{method:'POST',body:form});
  emit('submitted',job.id);emit('update:modelValue',false);
 }catch(cause){error.value=cause instanceof Error?cause.message:'导入材料文件夹失败，请重试';}
 finally{busy.value=false;}
}
watch(()=>props.modelValue,open=>{
 if(open){files.value=[];folderName.value='';ignoredCount.value=0;error.value='';requestKey.value='';preserveImages.value=false;imageReviewFiles.value=[];if(folderInput.value)folderInput.value.value='';}
});
</script>
<template>
 <v-dialog :model-value="modelValue" :persistent="busy" max-width="600" @update:model-value="value=>{if(!value)close()}">
  <Column class="surface-card p-20" :gap="16">
   <h2 class="section-title">从材料文件夹建立材料包</h2>
   <p class="text-sm text-muted">直接支持 PDF、DOCX、TXT、MD、PNG、JPG、JPEG；DOC、WPS、OFD 请先使用 <code>library files prepare</code> 预处理后导入。</p>
   <input ref="folderInput" type="file" webkitdirectory multiple class="hidden" :disabled="busy" @change="selectFolder"/>
   <v-btn variant="outlined" :disabled="busy" @click="folderInput?.click()">选择材料文件夹</v-btn>
   <template v-if="files.length"><strong>{{ folderName }} · {{ files.length }} 份材料</strong><v-switch :model-value="preserveImages" label="保留并判断核心图片" :disabled="busy" hide-details @update:model-value="setPreserveImages(Boolean($event))"/><p v-if="preserveImages" class="text-xs text-muted">勾选需要核心图片的文件；仅这些文件会提取图片并在材料整理时逐张判断。</p><Column class="max-h-240 overflow-y-auto" :gap="4"><Row v-for="(file,index) in files" :key="file.webkitRelativePath||file.name" x="between" y="center" :gap="8"><p class="text-sm break-all">{{ file.webkitRelativePath||file.name }}</p><v-checkbox v-if="preserveImages&&canReview(file)" :model-value="imageReviewFiles[index]" label="需要核心图片" :disabled="busy" hide-details @update:model-value="setImageReview(index,Boolean($event))"/></Row></Column></template>
   <p v-if="ignoredCount" class="text-xs text-muted">已跳过 {{ ignoredCount }} 个不支持的文件。</p>
   <v-alert v-if="error" type="error" density="compact" role="alert">{{ error }}</v-alert>
   <p class="text-xs text-muted">提交后自动排队提取；全部文件提取并入库成功后才生成材料记录。失败只保留任务与错误，不生成材料包或文件版本。</p>
   <Row x="end" :gap="8"><v-btn :disabled="busy" @click="close">取消</v-btn><v-btn color="primary" :disabled="busy||!files.length||preserveImages&&!reviewCount" :loading="busy" @click="importFolder">提交提取入库</v-btn></Row>
  </Column>
 </v-dialog>
</template>
