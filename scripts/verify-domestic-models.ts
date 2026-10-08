import {mkdir,writeFile} from 'node:fs/promises';
import {resolveDomesticConfig,createDomesticClient,DomesticError,type DomesticConfig} from '../server/answer-models/domestic';
// Default is configuration-only. --call <provider> sends exactly one synthetic request.
const providers:DomesticConfig['provider'][]=['kimi','deepseek','doubao','openrouter'];
const keys:Record<DomesticConfig['provider'],string[]>={kimi:['KIMI_API_KEY','MOONSHOT_API_KEY'],deepseek:['DEEPSEEK_API_KEY'],doubao:['DOUBAO_API_KEY','ARK_API_KEY'],openrouter:['OPEN_ROUTER_KEY']};
const args=process.argv.slice(2);
const selected=args.length===2&&args[0]==='--call'&&providers.includes(args[1] as DomesticConfig['provider'])?args[1] as DomesticConfig['provider']:undefined;
const checks:Record<string,unknown>[]=[];
if(args.length&&!selected){console.error('用法：bun scripts/verify-domestic-models.ts [--call kimi|deepseek|doubao|openrouter]');process.exitCode=2;}
else try{
 for(const provider of selected?[selected]:providers){
  const prefix=provider.toUpperCase();const missing:string[]=[];
  if(!keys[provider].some(key=>!!process.env[key]?.trim()))missing.push(keys[provider].join(' or '));
  const model=provider==='openrouter'?process.env.OPENROUTER_MODEL?.trim()||'z-ai/glm-5.3-flash':process.env[prefix+'_MODEL']?.trim();
  if(!model)missing.push(prefix+'_MODEL');
  const evidence:Record<string,unknown>={provider,status:'unverified',request_attempted:false,called_provider:false,input_kind:'synthetic_question_and_text_material',missing};
  checks.push(evidence);
  if(missing.length){evidence.reason='未配置直连模型或可用凭证';if(selected)process.exitCode=2;continue;}
  try{
   const config=resolveDomesticConfig({provider,model});
   evidence.requested_model=config.model;evidence.endpoint_host=new URL(config.base_url).hostname;
   if(!selected){evidence.status='configured_not_called';continue;}
   const client=createDomesticClient(process.env,async(url,init)=>{try{evidence.request_attempted=true;const response=await fetch(url,init);evidence.called_provider=true;return response;}catch(error){throw error;}});
   const result=await client.answer({config,question:'请根据附件计算剩余应付金额，并简要说明计算过程。',materials:[{name:'合成付款记录',text:'应付金额为100元；已经支付40元。'}],timeout_ms:30000});
   evidence.status='passed';evidence.actual_model=result.model;evidence.request_id=result.request_id;evidence.completion_id=result.completion_id;evidence.duration_ms=result.duration_ms;evidence.started_at=result.started_at;evidence.finished_at=result.finished_at;evidence.answer_received=!!result.text.trim();
   evidence.usage=result.usage===null?null:Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens','cost'].flatMap(key=>typeof result.usage?.[key]==='number'?[[key,result.usage[key]]]:[]));
  }catch(error){evidence.status='failed';evidence.error=error instanceof DomesticError?{kind:error.kind,retryable:error.retryable,http_status:error.http_status,provider_code:error.provider_code,request_id:error.request_id}:{kind:'verification_failed',details_omitted:true};process.exitCode=1;}
 }
 const output=new URL('../docs/evidence/domestic-api-smoke-results.json',import.meta.url);
 await mkdir(new URL('.',output),{recursive:true});
 const result={checked_at:new Date().toISOString(),mode:selected?'single_synthetic_api_call':'configuration_only',checks};
 await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch{console.error('国产模型验收记录保存失败；未输出凭证、材料或响应正文');process.exitCode=1;}
