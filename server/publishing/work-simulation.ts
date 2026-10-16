/**
 * 职责：归档时生成 Work 项目的 AI 模拟专家成果，并把模型引用绑定到本次 Codex 实际网页检索事件。
 * 关键入口：`generateWorkSimulation()` 使用项目 Agent 配置和当前脱敏材料生成成果；无实际检索证据时失败关闭。
 * 使用场景：仅由 Work 项目归档流程调用；不声称真人办理、签署或平台验收。
 */
import {projectReference,type WorkContent} from '../authoring/work-contract';
import {lstat,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readProjectAgentDefaults} from '../agent/config';
import {runAgent} from '../agent/runner';
import type {Pool} from 'pg';

export interface WorkResearchEntry {
 id:string;
 query:string;
 title:string;
 url:string;
 finding:string;
 version_or_date:string;
 used_in:string;
}
export interface WorkSimulation {
 deliverable_type:'F1'|'F2'|'F3'|'F4'|'F5';
 deliverable_title:string;
 deliverable_markdown:string;
 harbor_files:{path:string;markdown:string;sheets:{name:string;columns:string[];rows:(string|number|boolean)[][]}[]}[];
 research_entries:WorkResearchEntry[];
 unresolved:string[];
 generated_at:string;
 model:string;
 reasoning_effort:string;
 actual_search_queries:string[];
 actually_opened_urls:string[];
}
export interface WorkSimulationInput {
 project_id:string;
 workflow_id:string;
 title:string;
 question_version:string;
 rubric_version:string;
 question:Record<string,unknown>;
 attachments:{name:string;text:string}[];
}

const researchSchema={type:'object',additionalProperties:false,required:['id','query','title','url','finding','version_or_date','used_in'],properties:{
 id:{type:'string'},query:{type:'string'},title:{type:'string'},url:{type:'string'},finding:{type:'string'},version_or_date:{type:'string'},used_in:{type:'string'},
}};
const harborFileSchema={type:'object',additionalProperties:false,required:['path','markdown','sheets'],properties:{
 path:{type:'string'},markdown:{type:'string'},sheets:{type:'array',items:{type:'object',additionalProperties:false,required:['name','columns','rows'],properties:{name:{type:'string'},columns:{type:'array',items:{type:'string'}},rows:{type:'array',items:{type:'array',items:{anyOf:[{type:'string'},{type:'number'},{type:'boolean'}]}}}}}},
}};
const schema={type:'object',additionalProperties:false,required:['deliverable_type','deliverable_title','deliverable_markdown','harbor_files','research_entries','unresolved'],properties:{
 deliverable_type:{type:'string',enum:['F1','F2','F3','F4','F5']},
 deliverable_title:{type:'string'},deliverable_markdown:{type:'string'},
 harbor_files:{type:'array',minItems:1,maxItems:20,items:harborFileSchema},
 research_entries:{type:'array',minItems:1,maxItems:20,items:researchSchema},
 unresolved:{type:'array',items:{type:'string'}},
}};
const cleanText=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
function validate(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('模拟专家结果结构无效');
 const result=value as Record<string,unknown>;
 if(!['F1','F2','F3','F4','F5'].includes(String(result.deliverable_type))||!cleanText(result.deliverable_title,300)||!cleanText(result.deliverable_markdown,2_000_000)||!Array.isArray(result.research_entries)||result.research_entries.length<1||result.research_entries.length>20||!Array.isArray(result.unresolved)||result.unresolved.some(item=>!cleanText(item,2000)))throw new Error('模拟专家成果或检索记录缺失');
 const ids=new Set<string>();
 const research=result.research_entries.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('法规案例检索条目无效');
  const row=raw as Record<string,unknown>;
  const id=row.id,query=row.query,title=row.title,url=row.url,finding=row.finding,versionOrDate=row.version_or_date,usedIn=row.used_in;
  if(!cleanText(id,40)||!/^S\d{1,2}$/.test(id)||ids.has(id)||!cleanText(query,500)||!cleanText(title,500)||!cleanText(url,4000)||!cleanText(finding,4000)||!cleanText(versionOrDate,500)||!cleanText(usedIn,1000))throw new Error('法规案例检索字段不完整');
  let parsed:URL;try{parsed=new URL(url);}catch{throw new Error('检索来源网址无效');}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('检索来源必须为公开 HTTPS 页面');
  ids.add(id);
  return{id,query:query.trim(),title:title.trim(),url:parsed.href,finding:finding.trim(),version_or_date:versionOrDate.trim(),used_in:usedIn.trim()};
 });
 const markdown=(result.deliverable_markdown as string).trim();
 if(research.some(row=>!markdown.includes(`[${row.id}]`)))throw new Error('专家成果须在相应法律结论处引用检索编号');
 return{deliverable_type:result.deliverable_type as WorkSimulation['deliverable_type'],deliverable_title:(result.deliverable_title as string).trim(),deliverable_markdown:markdown,research_entries:research,unresolved:(result.unresolved as string[]).map(item=>item.trim())};
}

