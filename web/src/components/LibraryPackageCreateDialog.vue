<!-- 职责：选择本机材料文件夹，以文件夹名称创建材料包并上传首个不可变文件集合。
入口：modelValue 控制弹窗；created 返回已创建包 ID（包括上传失败后关闭时的包），由材料库页面刷新。
上传失败保留包和同一请求标识，重试不会再创建空包或重复文件集合；不读取或输入材料正文。 -->
<script setup lang="ts">
import {api} from '../api/client';
import {readMaterialFolderSelection} from '../utils/material-folder';
const props=defineProps<{modelValue:boolean}>();
const emit=defineEmits<{'update:modelValue':[value:boolean];created:[id:string,imported:boolean]}>();
const folderInput=shallowRef<HTMLInputElement>();
const files=shallowRef<File[]>([]);
const folderName=shallowRef('');
const ignoredCount=shallowRef(0);
const busy=shallowRef(false);
const error=shallowRef('');
const created=shallowRef<{id:string;lock_version:number}|null>(null);
const requestKey=shallowRef('');
function selectFolder(event:Event){
 const incoming=Array.from((event.target as HTMLInputElement).files??[]);
 error.value='';files.value=[];folderName.value='';ignoredCount.value=0;
 try{const selection=readMaterialFolderSelection(incoming);folderName.value=selection.name;files.value=selection.files;ignoredCount.value=selection.ignoredCount;requestKey.value=crypto.randomUUID();}
 catch(cause){error.value=cause instanceof Error?cause.message:'无法读取材料文件夹';}
}
function close(){
 if(busy.value)return;
 if(created.value)emit('created',created.value.id,false);
 emit('update:modelValue',false);
}
async function importFolder(){
 if(busy.value||!files.value.length)return;
 busy.value=true;error.value='';
 try{
  if(!created.value)created.value=await api<{id:string;lock_version:number}>('/material-library/packages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:folderName.value,tags:[]})});
  const form=new FormData();form.set('request_key',requestKey.value);files.value.forEach(file=>form.append('files',file));
  await api(`/material-library/packages/${created.value.id}/revisions`,{method:'POST',headers:{'If-Match':String(created.value.lock_version)},body:form});
  emit('created',created.value.id,true);emit('update:modelValue',false);
 }catch(cause){error.value=cause instanceof Error?cause.message:'导入材料文件夹失败，请重试';}
 finally{busy.value=false;}
}
watch(()=>props.modelValue,open=>{
 if(open){files.value=[];folderName.value='';ignoredCount.value=0;created.value=null;error.value='';requestKey.value='';if(folderInput.value)folderInput.value.value='';}
});
</script>
<template>
 <v-dialog :model-value="modelValue" :persistent="busy" max-width="600" @update:model-value="value=>{if(!value)close()}">
  <Column class="surface-card p-20" :gap="16">
   <h2 class="section-title">从材料文件夹建立材料包</h2>
   <p class="text-sm text-muted">把同一案件或主题的 PDF、DOCX 放在一个文件夹中，选择该文件夹导入。也支持 TXT、MD。</p>
   <input ref="folderInput" type="file" webkitdirectory multiple class="hidden" :disabled="busy||!!created" @change="selectFolder"/>
   <v-btn variant="outlined" :disabled="busy||!!created" @click="folderInput?.click()">选择材料文件夹</v-btn>
   <template v-if="files.length"><strong>{{ folderName }} · {{ files.length }} 份材料</strong><Column class="max-h-240 overflow-y-auto" :gap="4"><p v-for="file in files" :key="file.webkitRelativePath||file.name" class="text-sm break-all">{{ file.webkitRelativePath||file.name }}</p></Column></template>
   <p v-if="ignoredCount" class="text-xs text-muted">已跳过 {{ ignoredCount }} 个不支持的文件。</p>
   <v-alert v-if="error" type="error" density="compact" role="alert">{{ error }}</v-alert>
   <p class="text-xs text-muted">导入后在材料库执行入库、文本提取和脱敏。脱敏完成且校验可用后，项目才能加载。</p>
   <Row x="end" :gap="8"><v-btn :disabled="busy" @click="close">取消</v-btn><v-btn color="primary" :disabled="busy||!files.length" :loading="busy" @click="importFolder">{{ created?'重试导入':'导入材料包' }}</v-btn></Row>
  </Column>
 </v-dialog>
</template>
