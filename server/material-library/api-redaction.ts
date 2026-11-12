/** 职责：仅替换整包化名的模型执行接口；将同源私有文件内联至llm-api，宿主运行同一编译器并反馈修正，不入队、不发布或写库。 */
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {AgentTask,AgentResult} from '../agent';
import {createModelApiClient,type ModelApiConfig,type ModelApiMessage} from '../llm-api';
import {compileAgentTextMaterialPlan,AGENT_MATERIAL_PLAN_SCHEMA} from '../../shared/agent-material-plan';
import {writePrivateJson} from './agent-redaction-artifacts';

/** API没有本地shell；由宿主提供完整文件和执行等价校验。只对校验失败修正，不重试供应商失败。 */
export function apiMaterialExecutor(config:ModelApiConfig,client=createModelApiClient()){
 return async <T>(task:AgentTask<T>):Promise<AgentResult<T>>=>{
  const started=performance.now(),deadline=Date.now()+(task.timeout_ms??1200000);
  const read=async(name:string)=>JSON.parse(await readFile(join(task.directory,name),'utf8'));
  const context=await read('validation-source.json');
  let resume:unknown=null;
  try{resume=await read('resume/material-plan.json');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const messages:ModelApiMessage[]=[{role:'system',content:task.prompt},{role:'user',content:JSON.stringify({source:await read('source.json'),review_hints:await read('review-hints.json'),plan_schema:AGENT_MATERIAL_PLAN_SCHEMA,resume})}];
  const usage:unknown[]=[];let round=0,lastInvalid:string|undefined;
  await mkdir(join(task.directory,'output'),{recursive:true,mode:0o700});
  while(true){
   if(task.signal?.aborted)throw task.signal.reason;
   const remaining=Math.floor(deadline-Date.now());if(remaining<=0)throw Object.assign(new Error('API化名达到执行预算'),{reason_code:'agent_redaction_timeout'});
   const result=await client.complete({config,messages,response_format:{type:'json_schema',json_schema:{name:'material_plan',strict:true,schema:AGENT_MATERIAL_PLAN_SCHEMA}},timeout_ms:remaining,signal:task.signal,call_id:task.call_id});
   usage.push(result.usage);round++;
   await writePrivateJson(join(task.directory,`api-call-${round}.private.json`),{requested_model:result.requested_model,returned_model:result.model,provider:result.provider,request_id:result.request_id,completion_id:result.completion_id,usage:result.usage,duration_ms:result.duration_ms});
   let plan:unknown;
   try{plan=JSON.parse(result.text);}
   catch(error){
    if(!(error instanceof SyntaxError))throw error;
    if(lastInvalid===result.text)throw Object.assign(new Error('API重复返回相同无效计划'),{reason_code:'invalid_json'});
    lastInvalid=result.text;messages.push({role:'assistant',content:result.text},{role:'user',content:'校验结果：{"valid":false,"reason_code":"invalid_json"}。返回修正后的完整JSON计划。'});continue;
   }
   await writePrivateJson(join(task.directory,'output/material-plan.json'),plan);
   try{compileAgentTextMaterialPlan(plan,context.files,context.identity);}
   catch(error){
    if(lastInvalid===result.text)throw error;
    lastInvalid=result.text;
    const details={valid:false,reason_code:(error as any)?.reason_code??'agent_plan_file_invalid',validation_details:(error as any)?.validation_details};
    messages.push({role:'assistant',content:result.text},{role:'user',content:`同一编译器校验结果：${JSON.stringify(details)}。修正实际条目并返回完整JSON计划。`});continue;
   }
   return{result:task.validate({plan_file:'output/material-plan.json',parsed_plan:plan}),session_id:result.completion_id??'',usage:{calls:usage},diagnostic_path:task.directory,duration_ms:Math.round(performance.now()-started),provider:result.provider,model:result.model??config.model,requested_model:config.model,returned_model:result.model};
  }
 };
}
