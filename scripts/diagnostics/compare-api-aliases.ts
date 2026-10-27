/** 本地八包API脱敏对照入口：bun scripts/diagnostics/compare-api-aliases.ts [prepare|run]。
 * prepare仅GET本机API冻结来源和Agent基线；run调用统一API模块，结果只写执行观察私有目录及报告，不连接业务数据库或派发任务。
 */
import {mkdir,readFile,writeFile,chmod,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareAgentLibraryMaterials} from '../../server/material-library/agent-redaction';
import {resolveModelApiConfig} from '../../server/llm-api';
const root=resolve('执行观察/api-aliases-20261027'),privateRoot=join(root,'private');
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
async function save(path:string,value:unknown){await writeFile(path,JSON.stringify(value,null,2),{mode:0o600});}
async function get(path:string){const response=await fetch(`http://127.0.0.1:3700/api/${path}`,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`GET ${response.status} ${path}`);return response.json() as Promise<any>;}
async function exists(path:string){try{await access(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function prepare(){
 await mkdir(privateRoot,{recursive:true,mode:0o700});await chmod(privateRoot,0o700);
 if(await exists(join(privateRoot,'manifest.json')))throw new Error('已有固定样本，不重复选择');
 const loaded=(await get('projects/c036ebd9-fca4-492e-89fd-ba730966384b/loaded-materials')).items.slice(0,8);
 const template=(await get('material-library/redaction-templates')).items.find((t:any)=>t.id==='aliases');
 const settings=(await get('material-library/processing-settings')).processing_settings;
 const catalog=await get('llm-api/models');
 const api=catalog.models.find((m:any)=>m.config.provider==='siliconflow'&&m.config.model==='deepseek-ai/DeepSeek-V4.1-Flash')?.config;
 if(!api||loaded.length!==8)throw new Error('缺少指定模型或八包样本');
 const manifest:any[]=[];
 for(const [i,item] of loaded.entries()){
  const dir=join(privateRoot,String(i+1).padStart(2,'0'));await mkdir(dir,{mode:0o700,recursive:true});
  const baseline=await get(`material-library/redactions/${item.selected_redaction_id}/preview`);
  if(baseline.validation_report?.material_processing_mode!=='aliases')throw new Error('基线不是化名结果');
  const job=await get(`material-library/jobs/${baseline.redaction_job_id}`);
  if(job.executor_kind!=='agent'||job.status!=='succeeded')throw new Error('基线不是成功Agent任务');
  const docs=await get(`material-library/revisions/${baseline.revision_id}/documents?extraction_job_id=${baseline.extraction_job_id}`);
  const files=[];
  for(const d of docs.items){const full=await get(`material-library/revisions/${baseline.revision_id}/documents?extraction_job_id=${baseline.extraction_job_id}&file_id=${d.file_id}`);const f=full.items[0];files.push({file_id:f.file_id,text_sha256:sha(f.pages.map((p:any)=>p.text).join('\n')),pages:f.pages});}
  const oldDir=resolve('.storage/material-library/jobs',baseline.redaction_job_id,'private');
  const oldPlan=JSON.parse(await readFile(join(oldDir,'semantic-plan.private.json'),'utf8'));
  const validation=JSON.parse(await readFile(join(oldDir,'validation-source.json'),'utf8'));
  // 比较只使用基线对应的同一提取文件，拒绝错配；不读取其他案件正文。
  if(files.some(f=>validation.files.find((v:any)=>v.file_id===f.file_id)?.text_sha256!==f.text_sha256))throw new Error('Agent本机计划与API提取版本不符');
  await save(join(dir,'input.json'),{directory:join(dir,'api'),files,revision_id:baseline.revision_id,extraction_job_id:baseline.extraction_job_id,template,api,model:api.model,reasoning_effort:'none',timeout_ms:settings.execution.task_timeout_ms});
  await save(join(dir,'baseline.json'),baseline);await save(join(dir,'baseline-plan.json'),oldPlan);await save(join(dir,'baseline-job.json'),job);
  manifest.push({sample:i+1,name:item.package_name,package_id:item.package_id,redaction_id:baseline.id,redaction_job_id:baseline.redaction_job_id,baseline_sha256:sha(baseline.markdown),revision_id:baseline.revision_id,extraction_job_id:baseline.extraction_job_id,template_digest:template.digest,baseline_template_digest:baseline.validation_report.redaction_template_digest,source_chars:files.reduce((n,f)=>n+f.pages.reduce((s:number,p:any)=>s+p.text.length,0),0),baseline_chars:baseline.markdown.length,files:files.length});
  console.log(JSON.stringify({prepared:i+1,source_chars:manifest.at(-1).source_chars}));
 }
 await save(join(privateRoot,'manifest.json'),{created_at:new Date().toISOString(),api,items:manifest});
}
function dice(a:string,b:string){if(a===b)return 1;if(a.length<2||b.length<2)return 0;const grams=new Map<string,number>();for(let i=0;i<a.length-1;i++){const k=a.slice(i,i+2);grams.set(k,(grams.get(k)??0)+1);}let overlap=0;for(let i=0;i<b.length-1;i++){const k=b.slice(i,i+2),n=grams.get(k)??0;if(n){overlap++;grams.set(k,n-1);}}return 2*overlap/(a.length+b.length-2);}
function normalized(text:string,plan:any){
 const mappings=plan.entities.map((e:any)=>({alias:e.alias,key:e.variants.map((v:any)=>v.text).sort((a:string,b:string)=>b.length-a.length||a.localeCompare(b))[0]})).sort((a:any,b:any)=>b.alias.length-a.alias.length);
 // 单次替换，防止化名与原称交叉导致级联污染。
 const map=new Map(mappings.map((m:any)=>[m.alias,m.key]));
 const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return mappings.length?text.replace(new RegExp(mappings.map((m:any)=>escape(m.alias)).join('|'),'g'),match=>String(map.get(match))):text;
}
async function report(){
 const manifest=JSON.parse(await readFile(join(privateRoot,'manifest.json'),'utf8'));const lines=['\n## 实测汇总','', '相似度采用字符二元组多重集 Dice：2×重合二元组数÷双方二元组总数。原始文本保留全部换行；归一指标将各自计划的化名一次性替换为其最长原称后计算。它不度量全局段落顺序；同名异写/主体识别差异也可能影响归一结果。高相似度不证明隐私安全。','', '| 样本 | 材料包 | 状态 | 页数 | Agent/API分册 | Agent/API实体 | 原始文本相似度 | 化名归一相似度 | API耗时 | 调用次数 |','| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
 for(const m of manifest.items){const path=join(privateRoot,String(m.sample).padStart(2,'0'),'comparison.json');if(!await exists(path)){const prior=join(privateRoot,String(m.sample).padStart(2,'0'),'comparison.siliconflow.json');if(await exists(prior)){const f=JSON.parse(await readFile(prior,'utf8'));lines.push(`| ${m.sample} | ${m.name} | SiliconFlow额度阻断；OpenRouter未发出 | — | ${f.baseline_documents}/— | ${f.baseline_entities}/— | 无结果 | 无结果 | ${(f.duration_ms/1000).toFixed(1)}秒 | 无有效返回 |`);}else lines.push(`| ${m.sample} | ${m.name} | 待执行 | — | — | — | — | — | — | — |`);continue;}const c=JSON.parse(await readFile(path,'utf8'));lines.push(`| ${m.sample} | ${m.name} | ${c.status} | ${c.pages??'—'} | ${c.baseline_documents}/${c.api_documents??'—'} | ${c.baseline_entities}/${c.api_entities??'—'} | ${c.raw_similarity==null?'—':(100*c.raw_similarity).toFixed(2)+'%'} | ${c.normalized_similarity==null?'—':(100*c.normalized_similarity).toFixed(2)+'%'} | ${(c.duration_ms/1000).toFixed(1)}秒 | ${c.calls??'—'} |`);}
 lines.push('','### 基线与归因限制','', '以下API测试采用当前冻结模板；历史Agent模板摘要不同时，差异不能仅归因于模型后端。基线不是人工金标准。每个样本保留同源提取ID、基线ID、摘要和私有计划。','');
 for(const m of manifest.items)lines.push(`- 样本${m.sample}：提取 ${m.extraction_job_id}，Agent结果 ${m.redaction_id}；模板摘要${m.template_digest===m.baseline_template_digest?'一致':'不同'}。`);
 const path=join(root,'对比报告.md'),text=await readFile(path,'utf8');await writeFile(path,text.split('\n## 实测汇总')[0]+lines.join('\n')+(text.includes('\n## 验收与未完成项')?text.slice(text.indexOf('\n## 验收与未完成项')):''));
}
async function run(){
 const manifest=JSON.parse(await readFile(join(privateRoot,'manifest.json'),'utf8'));
 await report();
 for(const m of manifest.items.slice(0,Number(process.argv[3]??8))){
  const dir=join(privateRoot,String(m.sample).padStart(2,'0'));if(await exists(join(dir,'comparison.json')))continue;
  if(await exists(join(dir,'started.json')))throw new Error(`样本${m.sample}原调用状态未结算，不自动重发`);
  const started=Date.now();await save(join(dir,'started.json'),{started_at:new Date().toISOString()});
  console.log(JSON.stringify({sample:m.sample,status:'running'}));
  const baseline=JSON.parse(await readFile(join(dir,'baseline.json'),'utf8')),oldPlan=JSON.parse(await readFile(join(dir,'baseline-plan.json'),'utf8'));
  const comparison:any={sample:m.sample,baseline_documents:baseline.validation_report.document_count,baseline_entities:oldPlan.entities.length,requested_model:manifest.api.model};
  try{
   const input=JSON.parse(await readFile(join(dir,'input.json'),'utf8'));input.api=resolveModelApiConfig(input.api);
   const out=await prepareAgentLibraryMaterials(input),text=out.prepared.documents.map(d=>d.text).join('\n\n');
   const plan=JSON.parse(await readFile(join(input.directory,'semantic-plan.private.json'),'utf8'));
   await save(join(dir,'api-result.json'),out);await writeFile(join(dir,'api.md'),text,{mode:0o600});
   Object.assign(comparison,{status:'succeeded',pages:out.prepared.pages.length,api_documents:out.prepared.documents.length,api_entities:out.entity_count,api_unresolved:out.unresolved_count,raw_similarity:dice(baseline.markdown,text),normalized_similarity:dice(normalized(baseline.markdown,oldPlan),normalized(text,plan)),returned_model:out.returned_model,calls:(out.usage as any)?.calls?.length});
  }catch(error){Object.assign(comparison,{status:'failed',error:{name:(error as any)?.name,reason_code:(error as any)?.reason_code??null,message:(error as Error).message,kind:(error as any)?.kind,http_status:(error as any)?.http_status,provider_code:(error as any)?.provider_code,request_id:(error as any)?.request_id,finish_reason:(error as any)?.finish_reason}});}
  comparison.duration_ms=Date.now()-started;await save(join(dir,'comparison.json'),comparison);await report();
  console.log(JSON.stringify(comparison));
  if(['configuration','authentication','quota'].includes(comparison.error?.kind))throw new Error('通道级错误，停止余下请求；先修复配置/账户再显式续测');
 }
}
try{const action=process.argv[2];if(action==='prepare')await prepare();else if(action==='run')await run();else if(action==='report')await report();else throw new Error('使用prepare或run');}catch(error){console.error(error instanceof Error?error.message:'对照执行失败');process.exitCode=1;}
