/**
 * 职责：把归档冻结的 AI 模拟专家成果、真实检索记录和脱敏材料生成 Siriser 内容稿五件套。
 * 关键入口：`generateSiriserConfirmation()` 生成平台JSON五件套和ZIP；`generateSiriserFivePiece()` 保留初稿兼容。
 * 使用场景：由 Work 项目 `scripts/delivery.ts` 在达标归档时调用；不操作平台、不声称外部验收通过。
 */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {buildRedactedDocx,REDACTED_DOCX_RENDERER_VERSION,type RedactedDocumentStructure} from '../../../../server/materials/redacted-docx';
import {buildXlsx,type WorkbookSheet} from '../../../../server/reporting/xlsx';
import {documentBlocksToText} from '../../../../server/materials/pdf';
import type {WorkContent} from '../../../../server/authoring/work-contract';

/** 根据作者声明的格式写完整成果；五件套不依赖先创建Harbor目录。 */
export async function deliverableBytes(file:Simulation['harbor_files'][number]){
 const extension=file.path.split('.').at(-1)?.toLowerCase();
 if(extension==='docx')return buildRedactedDocx(file.markdown);
 if(['md','txt','csv','tsv'].includes(extension??''))return Buffer.from(file.markdown,'utf8');
 if(extension==='json')return Buffer.from(JSON.stringify(JSON.parse(file.markdown),null,2)+'\n');
 if(extension==='xlsx')return buildXlsx(file.sheets.map(sheet=>({name:sheet.name,columns:sheet.columns,rows:sheet.rows.map(values=>Object.fromEntries(sheet.columns.map((column,index)=>[column,values[index]])))})));
 throw new Error(`五件套暂不支持成果格式：${extension}`);
}

