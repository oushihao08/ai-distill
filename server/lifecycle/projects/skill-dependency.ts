/**
 * Skill Dependency 出题字段：扩展默认 JSON schema，保留公共题面、Rubric 和冻结材料流程。
 * 由 steps.ts 注册；只定义作者需返回的逐题 Skill 与交付元数据，不调用数据库或模型。
 */
import {dependencyFields,formulaCellSchema} from '../../../projects/Skill Dependency/scripts/contract';
import type {StepRegistries} from '../step-types';
import {defaultAuthoringPlan} from '../default-authoring-plan';

const string={type:'string'};
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});

export function registerSkillDependencySteps(registry:StepRegistries){
 registry.authoringPlan.register('Skill Dependency',({options,base})=>{
  const schema=structuredClone(base);
  schema.properties.skill_files={type:'array',minItems:1,maxItems:3,items:object({name:string,content:string})};
  schema.properties.metadata=object({domain:string,complexity:string,capability_tags:{type:'array',items:string},skill_dependency:string});
  schema.properties.task_requirements=object({input_mode:{type:'string',enum:['text','image']},output_mode:{type:'string',enum:['text','file']},tools:{type:'array',items:string}});
  schema.properties.golden_files={type:'array',items:object({path:string,markdown:string,requires_formulas:{type:'boolean'},requires_render:{type:'boolean'},sheets:{type:'array',items:object({name:string,columns:{type:'array',items:string},rows:{type:'array',items:{type:'array',items:{anyOf:[{type:['string','number','boolean']},formulaCellSchema]}}}})}})};
  Object.assign(schema.properties,dependencyFields);
  schema.required=[...Object.keys(dependencyFields),...schema.required,'skill_files','metadata','task_requirements','golden_files'];
  const plan=defaultAuthoringPlan(options,schema);
  return{...plan,contract_prefix:'必须填写delivery_contract、platform_metadata及platform_rubric。delivery_contract.input_names与作者附件名附件N.txt一致；逐题Skill和成果文件名须在题面逐个明示。dependency_rules逐规则填写无Skill及规则改写检查，verification只记录实际完成的核验；未做写not_performed，不能伪造。平台Rubric与公共rubric保持同一判据；权重和档位按platform_rubric保存，不用公共max_score冒充平台格式。XLSX公式使用{formula,cached_value}对象，第一行为列标题。逐题交付字段：skill_files 写1—3份供作答者使用的完整 Skill 文件；metadata 写领域、复杂度依据、能力标签与依赖说明；task_requirements 写真实任务能力；golden_files 写需要实际生成的参考成果，path 为相对文件名，markdown 为正文，xlsx 的 sheets 填工作表。它们与 question、rubric、reference_answer 一同保存，不是项目作者 Skill 的副本。\n',runner_instruction:'answer_requirements 只记录本次本地被测作答器的能力，固定为 text/text/tools=[]；task_requirements 独立表达题目真实业务能力，不能因为本地被测器受限就缩小任务。',task_instruction:'题目以真实业务附件为依据，Instruction 说明使用指定 Skill 及实际成果，不泄露 Skill 内决定性规则；reference_answer 写完整可核对的 Golden Answer。题面要求文件成果时，golden_files 必须给出对应完整内容和可生成格式，不以文件名冒充文件。'};
 });
 registry.authoringVersion.register('Skill Dependency',({draft})=>({skill_files:draft.skill_files,platform_metadata:draft.platform_metadata,platform_rubric:draft.platform_rubric,delivery_contract:draft.delivery_contract,golden_files:draft.golden_files,task_requirements:draft.task_requirements}));
 registry.packageProjection.register('Skill Dependency',({draft})=>({rubric:Array.isArray(draft.rubric)?draft.rubric.map((item:any)=>`${item.id}：${item.criterion}`).join('\n'):'' ,private_sections:[`逐题 Skill：${JSON.stringify(draft.skill_files)}`,`Metadata：${JSON.stringify(draft.metadata)}`,`任务能力：${JSON.stringify(draft.task_requirements)}`,`参考文件：${JSON.stringify(draft.golden_files)}`],reference_answer:draft.reference_answer}));
}
