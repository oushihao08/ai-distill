/**
 * 职责：匿名评分执行器：准备题面、rubric、附件与匿名答案，通过独立临时文件向 Codex 会话提供材料，保存评分原文并在返回后提取总分。
 * 关键方法与用途：`buildAnonymousInput()` 白名单化并匿名化内部评分上下文；`runIndependentScore()` 在隔离 Codex 会话评分；`buildScoreFiles()` 生成实际提供给模型的文件；`buildScoreMessage()` 说明文件与提示词；`scoreSchema` 保留旧报告兼容。
 * 使用场景：由评分 worker 调用；不提供思路、目标分或作答模型身份，标准答案仅按显式校准政策提供。
 */
import {mkdir,realpath,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runAgent,SCORE_ISOLATION_CONFIG} from '../agent';
import {createModelApiClient,type ModelApiConfig} from '../llm-api';
import {hookAdditionText,type HookAddition} from '../workflow-hooks';
import {DEFAULT_STEP_PROMPTS,resolveScoreStepPrompt} from '../../shared/step-prompts';
import {extractTextScore,extractModelReport,scoreRubricSnapshot,scoreRubricBindingText,type RubricItem,type ScoreContext} from './validate';
import {buildScoreArithmeticFiles,buildLegacyScorePreflightFiles,LEGACY_PREFLIGHT_INSTRUCTIONS} from './arithmetic-tool';
import {buildCandidateQuoteFiles,CANDIDATE_QUOTE_INSTRUCTIONS} from './candidate-quotes';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
/** 内部上下文保留思路与标答用于题目包校验；只有 buildScoreFiles() 的文件会交给评分模型。 */
export function buildAnonymousInput(context:ScoreContext){
 if(context.candidate_quote_check!==undefined&&(context.candidate_quote_check!=='literal_v1'||context.scoring_policy?.contract!=='model_report_v1'))throw new Error('候选引文核验协议无效');
 const projectFiles=context.project_prompt?.files??context.project_rules?.files??[];
 const rubric=scoreRubricSnapshot(context.rubric,context.scoring_policy);
 if((context.project_name!==undefined&&(typeof context.project_name!=='string'||!context.project_name.trim()))||typeof context.question!=='string'||!context.question.trim()||typeof context.answer_approach!=='string'||!context.answer_approach.trim()||typeof context.reference_answer!=='string'||!context.reference_answer.trim()||typeof context.answer!=='string'||!context.answer.trim()||hash(context.answer)!==context.binding.answer_sha256||!Array.isArray(context.materials)||!context.materials.length||context.materials.some(m=>typeof m.text!=='string'||!m.text.trim())||!Array.isArray(context.rubric)||!context.rubric.length||context.rubric.length>500||new Set(context.rubric.map(r=>r.id)).size!==context.rubric.length||projectFiles.some(file=>!file.path||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isInteger(file.size_bytes)||file.size_bytes<0))throw new Error('评分输入或指纹无效');
 if(hash(scoreRubricBindingText(rubric,context.scoring_policy))!==context.binding.rubric_digest)throw new Error('评分规则指纹不一致');
 return {...(context.candidate_quote_check?{candidate_quote_check:context.candidate_quote_check}:{}),...(context.scoring_policy?{scoring_policy:context.scoring_policy}:{}),...(context.project_name!==undefined?{project_name:context.project_name,question_id:context.question_id,step:'独立评分'}:{}),...(context.answer_presentation?{answer_presentation:context.answer_presentation}:{}),question:context.question,materials:context.materials.map((m,i)=>({name:`附件${i+1}`,text:m.text})),rubric,answer_approach:context.answer_approach,reference_answer:context.reference_answer,answer:context.answer,...(context.step_prompt?{step_prompt:context.step_prompt}:{}),...(context.project_prompt?{project_context:{source_digest:context.project_prompt.source_digest,files:context.project_prompt.files.map(({path,sha256,size_bytes})=>({path,sha256,size_bytes}))}}:context.project_rules?{project_rules:{version_id:context.project_rules!.version_id,source_digest:context.project_rules!.source_digest,files:context.project_rules!.files.map(({path,sha256,size_bytes})=>({path,sha256,size_bytes}))}}:{})};
}
const string={type:'string'};
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const scoreSchema=object({assessment_valid:{type:'boolean'},items:{type:'array',items:object({id:string,score:{type:'number'},reason:string,missing:{type:'boolean'},evidence:{type:'array',items:object({source:{type:'string',enum:['answer','question','material','rubric']},quote:string,material_index:{type:['integer','null']}})}})},total:{type:'number'},max_score:{type:'number'},disputes:{type:'array',items:string}});
export const SCORE_TASK_PROMPT='';
/** 新报告的证据核对方法；入队冻结正文，模型仍负责业务判断及原始成绩。 */
const MODEL_REPORT_READING_INSTRUCTIONS=[
 '核对顺序与来源边界：',
 '先依据题面、Rubric、待评答案.txt和附件完成独立判断，再按本次政策使用校准参考答案。参考答案的事实、措辞和检索记录不代表候选完成过，不覆盖附件，也不增加唯一答案条件。',
 '有文件工具时分段读取长文件；遇到omitted、truncated或其他省略提示，补读遗漏范围后再判断。一次cat、搜索结果截断或文件已列出都不证明全文已读完。无工具的API模式只核对本次实际提供的正文，不声称调用工具或读取未提供内容。',
 '判“未找到”前，核对脱敏别名、同姓主体、案号空格／括号／星号、OCR格式及同一文书的不同版本，并回读相关段落。精确关键词没有命中不等于材料不存在；不能只凭姓名显示形式不同把真实案件判为编造。主体无法可靠区分时说明证据限度，不猜身份。',
 '在每项reason中区分候选证据与核对依据：候选引文只从待评答案.txt逐字复制；材料、题面、Rubric或校准标答的引文注明实际文件及可定位位置。提交前回查引文确实位于所标来源；不得将校准标答的语句或访问记录写成候选证据。未找到时说明核对范围，不补造反证。',
 'Rubric与附件或适用规范冲突时，说明原判据、冲突来源及影响，不用标答覆盖事实、不擅改权重或计分口径；无法形成可靠比较指标时，按冻结规则保留不确定及原因。将工具未执行、事实／法律判断错误和调用失败分别说明，不把能力限制当已完成，也不把技术失败当有效零分。',
].join('\n');
/** 文件只在 Codex 的系统临时工作区生成，不写入持久化评分目录。 */
export function buildScoreFiles(input:ReturnType<typeof buildAnonymousInput>,legacyPreflight=false){
 return [
  {name:'题面与评分标准.txt',text:['【题面】',input.question,'【rubric】',...input.rubric.map(r=>'rule' in r?`${r.id}：${r.criterion}\n计分规则：${r.rule}${r.metadata?`\n业务信息：${JSON.stringify(Object.fromEntries(Object.entries(r.metadata).filter(([key])=>key!=='project_context')))}`:''}`:`${r.id}（满分${r.max_score}）：${r.criterion}`)].join('\n\n')},
  ...input.materials.map((m,i)=>({name:`附件${i+1}.txt`,text:m.text})),
  {name:'待评答案.txt',text:input.answer},
  ...(input.scoring_policy?.contract==='model_report_v1'?buildScoreArithmeticFiles(input.rubric):[]),
  ...(legacyPreflight&&input.scoring_policy?.contract!=='model_report_v1'?buildLegacyScorePreflightFiles(input.rubric):[]),
  ...(input.candidate_quote_check?buildCandidateQuoteFiles():[]),
  ...(input.answer_presentation?[{name:'本次文字呈现约定.txt',text:JSON.stringify(input.answer_presentation)+'\n本轮以回复中的完整文字成果对应成果清单，不因未创建实体文件而认定内容缺失。文件名用于定位对应成果：正文分节可明确对应同名成果且内容齐备时，不因未复述/app/output/等运行目录前缀、未创建目录或文件而扣分；清单中其他有业务意义的结构、字段及格式要求仍按原Rubric核对。不得改变Rubric分值或豁免专业内容要求。实际外部检索、工具执行和文件生成未被本轮验证，相关条目须据实际表现说明限制；不能将文字描述认定为已完成操作，也不能把未验证能力当已通过。'}]:[]),
  ...(input.scoring_policy?.contract==='model_report_v1'&&input.scoring_policy.reference_answer==='calibration'?[{name:'校准参考答案.txt',text:input.reference_answer}]:[]),
 ];
}
/** 仅说明文件用途、完整阅读要求及用户原样评分提示词。 */
export function buildScoreMessage(input:ReturnType<typeof buildAnonymousInput>,readingInstructions=MODEL_REPORT_READING_INSTRUCTIONS,legacyPreflight=false){
 const rubricIds=input.rubric.map(item=>item.id);
 const presentationNote=input.answer_presentation?'完整读取本次文字呈现约定.txt，结合本次实际执行边界评价；不改变原Rubric。':'';
 if(input.scoring_policy?.contract==='model_report_v1')return [
  ...(presentationNote?[presentationNote]:[]),'题面与评分标准：题面与评分标准.txt',`题目附件：${input.materials.map((_,i)=>`附件${i+1}.txt`).join('、')}`,'待评分答案：待评答案.txt',
  '完整读取上述文件，依据本次冻结项目规则逐项独立判断并说明答案证据。每项失分指出本条实际要求及答案中的缺失或错误，不增设目录前缀、措辞或标答唯一表达等条件。必要材料已实际提供时，模型漏读、误读或未答按有效Rubric评价，不反推为出题缺陷；技术调用失败不能当作有效零分。',...(readingInstructions?[readingInstructions]:[]),input.step_prompt??'',`本题冻结项目规则：\n${input.scoring_policy.rules_text}`,
  input.scoring_policy.reference_answer==='calibration'?'校准参考答案：校准参考答案.txt。仅用于结构、字段和数量级校准；不得当作唯一答案键，不得因候选措辞、顺序或同等有效方案不同而扣分。Rubric是计分依据。':'不提供参考答案。',
  `本题条目ID（每个恰好一次，不增加或删改）：${JSON.stringify(rubricIds)}`,
  '算术工具：计分条目.json直接来自本次Rubric，不手抄权重。先完成逐项业务判断，把最终items保存为JSON，再执行python3 复算评分.py <该JSON路径>。工具只求实际加扣分之和、正项满分和净分比例，不判断业务或否决；仅在冻结规则采用净分/正项满分口径时，将net_percentage作为evaluation_percent。其他计分口径不能套用该比例。无工具的API模式如实按冻结规则核算，不声称执行脚本。正文与最终JSON必须对应同一组items；不要在工具计算后改动条目却沿用旧汇总。',
  ...(input.candidate_quote_check?[CANDIDATE_QUOTE_INSTRUCTIONS]:[]),
  '先输出完整评审正文，最后输出唯一结果区：<model_report>有效JSON</model_report>。JSON字段：contract="model_report_v1"；items数组每项包含id、judgment、score_delta（数字或null）、reason；summary包含raw_score、full_score、evaluation_percent（以上各为数字或null）、veto_triggered（布尔或null）。按冻结规则判断加扣分、合计及否决；evaluation_percent是规则明确允许的0—100比较指标，未规定可比较口径时为null。否决独立记录，不擅自归零。不得把绑定、任务身份或程序状态写入结果区。',
 ].join('\n\n');
 const formats=input.rubric.map(item=>`${item.id}：<得分>/${'max_score' in item?item.max_score:''}`);
 return [...(presentationNote?[presentationNote]:[]),`题面与评分标准：题面与评分标准.txt`,`题目附件：${input.materials.map((_,i)=>`附件${i+1}.txt`).join('、')}`,`待评分答案：待评答案.txt`,'请完整读取上述文件。',input.step_prompt??'',`评分条目编号规则（优先级高于前述提示词中的任何格式示例）：必须逐字使用本题清单中的 ID，每个恰好一次；若前述示例与清单不同，以本清单和题面与评分标准文件中的实际 ID 为准，不添加、删除或改写任何前后缀。\n本题rubric ID及逐项格式：\n${formats.join('\n')}`,...(legacyPreflight?[LEGACY_PREFLIGHT_INSTRUCTIONS]:[])].join('\n\n');
}
/** 新契约默认提示不继承旧二元分格式；自定义正文原样保留。 */
function scoringPrompt(context:ScoreContext,prompt?:string){
 const resolved=resolveScoreStepPrompt(prompt??context.step_prompt??DEFAULT_STEP_PROMPTS[6]);
 const source=context.material_mode==='original'?'原文提取附件':'脱敏附件';
 return context.scoring_policy?.contract==='model_report_v1'&&resolved===DEFAULT_STEP_PROMPTS[6]?`依据题面、Rubric、${source}和待评答案评分，逐项说明判断理由和答案原文证据；只评价候选实际表现。`:resolved;
}
/** 原始分和比较指标分开保存，旧消费者不能误用新模式的原始分。 */
function collectScore(text:string,context:ScoreContext,binding:ScoreContext['binding']){
 if(context.scoring_policy?.contract==='model_report_v1'){
  const extraction=extractModelReport(text,context.rubric,context.candidate_quote_check?context.answer:undefined);
  return {score_extraction:{...extraction,total:null,max_score:null},report:{binding,total:null,max_score:null,...(extraction.report??{contract:'model_report_v1'})} as Record<string,unknown>};
 }
 const extraction=extractTextScore(text,context.rubric as RubricItem[]);
 return {score_extraction:extraction,report:{binding,total:extraction.total,max_score:extraction.max_score} as Record<string,unknown>};
}
/** 配置界面与实际执行共用同一指令来源，不以当前指令冒充历史快照。 */
export function scoreExecutionInstructions(provider:'codex'|'api'='codex',contract?:string,quoteCheck?:ScoreContext['candidate_quote_check'],legacyPreflight=false){return {provider,developer_instructions:'',task_prompt:SCORE_TASK_PROMPT,input_format:provider==='api'?'inline_text_blind_v3':'separate_input_files_blind_v3',output_format:'text' as const,isolation_config:provider==='codex'?SCORE_ISOLATION_CONFIG:{},...(contract==='model_report_v1'?{model_report_reading_instructions:MODEL_REPORT_READING_INSTRUCTIONS}:{}),...candidateQuoteExecutionInstructions(quoteCheck),...(legacyPreflight&&provider==='codex'&&contract!=='model_report_v1'?{legacy_text_preflight:'text_v1' as const,legacy_text_preflight_instructions:LEGACY_PREFLIGHT_INSTRUCTIONS,legacy_text_preflight_tool_sha256:hash(buildLegacyScorePreflightFiles([])[1]!.text)}:{})};}
function candidateQuoteExecutionInstructions(check?:ScoreContext['candidate_quote_check']){return check?{candidate_quote_check:check,candidate_quote_instructions:CANDIDATE_QUOTE_INSTRUCTIONS,candidate_quote_tool_sha256:hash(buildCandidateQuoteFiles()[0]!.text)}:{};}
/** JSONB 不保留键顺序，绑定比较按固定字段与排序后的配置项计算。 */
export function scoreExecutionDigest(provider:'codex'|'api'='codex',instructions=scoreExecutionInstructions(provider)){
 const values:unknown[]=[instructions.developer_instructions,instructions.task_prompt,instructions.input_format,instructions.output_format,Object.entries(instructions.isolation_config).sort(([a],[b])=>a.localeCompare(b))];
 if(instructions.model_report_reading_instructions!==undefined)values.push(instructions.model_report_reading_instructions);
 if(instructions.candidate_quote_check!==undefined)values.push(instructions.candidate_quote_check,instructions.candidate_quote_instructions,instructions.candidate_quote_tool_sha256);
 if(instructions.legacy_text_preflight!==undefined)values.push(instructions.legacy_text_preflight,instructions.legacy_text_preflight_instructions,instructions.legacy_text_preflight_tool_sha256);
 return hash(JSON.stringify(values));
}
export async function runIndependentScore(context:ScoreContext,options:{root:string;model:string;reasoning_effort:string;step_prompt?:string;legacy_text_preflight?:boolean;model_report_reading_instructions?:string;hook_additions?:HookAddition[];signal?:AbortSignal;timeout_ms?:number;call_id?:string;execute?:typeof runAgent}){
 // 项目身份与旧项目文件元数据只用于队列绑定，不发送给评分 Agent。
 const input=buildAnonymousInput({...context,project_name:undefined,question_id:undefined,project_prompt:undefined,project_rules:undefined,step_prompt:scoringPrompt(context,options.step_prompt)});
 if(options.signal?.aborted)throw new Error('评分执行已取消');
 const frozen=structuredClone(context.binding);
 let directory:string;
 try{
  await mkdir(resolve(options.root),{recursive:true,mode:0o700});
  const root=await realpath(resolve(options.root));
  directory=join(root,`score-${randomUUID()}`);await mkdir(directory,{mode:0o700});
  const readingInstructions=options.model_report_reading_instructions??MODEL_REPORT_READING_INSTRUCTIONS;
  const legacyPreflight=options.legacy_text_preflight===true&&input.scoring_policy?.contract!=='model_report_v1';
  const prompt=buildScoreMessage(input,readingInstructions,legacyPreflight)+hookAdditionText(options.hook_additions);
  const input_files=buildScoreFiles(input,legacyPreflight);
  const execution_request={...scoreExecutionInstructions('codex',undefined,undefined,legacyPreflight),...candidateQuoteExecutionInstructions(input.candidate_quote_check),...(input.scoring_policy?.contract==='model_report_v1'&&readingInstructions?{model_report_reading_instructions:readingInstructions}:{}),step_prompt:input.step_prompt,model:options.model,reasoning_effort:options.reasoning_effort,input_sha256:hash(JSON.stringify({stdin:prompt,input_files})),stdin:prompt,input_files:input_files.map(file=>({name:file.name,sha256:hash(file.text),size_bytes:Buffer.byteLength(file.text)}))};
  const invocation=await (options.execute??runAgent)({task_type:'independent_scoring',directory,prompt,model:options.model,reasoning_effort:options.reasoning_effort,output_format:'text',input_files,signal:options.signal,timeout_ms:options.timeout_ms,call_id:options.call_id,validate(value){
   if(typeof value!=='string'||!value.trim())throw new Error('评分未返回文本');
   return value;
  }});
  const raw_text=invocation.result;
  const {score_extraction,report}=collectScore(raw_text,context,frozen);
  const cli_request=options.execute?undefined:JSON.parse(await readFile(join(directory,'output','request.json'),'utf8'));
  return {...invocation,execution_request:{...execution_request,...(cli_request?{cli_request}:{})},raw_text,report,score_extraction,validation:score_extraction,directory};
 }catch(error){throw error;}
}

