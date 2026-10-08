export const stages = ['入库（含PDF文本提取）', '脱敏与检查', '加载本期规则', '出题与质检', '模型作答', '独立评分', '达标或返修', '发布成果与导出'] as const;
export type StepStatus = 'waiting' | 'running' | 'succeeded' | 'failed' | 'skipped';
export const statusLabels: Record<StepStatus, string> = { waiting: '等待', running: '运行中', succeeded: '成功', failed: '失败', skipped: '跳过' };
export interface Project { id: string; name: string; description: string; created_at: string; workflow_count?: number; material_root: string | null; local_skill_path: string | null; skill_exists?: boolean; }
export interface Workflow { id: string; project_id: string; title: string; created_at: string; status: string; source_key: string | null; input_revision: number; material_count?: number; source_manifest?: {name:string;size:number;sha256:string}[]; current_ordinal?: number; current_status?: StepStatus | null; }
export interface Material { id: string; original_name: string; sha256: string; size_bytes: number; content_type: string; processing_status: string; created_at: string; }
export interface MaterialTextPage { page: number; text: string; method: string; issues?: string[] }
export interface MaterialTextDetail { material: Pick<Material, 'id' | 'original_name' | 'processing_status' | 'sha256'>; format: string; provider: string; pages: MaterialTextPage[]; redaction_status: 'redacted' | 'not_redacted'; redacted_pages?: (Pick<MaterialTextPage, 'page' | 'text'> & Partial<Pick<MaterialTextPage, 'method' | 'issues'>>)[] }
export interface Step { ordinal: number; position?:number; display_position?:number; step_key?:string; enabled?:boolean; name: string; status: StepStatus; implemented: boolean; result: Record<string, unknown> | null; error: string | null; started_at: string | null; finished_at: string | null; }
export interface Attempt { id: string; ordinal: number; status: StepStatus; input_revision: number; error: string | null; input: unknown; config?:unknown; result: unknown; started_at: string; finished_at: string | null; }
export interface WorkflowDetail { artifacts: {id:string;kind:string;attempt_id:string;created_at:string;question_version?:string|null}[]; workflow: Workflow; project: Project; materials: Material[]; steps: Step[]; attempts: Attempt[]; }

export interface ProjectStage { ordinal:number;position:number;key:string;name:string;implemented:boolean;total:number;ready:number;queued:number;running:number;succeeded:number;failed:number;config:{provider?:string;model?:string;reasoning_effort?:string;prompt?:string;base_url?:string;enable_thinking?:boolean;max_tokens?:number;required_models?:string[];minimum_score_by_model?:Record<string,number>;revision_budget?:Record<string,number>} }
export interface ProjectDetail { project:Project;workflows:Workflow[];steps:ProjectStage[] }

export interface RuleFile { path:string;sha256:string;size_bytes:number }
export interface RuleWorkspace {
 workspace_path:string;skill_path:string;files:RuleFile[];source_digest:string;
 assessment:Record<string,unknown>;unresolved:{id:string;detail?:string}[];issues:string[];
}
export interface RuleVersion {
 id:string;project_id:string;version:number;status:string;created_at?:string;
 manifest:Partial<RuleWorkspace>&{snapshot_path?:string;execution_scope?:string;official_eligibility?:string};
}
export interface ProjectRules { workspace:RuleWorkspace;versions:RuleVersion[];source_changed:boolean;draft_is_stale:boolean }
