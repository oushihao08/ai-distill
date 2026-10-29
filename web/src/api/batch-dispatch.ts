/** 职责：项目页与筛选列表共用的小批次派发，逐批返回回执，避免全部题目共用一个HTTP截止。
 * 入口：dispatchWorkflowBatch；失败停止后续提交，保留已收到的结果，不自动重试未知写入。
 */
import {api} from './client';
import type {BatchStepResult} from '../utils/workflow-status';
export async function dispatchWorkflowBatch(projectId:string,ordinal:number,workflowIds:string[],progress:(results:BatchStepResult[],total:number)=>void){
 const ids=[...new Set(workflowIds)],results:BatchStepResult[]=[];
 for(let offset=0;offset<ids.length;offset+=2){
  try{
   const receipt=await api<{results:BatchStepResult[]}>(`/projects/${projectId}/steps/${ordinal}/run-batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow_ids:ids.slice(offset,offset+2)})});
   results.push(...receipt.results);progress([...results],ids.length);
  }catch(cause){
   throw new Error(`已收到 ${results.length}/${ids.length} 道题的派发回执；本批提交中断，后续未提交。${cause instanceof Error?cause.message:'请刷新任务状态核实'}${results.length?` 已收到任务ID：${results.flatMap(item=>item.attempt_ids??(item.attempt_id?[item.attempt_id]:[])).join('、')}`:''}`);
  }
 }
 return {results};
}
