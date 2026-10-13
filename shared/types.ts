/** 文件职责：定义前后端共用的项目、工作流、材料、步骤、尝试、规则和 API 返回类型。
 * 关键契约与用法：导出 StepStatus/statusLabels 等状态定义及 Project、WorkflowDetail、ProjectStage、RuleVersion 等接口；web/src/types/api.ts 重导出，服务端路由和前端页面据此保持字段一致，类型不代替运行时校验。
 */
import type {AcceptanceResult} from './workflow-results';
export const stages = ['入库（含PDF文本提取）', '脱敏与检查', '出题', '模型作答', '独立评分', '达标判断', '归档达标题目'] as const;
export type StepStatus = 'waiting' | 'running' | 'succeeded' | 'failed' | 'skipped';
export const statusLabels: Record<StepStatus, string> = { waiting: '等待', running: '执行中', succeeded: '成功', failed: '失败', skipped: '跳过' };
export interface Project { id: string; name: string; parent_name?:string; phase_name?:string; description: string; created_at: string; workflow_count?: number; material_root: string | null; local_skill_path: string | null; skill_exists?: boolean; }
export interface Workflow { id: string; project_id: string; title: string; created_at: string; status: string; source_key: string | null;  material_count?: number; source_manifest?: {name:string;size:number;sha256:string}[]; current_ordinal?: number; current_status?: StepStatus | null; current_decision?: AcceptanceResult['decision'] | null; acceptance_result?:AcceptanceResult|null; current_question_version?:string|null;current_rubric_version?:string|null;answer_models?:{model_id:string;name:string;status:string;attempt_id?:string|null}[]|null;publication_status?:StepStatus|null;exported?:boolean; }
export interface ResultLibraryItem { workflow_id:string;project_id:string;project_name:string;title:string;source_key:string|null;created_at:string;current_question_version:string|null;current_rubric_version:string|null;acceptance_result:Workflow['acceptance_result'];answer_models:Workflow['answer_models'];publication_status:StepStatus|null;exported:boolean }
export interface Material { id: string; original_name: string; sha256: string; size_bytes: number; content_type: string; processing_status: string; created_at: string; }
export interface MaterialTextPage { page: number; text: string; method: string; issues?: string[] }
export interface MaterialTextDetail { material: Pick<Material, 'id' | 'original_name' | 'processing_status' | 'sha256'>; format: string; provider: string; pages: MaterialTextPage[]; redaction_status: 'redacted' | 'not_redacted'; redacted_text?: string; redacted_pages?: (Pick<MaterialTextPage, 'page' | 'text'> & Partial<Pick<MaterialTextPage, 'method' | 'issues'>>)[] }
export interface Step { ordinal: number; position?:number; display_position?:number; step_key?:string; enabled?:boolean; name: string; status: StepStatus; implemented: boolean; result: Record<string, unknown> | null; error: string | null; started_at: string | null; finished_at: string | null; ready?:boolean; ready_reason?:string|null; }
export interface Attempt { id: string; ordinal: number; status: StepStatus;  error: string | null; input: unknown; config?:unknown; result: unknown; started_at: string; finished_at: string | null; }
export interface WorkflowDetail { artifacts: {id:string;kind:string;attempt_id:string;created_at:string;question_version?:string|null;filename?:string|null}[]; workflow: Workflow; project: Project; materials: Material[]; steps: Step[]; attempts: Attempt[]; }

export type ModelApiProvider='qwen'|'kimi'|'deepseek'|'doubao'|'openrouter';
export const DEFAULT_MODEL_API_MODEL='z-ai/glm-5.3-flash';
export interface ModelApiConfig {provider:ModelApiProvider;base_url:string;model:string;enable_thinking?:boolean;max_tokens?:number}
export interface ProjectStage { ordinal:number;position:number;key:string;name:string;implemented:boolean;total:number;ready:number;queued:number;running:number;succeeded:number;failed:number;needs_repair:number;quarantined:number;config_source?:'step'|'project'|'system';config:{provider?:string;api?:ModelApiConfig;model?:string;reasoning_effort?:string;prompt?:string;base_url?:string;enable_thinking?:boolean;max_tokens?:number;required_models?:string[];minimum_score_by_model?:Record<string,number>} }
export interface ProjectDetail { project:Project;workflows:Workflow[];steps:ProjectStage[] }

export interface RuleFile { path:string;sha256:string;size_bytes:number }
export interface RuleWorkspace {
 workspace_path:string;materials_path:string;skill_path:string;files:RuleFile[];source_digest:string;
 assessment:Record<string,unknown>;unresolved:{id:string;detail?:string}[];issues:string[];
}
export interface ProjectRules { workspace:RuleWorkspace }
