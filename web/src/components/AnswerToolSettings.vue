<!--
职责：读取并保存项目步骤5的OpenRouter服务端与受限本地工具策略。
关键方法：refresh()读取本期策略，save()只更新之后新建的作答任务。
使用场景：由项目详情的作答模型设置弹窗传入projectId；不修改历史attempt或非OpenRouter模型。
-->
<script setup lang="ts">
import {api} from '../api/client';

const props=defineProps<{projectId:string}>();
type Tool='web_search'|'web_fetch'|'shell';
type LocalTool='attachment_list'|'attachment_search'|'attachment_read'|'document_inspect'|'artifact_write'|'artifact_render';
interface ToolPolicy{server_tools:Tool[];local_tools:LocalTool[];max_tool_calls?:number;source:'default'|'project';applies_to?:'new_attempts'}
const options=[
 {title:'网页搜索',value:'web_search' as const},
 {title:'网页抓取',value:'web_fetch' as const},
 {title:'Shell计算与校验',value:'shell' as const},
];
const localOptions=[
 {title:'附件列表',value:'attachment_list' as const},{title:'附件搜索',value:'attachment_search' as const},{title:'附件分段读取',value:'attachment_read' as const},
 {title:'文档结构检查',value:'document_inspect' as const},{title:'写入文本产物',value:'artifact_write' as const},{title:'校验并预览产物',value:'artifact_render' as const},
];
const tools=shallowRef<Tool[]>([]);const localTools=shallowRef<LocalTool[]>([]);const maxToolCalls=shallowRef<number|''>('');const source=shallowRef<'default'|'project'>('default');
const loading=shallowRef(false);const saving=shallowRef(false);const error=shallowRef('');const message=shallowRef('');
async function refresh(){
 try{
  loading.value=true;error.value='';
  const policy=await api<ToolPolicy>(`/projects/${props.projectId}/answer-tools`);
  tools.value=[...policy.server_tools];localTools.value=[...(policy.local_tools??[])];maxToolCalls.value=policy.max_tool_calls??'';source.value=policy.source;
 }catch(cause){error.value=cause instanceof Error?cause.message:'作答工具设置读取失败';}
 finally{loading.value=false;}
}
async function save(){
 try{
  saving.value=true;error.value='';message.value='';
  const body={server_tools:tools.value,local_tools:localTools.value,...((tools.value.length||localTools.value.length)&&maxToolCalls.value!==''?{max_tool_calls:Number(maxToolCalls.value)}:{})};
  const policy=await api<ToolPolicy>(`/projects/${props.projectId}/answer-tools`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  tools.value=[...policy.server_tools];localTools.value=[...(policy.local_tools??[])];maxToolCalls.value=policy.max_tool_calls??'';source.value=policy.source;message.value='工具设置已保存，仅用于之后新建的OpenRouter作答任务';
 }catch(cause){error.value=cause instanceof Error?cause.message:'作答工具设置保存失败';}
 finally{saving.value=false;}
}
onMounted(refresh);
</script>

<template>
 <Column :gap="12" class="border-t border-line-subtle pt-16">
  <Row x="between" wrap :gap="8"><Column :gap="4"><h3 class="text-sm font-semibold">本期OpenRouter作答工具</h3><p class="text-xs text-muted">当前值来自{{ source==='project'?'本期设置':'默认关闭' }}；只影响之后新建的作答任务。</p></Column><v-btn :loading="loading" :disabled="saving" @click="refresh">刷新</v-btn></Row>
  <v-alert v-if="error" type="error" density="compact">{{ error }}</v-alert>
  <v-alert v-if="message" type="success" density="compact">{{ message }}</v-alert>
  <v-select v-model="tools" :items="options" item-title="title" item-value="value" multiple chips label="允许模型按题面需要使用的工具" :disabled="loading||saving" />
  <v-select v-model="localTools" :items="localOptions" item-title="title" item-value="value" multiple chips label="允许读取冻结附件和写入本次产物的工具" :disabled="loading||saving" />
  <v-text-field :model-value="maxToolCalls" type="number" min="1" max="100" step="1" label="单次作答工具调用上限（可留空）" :disabled="loading||saving||(!tools.length&&!localTools.length)" @update:model-value="maxToolCalls=$event===''?'':Number($event)" />
  <p class="text-xs text-muted">联网和Shell由OpenRouter执行；附件和产物工具只在本次冻结材料与attempt目录内执行。系统不向模型暴露任意本机路径。</p>
  <Row x="end"><v-btn color="primary" variant="flat" :loading="saving" :disabled="loading||saving" @click="save">保存作答工具</v-btn></Row>
 </Column>
</template>
