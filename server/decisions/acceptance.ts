/**
 * 职责：达标纯决策：将必需模型原始分数换算为百分制，逐模型比较难度阈值。
 * 关键方法与用途：`decideAcceptance()` 所有必需模型得分率严格低于各自阈值时题目达标；任一达到或超过则题目未达标。
 * 使用场景：由 `jobs.ts` 组装当前快照后调用；不访问数据库或模型。
 */
import {scorePercentage} from '../../shared/score';
import type {AcceptanceResult,ModelAcceptance} from '../../shared/workflow-results';
export type {AcceptanceResult,ModelAcceptance} from '../../shared/workflow-results';
export interface AcceptanceConfig {
 required_models: string[];
 // 保留历史字段名；值为 0—100 的百分制分数上限，不是原始最低分。
 minimum_score_by_model: Record<string, number|null>;
}
export interface ModelAssessment {
 model: string;
 answer_status: 'waiting'|'running'|'succeeded'|'failed'|'skipped';
 score_status?: 'waiting'|'running'|'succeeded'|'failed';
 score_valid?: boolean;
 score?: number;
 max_score?: number;
}
export interface AcceptanceInput {
 question_current: boolean;
 config?: AcceptanceConfig;
 models: ModelAssessment[];
}
const validScore=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
export function decideAcceptance(input:AcceptanceInput):AcceptanceResult{
 const reasons:string[]=[];
 if(!input.question_current)return {decision:'quarantine',reasons:['question_or_material_version_stale']};
 const config=input.config;
 if(!config||!Array.isArray(config.required_models)||!config.required_models.length||config.required_models.some(model=>typeof model!=='string'||!model.trim())||new Set(config.required_models).size!==config.required_models.length||!config.minimum_score_by_model||typeof config.minimum_score_by_model!=='object'||Array.isArray(config.minimum_score_by_model))return {decision:'waiting',reasons:['acceptance_config_missing_or_invalid']};
 for(const model of config.required_models){const threshold=config.minimum_score_by_model[model];if(!validScore(threshold)||threshold<0||threshold>100)return {decision:'waiting',reasons:[`minimum_score_missing:${model}`]};}
 const byModel=new Map<string,ModelAssessment>();
 for(const item of input.models){if(!item.model||byModel.has(item.model))return {decision:'quarantine',reasons:['duplicate_or_invalid_model_result']};byModel.set(item.model,item);}
 const scores:Record<string,ModelAcceptance>={};
 let pending=false;
 for(const model of config.required_models){
  const result=byModel.get(model);
  const threshold=config.minimum_score_by_model[model]!;
  if(!result){scores[model]={status:'pending',threshold};pending=true;reasons.push(`required_model_missing:${model}`);continue;}
  if(result.answer_status!=='succeeded'){
   scores[model]={status:'pending',threshold};pending=true;reasons.push(result.answer_status==='skipped'?`required_model_unscored:${model}`:`required_model_incomplete:${model}`);continue;
  }
  if(result.score_valid===false){
   scores[model]={status:'invalid',threshold};pending=true;reasons.push(`score_invalid_or_disputed:${model}`);continue;
  }
  if(result.score_status==='failed'){
   scores[model]={status:'pending',threshold};pending=true;reasons.push(`required_model_score_failed:${model}`);continue;
  }
  if(result.score_status&&result.score_status!=='succeeded'){
   scores[model]={status:'pending',threshold};pending=true;reasons.push(`required_model_score_incomplete:${model}`);continue;
  }
  if(result.score_status==='succeeded'&&result.score_valid!==true){
   scores[model]={status:'pending',threshold};pending=true;reasons.push(`required_model_score_validation_missing:${model}`);continue;
  }
  if(!validScore(result.score)||!validScore(result.max_score)){
   scores[model]={status:'pending',threshold};pending=true;reasons.push(`score_missing_or_invalid:${model}`);continue;
  }
  const percentage=scorePercentage(result.score,result.max_score);
  if(percentage===null){scores[model]={status:'pending',threshold};pending=true;reasons.push(`score_missing_or_invalid:${model}`);continue;}
  const status=percentage<threshold?'passed':'not_passed';
  scores[model]={status,score:result.score,max_score:result.max_score,percentage,threshold};
  if(status==='not_passed')reasons.push(`at_or_above_model_threshold:${model}`);
 }
 if(pending)return {decision:'waiting',reasons,model_scores:scores};
 return {decision:reasons.length?'repair':'accepted',reasons,model_scores:scores};
}
