<!--
职责：作为单题工作流路由，编排步骤操作、附件、模型评测与产物下载。
关键方法与用法：`intake()`、`redact()`、`author()`、`answer()` 等方法派发对应阶段，`addMaterial()`／`removeMaterial()` 管理附件，`clearGenerated()` 重置生成状态；路由参数 `id` 指定题目工作流。
-->

<script setup lang="ts">
import { api } from '../api/client';
import { useResource } from '../composables/useResource';
import { dateLabel, fileSize } from '../utils/format';
import { readAnswerStepResult, statusLabels, type Attempt, type WorkflowDetail, type Step } from '../types/api';
import ModelEvaluationSummary from '../components/ModelEvaluationSummary.vue';
import MaterialRecordsTable from '../components/MaterialRecordsTable.vue';
const route = useRoute();
const { data, error, loading, refresh } = useResource<WorkflowDetail>(`/workflows/${route.params.id}`);
const submitting=shallowRef(false);
const exportingDocx=shallowRef(false);
const docxArchivePath=shallowRef('');
const clearOpen=shallowRef(false);
const questionOpen=shallowRef(false);
const visibleSteps=computed(()=>data.value?.steps.filter(step=>step.ordinal!==10)??[]);
const authoredStep=computed(()=>visibleSteps.value.find(step=>step.ordinal===4));
const activeTask=computed(()=>data.value?.attempts.some(a=>a.ordinal!==10&&['waiting','running'].includes(a.status)));
const hasSucceededAuthoring=computed(()=>data.value?.attempts.some(attempt=>attempt.ordinal===4&&attempt.status==='succeeded')??false);
const visibleAttempts=computed(()=>[...(data.value?.attempts??[])].filter(attempt=>attempt.ordinal!==10).sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at)));
const sortedAttempts=visibleAttempts;
const answerDiagnosticLabels:Record<string,string>={invalid_response_shape:'响应结构无效',missing_choice:'响应缺少结果',unexpected_choice_count:'响应结果数量异常',invalid_choice_shape:'结果结构无效',incomplete_finish_reason:'响应未正常结束',invalid_message_shape:'消息结构无效',invalid_message_role:'消息角色异常',empty_content:'响应正文为空',unexpected_tool_call:'返回了未支持的工具调用',refusal_response:'模型返回拒答',invalid_usage_shape:'用量字段格式异常',invalid_model_field:'模型字段格式异常',invalid_completion_id:'响应ID格式异常',invalid_json:'响应JSON无效',result_validation_failed:'答案内容未通过校验'};
function answerDiagnostic(attempt:Attempt){
 const result=attempt.result as {error?:{reason_code?:unknown}}|null;
 const code=result?.error?.reason_code;
 if(typeof code==='string')return `${answerDiagnosticLabels[code]??'响应校验未通过'}（${code}）`;
 if(attempt.ordinal===5&&attempt.status==='failed'&&attempt.error?.includes('未返回完整有效的内容'))return '历史记录未保存细分原因码';
 return null;
}
const materialOpen=shallowRef(false);const deleting=shallowRef<{id:string;original_name:string}|null>(null);
const currentStep=computed(()=>visibleSteps.value.find(step=>!['succeeded','skipped'].includes(step.status)||(step.ordinal===7&&step.result?.decision==='repair')));
const currentStepLabel=computed(()=>{
 const step=currentStep.value;
 if(!step)return '全部完成';
 if(step.ordinal===6){const models=readAnswerStepResult(visibleSteps.value.find(item=>item.ordinal===5)?.result)?.models;if(models?.length&&models.every(model=>model.status==='skipped'&&model.outcome==='qualified_timeout_unscored'))return '本轮免评分，不能判定达标';}
 if(step.ordinal!==7)return statusLabels[step.status];
 const labels:Record<string,string>={accepted:'达标',repair:'未达标',waiting:'等待判定条件',quarantine:'隔离'};
 return labels[String(step.result?.decision??'')]??statusLabels[step.status];
});
const stepStatus=(ordinal:number)=>visibleSteps.value.find(step=>step.ordinal===ordinal)?.status;
const canExportDocx=computed(()=>Boolean(data.value&&!currentStep.value&&stepStatus(8)==='succeeded'&&stepStatus(9)==='succeeded'&&!activeTask.value));
const currentRedactionAttempt=computed(()=>data.value?.attempts.filter(attempt=>attempt.ordinal===9).at(-1));
const currentDocxArtifacts=computed(()=>{const attempt=currentRedactionAttempt.value;if(!attempt||attempt.status!=='succeeded'||!canExportDocx.value)return [];return data.value?.artifacts.filter(artifact=>artifact.kind==='redacted_docx'&&artifact.attempt_id===attempt.id)??[];});
const answerDisabled=computed(()=>submitting.value || stepStatus(4)!=='succeeded' || data.value?.attempts.some(attempt=>attempt.ordinal===5 && ['waiting','running'].includes(attempt.status)));
const authorDisabled=computed(()=>submitting.value || stepStatus(9)!=='succeeded' || data.value?.attempts.some(attempt=>attempt.ordinal===4 && ['waiting','running'].includes(attempt.status)));
function addMaterial(){materialOpen.value=true;}
async function intake(){try{submitting.value=true;await api(`/workflows/${route.params.id}/intake`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'接收失败';}finally{submitting.value=false;}}
async function removeMaterial(){if(!deleting.value)return;try{submitting.value=true;await api(`/workflows/${route.params.id}/materials/${deleting.value.id}`,{method:'DELETE'});deleting.value=null;await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'删除失败';}finally{submitting.value=false;}}
async function redact() {
 try { submitting.value=true; await api(`/workflows/${route.params.id}/redact`,{method:'POST'}); await refresh(); }
 catch(failure){ error.value=failure instanceof Error?failure.message:'脱敏任务提交失败'; }
 finally {submitting.value=false;}
}
async function clearGenerated(){try{submitting.value=true;const result=await api<{file_cleanup:string}>(`/workflows/${route.params.id}/generated`,{method:'DELETE'});clearOpen.value=false;await refresh();if(result.file_cleanup!=='completed')error.value='数据库已清理，但隔离文件清理未完成，请检查存储权限';}catch(cause){error.value=cause instanceof Error?cause.message:'清理失败';}finally{submitting.value=false;}}
async function author(){try{submitting.value=true;await api(`/workflows/${route.params.id}/author`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'出题提交失败';}finally{submitting.value=false;}}
async function answer(){try{submitting.value=true;await api(`/workflows/${route.params.id}/answer`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'作答提交失败';}finally{submitting.value=false;}}
const answerReadyForScoring=computed(()=>{
 const answerStep=visibleSteps.value.find(step=>step.ordinal===5);
 if(answerStep?.status==='succeeded')return true;
 const models=readAnswerStepResult(answerStep?.result)?.models;
 return !!models?.length&&models.every(model=>['succeeded','failed','skipped'].includes(model.status))&&models.some(model=>model.status==='succeeded'&&typeof model.attempt_id==='string');
});
const scoreDisabled=computed(()=>submitting.value || !answerReadyForScoring.value || data.value?.attempts.some(attempt=>attempt.ordinal===6 && ['waiting','running'].includes(attempt.status)));
async function score(){try{submitting.value=true;await api(`/workflows/${route.params.id}/score`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'评分提交失败';}finally{submitting.value=false;}}
const acceptanceDecision=computed(()=>visibleSteps.value.find(step=>step.ordinal===7)?.result?.decision);
const publishDisabled=computed(()=>submitting.value || stepStatus(7)!=='succeeded' || acceptanceDecision.value!=='accepted' || stepStatus(8)==='succeeded');
const attemptNames:Record<number,string>={1:'入库',2:'PDF文本提取（入库内部）',3:'旧规则绑定（历史）',4:'出题',5:'模型作答',6:'独立评分',7:'达标判断',8:'归档达标题目',9:'脱敏与检查'};
function attemptStatusLabel(attempt:Attempt){
 const decision=attempt.ordinal===7&&attempt.result&&typeof attempt.result==='object'&&'decision' in attempt.result?String(attempt.result.decision??''):'';
 return ({accepted:'达标',repair:'未达标',waiting:'等待判定条件',quarantine:'隔离'} as Record<string,string>)[decision]??statusLabels[attempt.status];
}
function attemptStatusColor(attempt:Attempt){
 if(attempt.ordinal===7&&attempt.result&&typeof attempt.result==='object'&&'decision' in attempt.result&&attempt.result.decision==='accepted')return 'success';
 if(attempt.ordinal===7&&attempt.result&&typeof attempt.result==='object'&&'decision' in attempt.result&&attempt.result.decision==='repair')return 'warning';
 if(attempt.ordinal===7&&attempt.result&&typeof attempt.result==='object'&&'decision' in attempt.result&&attempt.result.decision==='quarantine')return 'error';
 return attempt.status==='succeeded'?'success':attempt.status==='failed'?'error':attempt.status==='running'?'primary':'secondary';
}
const artifactAttempts:Record<number,number[]>={1:[1,2],9:[9],4:[4],5:[5],6:[6],8:[8]};
function artifactsForStep(step:Step){
 const ordinals=new Set(artifactAttempts[step.ordinal]??[]);
 return (data.value?.artifacts??[]).filter(artifact=>{
  if(artifact.kind==='redacted_docx')return false;
  const attempt=data.value?.attempts.find(item=>item.id===artifact.attempt_id);
  return attempt?ordinals.has(attempt.ordinal):false;
 });
}
function questionSections(step:Step){
 const result=step.result??{};
 const text=(value:unknown)=>typeof value==='string'&&value.trim()?value:'尚未保存';
 const header=result.header&&typeof result.header==='object'?result.header as Record<string,unknown>:{};
 const labels:Record<string,string>={industry_l1:'一级行业',industry_l2:'二级行业',task_form:'任务形式',occupation_l1:'L1 职业簇',occupation_l2:'L2 职业'};
 const headerText=[`题目 ID：${text(result.question_id)}`,...Object.entries(labels).map(([key,label])=>`${label}：${header[key]==='single_round'?'单轮':text(header[key])}`)].join('\n');
 const rubric=Array.isArray(result.rubric)?result.rubric.map((item:Record<string,unknown>)=>`${text(item.id)}（${typeof item.max_score==='number'?item.max_score:'—'}分）\n${text(item.criterion)}`).join('\n\n'):'';
 return [{title:'表头',content:headerText},{title:'任务名称',content:text(result.task_name)},{title:'任务类型',content:text(result.task_type)},{title:'题面 prompt',content:text(result.question)},{title:'考点 rubric',content:rubric||'尚未保存'},{title:'作答思路',content:text(result.answer_approach)},{title:'标准答案',content:text(result.reference_answer)}];
}
function artifactLabel(kind:string){return kind==='published_result'?'下载发布成果':kind==='authored_question'?'下载题目包文本':kind==='score_report'?'下载评分报告':kind==='model_answer'?'下载模型答案':kind==='redacted_markdown'?'下载脱敏文本':'下载页码索引';}
async function publish(){try{submitting.value=true;error.value='';await api(`/workflows/${route.params.id}/publish`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'成果发布失败';}finally{submitting.value=false;}}
watch(()=>route.params.id,()=>{docxArchivePath.value='';});
async function exportDocx(){try{exportingDocx.value=true;error.value='';docxArchivePath.value='';const result=await api<{archive_path:string}>(`/workflows/${route.params.id}/redacted-docx`,{method:'POST'});docxArchivePath.value=`assets/out/${result.archive_path}`;await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'生成脱敏 DOCX 失败';}finally{exportingDocx.value=false;}}
</script>
<template><Column :gap="24">
 <RouterLink v-if="data" :to="`/projects/${data.project.id}`" class="link-text text-sm">← {{ data.project.name }}</RouterLink>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <p v-if="loading && !data" class="text-muted">正在读取工作流…</p>
 <template v-if="data">
  <Row x="between" wrap :gap="16"><Column :gap="8"><Row wrap :gap="8"><h1 class="text-3xl font-bold text-ink-heading break-words">{{ data.workflow.title }}</h1><v-chip color="secondary">{{ currentStep ? `${currentStep.display_position ?? currentStep.position ?? currentStep.ordinal} · ${currentStep.name} · ${currentStepLabel}` : '全部完成' }}</v-chip></Row><p class="text-sm text-muted">创建于 {{ dateLabel(data.workflow.created_at) }} · {{ data.materials.length }} 份材料 · 状态以最近一次刷新为准</p></Column><Row wrap :gap="8"><v-btn color="error" variant="text" :disabled="submitting || activeTask" @click="clearOpen=true">重置整条工作流</v-btn><v-btn color="secondary" :loading="loading" :disabled="loading" @click="refresh"><template #prepend><UiIcon name="refresh" /></template>刷新状态</v-btn></Row></Row>
  <v-alert type="info">原件保留在本机。PDF由第一步调用 MinerU 云端解析并入库，DOCX/TXT/MD本地解析入库；第二步读取数据库原文并脱敏。请核对脱敏产物与识别异常。</v-alert>
  <section v-if="stepStatus(9)==='succeeded'" class="surface-card p-16"><Column :gap="12"><h2 class="section-title">可选脱敏材料 DOCX</h2><p class="text-sm text-muted">流程完成并归档后可手动生成，供后续自行上传。每个附件分别生成一份 DOCX。导出使用当前脱敏结果，不会新增或重跑工作流步骤；原件副本与 DOCX 保存在仓库的 <code>assets/out/附件库/</code> 下。<template v-if="!canExportDocx">当前还需完成：{{ currentStep?.name ?? '归档达标题目' }}。</template></p><p v-if="docxArchivePath" class="text-xs text-muted break-all">本题附件目录：{{ docxArchivePath }}</p><Row wrap :gap="8"><v-btn color="primary" variant="flat" :loading="exportingDocx" :disabled="exportingDocx||!canExportDocx" @click="exportDocx">生成脱敏 DOCX</v-btn><v-btn v-for="artifact in currentDocxArtifacts" :key="artifact.id" :href="`/api/artifacts/${artifact.id}/download`" color="secondary" variant="text">下载 {{ artifact.filename ?? '脱敏材料.docx' }}</v-btn></Row></Column></section>
  <Row stack-on-mobile y="start" :gap="16">
   <StepTimeline :steps="visibleSteps" class="w-full lg:w-650px lg:flex-none">
    <template #actions="{step}">
     <v-btn v-if="step.ordinal===1 && stepStatus(1)!=='succeeded'" color="primary" variant="flat" :loading="submitting" :disabled="submitting || data?.attempts.some(a=>[1,2].includes(a.ordinal) && ['waiting','running'].includes(a.status))" @click="intake">入库</v-btn>
     <v-btn v-if="step.ordinal===9" color="primary" variant="flat" :loading="submitting" :disabled="submitting || stepStatus(1)!=='succeeded' || stepStatus(9)==='succeeded' || data?.attempts.some(a=>a.ordinal===9 && ['waiting','running'].includes(a.status))" @click="redact">脱敏</v-btn>
        <Row v-if="step.ordinal===4 && step.status==='succeeded' && step.result" >
      <v-btn color="secondary" variant="outlined" @click="questionOpen=true">查看完整题目</v-btn>
     </Row>
  <v-btn v-if="step.ordinal===4" color="primary" variant="flat" :loading="submitting" :disabled="authorDisabled" @click="author">{{ hasSucceededAuthoring ? '重新生成题目' : '生成题目' }}</v-btn>
     <v-btn v-if="step.ordinal===5" color="primary" variant="flat" :loading="submitting" :disabled="answerDisabled" @click="answer">模型作答</v-btn>
     <v-btn v-if="step.ordinal===6" color="primary" variant="flat" :loading="submitting" :disabled="scoreDisabled" @click="score">独立评分</v-btn>
     <span v-if="step.ordinal===7 && !step.result" class="text-xs text-muted">独立评分完成后自动判定</span>
     <v-btn v-if="step.ordinal===8" color="primary" variant="flat" :loading="submitting" :disabled="publishDisabled" @click="publish">归档题目</v-btn>
    </template>
    <template #artifacts="{step}">

     <Row v-if="![4,5,6,9].includes(step.ordinal) && artifactsForStep(step).length" wrap :gap="8" class="mt-8">
      <v-btn v-for="artifact in artifactsForStep(step)" :key="artifact.id" :href="`/api/artifacts/${artifact.id}/download`" color="secondary" variant="tonal">{{artifactLabel(artifact.kind)}} · {{dateLabel(artifact.created_at)}}{{artifact.question_version ? ` · 题目版本 ${artifact.question_version}` : ''}}</v-btn>
     </Row>
    </template>
   </StepTimeline>
   <Column class="w-full lg:w-auto min-w-0 lg:flex-1" :gap="16">
    <Column v-if="!data.materials.length && data.workflow.source_manifest?.length" class="surface-panel p-16" :gap="8"><p class="text-xs text-muted">待入库目录材料：</p><span v-for="source in data.workflow.source_manifest" :key="source.name" class="text-xs text-muted break-all">{{ source.name }} · {{ fileSize(source.size) }}</span></Column>
    <MaterialRecordsTable :workflow-id="data.workflow.id" :materials="data.materials" :steps="visibleSteps" :redaction-status="stepStatus(9)" :redaction-queued="data.attempts.some(attempt=>attempt.ordinal===9 && attempt.status==='waiting')" :disabled="submitting" prefer-redacted @add="addMaterial" @delete="deleting=$event" />
    <ModelEvaluationSummary :steps="visibleSteps" :attempts="data.attempts" />
    <section class="surface-card  p-16 min-w-0"><Column :gap="12"><Row x="between"><h2 class="section-title">最近执行状态</h2><span class="text-sm text-muted">{{ visibleAttempts.length }} 次</span></Row>
     <Column class="w-full overflow-x-auto">
      <v-table density="compact" class="min-w-0 h-400">
       <thead><tr><th scope="col">步骤</th><th scope="col">状态</th><th scope="col">执行时间</th><th scope="col">失败原因及诊断</th></tr></thead>
       <tbody>
        <template v-for="attempt in sortedAttempts" :key="attempt.id">
         <tr>
          <td class="text-sm">{{ attemptNames[attempt.ordinal] ?? `步骤 ${attempt.ordinal}` }}</td>
          <td class="whitespace-nowrap"><v-chip size="small" :color="attemptStatusColor(attempt)">{{ attemptStatusLabel(attempt) }}</v-chip></td>
          <td class="whitespace-nowrap text-xs">{{ dateLabel(attempt.started_at) }}</td>
          <td class="text-xs text-danger">{{ attempt.error || '—' }}<div v-if="answerDiagnostic(attempt)" class="text-muted">{{ answerDiagnostic(attempt) }}</div></td>
         </tr>
        </template>
        <tr v-if="!data.attempts.length"><td colspan="4" class="text-sm text-muted py-12">暂无执行记录</td></tr>
       </tbody>
      </v-table>
     </Column>
    </Column></section>
   </Column>
  </Row>
  <v-dialog v-model="clearOpen" max-width="560"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">重置整条工作流</h2><p class="text-sm text-muted">删除本题从入库到发布的处理数据：材料记录、提取与脱敏文本、规则绑定、全部步骤结果和执行历史，以及本机管理目录中的附件副本、产物和提取缓存。只含本题的导出也会删除；包含其他题目的导出会标记为过期，以免影响其他题目。项目题目目录中的原始文件和本题来源清单会保留，可重新入库；单独上传的材料需重新上传。运行中的任务未结束时不能重置。</p><Row x="end" :gap="8"><v-btn :disabled="submitting" @click="clearOpen=false">取消</v-btn><v-btn color="error" :loading="submitting" @click="clearGenerated">确认重置</v-btn></Row></Column></v-dialog>
  <v-dialog v-model="questionOpen" max-width="1100" scrollable>
   <v-card v-if="authoredStep" class="surface-card">
    <v-card-title><Row x="between" y="center" :gap="12"><h2 class="section-title">完整题目</h2><v-btn icon="$close" aria-label="关闭完整题目" variant="text" @click="questionOpen=false" /></Row></v-card-title>
    <v-card-text>
     <Column :gap="24">
      <section v-for="section in questionSections(authoredStep)" :key="section.title">
       <h3 class="text-base font-semibold text-ink-heading mb-8">{{ section.title }}</h3>
       <p class="text-sm whitespace-pre-wrap break-words">{{ section.content }}</p>
      </section>
     </Column>
    </v-card-text>
    <v-card-actions><v-spacer /><v-btn color="secondary" @click="questionOpen=false">关闭</v-btn></v-card-actions>
   </v-card>
  </v-dialog>
  <v-dialog v-model="materialOpen" max-width="520"><MaterialEditor v-if="materialOpen" :workflow-id="data.workflow.id" @saved="refresh" @close="materialOpen=false" /></v-dialog>
  <v-dialog :model-value="deleting!==null" max-width="460" @update:model-value="deleting=null"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">移除附件</h2><p class="text-sm text-muted break-all">{{ deleting?.original_name }} 将从这道题移除，历史记录和本机原件保留。移除后第一步会回到“入库”待执行；点击“入库”会重新读取题目目录，DOCX/TXT/MD 本地解析，PDF 提取文本，混合格式会分别处理。</p><Row x="end" :gap="8"><v-btn :disabled="submitting" @click="deleting=null">取消</v-btn><v-btn color="error" :loading="submitting" @click="removeMaterial">确认移除</v-btn></Row></Column></v-dialog>
 </template>
</Column></template>
