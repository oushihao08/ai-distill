/** 文件职责：定义前后端共用的项目、工作流、材料、步骤、尝试、规则和 API 返回类型。
 * 关键契约与用法：导出 StepStatus/statusLabels 等状态定义及 Project、WorkflowDetail、ProjectStage、RuleVersion 等接口；web/src/types/api.ts 重导出，服务端路由和前端页面据此保持字段一致，类型不代替运行时校验。
 */
import type {StepExecution} from './execution-state';
import type {WorkflowConfig} from './workflow-config';
import type {AcceptanceResult} from './workflow-results';
import type {MaterialBackend,QuestionMaterialOrigin} from './material-library';
export const stages = ['入库（含PDF文本提取）', '脱敏与检查', '出题', '模型作答', '独立评分', '达标判断', '归档达标题目'] as const;
export type StepStatus = 'waiting' | 'running' | 'succeeded' | 'failed' | 'skipped';
export const statusLabels: Record<StepStatus, string> = { waiting: '等待', running: '执行中', succeeded: '成功', failed: '失败', skipped: '跳过' };
export interface Project { id: string; name: string; parent_name?:string; phase_name?:string;project_group_id?:string;phase_no?:number|null; description: string; created_at: string; workflow_count?: number; material_package_count?:number; question_count?:number; material_root: string | null; material_mode?:'question_folders'|'material_packages'; material_backend?:MaterialBackend; workspace_path?:string|null; local_skill_path: string | null; skill_exists?: boolean; effective_skill_path?:string|null;skill_issue?:string; question_tags?:string[]; }
export interface Workflow { id: string; project_id: string; title: string; created_at: string; status: string; source_key: string | null; workflow_kind?:'question'|'material_package';source_workflow_id?:string|null;library_package_id?:string|null;library_package_name?:string|null;source_redaction_attempt_id?:string|null;source_redaction_sha256?:string|null;scenario?:string|null;role_perspective?:string|null;target_level?:'L2'|'L3'|'L4'|'L5'|null;question_tags?:string[];authoring_direction?: string | null; material_count?: number;material_redaction_status?:StepStatus|null; source_manifest?: {name:string;size:number;sha256:string;path?:string}[]; current_ordinal?: number; current_status?: StepStatus | null; current_decision?: AcceptanceResult['decision'] | null; acceptance_result?:AcceptanceResult|null;current_task_name?:string|null;current_question_version?:string|null;current_rubric_version?:string|null;answer_models?:{model_id:string;name:string;status:string;attempt_id?:string|null}[]|null;publication_status?:StepStatus|null;exported?:boolean; }
export interface ResultLibraryItem { workflow_id:string;project_id:string;project_name:string;title:string;source_key:string|null;source_workflow_id:string|null;source_material_package_title:string|null;created_at:string;current_question_version:string|null;current_rubric_version:string|null;acceptance_result:Workflow['acceptance_result'];answer_models:Workflow['answer_models'];publication_status:StepStatus|null;exported:boolean }
export interface Material { id: string; original_name: string; sha256: string; size_bytes: number; content_type: string; processing_status: string; redaction_mode: 'model' | 'declared_redacted'; created_at: string; }
export interface MaterialTextPage { page: number; text: string; method: string; issues?: string[] }
export interface MaterialTextDetail { material: Pick<Material, 'id' | 'original_name' | 'processing_status' | 'sha256'>; format: string; provider: string; pages: MaterialTextPage[]; redaction_status: 'redacted' | 'not_redacted'; redacted_text?: string; redacted_pages?: (Pick<MaterialTextPage, 'page' | 'text'> & Partial<Pick<MaterialTextPage, 'method' | 'issues'>>)[] }
export interface Step { executions?:StepExecution[]; ordinal: number; position?:number; display_position?:number; step_key?:string; enabled?:boolean; active?:boolean; name: string; status: StepStatus; implemented: boolean; result: Record<string, unknown> | null; error: string | null; started_at: string | null; finished_at: string | null; ready?:boolean; ready_reason?:string|null; }
export interface Attempt { id: string; ordinal: number; status: StepStatus;  error: string | null; input: unknown; config?:unknown; result: unknown; started_at: string; heartbeat_at?:string|null; finished_at: string | null; }
export interface PublicationHistoryItem {id:string;project_id:string;workflow_id:string;attempt_id:string;event_type:'archived'|'withdrawn';provenance:{project_id:string;project_name?:string|null;workflow_id:string;workflow_title?:string|null;standard_material_package_name?:string|null;material_origin:QuestionMaterialOrigin;materials:{artifact_id:string;sha256:string}[];source_files?:{file_id:string;material_id:string;original_name:string;sha256:string}[]};created_at:string;project_name:string;workflow_title:string}
export interface WorkflowDetail { artifacts: {id:string;kind:string;attempt_id:string|null;created_at:string;question_version?:string|null;filename?:string|null}[]; workflow: Workflow; project: Project; materials: Material[]; steps: Step[]; attempts: Attempt[]; publication_history?:PublicationHistoryItem[];source_material_package?:{id:string;title:string}|null;question_material_origin?:QuestionMaterialOrigin|null;material_package_questions?:Pick<Workflow,'id'|'title'|'created_at'|'source_redaction_attempt_id'|'source_redaction_sha256'>[]; }

