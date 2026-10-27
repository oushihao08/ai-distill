/**
 * Work法律全场景的生命周期注册位置。
 * 由 lifecycle/steps.ts 与 project-delivery.ts 装配；步骤本身不得根据 Work 名称分支。
 * 准备/五件套内容仍由 projects/Work法律全场景/scripts 维护，本文件维护专属策略与接入点；公共执行/事务由各步骤管理。
 * 执行必须等待项目准备和五件套完成；失败向公共归档传播，不登记归档成功。
 */
import type {ProjectImplementations, ProjectImplementation, ProjectKeyRegistry} from '../project-registry';
import type {ProjectDeliveryContext} from '../project-delivery';
export const WORK_PROJECT_KEY = 'Work法律全场景';
export function registerWorkDelivery(registry:ProjectImplementations<ProjectDeliveryContext,void>,scriptDelivery:ProjectImplementation<ProjectDeliveryContext,void>) {
 return registry.register(WORK_PROJECT_KEY,scriptDelivery);
}


import {defaultPackageProjection} from '../default-projection';
import {defaultAuthoringPlan} from '../default-authoring-plan';
import {basename} from 'node:path';
import type {StepRegistries,ProjectIdentity} from '../step-types';
import {workQuestionSchema,projectReference,projectRule} from './work-contract';
import {canonicalJson} from '../../../shared/workflow-config';
/** 历史字段只用于恢复原有行为；不将项目身份字段追加进旧冻结摘要。 */
function matchesWork(project:ProjectIdentity){
 return project.content_contract==='work_legal_v1'||project.parent_name===WORK_PROJECT_KEY||project.project_name===WORK_PROJECT_KEY||project.project_name?.startsWith(`${WORK_PROJECT_KEY} - `)===true||(project.parent_name??project.name?.split(' - ')[0])===WORK_PROJECT_KEY||!!project.workspace_path&&basename(project.workspace_path)===WORK_PROJECT_KEY;
}
/** Work在1—7的专属注册：同步纯策略不执行模型，不控制公共事务和调度。 */
export function registerWorkSteps(registry:StepRegistries,keys:ProjectKeyRegistry<ProjectIdentity>){
 keys.register(WORK_PROJECT_KEY,matchesWork);
 registry.materialQuestion.register(WORK_PROJECT_KEY,({active})=>active?'Work法律全场景每个材料包只能对应一道题，请在原题返修':null);
 registry.authoringPlan.register(WORK_PROJECT_KEY,({options,base})=>{
  if(options.scoring_policy?.contract!=='model_report_v1')throw new Error('Work 法律全场景出题必须配置 model_report_v1，才能保存五件套／六件套所需的 Harbor 映射');
  const modern=options.content_contract==='work_legal_v1',requireHarborMetadata=!options.content_contract;
  return {
   ...defaultAuthoringPlan(options,base),
   schema:modern?workQuestionSchema(base):base,
   validation_options:{requireHarborMetadata,contentContract:options.content_contract},
   delivery_fields:modern?{input_files:options.materials.map((m,i)=>({attachment_id:m.id,name:`附件${i+1}`,description:'由作者依据本份材料填写完整用途说明'}))}:{},
   ...(modern?{
    scoring_instruction:'按上述计分语义填写原始metadata.statement和分值字段；旧政策提到的criterion/rule由程序等义派生，不由作者重复填写。独立否决保持原意，不赋数值权重。',
    contract_prefix:'内容契约：work_legal_v1。完整读取指定Skill入口及其要求的规则文件；若有模板则按其导航读取。input_files的attachment_id与name从delivery.json.input_files按顺序原样复制，description按本份材料填写；原文件名只作显示，不替换映射名称。按delivery.json的schema填写独立整题信息、逐份完整成果、实际检索和原始评分字段。criterion/rule与reference_answer由程序派生，不另写第二份。真实业务能力填task_requirements，不能为当前文字runner删去必要法律工作；不兼容能力只影响后续执行，不阻止保存完整设计。\n',
    runner_instruction:'question由task_metadata.instruction与deliverables同源派生，作者不另填question；背景、委托诉求、基准日和硬约束分字段填写，成果要求只维护deliverables。baseline_date无适用时点时才填null，不拿开庭日或法条年份猜填。answer_requirements是程序派生的当前runner信息，作者不填写；task_requirements只写真实业务能力，不将作者工具机械填为候选义务。',
    task_instruction:'题目按真实任务设计，必要检索/文件能力在task_requirements如实记录；作者检索与候选义务分开，不自动泄露解题结论。',
   }:{}),
   prompt_suffix:requireHarborMetadata?'\n\nWork 出题元数据：本题须在一条 Rubric 的 metadata.project_context.harbor 中保留完整 Harbor metadata、逐份 input_files 映射和说明。task_id、org 是外部登记身份，已提供则原样保留，未提供可省略或为 null，不猜测，也不因此停止保存题包；归档时另行校验。这不免除专业元数据、完整题面、答案和判据要求。':'',
  };
 });
 registry.normalize.register(WORK_PROJECT_KEY,({value,contentContract})=>{
  if(contentContract!=='work_legal_v1'&&value.content_contract!=='work_legal_v1')return value;
  const instruction=value.task_metadata?.instruction;
  if(!value.question&&instruction){
   const numbered=(entries:any[])=>entries.map((entry,index)=>`${index+1}. ${entry}`).join('\n');
   value.question=[instruction.background?`背景\n${instruction.background}`:'',Array.isArray(instruction.requests)?`委托方诉求\n${numbered(instruction.requests)}`:'',Array.isArray(value.deliverables)?`交付物要求\n${numbered(value.deliverables.map((file:any)=>`${file.path}（${file.required?'必交':'选交'}）：${file.description??''}`))}`:'',instruction.baseline_date?`基准日：${instruction.baseline_date}`:'',instruction.hard_constraints?.length?`硬性约束\n${numbered(instruction.hard_constraints)}`:''].filter(Boolean).join('\n\n');
  }
  if(!value.reference_answer&&Array.isArray(value.reference_outputs))value.reference_answer=projectReference({...value,deliverables:value.deliverables??[],reference_outputs:value.reference_outputs.map((output:any)=>({...output,sheets:output.sheets??[]}))});
  return value;
 });
 registry.packageProjection.register(WORK_PROJECT_KEY,({draft,includePrivate})=>draft.content_contract!=='work_legal_v1'?defaultPackageProjection({draft}):({
  rubric:draft.rubric.map((item:any)=>`${item.id}\n${projectRule(item.metadata)}\n评分字段：${JSON.stringify(item.metadata)}`).join('\n\n'),
  private_sections:[`整题信息\n${JSON.stringify(draft.task_metadata,null,2)}`,`材料清单\n${JSON.stringify(draft.input_files,null,2)}`,`成果清单\n${JSON.stringify(draft.deliverables,null,2)}`,`任务能力\n${JSON.stringify(draft.task_requirements)}`,`内容状态\n${JSON.stringify(draft.content_status)}`,`作者检索记录\n${JSON.stringify(draft.research_records,null,2)}`],
  reference_answer:includePrivate?projectReference(draft):draft.reference_answer,
 }));
 registry.authoringVersion.register(WORK_PROJECT_KEY,({options,draft})=>options.content_contract?{content_contract:options.content_contract,work_content:JSON.parse(canonicalJson(draft)),task_requirements:draft.task_requirements,deliverables:draft.deliverables}:{});
 registry.answerIssue.register(WORK_PROJECT_KEY,value=>{
  if(value?.content_contract!=='work_legal_v1')return null;
  const task=value.task_requirements,status=value.content_status;
  if(status?.status!=='complete')return 'Work题目仍为草稿，不能作答';
  if(!task||task.input_mode!=='text'||!['text','file'].includes(task.output_mode)||!Array.isArray(task.tools))return '当前作答器仅支持文字输入；非文字任务不能按文字测试';
  return null;
 });
 registry.scoreProtocol.register(WORK_PROJECT_KEY,({context,frozen})=>{
  if(context.content_contract!=='work_legal_v1')return frozen?.candidate_quote_check===undefined;
  if(frozen){if(frozen.candidate_quote_check!==undefined)context.candidate_quote_check=frozen.candidate_quote_check;}
  else if(context.scoring_policy?.contract==='model_report_v1')context.candidate_quote_check='literal_v1';
  return true;
 });
 registry.publicationFields.register(WORK_PROJECT_KEY,q=>q.content_contract?{content_contract:q.content_contract,task_metadata:q.task_metadata,input_files:q.input_files,deliverables:q.deliverables,reference_outputs:q.reference_outputs,research_records:q.research_records,task_requirements:q.task_requirements,content_status:q.content_status}:{});
 registry.archiveDownload.register(WORK_PROJECT_KEY,()=>true);
}
