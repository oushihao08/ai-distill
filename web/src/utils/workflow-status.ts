/**
 * 职责：将服务端步骤状态、就绪判断及可选的尝试明细转换为工作台表格状态文字。
 * 公开入口：workflowStepDisplay() 供项目材料包表、题目表和材料包详情复用；列表可用步骤活动标记显示排队，不根据历史 waiting 尝试推断排队。
 */
import type {Attempt,Step} from '../types/api';
import type {AcceptanceResult} from '@shared/workflow-results';

export interface BatchStepResult {workflow_id:string;status:string;reused?:boolean;attempt_id?:string;attempt_ids?:string[];reason?:string;decision?:AcceptanceResult['decision'];reasons?:string[]}

/** 执行成功与业务达标分开显示；旧 API 不返回结论时不推测达标。 */
export function acceptanceBatchSummary(items:BatchStepResult[]):string{
 const count=(decision:AcceptanceResult['decision'])=>items.filter(item=>item.status==='succeeded'&&item.decision===decision).length;
 const unknown=items.filter(item=>item.status==='succeeded'&&!item.decision).length;
 return `达标 ${count('accepted')}，未达标 ${count('repair')}，等待判定 ${count('waiting')}，需核查 ${count('quarantine')}${unknown?`，已执行但未返回结论 ${unknown}（请刷新查看题目详情）`:''}`;
}

export function acceptanceReasonLabel(reason:string):string{
 const [code,...detail]=reason.split(':');
 const labels:Record<string,string>={
  minimum_score_missing:'未配置模型达标分数上限，请配置本期达标规则',
  acceptance_config_missing_or_invalid:'达标规则缺失或无效，请检查本期配置',
  acceptance_aggregation_invalid:'均分达标规则无效，请检查本期配置',
  required_model_count_mismatch:'当前模型数量与达标规则不一致',
  required_model_missing:'缺少必需模型的结果',required_model_unscored:'必需模型尚未评分',
  required_model_incomplete:'必需模型尚未完成',required_model_score_incomplete:'必需模型的评分尚未完成',
  score_missing_or_invalid:'缺少可比较的有效分数',score_source_binding_mismatch:'评分与当前题目或答案版本不匹配',
  question_or_material_version_stale:'题目或材料版本已变化',duplicate_or_invalid_model_result:'模型结果重复或无效',
  at_or_above_model_threshold:'模型得分未低于达标上限',model_mean_above_threshold:'模型均分超过达标上限',
 };
 return labels[code!] ? `${labels[code!]}${detail.length?`（${detail.join(':')}）`:''}` : reason;
}

export function batchStepIssue(item:BatchStepResult):string|null{
 if(['failed','not_found','not_ready','capacity_exceeded'].includes(item.status))return item.reason??'未执行，请查看任务记录';
 if(item.decision==='waiting'||item.decision==='quarantine')return item.reasons?.map(acceptanceReasonLabel).join('；')||'尚未得到达标结论，请查看题目详情';
 return null;
}

export interface WorkflowStatusView {steps:Step[];attempts?:Attempt[]}
export interface StepDisplay{label:string;color:string;reason:string;finishedAt:string|null}

export function workflowStepDisplay(view:WorkflowStatusView|undefined,ordinal:number):StepDisplay{
 if(!view)return{label:'读取中',color:'secondary',reason:'正在读取步骤状态',finishedAt:null};
 const step=view.steps.find(item=>item.ordinal===ordinal);
 if(!step)return{label:'未进入',color:'secondary',reason:'本工作流没有此步骤',finishedAt:null};
 const executions=step.executions;
 if(executions&&executions.length===0&&step.status==='running')return{label:'共享状态待核实',color:'warning',reason:'没有对应的活动尝试；本机不按共享running记录宣称正在执行',finishedAt:step.finished_at};
 if(executions?.length){
  const local=executions.filter(task=>task.scope==='local');
  const running=local.filter(task=>task.state==='running'&&task.active).length,queued=local.filter(task=>task.state==='queued'&&task.active).length;
  const other=executions.filter(task=>task.scope==='other_executor').length;
  const label=running||queued?[running?`本机执行中 ${running}`:'',queued?`排队 ${queued}`:'',other?`其他执行端 ${other}`:''].filter(Boolean).join(' · '):executions.map(task=>task.label).filter((label,index,all)=>all.indexOf(label)===index).join('；');
  return{label,color:running?'primary':queued||other?'secondary':'warning',reason:executions.map(task=>task.label).join('；'),finishedAt:step.finished_at};
 }
 const attempts=view.attempts?.filter(item=>item.ordinal===ordinal||(ordinal===1&&item.ordinal===2))??[];
 const active=attempts.find(item=>item.status==='running')??attempts.find(item=>item.status==='waiting');
 if(active?.status==='running'||step.status==='running')return{label:'执行中',color:'primary',reason:'任务正在执行',finishedAt:step.finished_at};
 if(active?.status==='waiting'||(!view.attempts&&step.active&&step.status==='waiting'))return{label:'排队',color:'primary',reason:'任务已提交，等待领取',finishedAt:step.finished_at};
 if(step.status==='failed')return{label:'失败',color:'error',reason:step.error??'请查看执行记录',finishedAt:step.finished_at};
 if(step.status==='skipped')return{label:'跳过',color:'secondary',reason:step.error??'',finishedAt:step.finished_at};
 if(ordinal===7&&step.result?.decision){
  const decision=String(step.result?.decision??'');
  const labels:Record<string,{label:string;color:string}>={accepted:{label:'达标',color:'success'},repair:{label:'未达标',color:'warning'},waiting:{label:'等待判定',color:'secondary'},quarantine:{label:'隔离',color:'error'}};
  const reasons=step.result.reasons;
  const reason=step.error??(Array.isArray(reasons)?reasons.filter((item):item is string=>typeof item==='string').map(acceptanceReasonLabel).join('；'):'');
  if(labels[decision])return{...labels[decision],reason,finishedAt:step.finished_at};
 }
 if(step.status==='succeeded')return{label:'成功',color:'success',reason:'',finishedAt:step.finished_at};
 return step.ready?{label:'就绪',color:'primary',reason:'可执行',finishedAt:step.finished_at}:{label:'等待',color:'secondary',reason:step.ready_reason??'等待前置步骤',finishedAt:step.finished_at};
}
