/**
 * 职责：把归档冻结的 AI 模拟专家成果、真实检索记录和脱敏材料生成 Siriser 内容稿五件套。
 * 关键入口：`generateSiriserFivePiece()` 生成两个 DOCX、评分 XLSX、脱敏输入及含全部交付文件的 golden_output。
 * 使用场景：由 Work 项目 `scripts/delivery.ts` 在达标归档时调用；不操作平台、不声称外部验收通过。
 */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {buildRedactedDocx} from '../../../../server/materials/redacted-docx';
import {buildXlsx,type WorkbookSheet} from '../../../../server/reporting/xlsx';
import type {WorkContent} from '../../../../server/authoring/work-contract';

interface RubricItem {id?:unknown;criterion?:unknown;rule?:unknown;max_score?:unknown;metadata?:unknown}
interface Simulation {
 deliverable_type:string;deliverable_title:string;deliverable_markdown:string;
 harbor_files:{path:string;markdown:string;sheets:{name:string;columns:string[];rows:(string|number|boolean)[][]}[]}[];
 research_entries:{id:string;query:string;title:string;url:string;finding:string;version_or_date:string;used_in:string}[];
 unresolved:string[];generated_at:string;model:string;reasoning_effort:string;
 actual_search_queries:string[];actually_opened_urls:string[];
}
interface PackageInput {
 title:string;workflow_id:string;source_digest:string;delivery_digest:string;question_version:string;rubric_version:string;
 question:{task_name?:unknown;task_type?:unknown;header?:unknown;question?:unknown;rubric?:unknown;task_metadata?:WorkContent['task_metadata']};
 attachments:{name:string;text:string}[];simulation:Simulation;
}
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const safe=(value:unknown)=>typeof value==='string'?value.trim():'';
const json=(value:unknown)=>JSON.stringify(value??'',null,2);
const fileNames=['任务说明.docx','题目信息表.docx','评分要点.xlsx','input_files','golden_output'];
function assertRelative(path:string){
 if(!path||Buffer.byteLength(path,'utf8')>200||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\u0000-\u001f\u007f]/.test(path))throw new Error(`五件套交付文件路径无效：${path}`);
}

export function traceMarkdown(simulation:Simulation){
 const rows=simulation.research_entries.map(row=>{
  const title=row.title.replace(/\|/g,'\\|'),source=row.url?`[${title}](${row.url})`:`${title}（未取得正文URL）`;
  return`| ${row.id} | ${row.query.replace(/\|/g,'\\|')} | ${source} | ${row.finding.replace(/[\r\n|]/g,' ')} | ${row.version_or_date.replace(/[\r\n|]/g,' ')} | ${row.used_in.replace(/[\r\n|]/g,' ')} |`;
 });
 const origin=simulation.model==='author_snapshot'?'本记录投影出题阶段的作者冻结检索记录；归档未重新联网，也未新增搜索或打开事件。记录中的核验状态不代替事件核查、法律正确性或人工验收。':'本记录对应本次 AI 模拟生成过程。仅列与实际 Codex 网页搜索／打开事件匹配的来源；自动匹配不等于法律正确性或人工验收。';
 return ['# 法规案例检索轨迹','',origin,'','| 编号 | 实际检索词 | 来源正文 | 核验要点 | 版本／日期 | 成果引用位置 |','| --- | --- | --- | --- | --- | --- |',...rows,'','## 归档阶段实际搜索词','',...simulation.actual_search_queries.map(query=>`- ${query}`),'','## 归档阶段实际打开页面','',...simulation.actually_opened_urls.map(url=>`- ${url}`),''].join('\n');
}

/** 新旧题目共用信息表；缺少正式分类如实显示，不能猜造登记值。 */
export function taskInfoMarkdown(input:PackageInput){
 const header=input.question.header&&typeof input.question.header==='object'?input.question.header as Record<string,unknown>:{},m=input.question.task_metadata;
 return ['# 题目信息表','',`题目名称：${safe(input.question.task_name)||input.title}`,`任务类型：${safe(input.question.task_type)}`,`行业一级：${safe(header.industry_l1)}`,`行业二级：${safe(header.industry_l2)}`,`职业一级：${safe(header.occupation_l1)}`,`职业二级：${safe(header.occupation_l2)}`,...(m?[`执业岗位：${m.occupation}`,`场景：${m.scenario}`,`角色视角：${m.role_perspective}`,`领域二级标签：${m.domain_l2??'未提供正式二级标签'}`,`评测能力：${m.capabilities.join('、')}`,`专业知识：${m.professional_knowledge.join('、')}`,`长程等级：${m.target_level}`,`业务人时：${m.level_basis.estimated_hours??'未估算'}`,`等级依据：${m.level_basis.explanation}`,`所需工具：${m.tools.join('、')||'无额外工具'}`,`视觉依赖：${m.vl_dependency?'是':'否'}`,`来源说明：${m.source_note}`,`生成说明：${m.generation_note}`]:[]),`题面版本：${input.question_version}`,`Rubric版本：${input.rubric_version}`,`工作流ID：${input.workflow_id}`,`模拟成果类型：${input.simulation.deliverable_type}`,`模拟成果名称：${input.simulation.deliverable_title}`,'','身份说明：本包是内部AI模拟成果，不是现实专家身份或外部验收凭据。',''].join('\n');
}