function harborTask(question:Record<string,unknown>){
 const rubric=question.rubric;
 if(!Array.isArray(rubric))throw new Error('题目 Rubric 缺失，无法读取 Harbor 归档映射');
 const projectContext=rubric.map(item=>item&&typeof item==='object'?(item as any).metadata?.project_context:undefined).find(item=>item&&typeof item==='object'&&!Array.isArray(item));
 const harbor=(projectContext as Record<string,unknown>|undefined)?.harbor;
 if(!harbor||typeof harbor!=='object'||Array.isArray(harbor))throw new Error('project_context.harbor 未填写，不能生成 Harbor 六件套');
 const value=harbor as Record<string,unknown>,metadata=value.metadata;
 if(!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(String(value.task_id??''))||!metadata||typeof metadata!=='object'||!Array.isArray((metadata as any).deliverables)||!(metadata as any).deliverables.length||!Array.isArray(value.input_files)||!value.input_files.length)throw new Error('project_context.harbor 缺少任务编号、完整 metadata、交付物或材料说明');
 return value;
}

function validateHarborFiles(value:unknown,question:Record<string,unknown>){
 const result=validate(value),task=harborTask(question),expected=(task.metadata as any).deliverables.map((item:any)=>item.path);
 const files=(value as Record<string,unknown>).harbor_files;
 if(!Array.isArray(files)||files.length!==expected.length)throw new Error('Harbor 模拟交付物数量与 project_context 清单不一致');
 const actual=files.map((item:any)=>item&&typeof item==='object'?item.path:undefined);
 if(actual.some(path=>typeof path!=='string')||new Set(actual).size!==actual.length||JSON.stringify([...actual].sort())!==JSON.stringify([...expected].sort()))throw new Error('Harbor 模拟交付物路径必须与 project_context 清单逐字一致');
 const checked=files.map((raw:any)=>{
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.sheets)||typeof raw.markdown!=='string')throw new Error('Harbor 交付物正文结构无效');
  const extension=String(raw.path).split('.').at(-1)?.toLowerCase();
  if(extension==='xlsx'){
   if(!raw.sheets.length||raw.sheets.some((sheet:any)=>!sheet||typeof sheet.name!=='string'||!sheet.name.trim()||!Array.isArray(sheet.columns)||!sheet.columns.length||new Set(sheet.columns).size!==sheet.columns.length||!sheet.columns.every((column:unknown)=>cleanText(column,200))||!Array.isArray(sheet.rows)||!sheet.rows.every((row:unknown)=>Array.isArray(row)&&(row as unknown[]).length===sheet.columns.length&&(row as unknown[]).every(cell=>typeof cell==='string'||typeof cell==='number'&&Number.isFinite(cell)||typeof cell==='boolean'))))throw new Error(`XLSX 交付物工作表无效：${raw.path}`);
  }else if(['docx','md','txt','csv','json'].includes(String(extension))){
   if(!cleanText(raw.markdown,2_000_000)||raw.sheets.length)throw new Error(`文本或 DOCX 交付物正文无效：${raw.path}`);
   if(extension==='json')try{JSON.parse(raw.markdown);}catch{throw new Error(`JSON 交付物不是有效 JSON：${raw.path}`);}
  }else throw new Error(`暂不支持 Harbor 交付格式：${raw.path}`);
  return{path:raw.path as string,markdown:raw.markdown,sheets:raw.sheets as WorkSimulation['harbor_files'][number]['sheets']};
 });
 const text=checked.map(file=>file.markdown).join('\n');
 if(result.research_entries.some(row=>!text.includes(`[${row.id}]`)))throw new Error('Harbor 主成果须在相应法律结论处引用检索编号');
 return{...result,harbor_files:checked};
}

