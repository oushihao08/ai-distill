/** 豆包阅读稿的考点编号投影；由步骤策略与飞书字段导出共用，不修改结构化判据或评分输入。 */
import type {StepRegistries} from '../step-types';

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

export function registerDoubaoProjections(registries:StepRegistries){
 registries.authoringPlan.register('豆包高经济价值',({options,base})=>{
  const schema=structuredClone(base);
  const enabled=[...(options.answer_capabilities?.server_tools??[]),...(options.answer_capabilities?.local_tools??[])];
  const fileEnabled=enabled.includes('artifact_write')&&enabled.includes('artifact_render');
  schema.properties.answer_requirements={type:'object',additionalProperties:false,properties:{input_mode:{type:'string',enum:['text']},output_mode:{type:'string',enum:fileEnabled?['text','file']:['text']},tools:{type:'array',uniqueItems:true,items:{type:'string',enum:enabled}}},required:['input_mode','output_mode','tools']};
  return{schema,validation_options:{requireHarborMetadata:false},delivery_fields:{answer_capabilities:{input_modes:['text'],output_modes:fileEnabled?['text','file']:['text'],tools:enabled,file_formats:fileEnabled?['txt','md','csv','json','html','docx','xlsx']:[],unsupported:['pdf_generation','pixel_rendering']}},scoring_instruction:'',contract_prefix:'',runner_instruction:'answer_requirements 按本次冻结的 answer_capabilities 和本题真实最低能力填写。文件成果仅在 output_mode 允许 file 时设置，且 tools 同时包含 artifact_write、artifact_render；DOCX/XLSX可真实生成并按结构与生成源读回，但不声称像素级渲染。PDF当前不可生成，不得要求。联网或Shell只有在题目确实要求且本次能力已开放时才填写。',task_instruction:'题面要求的能力必须与 answer_requirements 一致；不得把作者使用的工具当成候选义务，也不得把未开放的能力写入任务。',prompt_suffix:''};
 });
 registries.packageProjection.register('豆包高经济价值',({draft})=>({
  rubric:formatDoubaoRubric(draft.rubric,true),private_sections:[],reference_answer:draft.reference_answer,
 }));
}