/** 脱敏执行安全进度：只含计数、时间与阶段，不含附件正文或敏感值。 */
export interface RedactionProgress {
 phase:'planning'|'requesting'|'saving'|'completed'|'failed';total_fields:number;completed_fields:number;total_batches:number;
 active_requests:number;request_count:number;retry_count:number;started_at:string;last_progress_at:string;deadline_at:string;
 request_duration_ms:number;queue_wait_ms:number;validation_duration_ms:number;checkpoint_duration_ms:number;wall_elapsed_ms:number;
}
export const MODEL_API_PROVIDERS=['qwen','kimi','deepseek','doubao','openrouter','siliconflow'] as const;
export type ModelApiProvider=typeof MODEL_API_PROVIDERS[number];
export const DEFAULT_MODEL_API_MODEL='deepseek/deepseek-v4.1-flash';
export const OPENROUTER_SERVER_TOOLS=['web_search','web_fetch','shell'] as const;
export type OpenRouterServerTool=typeof OPENROUTER_SERVER_TOOLS[number];
export const ANSWER_LOCAL_TOOLS=['attachment_list','attachment_search','attachment_read','document_inspect','artifact_write','artifact_render'] as const;
export type AnswerLocalTool=typeof ANSWER_LOCAL_TOOLS[number];
export interface ModelApiConfig {provider:ModelApiProvider;base_url:string;model:string;enable_thinking?:boolean;max_tokens?:number;provider_options?:{only:string[];allow_fallbacks:boolean};server_tools?:OpenRouterServerTool[];local_tools?:AnswerLocalTool[];max_tool_calls?:number}
export interface ProjectStage { ordinal:number;position:number;key:string;name:string;implemented:boolean;total:number;ready:number;queued:number;running:number;succeeded:number;failed:number;needs_repair:number;quarantined:number;config_source?:'step'|'project'|'system';config:{workflow?:WorkflowConfig;provider?:string;api?:ModelApiConfig;model?:string;reasoning_effort?:string;prompt?:string;timeout_ms?:number;material_source_mode?:'redacted'|'original';material_processing_mode?:import('./material-library').MaterialProcessingMode;base_url?:string;enable_thinking?:boolean;max_tokens?:number;required_models?:string[];minimum_score_by_model?:Record<string,number>} }
export interface ProjectWorkflowStatus {steps:Step[];attempt_summary:{has_authored:boolean}}
export interface ProjectDetail { project:Project;workflows:Workflow[];steps:ProjectStage[];workflow_status?:Record<string,ProjectWorkflowStatus> }

export interface RuleFile { path:string;sha256:string;size_bytes:number }
export interface RuleWorkspace {
 workspace_path:string;materials_path:string;skill_path:string;files:RuleFile[];source_digest:string;
 assessment:Record<string,unknown>;unresolved:{id:string;detail?:string}[];issues:string[];
}
export interface ProjectSkillBinding {source:'phase'|'project';path:string;project_path:string;phase_path:string|null}
export interface ProjectRules { workspace:RuleWorkspace;skill:ProjectSkillBinding }
