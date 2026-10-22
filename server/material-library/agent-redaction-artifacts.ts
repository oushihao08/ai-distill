/** 职责：准备Agent私有输入、同源检查点及读取固定结果文件；不调用模型、不决定化名、不发布业务结果。 */
import {mkdir,writeFile,readFile,copyFile,lstat,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {agentMaterialSource,AGENT_MATERIAL_PLAN_SCHEMA,type AgentMaterialPlan,type PreparationFile} from '../../shared/agent-material-plan';

export async function writePrivateJson(path:string,value:unknown){await writeFile(path,JSON.stringify(value),{mode:0o600});}

export async function prepareAgentRedactionArtifacts(options:{directory:string;files:PreparationFile[];identity:{revision_id:string;extraction_job_id:string;template_id:string;template_digest:string};fingerprint:string;previous_directory?:string}){
 await mkdir(options.directory,{recursive:true,mode:0o700});
 await writePrivateJson(join(options.directory,'checkpoint-identity.json'),{fingerprint:options.fingerprint});
 const material=agentMaterialSource(options.files);
 await writePrivateJson(join(options.directory,'source.json'),{files:material.source});
 // 仅作阅读导航，不判定身份/边界，也不据命中数制造材料份数。
 const subjectFields=[...material.fields].filter(([,field])=>/(原告|被告|执行人|委托.*代理人|法定代表人|审判长|审判员|书记员|证人|借款人|出借人|担保人|收件人)[：:\s]/.test(field.text)).map(([target_id])=>target_id);
 const documentStarts=material.source.flatMap(file=>file.pages.flatMap(page=>page.blocks.filter(block=>block.fields.some(field=>field.text.trim().length<65&&/^(?:民事判决书|民事裁定书|执行裁定书|申请执行书|执行申请书|起诉状|民事起诉状|授权委托书|送达回证|询问笔录|庭审笔录|执行笔录|借款合同|借条|收条)/.test(field.text.trim()))).map(block=>block.id)));
 await writePrivateJson(join(options.directory,'review-hints.json'),{subject_fields:subjectFields,possible_document_start_blocks:documentStarts,scope:'heuristic_navigation_not_identity_or_boundary_decisions'});
 await writePrivateJson(join(options.directory,'plan-schema.json'),AGENT_MATERIAL_PLAN_SCHEMA);
 await writePrivateJson(join(options.directory,'validation-source.json'),{files:options.files,identity:options.identity});
 const validator=await Bun.build({entrypoints:[join(import.meta.dir,'agent-redaction-validator.ts')],target:'bun',format:'esm'});
 if(!validator.success||validator.outputs.length!==1)throw Object.assign(new Error('Agent本地校验工具准备失败'),{reason_code:'agent_validator_setup_failed'});
 await writeFile(join(options.directory,'validate-plan.mjs'),await validator.outputs[0]!.text(),{mode:0o600});
 if(!options.previous_directory)return;
 try{
  const prior=JSON.parse(await readFile(join(options.previous_directory,'checkpoint-identity.json'),'utf8'));
  if(prior.fingerprint!==options.fingerprint)return;
  await mkdir(join(options.directory,'resume'),{mode:0o700,recursive:true});
  for(const name of ['subject-map.json','document-plan.json','edits.json','unresolved.json','material-plan.json','progress.json']){
   const source=join(options.previous_directory,'output',name);
   try{
    const file=await lstat(source);
    if(!file.isFile()||file.isSymbolicLink())throw new Error('Agent检查点文件无效');
    const destination=join(options.directory,'resume',name);
    await copyFile(source,destination);await chmod(destination,0o600);
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

/** 仅接受固定文件，绝不从消息摘要、任意路径或阶段文件拼造成功结果。 */
export async function readAgentRedactionPlan(directory:string):Promise<AgentMaterialPlan>{
 const path=join(directory,'output','material-plan.json');
 const file=await lstat(path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')throw Object.assign(new Error('Agent未生成材料计划文件'),{reason_code:'agent_plan_file_missing'});throw error;});
 if(!file.isFile()||file.isSymbolicLink())throw Object.assign(new Error('Agent材料计划文件无效'),{reason_code:'agent_plan_file_invalid'});
 await chmod(path,0o600);
 return JSON.parse(await readFile(path,'utf8')) as AgentMaterialPlan;
}
