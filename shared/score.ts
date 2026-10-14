/**
 * 职责：统一原始评分到百分制的换算；供达标判定与模型评分展示调用。
 * `scorePercentage()` 不舍入判定值；缺失满分或越界分数返回 null，不能当作零分。
 */
export function scorePercentage(score: unknown, maximum: unknown): number | null {
 if (typeof score !== 'number' || !Number.isFinite(score) || typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum <= 0 || score < 0 || score > maximum) return null;
 return (score / maximum) * 100;
}
/** 新契约直接展示模型报告的0—100指标；缺失时不得退回原始分换算。 */
export function evaluationPercentage(value:{score_contract?:unknown;evaluation_percent?:unknown;score?:unknown;max_score?:unknown;raw_score?:unknown;full_score?:unknown;veto_triggered?:unknown}|undefined):number|null{
 if(value?.score_contract!=='model_report_v1')return scorePercentage(value?.score,value?.max_score);
 const percent=value.evaluation_percent;
 return typeof percent==='number'&&Number.isFinite(percent)&&percent>=0&&percent<=100?percent:null;
}
