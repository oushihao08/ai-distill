export interface AcceptanceConfig {
 required_models: string[];
 minimum_score_by_model: Record<string, number|null>;
 revision_budget?:{max_content_revisions?:number;max_technical_retries?:number;max_duration_ms?:number;max_calls?:number};
}
export interface ModelAssessment {
 model: string;
 answer_status: 'waiting'|'running'|'succeeded'|'failed';
 score_status: 'waiting'|'running'|'succeeded'|'failed';
 score?: number;
 max_score?: number;
 score_valid?: boolean;
 binding_matches?: boolean;
 disputes?: string[];
}
export interface AcceptanceInput {
 question_current: boolean;
 quality: {status:'waiting'|'failed'|'passed';issues?:string[]};
 config?: AcceptanceConfig;
 models: ModelAssessment[];
}
export type AcceptanceResult =
 | {decision:'waiting'|'quarantine';reasons:string[]}
 | {decision:'accepted'|'repair';reasons:string[];model_scores:Record<string,{score:number;max_score:number}>};
const validScore=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
export function decideAcceptance(input:AcceptanceInput):AcceptanceResult{
 const reasons:string[]=[];
 if(!input.question_current)return {decision:'quarantine',reasons:['question_or_material_version_stale']};
 if(input.quality.status==='waiting')return {decision:'waiting',reasons:['quality_check_pending']};
 if(input.quality.status==='failed')return {decision:'repair',reasons:['quality_check_failed',...(input.quality.issues??[])],model_scores:{}};
 const config=input.config;
 if(!config||!Array.isArray(config.required_models)||!config.required_models.length||config.required_models.some(model=>typeof model!=='string'||!model.trim())||new Set(config.required_models).size!==config.required_models.length||!config.minimum_score_by_model||typeof config.minimum_score_by_model!=='object'||Array.isArray(config.minimum_score_by_model))return {decision:'waiting',reasons:['acceptance_config_missing_or_invalid']};
 for(const model of config.required_models){const threshold=config.minimum_score_by_model[model];if(!validScore(threshold)||threshold<0)return {decision:'waiting',reasons:[`minimum_score_missing:${model}`]};}
 const byModel=new Map<string,ModelAssessment>();
 for(const item of input.models){if(!item.model||byModel.has(item.model))return {decision:'quarantine',reasons:['duplicate_or_invalid_model_result']};byModel.set(item.model,item);}
 const scores:Record<string,{score:number;max_score:number}>={};
 for(const model of config.required_models){
  const result=byModel.get(model);
  if(!result)return {decision:'waiting',reasons:[`required_model_missing:${model}`]};
  if(result.answer_status!=='succeeded'||result.score_status!=='succeeded')return {decision:'waiting',reasons:[`required_model_incomplete:${model}`]};
  if(result.score_valid!==true||result.binding_matches!==true||!result.disputes||result.disputes.length)return {decision:'repair',reasons:[`score_invalid_or_disputed:${model}`],model_scores:{...scores}};
  if(!validScore(result.score)||!validScore(result.max_score)||result.max_score<=0||result.score<0||result.score>result.max_score)return {decision:'quarantine',reasons:[`score_out_of_range:${model}`]};
  if(config.minimum_score_by_model[model]!>result.max_score)return {decision:'waiting',reasons:[`minimum_score_exceeds_maximum:${model}`]};
  scores[model]={score:result.score,max_score:result.max_score};
  if(result.score<config.minimum_score_by_model[model]!)reasons.push(`below_model_threshold:${model}`);
 }
 return {decision:reasons.length?'repair':'accepted',reasons,model_scores:scores};
}
