<!--
职责：作为材料包或题目工作流路由，按身份编排步骤操作、材料包建题、附件、模型评测与产物下载。
关键方法与用法：`intake()`、`redact()`、`author()`、`answer()` 等方法派发对应阶段，`addMaterial()`／`removeMaterial()` 管理附件，`clearGenerated()` 重置生成状态；路由参数 `id` 指定题目工作流。
-->

<script setup lang="ts">
import {usePageBreadcrumbs} from '../composables/usePageBreadcrumbs';
import { api } from '../api/client';
import { useResource } from '../composables/useResource';
import {workflowStepDisplay} from '../utils/workflow-status';
import { dateLabel, fileSize } from '../utils/format';
import { readAnswerStepResult, statusLabels, type Attempt, type WorkflowDetail, type Step, type RedactionProgress } from '../types/api';
import RevisionAdvice from '../components/RevisionAdvice.vue';
import WorkflowHookRecords from '../components/WorkflowHookRecords.vue';
import ModelEvaluationSummary from '../components/ModelEvaluationSummary.vue';
import MaterialRecordsTable from '../components/MaterialRecordsTable.vue';
import MaterialPackageQuestionForm from '../components/MaterialPackageQuestionForm.vue';
import MaterialPackageQuestions from '../components/MaterialPackageQuestions.vue';
const route = useRoute();const router=useRouter();
const { data, error, loading, refresh } = useResource<WorkflowDetail>(`/workflows/${route.params.id}`);
usePageBreadcrumbs(()=>{const project=data.value?.project;return [{title:'出题项目',to:'/'},...(project?.project_group_id?[{title:project.parent_name||'主项目',to:`/project-groups/${project.project_group_id}`}]:[]),...(project?[{title:project.phase_name||project.name,to:`/projects/${project.id}`}]:[]),{title:data.value?.workflow.title||'题目详情'}];});
const submitting=shallowRef(false);
const exportingDocx=shallowRef(false);
const docxArchivePath=shallowRef('');
const clearOpen=shallowRef(false);
const withdrawArchiveOpen=shallowRef(false);
const questionOpen=shallowRef(false);
const directionOpen=shallowRef(false);
const directionDraft=shallowRef('');
const scenarioDraft=shallowRef('');
const roleDraft=shallowRef('');
const archiveTaskId=shallowRef('');
const archiveOrg=shallowRef('');
const directionSaving=shallowRef(false);
const designChanged=computed(()=>directionDraft.value.trim()!==(data.value?.workflow.authoring_direction??'')||scenarioDraft.value.trim()!==(data.value?.workflow.scenario??'')||roleDraft.value.trim()!==(data.value?.workflow.role_perspective??''));
function editDirection(){directionDraft.value=data.value?.workflow.authoring_direction??'';scenarioDraft.value=data.value?.workflow.scenario??'';roleDraft.value=data.value?.workflow.role_perspective??'';directionOpen.value=true;}
async function saveDirection(){
 try{
  directionSaving.value=true;error.value='';
  await api(`/workflows/${route.params.id}/authoring-direction`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({authoring_direction:directionDraft.value,scenario:scenarioDraft.value,role_perspective:roleDraft.value})});
  directionOpen.value=false;await refresh();
 }catch(cause){error.value=cause instanceof Error?cause.message:'保存出题设置失败';}
 finally{directionSaving.value=false;}
}
const materialPackage=computed(()=>data.value?.workflow.workflow_kind==='material_package');
const derivedQuestion=computed(()=>Boolean(data.value?.workflow.source_workflow_id));
const libraryQuestion=computed(()=>data.value?.question_material_origin?.kind==='library_v1');
const questionMaterialMode=computed(()=>data.value?.question_material_origin?.kind==='library_v1'?data.value.question_material_origin.material_mode:'redacted');
const questionMaterialModeLabel=computed(()=>questionMaterialMode.value==='original'?'原文':'脱敏');
const visibleSteps=computed(()=>data.value?.steps.filter(step=>step.ordinal!==10&&(materialPackage.value?[1,9].includes(step.ordinal):derivedQuestion.value?![1,2,9].includes(step.ordinal):true))??[]);
const authoredStep=computed(()=>visibleSteps.value.find(step=>step.ordinal===4));
const activeTask=computed(()=>data.value?.attempts.some(a=>a.ordinal!==10&&['waiting','running'].includes(a.status)));
const revisionDisabledReason=computed(()=>{
 const steps=data.value?.steps??[];
 if(steps.find(step=>step.ordinal===7)?.result?.decision==='accepted')return '当前题目已达标，无需生成返修建议。';
 if(steps.some(step=>[4,5,6].includes(step.ordinal)&&step.active))return '出题、作答或评分已有活动任务，结束后可生成返修建议。';
 if(steps.find(step=>step.ordinal===4)?.status!=='succeeded')return '请先完成出题。';
 const answers=steps.find(step=>step.ordinal===5)?.result?.models,scores=steps.find(step=>step.ordinal===6)?.result?.models;
 if(!Array.isArray(answers)||!Array.isArray(scores)||!scores.length)return '请先取得当前作答和评分记录。';
 return '';
});
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
 return workflowStepDisplay(data.value??undefined,step.ordinal).label;
});

