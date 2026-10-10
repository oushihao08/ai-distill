/** 文件职责：提供页面展示日期和附件体积的格式化函数。
 * 关键方法与用法：dateLabel(value) 按上海时区格式化时间，fileSize(size) 转为 KB／MB；列表、材料与记录组件在渲染字段时调用。
 */
export function dateLabel(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
export function fileSize(size: number) { return size < 1024 * 1024 ? `${(size/1024).toFixed(1)} KB` : `${(size/1024/1024).toFixed(1)} MB`; }
