export function dateLabel(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
export function fileSize(size: number) { return size < 1024 * 1024 ? `${(size/1024).toFixed(1)} KB` : `${(size/1024/1024).toFixed(1)} MB`; }
