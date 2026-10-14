/**
 * 职责：将服务端当前步骤、就绪判断与活动尝试转换为工作台表格的状态文字。
 * 公开入口：workflowStepDisplay() 供项目材料包表、题目表和材料包详情复用；不根据历史 waiting 尝试推断排队。
 */
import type {WorkflowDetail} from '../types/api';

export type WorkflowStatusView=Pick<WorkflowDetail,'steps'|'attempts'>;
export interface StepDisplay{label:string;color:string;reason:string;finishedAt:string|null}

export function workflowStepDisplay(view:WorkflowStatusView|undefined,ordinal:number):StepDisplay{
 if(!view)return{label:'读取中',color:'secondary',reason:'正在读取步骤状态',finishedAt:null};
 const step=view.steps.find(item=>item.ordinal===ordinal);
 if(!step)return{label:'未进入',color:'secondary',reason:'本工作流没有此步骤',finishedAt:null};
 const attempts=view.attempts.filter(item=>item.ordinal===ordinal||(ordinal===1&&item.ordinal===2));
 const active=attempts.find(item=>item.status==='running')??attempts.find(item=>item.status==='waiting');
 if(active?.status==='running'||step.status==='running')return{label:'执行中',color:'primary',reason:'任务正在执行',finishedAt:step.finished_at};
 if(active?.status==='waiting')return{label:'排队',color:'primary',reason:'任务已提交，等待领取',finishedAt:step.finished_at};
 if(step.status==='failed')return{label:'失败',color:'error',reason:step.error??'请查看执行记录',finishedAt:step.finished_at};
 if(step.status==='skipped')return{label:'跳过',color:'secondary',reason:step.error??'',finishedAt:step.finished_at};
 if(ordinal===7&&step.result?.decision){
  const decision=String(step.result?.decision??'');
  const labels:Record<string,{label:string;color:string}>={accepted:{label:'达标',color:'success'},repair:{label:'未达标',color:'warning'},waiting:{label:'等待判定',color:'secondary'},quarantine:{label:'隔离',color:'error'}};
  const reasons=step.result.reasons;
  const reason=step.error??(Array.isArray(reasons)?reasons.filter(item=>typeof item==='string').join('；'):'');
  if(labels[decision])return{...labels[decision],reason,finishedAt:step.finished_at};
 }
 if(step.status==='succeeded')return{label:'成功',color:'success',reason:'',finishedAt:step.finished_at};
 return step.ready?{label:'就绪',color:'primary',reason:'可执行',finishedAt:step.finished_at}:{label:'等待',color:'secondary',reason:step.ready_reason??'等待前置步骤',finishedAt:step.finished_at};
}