function generationRecord(input:PackageInput){
 return ['# AI 模拟生成记录','','生成性质：AI 模拟专家成果，不代表真人律师或专家办理、签署、核定。',`生成时间：${input.simulation.generated_at}`,`工作流 ID：${input.workflow_id}`,`题面版本：${input.question_version}`,`Rubric 版本：${input.rubric_version}`,`来源摘要：${input.source_digest}`,`生成模型：${input.simulation.model}`,`推理强度：${input.simulation.reasoning_effort}`,`成果类型：${input.simulation.deliverable_type}`,`读取的脱敏材料：${input.attachments.map(item=>item.name).join('、')}`,input.simulation.model==='author_snapshot'?'实际检索：采用作者冻结记录，归档未重新联网；详情见《法规案例检索轨迹.md》。':'实际检索：由网页搜索事件核对查询词及打开URL；详情见《法规案例检索轨迹.md》。','未决事项：',...(input.simulation.unresolved.length?input.simulation.unresolved.map(item=>`- ${item}`):['- 未记录未决事项']), '','自动状态：已完成内容文件组装；Oracle、Harbor 自测、三模型运行、人工质量复核和平台验收均未由本流程执行。',''].join('\n');
}

function rubricWorkbook(rubric:unknown):WorkbookSheet{
 if(!Array.isArray(rubric)||!rubric.length)throw new Error('Rubric 为空，不能生成评分要点表');
 return{name:'评分要点',columns:['ID','评分要点','评分规则','满分','业务元数据'],rows:(rubric as RubricItem[]).map((item,index)=>({
  ID:safe(item.id)||`R${index+1}`,评分要点:safe(item.criterion),评分规则:safe(item.rule),满分:typeof item.max_score==='number'?item.max_score:'',业务元数据:json(item.metadata),
 }))};
}

async function inventory(directory:string){
 const files:{path:string;sha256:string}[]=[];
 const walk=async(folder:string,prefix='')=>{
  for(const entry of await readdir(folder,{withFileTypes:true})){
   const relative=prefix?`${prefix}/${entry.name}`:entry.name,path=join(folder,entry.name),info=await lstat(path);
   if(info.isSymbolicLink())throw new Error(`五件套禁止符号链接：${relative}`);
   if(entry.isDirectory())await walk(path,relative);
   else if(info.isFile())files.push({path:relative,sha256:sha(await readFile(path))});
   else throw new Error(`五件套包含不支持的文件：${relative}`);
  }
 };
 await walk(directory);return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}

