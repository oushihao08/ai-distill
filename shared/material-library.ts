/**
 * 文件职责：定义独立材料库及项目加载关系的前后端 DTO 和稳定状态契约。
 * 关键类型与用法：MaterialBackend、MaterialLibraryJob、LoadedMaterialPackage 和 QuestionMaterialOrigin 约束新旧来源分流；由 API、worker 与 Vue 工作台共同使用，不执行数据库或模型调用。
 */

export type MaterialBackend = 'legacy' | 'library_v1';
export type LibraryRevisionState = 'pending' | 'ready';
export type LibraryJobKind = 'intake' | 'extract' | 'redact';
export type LibraryJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type LibraryExecutorKind = 'internal' | 'api' | 'agent';
export type LibraryExecutionTarget = 'local' | 'server';
export type LibraryRedactionMode = 'model' | 'declared_redacted';
export type QuestionMaterialMode = 'redacted' | 'original';

/** 永久使用账不依赖题目；页面在本期材料行内展示，历史事件按原时间保留。 */
export interface MaterialUseRecord {
  id:string;package_id:string;package_name:string;status:'in_use'|'submitted';lock_version:number;
}

export interface MaterialUseEvent {
  id:string;use_id:string;event_type:string;previous_status:'in_use'|'submitted'|null;status:'in_use'|'submitted';
  reason:string;evidence:Record<string,unknown>;created_at:string;
}

export interface MaterialLibraryPackageSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  current_revision_id: string | null;
  file_count: number;
  revision_state: LibraryRevisionState | null;
  intake_status: LibraryJobStatus | 'not_started';
  extraction_status: LibraryJobStatus | 'not_started';
  redaction_status: LibraryJobStatus | 'not_started';
  available_redaction_count: number;
  available_extraction_count?: number;
  loaded_project_count: number;
  /** 列表当前页的永久占用摘要；详情接口仍通过 /packages/:id/usage 读取完整事件。 */
  material_uses?: MaterialLibraryPackageUseSummary[];
  lock_version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaterialLibraryPackageUseSummary {
  id:string;
  project_group_id:string;
  project_name:string;
  owner_phase_id:string;
  phase_name:string|null;
  phase_no:number|null;
  status:'in_use'|'submitted';
  first_used_at:string;
}

export interface MaterialLibraryFile {
  id: string;
  revision_id: string;
  original_name: string;
  position: number;
  sha256: string;
  size_bytes: number;
  content_type: string;
  redaction_mode: LibraryRedactionMode;
  created_at: string;
}

export interface MaterialLibraryRevision {
  id: string;
  package_id: string;
  parent_revision_id: string | null;
  state: LibraryRevisionState;
  manifest_sha256: string;
  file_count: number;
  created_at: string;
  sealed_at: string | null;
  files: MaterialLibraryFile[];
  redactions: MaterialLibraryRedactionSummary[];
}

export interface MaterialLibraryJob {
  origin?: 'execution'|'legacy_import';
  id: string;
  package_id: string;
  revision_id: string;
  kind: LibraryJobKind;
  status: LibraryJobStatus;
  executor_kind: LibraryExecutorKind;
  execution_target: LibraryExecutionTarget;
  progress: Record<string, unknown>;
  result_summary: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  previous_job_id: string | null;
  extraction_job_id: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface MaterialLibraryRedactionSummary {
  id: string;
  package_id: string;
  revision_id: string;
  extraction_job_id: string;
  redaction_job_id: string;
  output_digest: string;
  usable_for_question: boolean;
  created_at: string;
}

export interface LoadedMaterialPackage {
  id: string;
  project_id: string;
  package_id: string;
  package_name: string;
  selected_revision_id: string | null;
  selected_redaction_id: string | null;
  current_revision_id: string | null;
  position: number;
  lock_version: number;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type QuestionMaterialOrigin =
  | { kind: 'legacy'; redaction_attempt_id: string }
  | {
      kind: 'library_v1';
      material_mode: QuestionMaterialMode;
      package_id: string;
      revision_id: string;
      redaction_id: string | null;
      snapshot_digest: string;
    };

export interface QuestionLibrarySource {
  workflow_id: string;
  project_id: string;
  project_material_id: string;
  package_id: string;
  revision_id: string;
  redaction_id: string | null;
  material_mode: QuestionMaterialMode;
  source_digest: string;
  snapshot_digest: string;
  request_key: string;
  created_at: string;
}

export interface CreateLibraryJobRequest {
  kind: LibraryJobKind;
  request_key: string;
  execution_target: LibraryExecutionTarget;
  extraction_job_id?: string;
  previous_job_id?: string;
}

export interface CreateLibraryQuestionRequest {
  request_key: string;
  redaction_id?: string;
  revision_id?: string;
  expected_link_version: number;
  title: string;
  scenario?: string;
  role_perspective?: string;
  target_level?: 'L2' | 'L3' | 'L4' | 'L5';
  authoring_direction?: string;
  question_tags?: string[];
}
