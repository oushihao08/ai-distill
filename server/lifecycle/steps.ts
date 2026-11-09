/**
 * 1—7步骤的项目策略门面。公共步骤传身份和执行点，注册装配集中到projects目录。
 * 这里只提供通用默认值；纯策略同步返回并传播错误，不创建队列/事务或修改业务状态。
 * 原有数据契约标识保留在快照，历史兼容的识别规则由项目注册声明。
 */
import {SyncProjectImplementations,ProjectKeyRegistry} from './project-registry';
import {defaultPackageProjection} from './default-projection';
import {defaultAuthoringPlan} from './default-authoring-plan';
import type {ProjectIdentity,StepRegistries} from './step-types';
import {registerWorkSteps} from './projects/work';
import {registerDoubaoProjections} from './projects/doubao-projection';
import {registerSkillDependencySteps} from './projects/skill-dependency';
export type {ProjectIdentity} from './step-types';
const projectKeys=new ProjectKeyRegistry<ProjectIdentity>();
/** 显式key优先；兼容名称/契约/目录的项目识别只在项目实现中维护。 */
export function resolveStepProjectKey(project:ProjectIdentity={}):string|null {
 if(project.project_key!==undefined)return project.project_key;
 const registered=projectKeys.resolve(project);
 if(registered)return registered;
 return project.parent_name??(project.project_name??project.name)?.split(' - ')[0]??null;
}
export const projectStepPolicies:StepRegistries={
 materialQuestion:new SyncProjectImplementations(()=>null),
 authoringPlan:new SyncProjectImplementations(({options,base})=>defaultAuthoringPlan(options,base)),
 normalize:new SyncProjectImplementations(({value})=>value),
 packageProjection:new SyncProjectImplementations(input=>defaultPackageProjection(input)),
 authoringVersion:new SyncProjectImplementations(()=>({})),
 answerIssue:new SyncProjectImplementations(()=>null),
 scoreProtocol:new SyncProjectImplementations(({frozen})=>frozen?.candidate_quote_check===undefined),
 publicationFields:new SyncProjectImplementations(()=>({})),
 archiveDownload:new SyncProjectImplementations(()=>false),
};
registerWorkSteps(projectStepPolicies,projectKeys);
registerDoubaoProjections(projectStepPolicies);
registerSkillDependencySteps(projectStepPolicies);
// 豆包定制阅读稿投影及新题可声明的受控作答能力；飞书仍在独立交付注册中维护。
