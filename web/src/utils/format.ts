/** 文件职责：提供页面展示日期、附件体积和考点阅读稿的格式化函数。
 * 关键方法与用法：dateLabel(value) 按上海时区格式化时间，fileSize(size) 转为 KB／MB，numberedRubric(value) 将结构化考点显示为普通编号。
 */
export function dateLabel(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
export function fileSize(size: number) { return size < 1024 * 1024 ? `${(size/1024).toFixed(1)} KB` : `${(size/1024/1024).toFixed(1)} MB`; }
export function numberedRubric(value: unknown): string {
 if (!Array.isArray(value)) return '';
 return value.map((item, index) => {
  if (typeof item === 'string') return `${index + 1}、${item}`;
  if (!item || typeof item !== 'object') return `${index + 1}、`;
  const row = item as Record<string, unknown>;
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : undefined;
  const score = typeof metadata?.score === 'number' ? metadata.score : row.max_score;
  const scoreLabel = typeof score === 'number' && score !== 1 ? `（${score}分）` : '';
  const criterion = metadata?.statement ?? row.criterion ?? '';
  const rule = row.rule ? `\n计分规则：${row.rule}` : '';
  const business = metadata ? `\n业务信息：${JSON.stringify(metadata)}` : '';
  return `${index + 1}、${scoreLabel}${criterion}${rule}${business}`;
 }).join('\n\n');
}