function normalizedUrl(raw:string){try{const url=new URL(raw);url.hash='';return url.href.replace(/\/$/,'');}catch{return'';}}
function searchEvidence(events:string){
 const queries:string[]=[],openedUrls:string[]=[];
 for(const line of events.split(/\r?\n/)){
  if(!line.trim())continue;
  let event:Record<string,any>;try{event=JSON.parse(line);}catch{continue;}
  const candidates=[event.item,event.output_item,event];
  for(const item of candidates){
   if(!item||typeof item!=='object'||item.type!=='web_search_call')continue;
   const action=item.action&&typeof item.action==='object'?item.action:{};
   const actionType=String(action.type??'');
   const rawQueries=Array.isArray(action.queries)?action.queries:action.query?[action.query]:[];
   if(actionType==='search'||rawQueries.length)for(const query of rawQueries)if(typeof query==='string'&&query.trim())queries.push(query.trim());
   const sources=Array.isArray(action.sources)?action.sources:Array.isArray(item.sources)?item.sources:[];
   if(actionType==='open_page'&&typeof action.url==='string')openedUrls.push(action.url);
   for(const source of sources)if(source&&typeof source.url==='string')openedUrls.push(source.url);
  }
 }
 return{queries:[...new Set(queries)],openedUrls:[...new Set(openedUrls.map(normalizedUrl).filter(Boolean))]};
}

function buildPrompt(input:WorkSimulationInput){
 const question=JSON.stringify({task_name:input.question.task_name,task_type:input.question.task_type,header:input.question.header,question:input.question.question,rubric:input.question.rubric});
 const harbor=harborTask(input.question);
 const attachmentNames=input.attachments.map(item=>item.name).join('、');
 return [
  '<role>你是为内部法律评测制作 AI 模拟专家成果的研究代理。你不是现实律师或真人专家。</role>',
  '<task>根据冻结题面、评分标准、全部脱敏材料和随附交付规范，完成题目要求的一个真实可用主成果，并记录本次确实完成的法律检索。</task>',
  '<files>必须逐个生成 project_context.harbor.metadata.deliverables 中列出的全部交付文件，harbor_files 的 path 与清单逐字一致。DOCX/MD/TXT/CSV/JSON 正文放在 markdown 字段，XLSX 按工作表返回 name、columns 和等长 rows。每个文件分别完成其用途，不得复制同一内容仅更名。若无法生成某一指定文件或资料不足，停止并在 unresolved 中说明。</files>',
  '读取并遵守 input_files/模拟专家生成提示词.md、交付规范.md 和模拟专家交付物与检索轨迹模板.md；逐一阅读全部 input_files/材料-*.md。',
  '<quality>不得读取或使用参考答案、作答思路、历史题目或评分结果。</quality>',
  '<input>',`项目题目：${input.title}`,`题面版本：${input.question_version}`,`Rubric 版本：${input.rubric_version}`,`题目包：${question}`,`Harbor 任务与文件契约：${JSON.stringify(harbor)}`,`脱敏材料：${attachmentNames}`,'</input>',
  '只返回 JSON Schema 指定字段。research_entries 中 query 必须原样对应实际工具搜索词，url 必须是实际打开的页面。',
 ].join('\n');
}

/** 用本项目冻结模型配置生成内部模拟成果；实际检索事件无法与输出逐项对上时不交付。 */
async function generateWorkSimulation(input:WorkSimulationInput,config:{model:string;reasoning_effort:string}):Promise<WorkSimulation>{
 const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../projects/Work法律全场景');
 const template=await readFile(join(projectRoot,'skill c/assets/模拟专家交付物与检索轨迹模板.md'),'utf8');
 const rules=await readFile(join(projectRoot,'materials/交付规范.md'),'utf8');
 const generationPrompt=await readFile(join(projectRoot,'scripts/siriser/模拟专家生成提示词.md'),'utf8');
 const workspace=await mkdtemp(join(tmpdir(),'ai-distill-work-delivery-'));
 try{
  const task=await runAgent({
   task_type:'project_delivery',execution_profile:'project_delivery',directory:workspace,
   prompt:buildPrompt(input),model:config.model,reasoning_effort:config.reasoning_effort,
   schema,timeout_ms:15*60*1000,
   input_files:[{name:'交付规范.md',text:rules},{name:'模拟专家交付物与检索轨迹模板.md',text:template},{name:'模拟专家生成提示词.md',text:generationPrompt},...input.attachments],
   validate:value=>validateHarborFiles(value,input.question),
  });
  const raw=await readFile(task.diagnostic_path,'utf8');
  const evidence=searchEvidence(raw),actualQueries=new Set(evidence.queries.map(value=>value.trim().toLocaleLowerCase()));
  const actualUrls=new Set(evidence.openedUrls);
  if(!actualQueries.size||!actualUrls.size)throw new Error('本次归档没有可核验的实际网页搜索和打开记录');
  const unmatched=task.result.research_entries.filter(row=>!actualQueries.has(row.query.trim().toLocaleLowerCase())||!actualUrls.has(normalizedUrl(row.url)));
  if(unmatched.length)throw new Error('模拟专家检索记录与本次实际网页搜索事件不一致');
  return{...task.result,generated_at:new Date().toISOString(),model:task.model,reasoning_effort:config.reasoning_effort,actual_search_queries:evidence.queries,actually_opened_urls:evidence.openedUrls};
 }finally{await rm(workspace,{recursive:true,force:true});}
}

