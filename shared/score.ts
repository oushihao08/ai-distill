/**
 * 职责：统一原始评分到百分制的换算；供达标判定与模型评分展示调用。
 * `scorePercentage()` 不舍入判定值；缺失满分或越界分数返回 null，不能当作零分。
 */
export function scorePercentage(score: unknown, maximum: unknown): number | null {
 if (typeof score !== 'number' || !Number.isFinite(score) || typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum <= 0 || score < 0 || score > maximum) return null;
 return (score / maximum) * 100;
}
