/**
 * 职责：构造达标题目数据工作簿。
 * 关键方法与用途：`buildResultWorkbook()` 将每题的题面、可读考点、逐模型评分、答案思路和标答写入主表，附件名称与本机路径写入独立清单。
 * 使用场景：由 `buildProjectExport()` 筛选当前达标题目后调用。
 */
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildXlsx,type WorkbookSheet} from '../document-generation/xlsx';

export interface ResultExportRecord {
 workflow_id:string;title:string;accepted:boolean;
 acceptance_aggregate?:{mode:'mean_at_most';model_count:number;mean_percentage:number;threshold:number};
 task_name:string;question:string;input_attachments:string[];
 model_scores:{model_id:string;name:string;score:number|null;max_score:number|null;percentage:number|null;score_contract?:'model_report_v1';raw_score?:number|null;full_score?:number|null;veto_triggered?:boolean|null}[];
 rubric:unknown[];answer_approach:string;reference_answer:string;reference_answer_attachment:string;
}

function rubricText(items:unknown[]):string{
 return items.map((value,index)=>{
  if(typeof value==='string')return `${index+1}. ${value}`;
  if(!value||typeof value!=='object'||Array.isArray(value))return '';
  const item=value as Record<string,unknown>;
  const criterion=typeof item.criterion==='string'?item.criterion.trim():'';
  if(!criterion)return '';
  const id=typeof item.id==='string'&&item.id.trim()?`${item.id.trim()}｜`:'';
  const points=typeof item.max_score==='number'&&Number.isFinite(item.max_score)?`（${item.max_score}分）`:'';
  const rule=typeof item.rule==='string'?`\n计分规则：${item.rule}`:'';
  const metadata=item.metadata&&typeof item.metadata==='object'?`\n业务信息：${JSON.stringify(item.metadata)}`:'';
  return `${id}${criterion}${points}${rule}${metadata}`;
 }).filter(Boolean).join('\n');
}

function modelScoresText(scores:ResultExportRecord['model_scores']):string{
 return scores.map(item=>{
  if(item.score_contract==='model_report_v1')return `${item.name}：原始分：${item.raw_score??'未给出'}/${item.full_score??'未给出'}；模型报告指标：${item.percentage===null?'未给出':`${Number(item.percentage.toFixed(2))}%`}；否决：${item.veto_triggered===true?'是':item.veto_triggered===false?'否':'未给出'}`;
  const value=item.score===null?'未评分':`${item.score}/${item.max_score??'?'}`;
  const percentage=item.percentage===null?'':`（${Number(item.percentage.toFixed(2))}%）`;
  return `${item.name}：${value}${item.score===null?'':' 分'}${percentage}`;
 }).join('\n');
}

export function buildResultWorkbook(records:ResultExportRecord[]):Uint8Array{
 const attachments=records.map(record=>record.input_attachments.map(target=>{
  const path=fileURLToPath(target);
  return {name:basename(path),path,target};
 }));
 const sheet:WorkbookSheet={
  name:'题目数据',
  columns:['题目','任务名称','评分','prompt','输入附件','考点','作答思路','标准答案-文本','标准答案-附件'],
  columnWidths:{'题目':32,'任务名称':28,'评分':36,'prompt':72,'输入附件':52,'考点':72,'作答思路':64,'标准答案-文本':80,'标准答案-附件':40},
  rowHeight:150,
  rows:records.map((record,index)=>({
   '题目':record.title,
   '任务名称':record.task_name,
   'prompt':record.question,
   '输入附件':attachments[index]!.map(attachment=>attachment.name).join('\n'),
   '考点':rubricText(record.rubric),
   '评分':[modelScoresText(record.model_scores),record.acceptance_aggregate?`${record.acceptance_aggregate.model_count}模型均分：${record.acceptance_aggregate.mean_percentage.toFixed(2)}%（≤${record.acceptance_aggregate.threshold}%）`:null].filter(Boolean).join('\n'),
   '作答思路':record.answer_approach,
   '标准答案-文本':record.reference_answer,
   '标准答案-附件':record.reference_answer_attachment,
  })),
 };
 const attachmentSheet:WorkbookSheet={
  name:'附件清单',
  columns:['题目','工作流ID','附件序号','文件名','本机完整路径','打开文件'],
  columnWidths:{'题目':32,'工作流ID':40,'附件序号':12,'文件名':40,'本机完整路径':100,'打开文件':40},
  rowHeight:45,
  rows:records.flatMap((record,index)=>attachments[index]!.map((attachment,attachmentIndex)=>({
   '题目':record.title,'工作流ID':record.workflow_id,'附件序号':attachmentIndex+1,
   '文件名':attachment.name,'本机完整路径':attachment.path,
   '打开文件':{text:attachment.name,target:attachment.target},
  }))),
 };
 return buildXlsx([sheet,attachmentSheet]);
}
