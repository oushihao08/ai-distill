/** 生命周期项目策略的输入输出；仅类型依赖业务模块，不加载执行器或项目代码。 */
import type {AuthoringOptions} from '../authoring/executor';
import type {ScoreContext} from '../scoring/validate';
import type {SyncProjectImplementations} from './project-registry';
export interface ProjectIdentity {project_key?:string|null;parent_name?:string|null;project_name?:string|null;name?:string|null;workspace_path?:string|null;content_contract?:string|null}
export interface AuthoringPlan {
 schema:Record<string,any>;
 validation_options:{requireHarborMetadata:boolean;contentContract?:'work_legal_v1';project_key?:string|null};
 delivery_fields:Record<string,unknown>;
 scoring_instruction:string;
 contract_prefix:string;
 runner_instruction:string;
 task_instruction:string;
 prompt_suffix:string;
}
export interface PackageProjection {rubric:string;private_sections:string[];reference_answer:string}
export interface StepRegistries {
 materialQuestion:SyncProjectImplementations<{project:ProjectIdentity;active:boolean},string|null>;
 authoringPlan:SyncProjectImplementations<{options:AuthoringOptions;base:Record<string,any>},AuthoringPlan>;
 normalize:SyncProjectImplementations<{value:Record<string,any>;contentContract?:string},Record<string,any>>;
 packageProjection:SyncProjectImplementations<{draft:Record<string,any>;includePrivate:boolean},PackageProjection>;
 authoringVersion:SyncProjectImplementations<{options:AuthoringOptions;draft:Record<string,any>},Record<string,unknown>>;
 answerIssue:SyncProjectImplementations<Record<string,any>,string|null>;
 scoreProtocol:SyncProjectImplementations<{context:ScoreContext;frozen?:ScoreContext},boolean>;
 publicationFields:SyncProjectImplementations<Record<string,any>,Record<string,unknown>>;
 archiveDownload:SyncProjectImplementations<ProjectIdentity,boolean>;
}