/** API评分接收与Agent相同的获准来源文件正文和评分指令；不读取宿主资料或会话记忆。 */
export async function runIndependentApiScore(context:ScoreContext,options:{config:ModelApiConfig;step_prompt?:string;model_report_reading_instructions?:string;hook_additions?:HookAddition[];signal?:AbortSignal;timeout_ms?:number;call_id?:string;complete?:ReturnType<typeof createModelApiClient>['complete']}){
 const input=buildAnonymousInput({...context,project_name:undefined,question_id:undefined,project_prompt:undefined,project_rules:undefined,step_prompt:scoringPrompt(context,options.step_prompt)});
 if(options.signal?.aborted)throw new Error('评分执行已取消');
 const readingInstructions=options.model_report_reading_instructions??MODEL_REPORT_READING_INSTRUCTIONS;
 const input_files=buildScoreFiles(input),prompt=buildScoreMessage(input,readingInstructions)+hookAdditionText(options.hook_additions);
 const body=[prompt,'【以下为本次评分文件的完整正文】',...input_files.map(file=>`<file name="${file.name}">\n${file.text}\n</file>`)].join('\n\n');
 const call=options.complete??createModelApiClient().complete;
 const result=await call({config:options.config,messages:[{role:'user',content:body}],timeout_ms:options.timeout_ms??1800000,signal:options.signal,call_id:options.call_id});
 const {score_extraction,report}=collectScore(result.text,context,structuredClone(context.binding));
 const session_id=result.completion_id??result.request_id??randomUUID();
 const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
 return{
  raw_text:result.text,
  report:{...report,disputes:[]},
  validation:score_extraction,
  score_extraction,
  session_id,
  usage:result.usage,
  duration_ms:result.duration_ms,
  provider:result.provider,
  model:result.model??result.requested_model,
  execution_request:{provider:result.provider,...candidateQuoteExecutionInstructions(input.candidate_quote_check),...(input.scoring_policy?.contract==='model_report_v1'&&readingInstructions?{model_report_reading_instructions:readingInstructions}:{}),model:result.requested_model,returned_model:result.model,request_id:result.request_id,completion_id:result.completion_id,input_sha256:digest(body),input_files:input_files.map(file=>({name:file.name,sha256:digest(file.text),size_bytes:Buffer.byteLength(file.text)})),started_at:result.started_at,finished_at:result.finished_at},
 };
}
