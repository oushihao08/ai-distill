/** 手动建议读取契约；来源摘要记录生成时依据，返修出题可携带该题任一成功有效建议。 */
export interface RevisionAdviceAttempt {id:string;status:'waiting'|'running'|'succeeded'|'failed'|'skipped';source_digest:string;authoring_version:string;result:{text:string}|null;error:string|null;started_at:string;finished_at:string|null;current:boolean}
export interface RevisionAdviceView {available:boolean;attempts:RevisionAdviceAttempt[]}
