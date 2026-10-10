/**
 * 职责：成果工作簿结构：按批次组织题面、模型答案、逐项评分、返修和 API 费用表。
 * 关键方法与用途：`buildResultWorkbook()` 按批次组装题面、答案、评分、返修和 API 费用工作表。
 * 使用场景：由 `buildProjectExport()` 提供规范化记录后调用。
 */
import {buildXlsx,type WorkbookSheet} from './xlsx';
export interface ResultExportRecord {
 project_id:string;project_name:string;batch:string;workflow_id:string;title:string;
 question:string;question_version:string;rubric_version:string;accepted:boolean;published?:boolean;quarantined:boolean;
 answers:{model:string;status:string;answer:string;score_status:string;score_valid:boolean;total:number|null;max_score:number|null;items:{id:string;score:number;max_score:number;reason:string}[]}[];
 revisions:{kind:string;reason:string;from_step:number|null;content_revision:number;technical_retry:number;summary:string;duration_ms?:number;calls?:number}[];
 api_costs:{model:string;amount:number|null;currency:string|null;unknown_reason?:string}[];
}
const key=(value:string)=>value.trim()||'未分组';
export function buildResultWorkbook(records:ResultExportRecord[]):Uint8Array{
 const grouped=new Map<string,ResultExportRecord[]>();
 for(const record of records){if(!record.workflow_id)throw new Error('成果工作流标识无效');const batch=key(record.batch);grouped.set(batch,[...(grouped.get(batch)??[]),record]);}
 const sheets:WorkbookSheet[]=[{name:'成果汇总',columns:['项目','批次','工作流ID','标题','题面','题目版本','rubric版本','达标','隔离'],rows:records.map(r=>({'项目':r.project_name,'批次':key(r.batch),'工作流ID':r.workflow_id,'标题':r.title,'题面':r.question,'题目版本':r.question_version,'rubric版本':r.rubric_version,'达标':r.accepted?'是':'否','隔离':r.quarantined?'是':'否'}))}];
 for(const [batch,items] of grouped){
  sheets.push({name:`答案评分-${batch}`,columns:['项目','工作流ID','标题','模型','作答状态','答案','评分状态','评分有效','总分','满分','考点ID','考点得分','考点满分','评分理由'],rows:items.flatMap(r=>r.answers.flatMap(a=>a.items.length?a.items.map(i=>({'项目':r.project_name,'工作流ID':r.workflow_id,'标题':r.title,'模型':a.model,'作答状态':a.status,'答案':a.answer,'评分状态':a.score_status,'评分有效':a.score_valid?'是':'否','总分':a.total,'满分':a.max_score,'考点ID':i.id,'考点得分':i.score,'考点满分':i.max_score,'评分理由':i.reason})): [{'项目':r.project_name,'工作流ID':r.workflow_id,'标题':r.title,'模型':a.model,'作答状态':a.status,'答案':a.answer,'评分状态':a.score_status,'评分有效':a.score_valid?'是':'否','总分':a.total,'满分':a.max_score}]))});
  sheets.push({name:`返修费用-${batch}`,columns:['项目','工作流ID','类型','原因','返回步骤','内容返修轮次','技术重试次数','返修摘要','模型','API费用','币种','费用未知原因','链累计有效耗时毫秒','链累计调用次数'],rows:items.flatMap(r=>[
   ...r.revisions.map(x=>({'项目':r.project_name,'工作流ID':r.workflow_id,'类型':x.kind,'原因':x.reason,'返回步骤':x.from_step,'内容返修轮次':x.content_revision,'技术重试次数':x.technical_retry,'返修摘要':x.summary,'链累计有效耗时毫秒':x.duration_ms??'','链累计调用次数':x.calls??''})),
   ...r.api_costs.map(x=>({'项目':r.project_name,'工作流ID':r.workflow_id,'模型':x.model,'API费用':x.amount,'币种':x.currency,'费用未知原因':x.unknown_reason??''}))
  ])});
 }
 return buildXlsx(sheets);
}
