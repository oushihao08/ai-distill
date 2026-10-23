/**
 * 职责：从评分模型已有结果投影可比较分数，不复评、不复算逐项或覆盖历史报告。
 * 入口：projectReportedScore，由达标快照读取调用；兼容旧文本合计和model_report_v1汇总。
 * 边界：只读取明确且无歧义的模型分数；题目、答案及附件绑定由jobs.ts核对。
 */
import {extractTextScore,type ScoreContext,type RubricItem} from '../scoring/validate';

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
export function projectReportedScore(result:any,rubric:ScoreContext['rubric'],modelReport:boolean){
 if(!result||typeof result!=='object')return result;
 if(modelReport){
  if(finite(result.report?.summary?.evaluation_percent))return result;
  if(typeof result.raw_text!=='string')return result;
  const sections=[...result.raw_text.matchAll(/<model_report>\s*([\s\S]*?)\s*<\/model_report>/g)];
  if(sections.length!==1)return result;
  try{
   const report=JSON.parse(sections[0]![1]!);
   if(report?.contract!=='model_report_v1'||!finite(report.summary?.evaluation_percent))return result;
   return {...result,report};
  }catch{return result;}
 }
 if(finite(result.report?.total)&&finite(result.report?.max_score)&&result.report.max_score>0)return result;
 if(typeof result.raw_text!=='string')return result;
 const extraction=extractTextScore(result.raw_text,rubric as RubricItem[]);
 return {...result,report:{...result.report,total:extraction.total,max_score:extraction.max_score},validation:extraction,score_extraction:extraction};
}