/** 原子生成内容稿五件套；同一来源只复用文件摘要完全一致的包。 */
export async function generateSiriserFivePiece(parent:string,input:PackageInput,harborGoldenDirectory:string){
 if(!input.simulation||!input.attachments.length||!Array.isArray(input.simulation.harbor_files)||!input.simulation.harbor_files.length||! /^[a-f0-9]{64}$/i.test(input.source_digest)||! /^[a-f0-9]{64}$/i.test(input.delivery_digest))throw new Error('五件套输入绑定不完整');
 if(input.simulation.research_entries.length<1||!input.simulation.deliverable_markdown.trim())throw new Error('模拟专家成果或实际检索记录缺失');
 const root=join(parent,'Siriser五件套'),packageName=`法律-AI模拟-${input.workflow_id.slice(0,8)}-${input.source_digest.slice(0,8)}-${input.delivery_digest.slice(0,8)}`;
 const target=join(root,packageName),stateDir=join(parent,'交付状态'),statePath=join(stateDir,`siriser-${input.source_digest}-${input.delivery_digest}.json`);
 await mkdir(root,{recursive:true,mode:0o700});await mkdir(stateDir,{recursive:true,mode:0o700});
 const existing=await lstat(target).catch(error=>(error as NodeJS.ErrnoException).code==='ENOENT'?undefined:Promise.reject(error));
 if(existing){
  if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error('已有 Siriser 五件套路径不是普通目录');
  const state=JSON.parse(await readFile(statePath,'utf8')) as {source_digest?:string;delivery_digest?:string;files?:{path:string;sha256:string}[]};
  if(state.source_digest!==input.source_digest||state.delivery_digest!==input.delivery_digest)throw new Error('已有 Siriser 五件套来源摘要不一致');
  const current=await inventory(target);
  if(JSON.stringify(current)!==JSON.stringify(state.files))throw new Error('Siriser 五件套文件与归档清单不一致');
  return{directory:target,files:current.length,reused:true};
 }
 const taskText=['# 任务说明','',`题目：${input.title}`,`成果类型：${input.simulation.deliverable_type} ${input.simulation.deliverable_title}`,'','## 任务要求','',safe(input.question.question),'','## 评分标准','',...(input.question.rubric as RubricItem[]).map(item=>`- ${safe(item.id)}：${safe(item.criterion)}${safe(item.rule)?`；${safe(item.rule)}`:''}`),'','## 输入材料','',...input.attachments.map(item=>`- ${item.name}`),''].join('\n');
 const infoText=taskInfoMarkdown(input);
 const temp=join(root,`.${packageName}.${randomUUID()}.tmp`);
 await mkdir(temp,{recursive:true,mode:0o700});
 try{
  await mkdir(join(temp,'input_files'),{mode:0o700});await mkdir(join(temp,'golden_output'),{mode:0o700});
  await writeFile(join(temp,'任务说明.docx'),await buildRedactedDocx(taskText),{mode:0o600});
  await writeFile(join(temp,'题目信息表.docx'),await buildRedactedDocx(infoText),{mode:0o600});
  await writeFile(join(temp,'评分要点.xlsx'),buildXlsx([rubricWorkbook(input.question.rubric)]),{mode:0o600});
  for(const attachment of input.attachments){
   const index=String(input.attachments.indexOf(attachment)+1).padStart(3,'0');
   await writeFile(join(temp,'input_files',`材料-${index}.docx`),await buildRedactedDocx(attachment.text),{mode:0o600});
  }
  await writeFile(join(temp,'golden_output','模拟专家主成果.docx'),await buildRedactedDocx(input.simulation.deliverable_markdown),{mode:0o600});
  const goldenRoot=await realpath(harborGoldenDirectory),paths=input.simulation.harbor_files.map(file=>file.path);
  for(const path of paths)assertRelative(path);
  const reserved=['模拟专家主成果.docx','法规案例检索轨迹.md','模拟生成记录.md'];
  if(new Set(paths).size!==paths.length||paths.some(path=>reserved.some(other=>path===other||path.startsWith(`${other}/`)||other.startsWith(`${path}/`))))throw new Error('Harbor 交付文件路径重复或与五件套固定文件冲突');
  for(const relativePath of paths){
   let source=goldenRoot;
   const parts=relativePath.split('/');
   for(const [index,part] of parts.entries()){
    source=join(source,part);const info=await lstat(source);
    if(info.isSymbolicLink()||(index===parts.length-1?!info.isFile():!info.isDirectory()))throw new Error(`Harbor 交付文件不是安全的普通文件：${relativePath}`);
   }
   if(await realpath(source)!==source)throw new Error(`Harbor 交付文件路径越界：${relativePath}`);
   const destination=join(temp,'golden_output',...parts);
   await mkdir(dirname(destination),{recursive:true,mode:0o700});
   await writeFile(destination,await readFile(source),{mode:0o600,flag:'wx'});
  }
  await writeFile(join(temp,'golden_output','法规案例检索轨迹.md'),traceMarkdown(input.simulation),{mode:0o600});
  await writeFile(join(temp,'golden_output','模拟生成记录.md'),generationRecord(input),{mode:0o600});
  const top=await readdir(temp);
  if(fileNames.some(name=>!top.includes(name))||top.length!==fileNames.length)throw new Error('Siriser 五件套根目录结构不完整');
  const files=await inventory(temp),packageHash=sha(JSON.stringify(files));
  await rename(temp,target);
  const state={source_digest:input.source_digest,delivery_digest:input.delivery_digest,package_hash:packageHash,files,directory:packageName,generated_at:input.simulation.generated_at};
  await writeFile(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
  return{directory:target,files:files.length,reused:false};
 }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
}
