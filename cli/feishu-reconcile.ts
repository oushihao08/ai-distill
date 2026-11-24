/** 职责：批次写响应异常后的只读对账；只接收当前业务API题目与指定目标，不创建/更新远端记录。 */
import {ApiClient} from './client';
import {feishuClient} from '../server/publishing/feishu-api';
import {findFeishuWorkflowRecords} from '../server/publishing/feishu-records';
import {feishuTextFields,compareFeishuText,hasFeishuAttachmentNames} from '../server/publishing/feishu-verification';
import type {FeishuCliTarget,FeishuCliAttachmentFormat} from './feishu';
export async function reconcileFeishuDraft(api:ApiClient,id:string,projectId:string,target:FeishuCliTarget,format:FeishuCliAttachmentFormat,signal?:AbortSignal){
 if(signal?.aborted)return null;
 const before=await api.json(`/api/workflows/${id}`,'GET',undefined,signal);
 const author=before.steps?.find((s:any)=>s.ordinal===4),archived=before.steps?.find((s:any)=>s.ordinal===8);
 if(before.workflow?.project_id!==projectId||author?.status!=='succeeded'||archived?.status==='succeeded')return null;
 const question=author.result;if(!question?.question_version||!question?.rubric_version)return null;
 const client=await feishuClient();
 try{
  const rows=await findFeishuWorkflowRecords(client,`/bitable/v1/apps/${target.base_token}/tables/${target.table_id}`,id);
  if(rows.length!==1)return null;
  const record=rows[0],fields=record.fields??{},files=fields['输入附件'];
  const differences=compareFeishuText(feishuTextFields(id,question,'未完成'),fields);
  const legacy=compareFeishuText(feishuTextFields(id,question,'未完成','legacy'),fields);
  if(differences.length&&legacy.length)return null;
  // 只自动接纳可确定命名的单个合册DOCX；其他模式保留未知，由原业务入口验收。
  if(format!=='docx'||!hasFeishuAttachmentNames(files,['材料.docx'])||!files[0]?.file_token)return null;
  const after=await api.json(`/api/workflows/${id}`,'GET',undefined,signal),current=after.steps?.find((s:any)=>s.ordinal===4);
  if(current?.status!=='succeeded'||JSON.stringify(current.result)!==JSON.stringify(question))return null;
  return {status:'succeeded',stage:'draft',base_token:target.base_token,table_id:target.table_id,record_id:record.record_id,attachment_format:format,reconciled:true,verification:{status:'passed',checked_at:new Date().toISOString(),question_version:question.question_version,rubric_version:question.rubric_version,method:'read_only_record_reconciliation',attachment_tokens:files.map((f:any)=>f.file_token)}};
 }finally{await client.close();}
}
