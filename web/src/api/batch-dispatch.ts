/** 职责：项目页与筛选列表共用的小批次派发，逐批返回回执，避免全部题目共用一个HTTP截止。
 * 入口：dispatchWorkflowBatch；失败停止后续提交，保留已收到的结果，不自动重试未知写入。
 */
import {api} from './client';
import type {BatchStepResult,WorkflowStatusView} from '../utils/workflow-status';
export async function dispatchWorkflowBatch(projectId:string,ordinal:number,workflowIds:string[],progress:(results:BatchStepResult[],total:number)=>void){
 const ids=[...new Set(workflowIds)],results:BatchStepResult[]=[];
 for(let offset=0;offset<ids.length;offset+=2){
  try{
   const batchIds=ids.slice(offset,offset+2);
   let dispatchIds=batchIds;
   if(ordinal===4){
    const views=await api<Record<string,WorkflowStatusView>>(`/projects/${projectId}/workflow-status?ids=${batchIds.join(',')}`);
    dispatchIds=[];
    for(const id of batchIds){
     const step=views[id]?.steps.find(item=>item.ordinal===4);
     if(!step)throw new Error(`无法核实题目 ${id} 的出题状态，已停止派发`);
     if(step.status==='succeeded')results.push({workflow_id:id,status:'not_ready',reason:'出题已成功，批量出题已跳过；如需重出，请使用单题“重新生成题目”'});
     else dispatchIds.push(id);
    }
   }
   if(!dispatchIds.length){progress([...results],ids.length);continue;}
   const receipt=await api<{results:BatchStepResult[]}>(`/projects/${projectId}/steps/${ordinal}/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow_ids:dispatchIds})});
   results.push(...receipt.results);progress([...results],ids.length);
  }catch(cause){
   const attemptIds=results.flatMap(item=>item.attempt_ids??(item.attempt_id?[item.attempt_id]:[]));
   throw new Error(`已收到 ${results.length}/${ids.length} 道题的派发回执；本批提交中断，后续未提交。本批待核实题目ID：${ids.slice(offset,offset+2).join('、')}。${cause instanceof Error?cause.message:'请刷新任务状态核实'}${attemptIds.length?` 已收到任务ID：${attemptIds.join('、')}`:''}`);
  }
 }
 return {results};
}
