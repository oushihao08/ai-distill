/** 职责：用一个限时Agent会话生成整包语义计划，私有保存主体表/进度，再复用精确结构校验。由材料库runner调用；不自行入队或写业务数据库。 */
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {runAgent,type AgentTask,type AgentResult} from '../agent';
import {compileAgentMaterialPlan,type PreparationFile} from '../../shared/agent-material-plan';
import {AGENT_REDACTION_MAX_MS} from '../../shared/redaction-templates';
import {canonicalJson} from '../../shared/workflow-config';
import {prepareAgentRedactionArtifacts,readAgentRedactionPlan,writePrivateJson} from './agent-redaction-artifacts';

type Options={directory:string;files:PreparationFile[];revision_id:string;extraction_job_id:string;template:{id:string;digest:string;redaction:{prompt:string}};model:string;reasoning_effort:string;signal?:AbortSignal;timeout_ms?:number;previous_directory?:string;execute?:<T>(task:AgentTask<T>)=>Promise<AgentResult<T>>};
const completionSchema={type:'object',additionalProperties:false,properties:{plan_file:{type:'string',enum:['output/material-plan.json']}},required:['plan_file']};
function timeoutError(){return Object.assign(new Error('Agent脱敏达到执行预算，已停止并保留私有进度'),{reason_code:'agent_redaction_timeout'});}

export async function prepareAgentLibraryMaterials(options:Options){
 const started=performance.now(),budget=Math.min(AGENT_REDACTION_MAX_MS,options.timeout_ms??AGENT_REDACTION_MAX_MS);
 if(!Number.isFinite(budget)||budget<=0)throw timeoutError();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(timeoutError()),budget);
 const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 const identity={revision_id:options.revision_id,extraction_job_id:options.extraction_job_id,template_id:options.template.id,template_digest:options.template.digest};
 const fingerprint=createHash('sha256').update(canonicalJson({...identity,files:options.files.map(f=>({file_id:f.file_id,text_sha256:f.text_sha256})),model:options.model,reasoning_effort:options.reasoning_effort})).digest('hex');
 try{
  await prepareAgentRedactionArtifacts({...options,fingerprint,identity});
  if(signal.aborted)throw signal.reason;
  const output=await (options.execute??runAgent)<{plan_file:string}>({task_type:'material_preparation',directory:options.directory,model:options.model,reasoning_effort:options.reasoning_effort,schema:completionSchema,
   timeout_ms:Math.max(1,budget-(performance.now()-started)),signal,
   prompt:options.template.redaction.prompt+'\n\n本次输入在source.json，文件/页/块/字段ID均已给出。完整计划结构见plan-schema.json。review-hints.json提供程序定位的可能主体字段和文书起点，仅作导航、非穷举，不是身份或边界结论；须核对实际原文，不能遗漏其他主体或按提示数量硬拆。用工具成组阅读全部字段，不逐页发起其他模型或等待外部复核。可用计算工具定位和整理，不要改写输入。若有resume目录，其中进度已由程序确认同输入同模板同模型：先读取其主体表、文书计划、编辑和未决项；已有完整计划时复用后校验，补齐遗漏和不合格项，不重复建立已确认的化名。\n'+
    '把entities、edits、documents、unresolved四个完整数组写入output/material-plan.json（不是最终回复），遵守plan-schema.json。entities.variants.targets为空表示已确认该原称在全包指向同一主体，由程序展开全部出现；有同名歧义时必须列出具体target_id。edits只列其他脱敏/清理片段，occurrence为0表示该字段内全部字面出现，正整数表示从1起的第几次出现，keep_prefix仅地址填写确认可保留的行政区划前缀，其余填空串；星号由程序生成。\n'+
    'documents.ranges用完整块first_block_id/last_block_id界定，跨页文书合并，可包含多个文件范围；全部块恰好分配一次，重复扫描保留为有duplicate_of关联的文书，不按行拆表。未修改的块也必须归入文书。未知垃圾保留；只把局部确实不清的连续附件保留为组合文书，仍须拆分其他可辨认文书，不能把整卷一概合并来代替识别。身份不明不合并但仍需对姓名敏感片段作用域化名。身份/边界unresolved.target_id必须是本次真实字段ID或块ID，不能用all/source.json等整包概述；未确认归并不等于保留原名。blocking遵守本次数据库模板，不把已安全处理的疑点设为阻断。\n'+
    '先将主体表写output/subject-map.json，再及时保存output/document-plan.json、output/edits.json、output/unresolved.json、output/progress.json；完成时合并为output/material-plan.json，使用UTF-8 JSON。返回前运行bun validate-plan.mjs，这是程序提供的只读精确校验工具，不调用其他模型；若返回错误码就在本次会话内修正对应条目后再校验，保持总预算。校验通过后最终回复只返回{"plan_file":"output/material-plan.json"}，不要重复完整计划，也不能用空数组代替计划。不抄回全文、不计算字符偏移、不改变法院名称。预算包含读取、输出和检查，请在剩余时间内完成；超时不自动重试。',
   validate(value){if(!value||typeof value!=='object'||(value as any).plan_file!=='output/material-plan.json')throw Object.assign(new Error('Agent材料计划文件声明缺失'),{reason_code:'agent_plan_file_missing'});return value as {plan_file:string};},
  });
  const plan=await readAgentRedactionPlan(options.directory);
  await writePrivateJson(join(options.directory,'semantic-plan.private.json'),plan);
  await writePrivateJson(join(options.directory,'主体对应表.private.json'),{...identity,fingerprint,entities:plan.entities});
  if(signal.aborted)throw signal.reason;
  const compiled=compileAgentMaterialPlan(plan,options.files,identity);
  if(signal.aborted||performance.now()-started>=budget)throw timeoutError();
  await writePrivateJson(join(options.directory,'exact-plan.private.json'),compiled.plan);
  return {...compiled,provider:output.provider,session_id:output.session_id,usage:output.usage,duration_ms:Math.round(performance.now()-started),model:output.model,entity_count:plan.entities.length,unresolved_count:plan.unresolved.length};
 }catch(error){if(controller.signal.aborted)throw timeoutError();throw error;}finally{clearTimeout(timer);}
}
