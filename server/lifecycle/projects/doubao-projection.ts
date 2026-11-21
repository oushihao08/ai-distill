/** 豆包出题能力需求与运行能力分离、阅读稿考点投影；供步骤策略和飞书导出使用，不启用作答工具。 */
import {ANSWER_LOCAL_TOOLS,OPENROUTER_SERVER_TOOLS} from '../../../shared/types';
import type {AuthoringPlan,StepRegistries} from '../step-types';
import type {AuthoringOptions} from '../../authoring/executor';

/** 只替换外层展示标签；正文、显式计分规则与历史非1分权重原样保留。 */
export function formatDoubaoRubric(rubric:unknown,includeMetadata=false):string {
 if(!Array.isArray(rubric))return '';
 return rubric.map((item:any,index:number)=>{
  if(typeof item==='string')return item;
  const score=item.max_score==null||item.max_score===1?'':`（${item.max_score}分）`;
  const rule=item.rule?`\n计分规则：${item.rule}`:'';
  const metadata=includeMetadata&&item.metadata?`\n业务信息：${JSON.stringify(item.metadata)}`:'';
  return `${index+1}、${score}${item.criterion??''}${rule}${metadata}`;
 }).join('\n\n');
}

function doubaoAuthoringPlan({options,base}:{options:AuthoringOptions;base:Record<string,any>}):AuthoringPlan {
  const schema=structuredClone(base);
  const enabled=[...(options.answer_capabilities?.server_tools??[]),...(options.answer_capabilities?.local_tools??[])];
  const fileEnabled=enabled.includes('artifact_write')&&enabled.includes('artifact_render');
  schema.properties.answer_requirements={type:'object',additionalProperties:false,properties:{input_mode:{type:'string',enum:['text']},output_mode:{type:'string',enum:['text','file']},tools:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}}},required:['input_mode','output_mode','tools']};
  return{schema,validation_options:{requireHarborMetadata:false},delivery_fields:{registered_tool_names:[...OPENROUTER_SERVER_TOOLS,...ANSWER_LOCAL_TOOLS],answer_capabilities:{input_modes:['text'],output_modes:fileEnabled?['text','file']:['text'],tools:enabled,file_formats:fileEnabled?['txt','md','csv','json','html','docx','xlsx']:[],unsupported:['pdf_generation','pixel_rendering']},capability_scope:'answer_capabilities仅描述本机作答现状，不限制出题。registered_tool_names供已有工具名称映射，不是需求白名单；未登记能力也如实声明。需求声明不启用工具，不证明运行就绪。'},scoring_instruction:'',contract_prefix:'',runner_instruction:'按Skill及业务用途设计完整任务，不以本机作答工具开关、工具目录或文件格式支持范围限制题目。answer_requirements如实记录必要能力：文件成果声明output_mode=file及artifact_write、artifact_render；已有工具使用registered_tool_names中的名称，未登记能力使用清晰名称并在完成说明记录对应需求。运行能力缺口不删改题目工作，也不冒充工具已启用或成果已核验。',task_instruction:'保存前按指定 Skill 复核题面、reference_answer、rubric 和 answer_requirements。作者将各件全文存入文本标答；题面须向作答者交办可实际使用的文件。文件用途、专业判断和验收条件由本案决定。',prompt_suffix:''};
}

export function registerDoubaoProjections(registries:StepRegistries){
 for(const project of ['豆包高经济价值','豆包高经济价值-返修']){
  registries.authoringPlan.register(project,doubaoAuthoringPlan);
 }
 registries.packageProjection.register('豆包高经济价值',({draft})=>({
  rubric:formatDoubaoRubric(draft.rubric,true),private_sections:[],reference_answer:draft.reference_answer,
 }));
}
