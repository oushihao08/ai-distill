/** 职责：限时生成整包ID/文本脱敏结果，按冻结字段映射回填原结构；由材料库runner调用，不自行入队或写库。 */
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {runAgent,type AgentTask,type AgentResult} from '../agent';
import {AGENT_TEXT_REDACTION_PROTOCOL,compileAgentTextMaterialPlan,type PreparationFile} from '../../shared/agent-material-plan';
import {canonicalJson} from '../../shared/workflow-config';
import {prepareAgentRedactionArtifacts,readAgentRedactionPlan,writePrivateJson} from './agent-redaction-artifacts';
import {apiMaterialExecutor} from './api-redaction';
import type {ModelApiConfig} from '../llm-api';

type Options={directory:string;files:PreparationFile[];revision_id:string;extraction_job_id:string;template:{id:string;digest:string;redaction:{prompt:string}};model:string;reasoning_effort:string;api?:ModelApiConfig;signal?:AbortSignal;timeout_ms?:number;previous_directory?:string;execute?:<T>(task:AgentTask<T>)=>Promise<AgentResult<T>>};
const completionSchema={type:'object',additionalProperties:false,properties:{plan_file:{type:'string',enum:['output/material-plan.json']}},required:['plan_file']};
function timeoutError(){return Object.assign(new Error('Agent脱敏达到执行预算，已停止并保留私有进度'),{reason_code:'agent_redaction_timeout'});}
export function validateAgentPlanFileDeclaration(value:unknown):{plan_file:string}{
 if(!value||typeof value!=='object'||(value as any).plan_file!=='output/material-plan.json')throw Object.assign(new Error('Agent材料计划文件声明无效'),{reason_code:'agent_plan_file_declaration_invalid'});
 return value as {plan_file:string};
}

export async function prepareAgentLibraryMaterials(options:Options){
 const validatorCommand=process.platform==='win32'?'node --preserve-symlinks-main --preserve-symlinks validate-plan.mjs':'bun validate-plan.mjs';
 const started=performance.now(),budget=options.timeout_ms??1200000;
 if(!Number.isFinite(budget)||budget<=0)throw timeoutError();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(timeoutError()),budget);
 const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 const identity={revision_id:options.revision_id,extraction_job_id:options.extraction_job_id,template_id:options.template.id,template_digest:options.template.digest};
 const fingerprint=createHash('sha256').update(canonicalJson({...identity,files:options.files.map(f=>({file_id:f.file_id,text_sha256:f.text_sha256,structure_sha256:createHash('sha256').update(canonicalJson(f.pages.map(page=>({page:page.page,structure:page.structure})))).digest('hex')})),text_protocol:AGENT_TEXT_REDACTION_PROTOCOL,model:options.model,reasoning_effort:options.reasoning_effort,...(options.api?{api:options.api}:{})})).digest('hex');
 try{
  await prepareAgentRedactionArtifacts({...options,fingerprint,identity});
  if(signal.aborted)throw signal.reason;
  const output=await (options.execute??(options.api?apiMaterialExecutor(options.api):runAgent))<{plan_file:string}>({task_type:'material_preparation',directory:options.directory,model:options.model,reasoning_effort:options.reasoning_effort,schema:completionSchema,
   timeout_ms:Math.max(1,budget-(performance.now()-started)),signal,
   prompt:options.template.redaction.prompt+`

【本次执行接口：${AGENT_TEXT_REDACTION_PROTOCOL}，交付格式以本节及plan-schema.json为准】
- source.json仅包含texts，每项只有唯一id和原文text；按原顺序阅读全包，跨字段保持主体化名一致。
- 将完整结果保存为output/material-plan.json（API直接返回完整JSON）。
- 输出texts完整列表：每个输入id恰好返回一次，text为完成化名、号码遮盖及确定扫描垃圾清理后的全文；未改文本原样返回，明确删除返回空字符串。禁止改写其他业务内容。不要返回entities或edits。
- 原页、标题层级、表格行列及合并关系由宿主持有并按id回填。保持输入阅读顺序；同文不同id是不同位置，不能合并或遗漏；原空字段保持空字符串。
- 文本id为“块ID#字段路径”，#前是分册所用block_id。块ID带文件/页作用域并沿用原块标识；缺失或重复标识时由宿主补位置，不自行改ID。documents.ranges以first_block_id和last_block_id指定完整文书范围，全部块恰好归属一次；unresolved按具体字段id记录疑点。
- 若有resume，先读取已有计划，沿用已确认化名并核对全包；可按需保存进度，不要求另写分项文件。
${options.api?'- API执行接口：上述文件由宿主以内联JSON完整提供，不访问本地路径、不调用shell。直接返回符合plan_schema的完整JSON计划，不返回plan_file。宿主运行同一校验器，valid:false时修正实际条目后返回完整计划，valid:true时由宿主保存文件并结束。':`- 在本次执行预算内运行${validatorCommand}。它直接接受上述计划，内部坐标转换无需你处理。返回valid:false就修正实际条目后再校验；valid:true后最终只返回{"plan_file":"output/material-plan.json"}。超时保留计划，不自行重试。`}`,
   validate:validateAgentPlanFileDeclaration,
  });
  const plan=await readAgentRedactionPlan(options.directory);
  await writePrivateJson(join(options.directory,'semantic-plan.private.json'),plan);
  if(signal.aborted)throw signal.reason;
  const compiled=compileAgentTextMaterialPlan(plan,options.files,identity);
  if(signal.aborted||performance.now()-started>=budget)throw timeoutError();
  await writePrivateJson(join(options.directory,'exact-plan.private.json'),compiled.plan);
  return {...compiled,text_protocol:AGENT_TEXT_REDACTION_PROTOCOL,provider:output.provider,session_id:output.session_id,usage:output.usage,duration_ms:Math.round(performance.now()-started),model:output.model,requested_model:output.requested_model??options.model,returned_model:output.returned_model??null,entity_count:null,unresolved_count:plan.unresolved.length};
 }catch(error){if(controller.signal.aborted)throw timeoutError();throw error;}finally{clearTimeout(timer);}
}
