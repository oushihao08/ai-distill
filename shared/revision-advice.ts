/** 手动建议的页面/CLI读取契约；建议绑定来源摘要，历史建议可查看但不自动用于新版本。 */
export interface RevisionAdviceAttempt {id:string;status:'waiting'|'running'|'succeeded'|'failed'|'skipped';source_digest:string;authoring_version:string;result:{text:string}|null;error:string|null;started_at:string;finished_at:string|null;current:boolean}
export interface RevisionAdviceView {available:boolean;attempts:RevisionAdviceAttempt[]}
