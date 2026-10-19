/**
 * 职责：定义和识别工作流当前答案、评分与达标汇总的 API 结果形状。
 * 关键方法：`readAnswerStepResult()`、`readScoreStepResult()`、`readAcceptanceResult()` 在消费 JSON 前确认其关键字段。
 * 使用场景：服务端结果生产、Web／CLI 读取；旧记录缺少可选字段仍可读取；缺少必要字段才返回不可识别，不推断业务成功。
 */
import type {StepStatus} from './types';

export interface AnswerStepModelSummary {
 model_id?:string|null;
 name?:string;
 minimum_score?:number;
 attempt_id?:string|null;
 status:StepStatus;
 answer_sha256?:string|null;
 answer?:string|null;
 outcome?:string;
 reason_code?:string;
 generation_activity?:unknown;
}
export interface AnswerStepResult {
 model_set_digest?:string;
 models:AnswerStepModelSummary[];
}

export interface ScoreStepModelSummary {
 score_contract?:'model_report_v1';
 raw_score?:number|null;full_score?:number|null;evaluation_percent?:number|null;veto_triggered?:boolean|null;
 model_id?:string|null;
 name?:string;
 answer_attempt_id?:string|null;
 answer_status:StepStatus;
 score_attempt_id?:string|null;
 score_status:StepStatus;
 score?:number|null;
 max_score?:number|null;
 extraction_status?:'parsed'|'unparsed';
 valid?:boolean|null;
 binding?:unknown;
 disputes?:unknown[];
}
export interface ScoreStepResult {models:ScoreStepModelSummary[]}

export interface ModelAcceptance {
 score_contract?:'model_report_v1';raw_score?:number|null;full_score?:number|null;veto_triggered?:boolean|null;
 status:'passed'|'not_passed'|'pending'|'invalid'|'included';
 score?:number;
 max_score?:number;
 percentage?:number;
 threshold:number;
}
export interface AcceptanceAggregate {mode:'mean_at_most';model_count:number;mean_percentage:number;threshold:number}
export type AcceptanceResult =
 | {decision:'waiting'|'quarantine';reasons:string[];model_scores?:Record<string,ModelAcceptance>;aggregate?:AcceptanceAggregate}
 | {decision:'accepted'|'repair';reasons:string[];model_scores:Record<string,ModelAcceptance>;aggregate?:AcceptanceAggregate};

type UnknownRecord=Record<string,unknown>;
const isRecord=(value:unknown):value is UnknownRecord=>!!value&&typeof value==='object'&&!Array.isArray(value);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const statuses=new Set<StepStatus>(['waiting','running','succeeded','failed','skipped']);

export function readAnswerStepResult(value:unknown):AnswerStepResult|undefined{
 if(!isRecord(value)||!Array.isArray(value.models))return;
 const models:AnswerStepModelSummary[]=[];
 for(const row of value.models){
  if(!isRecord(row)||!statuses.has(row.status as StepStatus))return;
  if(row.model_id!==undefined&&row.model_id!==null&&typeof row.model_id!=='string')return;
  if(row.name!==undefined&&typeof row.name!=='string')return;
  if(row.attempt_id!==undefined&&row.attempt_id!==null&&typeof row.attempt_id!=='string')return;
  models.push({...row,status:row.status as StepStatus} as AnswerStepModelSummary);
 }
 return {...value,models} as AnswerStepResult;
}

export function readScoreStepResult(value:unknown):ScoreStepResult|undefined{
 if(!isRecord(value)||!Array.isArray(value.models))return;
 const models:ScoreStepModelSummary[]=[];
 for(const row of value.models){
  if(!isRecord(row)||!statuses.has(row.answer_status as StepStatus)||!statuses.has(row.score_status as StepStatus))return;
  if(row.model_id!==undefined&&row.model_id!==null&&typeof row.model_id!=='string')return;
  if(row.name!==undefined&&typeof row.name!=='string')return;
  if(row.score!==undefined&&row.score!==null&&!finite(row.score))return;
  if(row.max_score!==undefined&&row.max_score!==null&&!finite(row.max_score))return;
  if(row.score_contract!==undefined&&row.score_contract!=='model_report_v1')return;
  if(['raw_score','full_score','evaluation_percent'].some(key=>row[key]!==undefined&&row[key]!==null&&!finite(row[key])))return;
  if(typeof row.evaluation_percent==='number'&&(row.evaluation_percent<0||row.evaluation_percent>100))return;
  if(row.veto_triggered!==undefined&&row.veto_triggered!==null&&typeof row.veto_triggered!=='boolean')return;
  models.push({...row,answer_status:row.answer_status as StepStatus,score_status:row.score_status as StepStatus} as ScoreStepModelSummary);
 }
 return {...value,models};
}

function readModelAcceptance(value:unknown):value is ModelAcceptance{
 if(!isRecord(value)||!['passed','not_passed','pending','invalid','included'].includes(String(value.status))||!finite(value.threshold))return false;
 if(value.score_contract!==undefined&&value.score_contract!=='model_report_v1')return false;
 if(['raw_score','full_score'].some(key=>value[key]!==undefined&&value[key]!==null&&!finite(value[key])))return false;
 if(value.veto_triggered!==undefined&&value.veto_triggered!==null&&typeof value.veto_triggered!=='boolean')return false;
 return ['score','max_score','percentage'].every(key=>value[key]===undefined||finite(value[key]));
}

export function readAcceptanceResult(value:unknown):AcceptanceResult|undefined{
 if(!isRecord(value)||!['accepted','repair','waiting','quarantine'].includes(String(value.decision))||!Array.isArray(value.reasons)||!value.reasons.every(reason=>typeof reason==='string'))return;
 const decision=value.decision;
 const scores=value.model_scores;
 if(scores!==undefined&&(!isRecord(scores)||!Object.values(scores).every(readModelAcceptance)))return;
 if((decision==='accepted'||decision==='repair')&&!scores)return;
 if(value.aggregate!==undefined&&(!isRecord(value.aggregate)||value.aggregate.mode!=='mean_at_most'||!Number.isInteger(value.aggregate.model_count)||Number(value.aggregate.model_count)<1||!finite(value.aggregate.mean_percentage)||value.aggregate.mean_percentage<0||value.aggregate.mean_percentage>100||!finite(value.aggregate.threshold)||value.aggregate.threshold<0||value.aggregate.threshold>100))return;
 return value as AcceptanceResult;
}
