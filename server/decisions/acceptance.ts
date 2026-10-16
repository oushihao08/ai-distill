/**
 * 职责：达标纯决策：将必需模型分数换算为百分制并按项目策略判断。
 * 关键方法与用途：`decideAcceptance()` 保留通用逐模型策略，Work使用两个模型的百分制均分门槛。
 * 使用场景：由 `jobs.ts` 组装当前快照后调用；不访问数据库或模型。
 */
import {scorePercentage} from '../../shared/score';
import type {AcceptanceResult,ModelAcceptance} from '../../shared/workflow-results';
export type {AcceptanceResult,ModelAcceptance} from '../../shared/workflow-results';
export interface AcceptanceConfig {
 required_models: string[];
 // 保留历史字段名；值为 0—100 的百分制分数上限，不是原始最低分。
 minimum_score_by_model: Record<string, number|null>;
 aggregation?: {mode:'mean_at_most';model_count:number;threshold:number};
}
export interface ModelAssessment {
 score_contract?:'model_report_v1';evaluation_percent?:number|null;raw_score?:number|null;full_score?:number|null;veto_triggered?:boolean|null;
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
 const aggregation=config.aggregation;
 if(aggregation&&(aggregation.mode!=='mean_at_most'||!Number.isInteger(aggregation.model_count)||aggregation.model_count<1||!validScore(aggregation.threshold)||aggregation.threshold<0||aggregation.threshold>100))return {decision:'waiting',reasons:['acceptance_aggregation_invalid']};
 if(aggregation&&config.required_models.length!==aggregation.model_count)return {decision:'waiting',reasons:[`required_model_count_mismatch:${aggregation.model_count}`]};
 if(!aggregation)for(const model of config.required_models){const threshold=config.minimum_score_by_model[model];if(!validScore(threshold)||threshold<0||threshold>100)return {decision:'waiting',reasons:[`minimum_score_missing:${model}`]};}
 const byModel=new Map<string,ModelAssessment>();
 for(const item of input.models){if(!item.model||byModel.has(item.model))return {decision:'quarantine',reasons:['duplicate_or_invalid_model_result']};byModel.set(item.model,item);}
 const scores:Record<string,ModelAcceptance>={};
 let pending=false;const includedPercentages:number[]=[];
 for(const model of config.required_models){
  const result=byModel.get(model);
  const threshold=aggregation?.threshold??config.minimum_score_by_model[model]!;
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
  if(result.score_contract==='model_report_v1'){
   const percentage=result.evaluation_percent;
   if(result.score_valid!==true||!validScore(percentage)||percentage<0||percentage>100){scores[model]={status:'pending',threshold};pending=true;reasons.push(`score_missing_or_invalid:${model}`);continue;}
   const status=aggregation?'included':percentage<threshold?'passed':'not_passed';
   scores[model]={status,score_contract:'model_report_v1',raw_score:result.raw_score??null,full_score:result.full_score??null,veto_triggered:result.veto_triggered??null,percentage,threshold};
   if(aggregation)includedPercentages.push(percentage);else if(status==='not_passed')reasons.push(`at_or_above_model_threshold:${model}`);
   continue;
  }
  if(!validScore(result.score)||!validScore(result.max_score)){
   scores[model]={status:'pending',threshold};pending=true;reasons.push(`score_missing_or_invalid:${model}`);continue;
  }
  const percentage=scorePercentage(result.score,result.max_score);
  if(percentage===null){scores[model]={status:'pending',threshold};pending=true;reasons.push(`score_missing_or_invalid:${model}`);continue;}
  const status=aggregation?'included':percentage<threshold?'passed':'not_passed';
  scores[model]={status,score:result.score,max_score:result.max_score,percentage,threshold};
  if(aggregation)includedPercentages.push(percentage);else if(status==='not_passed')reasons.push(`at_or_above_model_threshold:${model}`);
 }
 if(pending)return {decision:'waiting',reasons,model_scores:scores};
 if(aggregation){
  const meanPercentage=includedPercentages.reduce((sum,value)=>sum+value,0)/aggregation.model_count;
  const accepted=meanPercentage<=aggregation.threshold;
  if(!accepted)reasons.push('model_mean_above_threshold');
  return {decision:accepted?'accepted':'repair',reasons,model_scores:scores,aggregate:{mode:aggregation.mode,model_count:aggregation.model_count,mean_percentage:meanPercentage,threshold:aggregation.threshold}};
 }
 return {decision:reasons.length?'repair':'accepted',reasons,model_scores:scores};
}

/** 当前必需模型来自项目模型集合，聚合口径来自项目 ordinal 7 配置。 */
export function buildAcceptanceConfig(models:{model_id:string;minimum_score:number|null}[],aggregation?:AcceptanceConfig['aggregation']):AcceptanceConfig{
 const base:AcceptanceConfig={required_models:models.map(model=>model.model_id),minimum_score_by_model:Object.fromEntries(models.map(model=>[model.model_id,model.minimum_score]))};
 return aggregation?{...base,aggregation}:base;
}
