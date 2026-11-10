/** 职责：材料库文件阅读、任务历史及项目使用页面的精简接口类型；不包含原件路径、密钥或任务配置。 */
import type {MaterialLibraryFile,MaterialLibraryJob,MaterialLibraryRedactionSummary,MaterialLibraryRevision} from '@shared/material-library';
export type LibraryFile=Pick<MaterialLibraryFile,'id'|'original_name'|'sha256'|'size_bytes'|'image_review_required'>;
export type LibraryJobSummary=Pick<MaterialLibraryJob,'id'|'kind'|'status'|'origin'|'created_at'|'finished_at'>;
export type LibraryRedaction=Omit<Pick<MaterialLibraryRedactionSummary,'id'|'extraction_job_id'|'redaction_job_id'|'redaction_template_name'|'usable_for_question'|'created_at'|'output_digest'>,'usable_for_question'>&{usable_for_question:boolean|string};
export type LibraryRevision=Pick<MaterialLibraryRevision,'id'|'state'|'file_count'|'created_at'>&{files:LibraryFile[];jobs:LibraryJobSummary[];redactions:LibraryRedaction[]};
export interface PublicationEvent {
 id:string;project_id:string;project_name:string;workflow_id:string;workflow_title:string|null;workflow_exists:boolean;
 event_type:'archived'|'withdrawn';current_publication_event:'archived'|'withdrawn'|'superseded'|'workflow_deleted';created_at:string;
 provenance:{project_name?:string|null;workflow_title?:string|null;standard_material_package_name?:string|null;material_origin:{kind:string;revision_id?:string;redaction_id?:string};materials:{artifact_id:string;sha256:string}[]};
}
export interface LibraryUsage {
 material_uses?:{id:string;project_name:string;owner_phase_id:string;phase_name:string;phase_no:number|null;status:'in_use'|'submitted';first_used_at:string;updated_at:string;events:{id:string;event_type:string;previous_status:'in_use'|'submitted'|null;status:'in_use'|'submitted';reason:string;evidence:Record<string,unknown>;created_at:string}[]}[];
 loaded_projects:{project_id:string;project_name:string;selected_revision_id:string|null;selected_redaction_id:string|null;created_at:string;removed_at:string|null}[];
 publication_events:PublicationEvent[];
}

/** 材料整理结果的版本与来源标识，用于当前版本状态展示；正文按需读取。 */
export interface LibraryPreparationSummary {id:string;job_id:string;revision_id:string;redaction_id:string|null;project_id:string|null}
