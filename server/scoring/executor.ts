/**
 * 职责：匿名评分执行器：准备题面、rubric、附件与匿名答案，通过独立临时文件向 Codex 会话提供材料，保存评分原文并在返回后提取总分。
 * 关键方法与用途：`buildAnonymousInput()` 白名单化并匿名化内部评分上下文；`runIndependentScore()` 在隔离 Codex 会话评分；`buildScoreFiles()` 生成实际提供给模型的文件；`buildScoreMessage()` 说明文件与提示词；`scoreSchema` 保留旧报告兼容。
 * 使用场景：由评分 worker 调用；评分模型不接收作答思路、标准答案、目标分或作答模型身份。
 */
import {mkdir,realpath,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runAgent,SCORE_ISOLATION_CONFIG} from '../agent';
import {DEFAULT_STEP_PROMPTS,resolveScoreStepPrompt} from '../../shared/step-prompts';
import {extractTextScore,type ScoreContext} from './validate';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
/** 内部上下文保留思路与标答用于题目包校验；只有 buildScoreFiles() 的文件会交给评分模型。 */
export function buildAnonymousInput(context:ScoreContext){
 const projectFiles=context.project_prompt?.files??context.project_rules?.files??[];
 if((context.project_name!==undefined&&(typeof context.project_name!=='string'||!context.project_name.trim()))||typeof context.question!=='string'||!context.question.trim()||typeof context.answer_approach!=='string'||!context.answer_approach.trim()||typeof context.reference_answer!=='string'||!context.reference_answer.trim()||typeof context.answer!=='string'||!context.answer.trim()||hash(context.answer)!==context.binding.answer_sha256||!Array.isArray(context.materials)||!context.materials.length||context.materials.some(m=>typeof m.text!=='string'||!m.text.trim())||!Array.isArray(context.rubric)||!context.rubric.length||context.rubric.length>500||new Set(context.rubric.map(r=>r.id)).size!==context.rubric.length||context.rubric.some(r=>typeof r.id!=='string'||!r.id.trim()||typeof r.criterion!=='string'||!r.criterion.trim()||!Number.isFinite(r.max_score)||r.max_score<=0)||projectFiles.some(file=>!file.path||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isInteger(file.size_bytes)||file.size_bytes<0))throw new Error('评分输入或指纹无效');
 const rubric=context.rubric.map(r=>({id:r.id,criterion:r.criterion,max_score:r.max_score}));
 if(hash(JSON.stringify(rubric))!==context.binding.rubric_digest)throw new Error('评分规则指纹不一致');
 return {...(context.project_name!==undefined?{project_name:context.project_name,question_id:context.question_id,step:'独立评分'}:{}),question:context.question,materials:context.materials.map((m,i)=>({name:`附件${i+1}`,text:m.text})),rubric,answer_approach:context.answer_approach,reference_answer:context.reference_answer,answer:context.answer,...(context.step_prompt?{step_prompt:context.step_prompt}:{}),...(context.project_prompt?{project_context:{source_digest:context.project_prompt.source_digest,files:context.project_prompt.files.map(({path,sha256,size_bytes})=>({path,sha256,size_bytes}))}}:context.project_rules?{project_rules:{version_id:context.project_rules!.version_id,source_digest:context.project_rules!.source_digest,files:context.project_rules!.files.map(({path,sha256,size_bytes})=>({path,sha256,size_bytes}))}}:{})};
}
const string={type:'string'};
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const scoreSchema=object({assessment_valid:{type:'boolean'},items:{type:'array',items:object({id:string,score:{type:'number'},reason:string,missing:{type:'boolean'},evidence:{type:'array',items:object({source:{type:'string',enum:['answer','question','material','rubric']},quote:string,material_index:{type:['integer','null']}})}})},total:{type:'number'},max_score:{type:'number'},disputes:{type:'array',items:string}});
export const SCORE_TASK_PROMPT='';
/** 文件只在 Codex 的系统临时工作区生成，不写入持久化评分目录。 */
export function buildScoreFiles(input:ReturnType<typeof buildAnonymousInput>){
 return [
  {name:'题面与评分标准.txt',text:['【题面】',input.question,'【rubric】',...input.rubric.map(r=>`${r.id}（满分${r.max_score}）：${r.criterion}`)].join('\n\n')},
  ...input.materials.map((m,i)=>({name:`附件${i+1}.txt`,text:m.text})),
  {name:'待评答案.txt',text:input.answer},
 ];
}
/** 仅说明文件用途、完整阅读要求及用户原样评分提示词。 */
export function buildScoreMessage(input:ReturnType<typeof buildAnonymousInput>){
 const rubricIds=input.rubric.map(item=>item.id);
 const formats=input.rubric.map(item=>`${item.id}：<得分>/${item.max_score}`);
 return [`题面与评分标准：题面与评分标准.txt`,`题目附件：${input.materials.map((_,i)=>`附件${i+1}.txt`).join('、')}`,`待评分答案：待评答案.txt`,'请完整读取上述文件。',input.step_prompt??'',`评分条目编号规则（优先级高于前述提示词中的任何格式示例）：必须逐字使用本题清单中的 ID，每个恰好一次；若前述示例与清单不同，以本清单和题面与评分标准文件中的实际 ID 为准，不添加、删除或改写任何前后缀。\n本题rubric ID及逐项格式：\n${formats.join('\n')}`].join('\n\n');
}
/** 配置界面与实际执行共用同一指令来源，不以当前指令冒充历史快照。 */
export function scoreExecutionInstructions(){return {developer_instructions:'',task_prompt:SCORE_TASK_PROMPT,input_format:'separate_input_files_blind_v2',output_format:'text' as const,isolation_config:SCORE_ISOLATION_CONFIG};}
/** JSONB 不保留键顺序，绑定比较按固定字段与排序后的配置项计算。 */
export function scoreExecutionDigest(instructions=scoreExecutionInstructions()){
 return hash(JSON.stringify([instructions.developer_instructions,instructions.task_prompt,instructions.input_format,instructions.output_format,Object.entries(instructions.isolation_config).sort(([a],[b])=>a.localeCompare(b))]));
}
export async function runIndependentScore(context:ScoreContext,options:{root:string;model:string;reasoning_effort:string;step_prompt?:string;signal?:AbortSignal;timeout_ms?:number;call_id?:string;execute?:typeof runAgent}){
 // 项目身份与旧项目文件元数据只用于队列绑定，不发送给评分 Agent。
 const input=buildAnonymousInput({...context,project_name:undefined,question_id:undefined,project_prompt:undefined,project_rules:undefined,step_prompt:resolveScoreStepPrompt(options.step_prompt??context.step_prompt??DEFAULT_STEP_PROMPTS[6])});
 if(options.signal?.aborted)throw new Error('评分执行已取消');
 const frozen=structuredClone(context.binding);
 let directory:string;
 try{
  await mkdir(resolve(options.root),{recursive:true,mode:0o700});
  const root=await realpath(resolve(options.root));
  directory=join(root,`score-${randomUUID()}`);await mkdir(directory,{mode:0o700});
  const prompt=buildScoreMessage(input);
  const input_files=buildScoreFiles(input);
  const execution_request={...scoreExecutionInstructions(),step_prompt:input.step_prompt,model:options.model,reasoning_effort:options.reasoning_effort,input_sha256:hash(JSON.stringify({stdin:prompt,input_files})),stdin:prompt,input_files:input_files.map(file=>({name:file.name,sha256:hash(file.text),size_bytes:Buffer.byteLength(file.text)}))};
  const invocation=await (options.execute??runAgent)({task_type:'independent_scoring',directory,prompt,model:options.model,reasoning_effort:options.reasoning_effort,output_format:'text',input_files,signal:options.signal,timeout_ms:options.timeout_ms,call_id:options.call_id,validate(value){
   if(typeof value!=='string'||!value.trim())throw new Error('评分未返回文本');
   return value;
  }});
  const raw_text=invocation.result;
  const score_extraction=extractTextScore(raw_text,context.rubric);
  const report:Record<string,unknown>={binding:frozen,total:score_extraction.total,max_score:score_extraction.max_score};
  const cli_request=options.execute?undefined:JSON.parse(await readFile(join(directory,'output','request.json'),'utf8'));
  return {...invocation,execution_request:{...execution_request,...(cli_request?{cli_request}:{})},raw_text,report,score_extraction,validation:score_extraction,directory};
 }catch(error){throw error;}
}