interface RubricItem {id?:unknown;criterion?:unknown;rule?:unknown;max_score?:unknown;metadata?:unknown}
interface Simulation {
 deliverable_type:string;deliverable_title:string;deliverable_markdown:string;
 harbor_files:{path:string;markdown:string;sheets:{name:string;columns:string[];rows:(string|number|boolean)[][]}[]}[];
 research_entries:{id:string;query:string;title:string;url:string;finding:string;version_or_date:string;used_in:string}[];
 unresolved:string[];generated_at:string;model:string;reasoning_effort:string;
 actual_search_queries:string[];actually_opened_urls:string[];
}
export interface PackageInput {
 title:string;workflow_id:string;source_digest:string;delivery_digest:string;question_version:string;rubric_version:string;
 question:{task_name?:unknown;task_type?:unknown;header?:unknown;question?:unknown;rubric?:unknown;task_metadata?:WorkContent['task_metadata'];content_contract?:string;input_files?:WorkContent['input_files'];deliverables?:WorkContent['deliverables'];reference_outputs?:WorkContent['reference_outputs'];research_records?:WorkContent['research_records'];task_requirements?:WorkContent['task_requirements']};
 attachments:{name:string;text:string;documents?:RedactedDocumentStructure[]}[];simulation:Simulation;
}
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const safe=(value:unknown)=>typeof value==='string'?value.trim():'';
const json=(value:unknown)=>JSON.stringify(value??'',null,2);
const fileNames=['任务说明.docx','题目信息表.docx','评分要点.xlsx','input_files','golden_output'];
const SIRISER_CONFIRMATION_RENDERER_VERSION='siriser-confirmation-docx-v2';
const businessSelfDisclosure=[
 /(?:本(?:文件|文书|成果|报告|意见|方案)|本文)\s*(?:由|系|为)\s*(?:生成式\s*)?(?:AI|人工智能|模型)(?:系统|助手|代理)?\s*(?:生成|撰写|编写|制作)/iu,
 /(?:我是|本人是|作为)\s*(?:一个|一名)?\s*(?:AI|人工智能|大语言模型|语言模型)(?:系统|助手|代理|模型)?/iu,
 /(?:AI|人工智能)\s*(?:模拟专家成果|模拟成果)/iu,
];
function assertBusinessBody(text:string,path:string){
 if(businessSelfDisclosure.some(pattern=>pattern.test(text)))throw new Error(`业务正本包含生成身份自述：${path}`);
}
function assertBusinessFile(file:Simulation['harbor_files'][number]){
 assertBusinessBody(file.markdown,file.path);
 for(const sheet of file.sheets)for(const row of sheet.rows)for(const cell of row)if(typeof cell==='string')assertBusinessBody(cell,file.path);
}
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
  ID:safe(item.id)||`R${index+1}`,评分要点:safe(item.criterion),评分规则:safe(item.rule),满分:typeof item.max_score==='number'?item.max_score:((item.metadata as {score?:number|null}|undefined)?.score??'独立否决'),业务元数据:json(item.metadata),
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
export async function generateSiriserFivePiece(parent:string,input:PackageInput,harborGoldenDirectory?:string){
 if(!input.simulation||!input.attachments.length||!Array.isArray(input.simulation.harbor_files)||!input.simulation.harbor_files.length||! /^[a-f0-9]{64}$/i.test(input.source_digest)||! /^[a-f0-9]{64}$/i.test(input.delivery_digest))throw new Error('五件套输入绑定不完整');
 if(input.simulation.research_entries.length<1||!input.simulation.deliverable_markdown.trim())throw new Error('模拟专家成果或实际检索记录缺失');
 assertBusinessBody(input.simulation.deliverable_markdown,'主成果.docx');
 input.simulation.harbor_files.forEach(assertBusinessFile);
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
 const taskText=['# 任务说明','',`题目：${input.title}`,`成果类型：${input.simulation.deliverable_type} ${input.simulation.deliverable_title}`,'','## 任务要求','',safe(input.question.question),'','## 输入材料','',...input.attachments.map(item=>`- ${item.name}`),''].join('\n');
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
   await writeFile(join(temp,'input_files',`材料-${index}.docx`),await buildRedactedDocx(confirmationDocument(attachment.text,[{start:0,end:attachment.text.length}],attachment.documents)),{mode:0o600});
  }
  await writeFile(join(temp,'golden_output','主成果.docx'),await buildRedactedDocx(input.simulation.deliverable_markdown),{mode:0o600});
  const goldenRoot=harborGoldenDirectory?await realpath(harborGoldenDirectory):undefined,paths=input.simulation.harbor_files.map(file=>file.path);
  for(const path of paths)assertRelative(path);
  const reserved=['主成果.docx','法规案例检索轨迹.md','模拟生成记录.md'];
  if(new Set(paths).size!==paths.length||paths.some(path=>reserved.some(other=>path===other||path.startsWith(`${other}/`)||other.startsWith(`${path}/`))))throw new Error('Harbor 交付文件路径重复或与五件套固定文件冲突');
  for(const relativePath of paths){
   if(!goldenRoot){
    const file=input.simulation.harbor_files.find(item=>item.path===relativePath)!;
    const destination=join(temp,'golden_output',relativePath);await mkdir(dirname(destination),{recursive:true,mode:0o700});
    await writeFile(destination,await deliverableBytes(file),{mode:0o600,flag:'wx'});continue;
   }
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

/** 仅按已登记且SHA匹配的文书清单分册；未知材料保持原样，绝不按页数自动凑份数。 */
async function sourceDocumentFiles(name:string,text:string){
 const manifest=JSON.parse(await readFile(join(import.meta.dir,'document-boundaries.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.sources))throw new Error('文书分册清单版本无效');
 const source=manifest.sources.find((s:{sha256:string})=>s.sha256===sha(text));
 if(!source)return[{name:`${name}.docx`,text,ranges:[{start:0,end:text.length}]}];
 const markers=[...text.matchAll(/【附件\s*(\d+)】|【原附件第\s*(\d+)\s*页】/g)];
 const pages:{group:number;page:number;start:number;end:number}[]=[];let group=0,prefix=0;
 for(const [index,marker] of markers.entries()){
  if(marker[1]){group=Number(marker[1]);prefix=marker.index!;continue;}
  const start=pages.length&&pages.at(-1)!.group===group?marker.index!:prefix;
  pages.push({group,page:Number(marker[2]),start,end:markers[index+1]?.index??text.length});
 }
 // 下一组头部属于下一组首文书，不留在上一文书末尾；所有字符须恰好覆盖一次。
 for(let i=0;i<pages.length-1;i++)pages[i]!.end=pages[i+1]!.start;
 if(!pages.length)throw new Error('已登记分册清单未匹配原页标记');pages[0]!.start=0;
 const used=new Set<string>();
 const files=source.documents.map((doc:{id:string;title:string;ranges:{group:number;first:number;last:number}[]})=>{
  if(!/^DOC-\d+$/.test(doc.id)||!doc.title||!Array.isArray(doc.ranges)||!doc.ranges.length)throw new Error('文书分册条目无效');
  const ranges=doc.ranges.map(range=>{
   if(!Number.isInteger(range.group)||!Number.isInteger(range.first)||!Number.isInteger(range.last)||range.last<range.first)throw new Error('文书页码无效');
   const selected=pages.filter(p=>p.group===range.group&&p.page>=range.first&&p.page<=range.last);
   if(selected.length!==range.last-range.first+1)throw new Error('文书页段不连续或缺页');
   for(const page of selected){const key=`${page.group}:${page.page}`;if(used.has(key))throw new Error('文书清单重复引用同一页');used.add(key);}
   return{start:selected[0]!.start,end:selected.at(-1)!.end};
  });
  const locator=doc.ranges.map(r=>`A${r.group}P${r.first}-${r.last}`).join("_");
  const filename=`${name}-${doc.id}-${locator}.docx`;assertRelative(filename);
  return{name:filename,text:ranges.map(r=>text.slice(r.start,r.end)).join(''),ranges};
 });
 if(used.size!==pages.length||!files.length)throw new Error('文书分册未覆盖全部原页');
 const ranges=files.flatMap((file:{ranges:{start:number;end:number}[]})=>file.ranges).sort((a:{start:number},b:{start:number})=>a.start-b.start);
 if(ranges[0]?.start!==0||ranges.at(-1)?.end!==text.length||ranges.some((r:{start:number},i:number)=>i>0&&r.start!==ranges[i-1].end))throw new Error('分册正文有缺失或重叠');
 return files as {name:string;text:string;ranges:{start:number;end:number}[]}[];
}

/** 将已校验的脱敏结构投影到原分册页段；历史无结构只走Markdown兼容，不读取原件。 */
export function confirmationDocument(text:string,ranges:{start:number;end:number}[],documents?:RedactedDocumentStructure[]):string|RedactedDocumentStructure{
 if(!documents?.length)return ranges.map(range=>text.slice(range.start,range.end)).join('');
 // 外层页定位来自结构投影的实际偏移，正文里的同形附件/页码标记不是结构边界。
 let expected='';
 const locations:{offset:number;group:number;page:RedactedDocumentStructure['pages'][number]}[]=[];
 documents.forEach((document,index)=>{
  if(index)expected+='\n\n';
  expected+=`【附件 ${index+1}】\n\n`;
  document.pages.forEach((page,pageIndex)=>{
   if(pageIndex)expected+='\n\n';
   locations.push({offset:expected.length,group:index+1,page});
   expected+=`【原附件第 ${page.page} 页】\n${documentBlocksToText(page.blocks)}`;
  });
  expected+=`\n\n【附件 ${index+1} 结束】`;
 });
 if(expected!==text)throw new Error('确认稿脱敏结构与冻结正文不一致');
 const pages:RedactedDocumentStructure['pages']=[];
 for(const {offset,group,page} of locations){
  if(!ranges.some(range=>offset>=range.start&&offset<range.end))continue;
  const unresolved=page.issues?.filter(issue=>!['empty_page','empty_after_recheck'].includes(issue))??[];
  if(unresolved.length)throw new Error(`原附件第 ${page.page} 页复识别后仍存在识别问题`);
  if(!documentBlocksToText(page.blocks).trim()){
   // Empty pages without unresolved recognition issues have no content to deliver.
   continue;
  }
  pages.push({...page,blocks:[{kind:'paragraph',text:`【附件 ${group} · 原附件第 ${page.page} 页】`},...page.blocks]});
 }
 if(!pages.length)throw new Error('确认稿分册未包含脱敏结构页');
 return{format:'redacted-structure-v1',pages};
}

/** 平台确认稿：投影冻结作者内容，独立于Harbor；不改事实、判据或捏造认领码。 */
export async function generateSiriserConfirmation(parent:string,input:PackageInput,options:{expertName?:string;date?:string}={}){
 const q=input.question,m=q.task_metadata;
 if(q.content_contract!=='work_legal_v1'||!m||!q.input_files?.length||!q.deliverables?.length||!q.reference_outputs?.length||!q.research_records?.length||!Array.isArray(q.rubric))throw new Error('平台确认稿需要完整Work作者快照');
 if(!/^[a-f0-9]{64}$/i.test(input.source_digest)||!/^[a-f0-9]{64}$/i.test(input.delivery_digest)||q.input_files.length!==input.attachments.length)throw new Error('平台确认稿输入绑定不完整');
 for(const file of q.deliverables){
  const output=q.reference_outputs.find(item=>item.deliverable_id===file.id);if(!output)throw new Error('缺少完整标准成果');
  assertBusinessBody(output.content,file.path);
  for(const sheet of output.sheets)for(const row of sheet.rows)for(const cell of row)if(typeof cell==='string')assertBusinessBody(cell,file.path);
 }
 const code=/^([A-Z]{2}\d{2})(?:\s|$)/.exec(m.scenario)?.[1];
 if(!code)throw new Error('缺少可映射的三级场景编号');
 const expertName=options.expertName??'杨政'; // 本项目用户已确认的认领姓名；不是专家核定声明。
 const date=options.date??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replace(/-/g,'');
 if(!/^\d{8}$/.test(date)||!expertName.trim()||/[\\/:*?"<>|\x00-\x1f]/.test(expertName))throw new Error('五件套日期或署名无效');
 const name=`法律-${code}-${date}-${expertName}`,root=join(parent,'Siriser五件套',`${input.source_digest.slice(0,16)}-${input.delivery_digest.slice(0,16)}`),target=join(root,name),statePath=join(parent,'Siriser五件套.json');
 const sceneCategory:Record<string,string>={LS02:'1.1 案件受理与策略',LS03:'1.1 案件受理与策略',LS04:'1.2 庭审与文书',LS05:'1.2 庭审与文书'};
 // 保持完整原题面，诉求拆分只提取已存在段落；不使用另一轮模型重写任务。
 const question=safe(q.question),paragraphs=question.split(/\n\s*\n/),requests=paragraphs.filter(p=>/^(?:#{1,6}\s*)?(?:\d+[.、）)]\s*|[-*]\s+)/.test(p));
 const baseline=/(?:基准日|基准日期)\s*[:：]\s*(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})/.exec(question);
 const projected=await Promise.all(q.input_files.map((file,index)=>sourceDocumentFiles(file.name,input.attachments[index]!.text)));
 const projectionNote=projected.some(files=>files.length>1)?'\n\n材料定位说明：合订附件按完整文书分册；文件名前缀“附件N”仍对应题面同一附件，正文保留原附件编号与原页标记，DOC编号仅用于分册定位。未增加或删减原文。':'';
 const instruction={background:question+projectionNote,requests:requests.length?requests:['按上述委托任务及以下成果清单完成工作。'],deliverableReqs:q.deliverables.map(f=>`${f.path}（${f.required?'必交':'选交'}）：${f.description}`).join('\n'),baselineDate:baseline?`${baseline[1]}-${baseline[2]!.padStart(2,'0')}-${baseline[3]!.padStart(2,'0')}`:'',hardConstraints:paragraphs.filter(p=>/^(?:基准日|硬性约束|特别约定|约束条件)\s*[:：]/.test(p)),commissionerType:'professional',tone:'法律专业人士'};
 const metadata={title:safe(q.task_name)||input.title,domain:'法律',claimCode:code,taskType:safe(q.task_type).match(/^F[1-5]/)?.[0]??'',longevity:m.target_level,businessArea:sceneCategory[code]??m.domain_l2??'',summary:safe(q.task_name)||input.title,abilities:m.capabilities,dependsVl:m.vl_dependency,vlFiles:m.vl_dependency?projected.flat().map(f=>f.name):[],hasScan:false,scanFiles:[],taskDesc:`${m.level_basis.explanation}\n${m.generation_note}`,expertHours:m.level_basis.estimated_hours,dataSource:m.source_note,neededTools:m.tools,neededKnowledge:m.professional_knowledge};
 const anchors:Record<string,string[]>={F1:['Q3','Q4'],F2:['Q2','Q3'],F3:['Q1','Q4'],F4:['Q4','Q6'],F5:['Q1','Q5']};
 const items=(q.rubric as RubricItem[]).map(item=>{
  if(!item.id||!item.metadata||typeof item.metadata!=='object')throw new Error('Work评分条目缺少原始字段');
  return{id:item.id,...item.metadata};
 });
 const rubric={task_id:name,domain:'法律',task_type:q.task_type,difficulty_tier:m.target_level,anchor_dimensions:anchors[metadata.taskType]??[],items};
 const contentHash=sha(JSON.stringify({input_format:REDACTED_DOCX_RENDERER_VERSION,confirmation_renderer:SIRISER_CONFIRMATION_RENDERER_VERSION,question:q,attachments:input.attachments,projection:projected.map(files=>files.map(({name,ranges})=>({name,ranges}))),expertName,date}));
 await mkdir(root,{recursive:true,mode:0o700});
 const previous=await lstat(target).catch(error=>(error as NodeJS.ErrnoException).code==='ENOENT'?undefined:Promise.reject(error));
 if(previous){
  if(!previous.isDirectory()||previous.isSymbolicLink())throw new Error('已有确认稿路径不是普通目录');
  const state=JSON.parse(await readFile(join(root,`${name}.state.json`),'utf8'));
  const files=await inventory(target),bytes=await readFile(join(root,`${name}.zip`));
  if(state.content_sha256!==contentHash||JSON.stringify(state.files)!==JSON.stringify(files)||state.zip_sha256!==sha(bytes))throw new Error('已有确认稿与冻结输入或文件摘要不一致');
  await writeFile(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
  return{directory:target,zip_path:join(root,`${name}.zip`),filename:`${name}.zip`,sha256:state.zip_sha256,files:files.length,reused:true};
 }
 const temp=join(root,`.${randomUUID()}.tmp`),folder=join(temp,name);
 await mkdir(join(folder,'input_files'),{recursive:true,mode:0o700});await mkdir(join(folder,'golden_output'),{mode:0o700});
 try{
  for(const [file,value] of [['instruction.json',instruction],['metadata.json',metadata],['rubric.json',rubric]] as const)await writeFile(join(folder,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});
  for(const [index,files] of projected.entries())for(const file of files){
   if(!file.text.trim())throw new Error('确认稿缺少脱敏正文');
   await writeFile(join(folder,'input_files',file.name),await buildRedactedDocx(confirmationDocument(input.attachments[index]!.text,file.ranges,input.attachments[index]!.documents)),{mode:0o600,flag:'wx'});
  }
  const paths=new Set<string>();
  for(const file of q.deliverables){
   assertRelative(file.path);if(paths.has(file.path)||file.path==='法规案例检索轨迹.xlsx')throw new Error('标准成果路径重复或与检索轨迹冲突');paths.add(file.path);
   const output=q.reference_outputs.find(item=>item.deliverable_id===file.id);if(!output)throw new Error('缺少完整标准成果');
   const destination=join(folder,'golden_output',file.path);await mkdir(dirname(destination),{recursive:true,mode:0o700});
   await writeFile(destination,await deliverableBytes({path:file.path,markdown:output.content,sheets:output.sheets}),{mode:0o600,flag:'wx'});
  }
  const columns=['序号','检索词','命中要点','正文来源URL','来源档位','版本核验说明'];
  const rows=q.research_records.map((r,index)=>({'序号':index+1,'检索词':r.query,'命中要点':r.findings,'正文来源URL':r.source_url??'','来源档位':r.verification_status==='verified'?'一档（正文来源，允许）':'二档（辅助，不作依据）','版本核验说明':`${r.version}；作者记录：${r.verification_status}；归档未重新检索；关联：${r.supports.join('、')||'未采用'}`}));
  await writeFile(join(folder,'golden_output','法规案例检索轨迹.xlsx'),buildXlsx([{name:'法规案例检索轨迹',columns,rows}]),{mode:0o600});
  const files=await inventory(folder),zipPath=join(temp,`${name}.zip`);
  const child=Bun.spawn(['zip','-qr',zipPath,name],{cwd:temp,stdout:'ignore',stderr:'pipe'});
  const [,exit]=await Promise.all([new Response(child.stderr).text(),child.exited]);if(exit!==0)throw new Error('五件套ZIP生成失败');
  const bytes=await readFile(zipPath),relativeZip=`Siriser五件套/${input.source_digest.slice(0,16)}-${input.delivery_digest.slice(0,16)}/${name}.zip`;
  const state={format:'siriser_confirmation_v1',input_format:'docx',input_renderer:REDACTED_DOCX_RENDERER_VERSION,confirmation_renderer:SIRISER_CONFIRMATION_RENDERER_VERSION,workflow_id:input.workflow_id,source_digest:input.source_digest,delivery_digest:input.delivery_digest,question_version:input.question_version,rubric_version:input.rubric_version,content_sha256:contentHash,filename:`${name}.zip`,zip_relative_path:relativeZip,zip_sha256:sha(bytes),zip_bytes:bytes.length,files,physical_input_files:projected.flat().length,input_projection:projected.map((files,index)=>({source_name:q.input_files![index]!.name,structure_mode:input.attachments[index]!.documents?.length?'redacted-structure':'legacy-markdown',source_sha256:sha(input.attachments[index]!.text),files:files.map(({name,ranges,text})=>({name,ranges,sha256:sha(text)}))})),declared_document_entries:m.level_basis.documents.length,submission_ready:false,submitted:false};
  await rename(folder,target);await rename(zipPath,join(root,`${name}.zip`));
  await writeFile(join(root,`${name}.state.json`),JSON.stringify(state,null,2)+'\n',{mode:0o600});await writeFile(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
  return{directory:target,zip_path:join(root,`${name}.zip`),filename:`${name}.zip`,sha256:state.zip_sha256,files:files.length,reused:false};
 }finally{await rm(temp,{recursive:true,force:true});}
}