/** 缓存键绑定归档来源摘要，重复归档复用同一生成结果，避免再次检索或改写。 */
export async function getOrGenerateWorkSimulation(pool:Pick<Pool,'query'>,input:WorkSimulationInput,storageRoot:string,sourceDigest:string):Promise<WorkSimulation>{
 if(input.question.content_contract==='work_legal_v1'){
  const q=input.question as unknown as WorkContent;
  if(q.content_status?.status!=='complete'||!q.reference_outputs?.length)throw new Error('Work内容尚未完成，不能转换成果');
  const records=q.research_records;
  if(records.some(r=>r.supports.length>0&&(r.verification_status!=='verified'||!r.source_url)))throw new Error('用于成果或判据的出题检索记录尚有未核验项，不在归档阶段重新创作补齐');
  const type=String(input.question.task_type).match(/^F[1-5]/)?.[0] as WorkSimulation['deliverable_type'];
  if(!type)throw new Error('Work主任务类型缺失');
  return {deliverable_type:type,deliverable_title:String(input.question.task_name),deliverable_markdown:projectReference(q),harbor_files:q.reference_outputs.map(output=>{const file=q.deliverables.find(d=>d.id===output.deliverable_id);if(!file)throw new Error('标准成果引用缺失');return{path:file.path,markdown:output.content,sheets:output.sheets};}),research_entries:records.map(r=>({id:r.id,query:r.query,title:r.source_title,url:r.source_url??'',finding:`${r.verification_status==='verified'?'已核验':'未核验'}：${r.findings}`,version_or_date:r.version,used_in:r.supports.join('、')||'未采用为成果或判据依据'})),unresolved:[],generated_at:new Date().toISOString(),model:'author_snapshot',reasoning_effort:'not_applicable',actual_search_queries:[],actually_opened_urls:[]};
 }
 if(!/^[a-f0-9]{64}$/i.test(sourceDigest))throw new Error('模拟成果来源摘要无效');
 const config=await readProjectAgentDefaults(pool,input.project_id);
 const cacheKey=createHash('sha256').update(`work-simulation-harbor-files-v2:${sourceDigest}:${config.model}:${config.reasoning_effort}`).digest('hex');
 const directory=join(resolve(storageRoot),'project-delivery','work-simulation',input.workflow_id);
 await mkdir(directory,{recursive:true,mode:0o700});
 if((await lstat(directory)).isSymbolicLink())throw new Error('模拟成果缓存目录不能是符号链接');
 const path=join(directory,`${cacheKey}.json`);
 try{
  const cache=JSON.parse(await readFile(path,'utf8')) as {source_digest?:string;simulation?:WorkSimulation};
  const value=cache.simulation;
  if(cache.source_digest!==cacheKey||!value||typeof value!=='object'||!Array.isArray(value.harbor_files)||!Array.isArray(value.actual_search_queries)||!Array.isArray(value.actually_opened_urls)||typeof value.generated_at!=='string'||value.model!==config.model||value.reasoning_effort!==config.reasoning_effort)throw new Error('模拟成果缓存与来源版本不一致');
  return value;
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const simulation=await generateWorkSimulation(input,config),current=await readProjectAgentDefaults(pool,input.project_id);
 if(current.model!==config.model||current.reasoning_effort!==config.reasoning_effort)throw new Error('生成期间项目 Agent 模型配置发生变化，请重新归档');
 const temporary=`${path}.${crypto.randomUUID()}.tmp`;
 try{await writeFile(temporary,JSON.stringify({source_digest:cacheKey,simulation},null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);}
 catch(error){await rm(temporary,{force:true});throw error;}
 return simulation;
}
