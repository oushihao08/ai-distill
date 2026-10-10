/**
 * 职责：项目报表取数：关联当前题目产物及历史调用费用，筛选当前有效的达标题目用于导出。
 * 关键方法与用途：`collectProjectResults()` 读取当前可导出记录和历史用量；`buildProjectExport()` 生成并登记工作簿。
 * 使用场景：由 `app.ts` 导出接口调用，`workbookSha256()` 用于文件完整性标识。
 */
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {calculateApiCallCost,type ApiCallUsage} from './usage';
import {buildResultWorkbook,type ResultExportRecord} from './results';
import {classifyLogError,logEvent,withLogContext} from '../logging';
const apiProviders=new Set(['qwen','kimi','deepseek','doubao','zhipu','openrouter']);
const object=(value:unknown):Record<string,any>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:undefined;
export async function collectProjectResults(pool:Pool,projectId:string,batch?:string){
 const project=(await pool.query('SELECT id,name FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL',[projectId])).rows[0];
 if(!project)throw new Error('project_not_found');
 const workflows=await pool.query("SELECT w.id,w.source_key,w.title,s.status AS publication_status FROM ai_distill.workflows w LEFT JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=8 WHERE w.project_id=$1 AND w.deleted_at IS NULL AND ($2::text IS NULL OR w.source_key=$2) ORDER BY w.source_key,w.id",[projectId,batch??null]);
 const ids=workflows.rows.map((row:any)=>row.id);
 if(!ids.length)return {records:[] as ResultExportRecord[],usage_costs:[] as ReturnType<typeof calculateApiCallCost>[]};
 const [attempts,prices,revisionRows]=await Promise.all([
  pool.query("SELECT id,workflow_id,ordinal,attempt,status,input,result,config,started_at,finished_at FROM ai_distill.step_attempts WHERE workflow_id=ANY($1::uuid[]) ORDER BY workflow_id,ordinal,attempt",[ids]),
  pool.query('SELECT provider,model,currency,input_per_million::float8,output_per_million::float8,cached_input_per_million::float8,cache_write_per_million::float8,valid_from,valid_until,source FROM ai_distill.api_model_prices ORDER BY valid_from DESC'),
  pool.query("SELECT r.*,c.workflow_id,c.status AS chain_status,c.spent_duration_ms,c.calls_reserved FROM ai_distill.revision_rounds r JOIN ai_distill.revision_chains c ON c.id=r.chain_id WHERE c.workflow_id=ANY($1::uuid[]) ORDER BY c.created_at,r.round",[ids]),
 ]);
 const byWorkflow=new Map<string,any[]>();for(const row of attempts.rows){const values=byWorkflow.get(row.workflow_id)??[];values.push(row);byWorkflow.set(row.workflow_id,values);}
 const allCosts:ReturnType<typeof calculateApiCallCost>[]=[];
 const records:ResultExportRecord[]=workflows.rows.map((workflow:any)=>{
  const workflowRows=byWorkflow.get(workflow.id)??[];
  const current=workflowRows;
  const step=(ordinal:number)=>current.filter(row=>row.ordinal===ordinal);
  const questions=step(4),question=questions.at(-1),q=object(question?.result)??{};
  const answerAttempts=step(5).filter(row=>object(row.result)?.question_version===q.question_version&&(object(row.result)?.question_attempt_id===question?.id||Array.isArray(q.answer_source_attempt_ids)&&q.answer_source_attempt_ids.includes(object(row.result)?.question_attempt_id)));
  const scoreAttempts=step(6);
  const answers=answerAttempts.map((answer:any)=>{
   const result=object(answer.result)??{},config=object(answer.config)??{};
   const scores=scoreAttempts.filter(score=>object(object(object(score.input)?.context)?.binding)?.answer_attempt_id===answer.id);
   const latest=scores.at(-1),scoreResult=object(latest?.result)??{},report=object(scoreResult.report)??{};
   return {model:String(result.model??config.model??'unknown'),status:answer.status,answer:typeof result.text==='string'?result.text:'',score_status:latest?.status??'waiting',score_valid:scoreResult.validation?.valid===true,total:typeof report.total==='number'?report.total:null,max_score:typeof report.max_score==='number'?report.max_score:null,items:Array.isArray(report.items)?report.items.filter((item:any)=>item&&typeof item==='object').map((item:any)=>({id:String(item.id??''),score:Number(item.score??0),max_score:Number(item.max_score??0),reason:String(item.reason??'')})):[]};
  });
  const acceptance=step(7).at(-1),decision=object(acceptance?.result)??{};
  const publication=step(8).at(-1),publishedResult=object(publication?.result)??{};
  const published=workflow.publication_status==='succeeded'&&publication?.status==='succeeded'&&publishedResult.acceptance_attempt_id===acceptance?.id&&typeof publishedResult.source_digest==='string'&&publishedResult.source_digest===object(acceptance?.input)?.source_digest&&publishedResult.question_version===q.question_version&&publishedResult.rubric_version===q.rubric_version;
  const revisions=revisionRows.rows.filter(row=>row.workflow_id===workflow.id).map(row=>({kind:String(row.issue_kind),reason:String(row.decision?.reason??''),from_step:row.decision?.return_step??null,content_revision:Number(row.decision?.content_revisions??0),technical_retry:Number(row.decision?.technical_retries??0),summary:JSON.stringify({round:row.round,status:row.status,chain_status:row.chain_status,before_versions:row.before_versions,after_versions:row.after_versions,before_scores:row.before_scores,after_scores:row.after_scores}),duration_ms:Number(row.spent_duration_ms),calls:Number(row.calls_reserved)}));
  const costs:{model:string;amount:number|null;currency:string|null;unknown_reason?:string}[]=[];
  const priceFor=(provider:string,model:string,at:string|Date|undefined)=>{
   const time=at?new Date(at).getTime():NaN;
   const active=prices.rows.filter((price:any)=>price.provider===provider&&price.model===model&&Number.isFinite(time)&&new Date(price.valid_from).getTime()<=time&&(!price.valid_until||new Date(price.valid_until).getTime()>time));
   return active.length===1?active[0]:undefined;
  };
  const addCost=(callId:string,provider:string,model:string,usage:unknown,at:string|Date|undefined)=>{
   if(!apiProviders.has(provider))return;
   const price=priceFor(provider,model,at);
   const input:ApiCallUsage={call_id:callId,billing:'api_key',provider,model,currency:price?.currency??'unknown',usage:object(usage)??null,price:price?{input_per_million:Number(price.input_per_million),output_per_million:Number(price.output_per_million),...(price.cached_input_per_million!==null?{cached_input_per_million:Number(price.cached_input_per_million)}:{}),...(price.cache_write_per_million!==null?{cache_write_per_million:Number(price.cache_write_per_million)}:{}),currency:price.currency}:null};
   const result=calculateApiCallCost(input);allCosts.push(result);costs.push({model,amount:result.cost,currency:result.currency,...(result.unknown_reason?{unknown_reason:result.unknown_reason}:{})});
  };
  for(const answer of workflowRows.filter(row=>row.ordinal===5&&row.result)){const result=object(answer.result)??{},config=object(answer.config)??{};addCost(answer.id,String(config.provider??''),String(result.model??config.model??''),result.usage,answer.finished_at);}
  for(const redaction of workflowRows.filter(row=>row.ordinal===9&&row.result&&row.config?.provider==='api')){
   const result=object(redaction.result)??{},config=object(redaction.config?.api)??{};
   addCost(redaction.id,String(result.provider??config.provider??''),String(result.model??config.model??''),result.usage,redaction.finished_at);
  }
  for(const extraction of workflowRows.filter(row=>row.ordinal===2&&row.result)){
   const pages=object(extraction.result)?.pages;
   if(!Array.isArray(pages))continue;
   pages.forEach((page:any,index:number)=>{if(page?.usage)addCost(`${extraction.id}:page:${index}`,String(page.provider??'zhipu'),String(page.model??''),page.usage,extraction.finished_at);});
  }
  const accepted=acceptance?.status==='succeeded'&&decision.decision==='accepted';
  return {project_id:project.id,project_name:project.name,batch:workflow.source_key??'未分组',workflow_id:workflow.id,title:workflow.title,question:String(q.question??''),question_version:String(q.question_version??''),rubric_version:String(q.rubric_version??''),accepted,published,quarantined:decision.decision==='quarantine'||revisionRows.rows.some(row=>row.workflow_id===workflow.id&&row.chain_status==='isolated'),answers,revisions,api_costs:costs};
 });
 return {records,usage_costs:allCosts};
}
export function workbookSha256(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
export async function buildProjectExport(pool:Pool,projectId:string,batch?:string){return withLogContext({component:'reporting',project_id:projectId,operation:'export'},async()=>{logEvent('export.started',{level:'info'});try{const result=await collectProjectResults(pool,projectId,batch);const records=result.records.filter(record=>record.accepted),bytes=buildResultWorkbook(records);logEvent('export.completed',{level:'info',state:'succeeded',attempt_count:records.length,output_bytes:bytes.length});return {...result,records,bytes};}catch(error){logEvent('export.failed',{level:'error',state:'failed',...classifyLogError(error)});throw error;}});}
