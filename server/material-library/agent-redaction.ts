/** 职责：用一个限时Agent会话生成整包语义计划，私有保存主体表/进度，再复用精确结构校验。由材料库runner调用；不自行入队或写业务数据库。 */
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {runAgent,type AgentTask,type AgentResult} from '../agent';
import {compileAgentMaterialPlan,type PreparationFile} from '../../shared/agent-material-plan';
import {canonicalJson} from '../../shared/workflow-config';
import {prepareAgentRedactionArtifacts,readAgentRedactionPlan,writePrivateJson} from './agent-redaction-artifacts';
import {apiMaterialExecutor} from './api-redaction';
import type {ModelApiConfig} from '../llm-api';

type Options={directory:string;files:PreparationFile[];revision_id:string;extraction_job_id:string;template:{id:string;digest:string;redaction:{prompt:string}};model:string;reasoning_effort:string;api?:ModelApiConfig;signal?:AbortSignal;timeout_ms?:number;previous_directory?:string;execute?:<T>(task:AgentTask<T>)=>Promise<AgentResult<T>>};
const completionSchema={type:'object',additionalProperties:false,properties:{plan_file:{type:'string',enum:['output/material-plan.json']}},required:['plan_file']};
function timeoutError(){return Object.assign(new Error('Agent脱敏达到执行预算，已停止并保留私有进度'),{reason_code:'agent_redaction_timeout'});}

export async function prepareAgentLibraryMaterials(options:Options){
 const validatorCommand=process.platform==='win32'?'node --preserve-symlinks-main --preserve-symlinks validate-plan.mjs':'bun validate-plan.mjs';
 const started=performance.now(),budget=options.timeout_ms??1200000;
 if(!Number.isFinite(budget)||budget<=0)throw timeoutError();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(timeoutError()),budget);
 const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 const identity={revision_id:options.revision_id,extraction_job_id:options.extraction_job_id,template_id:options.template.id,template_digest:options.template.digest};
 const fingerprint=createHash('sha256').update(canonicalJson({...identity,files:options.files.map(f=>({file_id:f.file_id,text_sha256:f.text_sha256})),model:options.model,reasoning_effort:options.reasoning_effort,...(options.api?{api:options.api}:{})})).digest('hex');
 try{
  await prepareAgentRedactionArtifacts({...options,fingerprint,identity});
  if(signal.aborted)throw signal.reason;
  const output=await (options.execute??(options.api?apiMaterialExecutor(options.api):runAgent))<{plan_file:string}>({task_type:'material_preparation',directory:options.directory,model:options.model,reasoning_effort:options.reasoning_effort,schema:completionSchema,
   timeout_ms:Math.max(1,budget-(performance.now()-started)),signal,
   prompt:options.template.redaction.prompt+`

【本次执行接口】
- 读取source.json的全部字段与结构块；review-hints.json只是导航，plan-schema.json是计划格式。
- ${options.api?'直接返回完整JSON计划，宿主保存为output/material-plan.json':'只需将完整计划保存为output/material-plan.json，可用工具辅助整理'}，不修改输入。entities记录化名及原称；variants.targets=[]表示已确认可全包替换，有同名歧义时列具体target_id。
- edits用target_id和连续原文source_text定位，occurrence=0表示该字段内全部出现，正整数表示从1起的第几次；kind按Schema选择，credential表示凭据全遮。地址的keep_prefix只填可保留行政区划，无法确认填空串，其他类别也填空串。程序负责字符坐标、遮盖和确定格式还原。
- documents.ranges以first_block_id和last_block_id指定完整文书起止，全部块恰好归属一次，跨页合并、同页多件分开。unresolved按具体字段或块记录疑点。
- 若有resume，先读取已有计划，沿用已确认化名并核对全包；可按需保存进度，不要求另写分项文件。
${options.api?'- API执行接口：上述文件由宿主以内联JSON完整提供，不访问本地路径、不调用shell。直接返回符合plan_schema的完整JSON计划，不返回plan_file。宿主运行同一校验器，valid:false时修正实际条目后返回完整计划，valid:true时由宿主保存文件并结束。':`- 在本次执行预算内运行${validatorCommand}。它直接接受上述计划，内部坐标转换无需你处理。返回valid:false就修正实际条目后再校验；valid:true后最终只返回{"plan_file":"output/material-plan.json"}。超时保留计划，不自行重试。`}`,
   validate(value){if(!value||typeof value!=='object'||(value as any).plan_file!=='output/material-plan.json')throw Object.assign(new Error('Agent材料计划文件声明缺失'),{reason_code:'agent_plan_file_missing'});return value as {plan_file:string};},
  });
  const plan=await readAgentRedactionPlan(options.directory);
  await writePrivateJson(join(options.directory,'semantic-plan.private.json'),plan);
  await writePrivateJson(join(options.directory,'主体对应表.private.json'),{...identity,fingerprint,entities:plan.entities});
  if(signal.aborted)throw signal.reason;
  const compiled=compileAgentMaterialPlan(plan,options.files,identity);
  if(signal.aborted||performance.now()-started>=budget)throw timeoutError();
  await writePrivateJson(join(options.directory,'exact-plan.private.json'),compiled.plan);
  return {...compiled,provider:output.provider,session_id:output.session_id,usage:output.usage,duration_ms:Math.round(performance.now()-started),model:output.model,requested_model:output.requested_model??options.model,returned_model:output.returned_model??null,entity_count:plan.entities.length,unresolved_count:plan.unresolved.length};
 }catch(error){if(controller.signal.aborted)throw timeoutError();throw error;}finally{clearTimeout(timer);}
}