function redactionProgressLabel(step:Step){
 const progress=step.result?.progress as Partial<RedactionProgress>|undefined;
 if(!progress||typeof progress.completed_fields!=='number'||typeof progress.total_fields!=='number')return '';
 const phases:Record<string,string>={planning:'计算批次',requesting:'处理中',saving:'保存进度',completed:'已完成',failed:'已停止'};
 const last=typeof progress.last_progress_at==='string'?dateLabel(progress.last_progress_at):'未知';
 return `${phases[progress.phase??'']??'处理中'} · 已完成 ${progress.completed_fields}/${progress.total_fields} 个字段 · 请求中 ${progress.active_requests??0} · 补做 ${progress.retry_count??0} 次 · 最近进度 ${last}`;
}
const stepStatus=(ordinal:number)=>visibleSteps.value.find(step=>step.ordinal===ordinal)?.status;
const canExportDocx=computed(()=>Boolean(data.value&&(libraryQuestion.value||data.value.steps.some(step=>step.ordinal===9&&step.status==='succeeded'))));
const currentRedactionAttempt=computed(()=>data.value?.attempts.filter(attempt=>attempt.ordinal===9).at(-1));
const currentDocxArtifacts=computed(()=>{if(!canExportDocx.value)return [];if(libraryQuestion.value)return data.value?.artifacts.filter(artifact=>artifact.filename===`${questionMaterialModeLabel.value}材料.docx`&&artifact.kind===(questionMaterialMode.value==='original'?'original_docx':'redacted_docx')&&artifact.attempt_id===null)??[];const attempt=currentRedactionAttempt.value;if(!attempt||attempt.status!=='succeeded')return [];return data.value?.artifacts.filter(artifact=>artifact.filename==='脱敏材料.docx'&&artifact.kind==='redacted_docx'&&artifact.attempt_id===attempt.id)??[];});
const feishuReceipt=computed(()=>data.value?.steps.find(step=>step.ordinal===8)?.result?.feishu_sync as {status?:string;reason_code?:string;url?:string;verification?:{status?:string;checked_at?:string;fields?:string[];differences?:{field:string}[]}}|undefined);
const feishuIssues=computed(()=>[...new Set([...(feishuReceipt.value?.verification?.fields??[]),...(feishuReceipt.value?.verification?.differences??[]).map(item=>item.field)])].join('、'));
const archived=computed(()=>stepStatus(8)==='succeeded');
const answerDisabled=computed(()=>archived.value || submitting.value || stepStatus(4)!=='succeeded' || data.value?.attempts.some(attempt=>attempt.ordinal===5 && ['waiting','running'].includes(attempt.status)));
const authorDisabled=computed(()=>archived.value || submitting.value || (!derivedQuestion.value&&!libraryQuestion.value&&data.value?.steps.find(step=>step.ordinal===9)?.status!=='succeeded') || data.value?.attempts.some(attempt=>attempt.ordinal===4 && ['waiting','running'].includes(attempt.status)));
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
const scoreDisabled=computed(()=>archived.value || submitting.value || !answerReadyForScoring.value || data.value?.attempts.some(attempt=>attempt.ordinal===6 && ['waiting','running'].includes(attempt.status)));
async function score(){try{submitting.value=true;await api(`/workflows/${route.params.id}/score`,{method:'POST'});await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'评分提交失败';}finally{submitting.value=false;}}
const acceptanceDecision=computed(()=>visibleSteps.value.find(step=>step.ordinal===7)?.result?.decision);
const publishDisabled=computed(()=>archived.value || submitting.value || activeTask.value || stepStatus(7)!=='succeeded' || acceptanceDecision.value!=='accepted');
const isWorkProject=computed(()=>data.value?.project.parent_name==='Work法律全场景');
const archiveIdentityValid=computed(()=>(!archiveTaskId.value.trim()&&!archiveOrg.value.trim())||(/^LAW-\d{3,}$/.test(archiveTaskId.value.trim())&&/^[a-z0-9][a-z0-9-]{1,31}$/.test(archiveOrg.value.trim())));
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
 const rubric=Array.isArray(result.rubric)?result.rubric.map((item:Record<string,unknown>)=>{const m=item.metadata as Record<string,unknown>|undefined;return `${text(item.id)}（${m?.priority==='Veto'?'独立否决':`${typeof m?.score==='number'?m.score:typeof item.max_score==='number'?item.max_score:'—'}分`}）\n${text(m?.statement??item.criterion)}${item.rule?`\n${text(item.rule)}`:''}${m?`\n${JSON.stringify(m,null,2)}`:''}`;}).join('\n\n'):'';
 const workSections=result.content_contract==='work_legal_v1'?['task_metadata','input_files','deliverables','reference_outputs','research_records','task_requirements','content_status'].map((key,index)=>({title:['整题信息与等级依据','输入材料清单','成果清单','逐份完整标准成果','作者检索记录','任务能力要求','内容完成状态'][index]!,content:JSON.stringify(result[key],null,2)??'尚未保存'})):[];
 return [{title:'表头',content:headerText},{title:'任务名称',content:text(result.task_name)},{title:'任务类型',content:text(result.task_type)},{title:'题面 prompt',content:text(result.question)},{title:'考点 rubric',content:rubric||'尚未保存'},{title:'作答思路',content:text(result.answer_approach)},{title:'标准答案',content:text(result.reference_answer)},...workSections];
}
function artifactLabel(kind:string){return kind==='published_result'?'下载发布成果':kind==='authored_question'?'下载题目包文本':kind==='score_report'?'下载评分报告':kind==='model_answer'?'下载模型答案':kind==='redacted_markdown'?'下载脱敏文本':'下载页码索引';}
function deliveryLabel(step:Step){const value=step.result?.delivery;return value&&typeof value==='object'&&'mode'in value&&value.mode==='noop'?'项目交付空函数已执行':'项目交付脚本已执行';}
async function publish(){try{submitting.value=true;error.value='';const result=await api<{docx_archive_path?:string}>(`/workflows/${route.params.id}/publish`,{method:'POST',...(isWorkProject.value&&(archiveTaskId.value.trim()||archiveOrg.value.trim())?{headers:{'Content-Type':'application/json'},body:JSON.stringify({delivery_identity:{task_id:archiveTaskId.value.trim(),org:archiveOrg.value.trim()}})}:{})});if(result.docx_archive_path)docxArchivePath.value=`assets/out/${result.docx_archive_path}`;await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'归档或 DOCX 生成失败';}finally{submitting.value=false;}}
async function withdrawArchive(){try{submitting.value=true;error.value='';await api(`/workflows/${route.params.id}/withdraw-archive`,{method:'POST'});withdrawArchiveOpen.value=false;await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:'撤回归档失败';}finally{submitting.value=false;}}
watch(()=>route.params.id,()=>{docxArchivePath.value='';directionOpen.value=false;});
async function exportDocx(){try{exportingDocx.value=true;error.value='';docxArchivePath.value='';const endpoint=libraryQuestion.value?'material-docx':'redacted-docx';const result=await api<{archive_path:string}>(`/workflows/${route.params.id}/${endpoint}`,{method:'POST'});docxArchivePath.value=`assets/out/${result.archive_path}`;await refresh();}catch(cause){error.value=cause instanceof Error?cause.message:`生成${questionMaterialModeLabel.value} DOCX 失败`;}finally{exportingDocx.value=false;}}
</script>
<template><Column :gap="24">
 <RouterLink v-if="data" :to="`/projects/${data.project.id}`" class="link-text text-sm">← {{ data.project.name }}</RouterLink>
 <v-alert v-if="error" type="error" role="alert">{{ error }}</v-alert>
 <v-btn v-if="error&&!data" color="primary" :loading="loading" :disabled="loading" @click="refresh">重新读取</v-btn>
 <p v-if="loading && !data" class="text-muted">正在读取工作流…</p>
 <template v-if="data">
  <Row x="between" wrap :gap="16"><Column :gap="8"><Row wrap :gap="8"><h1 class="text-3xl font-bold text-ink-heading break-words">{{ data.workflow.title }}</h1><v-chip color="secondary">{{ materialPackage?'材料包':derivedQuestion?'派生题目':'题目' }}</v-chip><v-chip color="secondary">{{ currentStep ? `${currentStep.name} · ${currentStepLabel}` : materialPackage?'材料已处理':'全部完成' }}</v-chip></Row><p class="text-sm text-muted">创建于 {{ dateLabel(data.workflow.created_at) }} · {{ data.materials.length }} 份材料 · 状态以最近一次刷新为准</p></Column><Row wrap :gap="8"><RevisionAdvice v-if="!materialPackage" :workflow-id="data.workflow.id" variant="outlined" :disabled="!!revisionDisabledReason" :disabled-reason="revisionDisabledReason" /><v-btn v-if="!derivedQuestion" color="error" variant="text" :disabled="archived || submitting || activeTask" @click="clearOpen=true">重置整条工作流</v-btn><v-btn color="secondary" :loading="loading" :disabled="loading" @click="refresh"><template #prepend><UiIcon name="refresh" /></template>刷新状态</v-btn></Row></Row>
  <v-alert v-if="feishuReceipt" :type="feishuReceipt.verification?.status==='passed'?'success':feishuReceipt.verification?.status==='failed'?'error':'warning'">
   {{ feishuReceipt.verification?.status==='passed'?'飞书核对通过':feishuReceipt.verification?.status==='failed'?'飞书核对失败':'飞书核对未完成' }}
   <span v-if="feishuIssues"> · 差异项：{{ feishuIssues }}</span>
   <span v-if="feishuReceipt.reason_code"> · 原因：{{ feishuReceipt.reason_code }}</span>
   <span v-if="feishuReceipt.verification?.checked_at"> · {{ dateLabel(feishuReceipt.verification.checked_at) }}</span>
   <a v-if="feishuReceipt.url" :href="feishuReceipt.url" target="_blank" rel="noopener noreferrer">查看飞书记录</a>
  </v-alert>
  <v-alert type="info">{{ materialPackage?'本材料包只执行入库、结构化提取和可选脱敏；成功后可按期次设置选择原文或脱敏版本创建题目。已创建题目的快照不随材料包变化。':derivedQuestion?`本题使用创建时冻结的材料包${questionMaterialModeLabel}快照。出题、作答、评分与交付均按此来源模式读取；更新材料请返回材料包后新建题目。`:'原件保留在本机。PDF/DOCX入库时结构化提取，TXT/MD本地解析；然后按附件脱敏方式处理。请核对提取与脱敏产物。' }}</v-alert>
  <p v-if="derivedQuestion" class="text-sm text-muted">来源材料包：<RouterLink :to="`/workflows/${data.workflow.source_workflow_id}`" class="link-text">{{ data.source_material_package?.title??'查看材料包' }}</RouterLink> · 冻结来源：{{ questionMaterialModeLabel }}材料{{ data.question_material_origin?.kind==='library_v1'?` · 版本 ${data.question_material_origin.revision_id} · 摘要 ${data.question_material_origin.snapshot_digest.slice(0,16)}`:` · 脱敏尝试 ${data.workflow.source_redaction_attempt_id??'无'}` }} · 下方附件为本题冻结快照</p>
  <LegacyMaterialOrigin :key="data.workflow.id" :workflow-id="data.workflow.id" />
  <section v-if="data.publication_history?.length" class="surface-card p-16"><Column :gap="12"><h2 class="section-title">归档记录与材料来源</h2><div v-for="event in data.publication_history" :key="event.id" class="border border-surface-border rounded-md p-12"><p class="font-semibold">{{ event.event_type==='archived'?'已归档':'已撤回' }} · {{ event.provenance.project_name??event.project_name }} · {{ event.provenance.workflow_title??event.workflow_title }} · {{ dateLabel(event.created_at) }}</p><p v-if="event.provenance.material_origin.kind==='library_v1'" class="text-sm text-muted break-all">标准材料包 {{ event.provenance.standard_material_package_name??event.provenance.material_origin.package_id }} · 包 ID {{ event.provenance.material_origin.package_id }} · 版本 {{ event.provenance.material_origin.revision_id }} · {{ event.provenance.material_origin.material_mode==='original'?'原文提取':'脱敏' }} · 冻结摘要 {{ event.provenance.material_origin.snapshot_digest }}</p><p v-else class="text-sm text-muted break-all">旧流程脱敏尝试 {{ event.provenance.material_origin.redaction_attempt_id }}</p><p v-for="file in event.provenance.source_files??[]" :key="file.file_id" class="text-xs text-muted break-all">标准材料：{{ file.original_name }} · 文件 {{ file.file_id }} · 原件摘要 {{ file.sha256 }}</p><p class="text-xs text-muted">题目附件摘要：{{ event.provenance.materials.map(item=>`${item.artifact_id}:${item.sha256}`).join('、')||'无' }}</p></div></Column></section>
  <Row v-if="derivedQuestion&&(data.workflow.question_tags?.length||data.workflow.target_level)" wrap :gap="4"><span class="text-sm text-muted">出题标签：</span><v-chip v-for="tag in data.workflow.question_tags?.length?data.workflow.question_tags:[data.workflow.target_level!]" :key="tag" size="small">{{ tag }}</v-chip></Row>
  <MaterialPackageQuestionForm v-if="materialPackage" :package-id="data.workflow.id" :project-tags="data.project.question_tags??[]" @created="router.push(`/workflows/${$event}`)" />
  <MaterialPackageQuestions v-if="materialPackage&&data.material_package_questions" :project-id="data.project.id" :questions="data.material_package_questions" @refresh="refresh" />
  <p v-else-if="materialPackage" class="text-sm text-muted">题目列表暂不可用，请刷新工作流详情。</p>
  <section v-if="!materialPackage" class="surface-card p-16"><Column :gap="12"><Row x="between" y="center"><h2 class="section-title">本题出题设置（选填）</h2><v-btn v-if="!directionOpen" color="secondary" variant="text" :disabled="archived" @click="editDirection">修改</v-btn></Row>
   <template v-if="directionOpen"><Row stack-on-mobile :gap="8"><v-text-field v-model="roleDraft" label="出题角色／视角" :maxlength="180" :disabled="directionSaving" /><v-text-field v-model="scenarioDraft" label="出题场景" :maxlength="180" :disabled="directionSaving" /></Row><v-textarea v-model="directionDraft" label="出题方向" variant="outlined" rows="3" auto-grow :maxlength="4000" counter="4000" :disabled="directionSaving" hint="三个字段均可留空；保存后的设置会用于下一次出题和重新出题。" persistent-hint /><p v-if="designChanged" class="text-sm text-muted">保存修改后，本题已有题目、作答、评分和归档结果将失效；入库和脱敏结果保留。</p><Row x="end" :gap="8"><v-btn :disabled="directionSaving" @click="directionOpen=false">取消</v-btn><v-btn color="primary" :loading="directionSaving" :disabled="directionSaving||!designChanged" @click="saveDirection">保存设置</v-btn></Row></template>
   <template v-else><p class="text-sm whitespace-pre-wrap break-words">出题角色／视角：{{ data.workflow.role_perspective || '无' }}</p><p class="text-sm whitespace-pre-wrap break-words">出题场景：{{ data.workflow.scenario || '无' }}</p><p class="text-sm whitespace-pre-wrap break-words">出题方向：{{ data.workflow.authoring_direction || '无' }}</p></template>
  </Column></section>
  <section v-if="canExportDocx" class="surface-card p-16"><Column :gap="12"><h2 class="section-title">{{ questionMaterialModeLabel }}材料 DOCX</h2><p class="text-sm text-muted">有可用材料即可生成，无需等待出题、评分、达标或归档。全部冻结材料合并生成一份 DOCX，保留文书顺序和表格，写入 <code>assets/out/附件库/</code>。已生成且校验有效的文件会直接复用。</p><p v-if="docxArchivePath" class="text-xs text-muted break-all">本题附件目录：{{ docxArchivePath }}</p><Row wrap :gap="8"><v-btn color="primary" variant="flat" :loading="exportingDocx" :disabled="exportingDocx||!canExportDocx" @click="exportDocx">重新生成{{ questionMaterialModeLabel }} DOCX</v-btn><v-btn v-for="artifact in currentDocxArtifacts" :key="artifact.id" :href="`/api/artifacts/${artifact.id}/download`" color="secondary" variant="text">下载 {{ artifact.filename ?? `${questionMaterialModeLabel}材料.docx` }}</v-btn></Row></Column></section>
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
   <Column v-if="step.ordinal===8" :gap="8" class="w-full"><Row v-if="isWorkProject" stack-on-mobile :gap="8"><v-text-field v-model="archiveTaskId" label="Harbor task_id（选填）" placeholder="LAW-001" hint="生成Siriser五件套无需填写；仅额外转换Harbor时使用。" persistent-hint :disabled="submitting" /><v-text-field v-model="archiveOrg" label="Harbor org（选填）" placeholder="小写字母或数字" hint="与task_id成对填写；无值时留空。" persistent-hint :disabled="submitting" /></Row><Row wrap y="center" :gap="8"><v-btn color="primary" variant="flat" :loading="submitting" :disabled="publishDisabled||(isWorkProject&&!archiveIdentityValid)" @click="publish">{{ step.status==='succeeded' ? '已归档' : '归档题目并执行项目交付' }}</v-btn><v-btn v-if="step.status==='succeeded'" color="error" variant="outlined" :disabled="submitting" @click="withdrawArchiveOpen=true">撤回归档</v-btn><v-btn v-if="isWorkProject && step.status==='succeeded'" :href="`/api/workflows/${data.workflow.id}/siriser-zip`" color="primary" variant="outlined">下载五件套 ZIP</v-btn><v-btn v-if="step.status==='succeeded' && step.result?.archive_workbook" :href="`/api/workflows/${data.workflow.id}/archive-xlsx`" color="secondary" variant="outlined">下载本题归档 Excel</v-btn><span v-if="step.status==='succeeded' && step.result?.delivery" class="text-xs text-muted">{{ deliveryLabel(step) }}</span></Row></Column>
    </template>
    <template #artifacts="{step}">
     <p v-if="step.ordinal===9 && redactionProgressLabel(step)" class="text-xs text-muted break-all">{{ redactionProgressLabel(step) }}</p>

     <Row v-if="![4,5,6,9].includes(step.ordinal) && artifactsForStep(step).length" wrap :gap="8" class="mt-8">
      <v-btn v-for="artifact in artifactsForStep(step)" :key="artifact.id" :href="`/api/artifacts/${artifact.id}/download`" color="secondary" variant="tonal">{{artifactLabel(artifact.kind)}} · {{dateLabel(artifact.created_at)}}{{artifact.question_version ? ` · 题目版本 ${artifact.question_version}` : ''}}</v-btn>
     </Row>
    </template>
   </StepTimeline>
   <Column class="w-full lg:w-auto min-w-0 lg:flex-1" :gap="16">
    <Column v-if="!data.materials.length && data.workflow.source_manifest?.length" class="surface-panel p-16" :gap="8"><p class="text-xs text-muted">待入库目录材料：</p><span v-for="source in data.workflow.source_manifest" :key="source.name" class="text-xs text-muted break-all">{{ source.name }} · {{ fileSize(source.size) }}</span></Column>
    <MaterialRecordsTable :workflow-id="data.workflow.id" :materials="data.materials" :steps="data.steps" :redaction-status="data.steps.find(step=>step.ordinal===9)?.status" :redaction-queued="data.attempts.some(attempt=>attempt.ordinal===9 && attempt.status==='waiting')" :disabled="submitting||derivedQuestion" :prefer-redacted="questionMaterialMode==='redacted'" @add="addMaterial" @delete="deleting=$event" @updated="refresh" />
    <ModelEvaluationSummary v-if="!materialPackage" :steps="visibleSteps" :attempts="data.attempts" />
    <WorkflowHookRecords v-if="!materialPackage" :key="data.workflow.id" :workflow-id="data.workflow.id" @updated="refresh" />
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
  <v-dialog v-model="withdrawArchiveOpen" max-width="520"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">撤回当前归档</h2><p class="text-sm text-muted">撤回后本题不再显示为已归档，归档文件和归档历史会保留；需要时可以重新归档。</p><Row x="end" :gap="8"><v-btn :disabled="submitting" @click="withdrawArchiveOpen=false">取消</v-btn><v-btn color="error" :loading="submitting" @click="withdrawArchive">确认撤回</v-btn></Row></Column></v-dialog>
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
  <v-dialog :model-value="deleting!==null" max-width="460" @update:model-value="deleting=null"><Column class="surface-card p-20" :gap="16"><h2 class="section-title">移除附件</h2><p class="text-sm text-muted break-all">{{ deleting?.original_name }} 将从这道题移除，历史记录和本机原件保留。移除后第一步会回到“入库”待执行；点击“入库”会重新读取题目目录，DOCX 使用 MinerU 结构化提取，TXT/MD 本地解析，PDF 按原提取方式处理。</p><Row x="end" :gap="8"><v-btn :disabled="submitting" @click="deleting=null">取消</v-btn><v-btn color="error" :loading="submitting" @click="removeMaterial">确认移除</v-btn></Row></Column></v-dialog>
 </template>
</Column></template>
