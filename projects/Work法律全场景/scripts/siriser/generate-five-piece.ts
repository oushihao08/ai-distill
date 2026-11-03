/**
 * 职责：生成 Work Siriser 五件套；旧契约使用归档阶段生成的 AI 成果，新 work_legal_v1 投影题目冻结的作者成果与检索记录。
 * 关键入口：`generateSiriserConfirmation()` 生成平台JSON五件套和ZIP；`markZipFilenamesUtf8()` 修正标准ZIP文件名标志；`generateSiriserFivePiece()` 保留初稿兼容。
 * 使用场景：由 Work 项目 `scripts/delivery.ts` 在达标归档时调用；不操作平台、不声称外部验收通过。
 */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {buildDocx,preparedTextDocument,REDACTED_DOCX_RENDERER_VERSION,type RedactedDocumentStructure} from '../../../../server/document-generation/docx';
import {buildXlsx,type WorkbookSheet} from '../../../../server/document-generation/xlsx';
import {documentBlocksToText} from '../../../../server/materials/pdf';
import {assertWorkBusinessRequirements,assertWorkSubmissionReady,workLevelWarnings,type WorkContent} from '../../../../server/authoring/work-contract';
import {inspectPdfScan} from './scan-metadata';

/** 根据作者声明的格式写完整成果；五件套不依赖先创建Harbor目录。 */
export async function deliverableBytes(file:Simulation['harbor_files'][number]){
 const extension=file.path.split('.').at(-1)?.toLowerCase();
 if(extension==='docx')return buildDocx(file.markdown,{style:'legal'});
 if(['md','txt','csv','tsv'].includes(extension??''))return Buffer.from(file.markdown,'utf8');
 if(extension==='json')return Buffer.from(JSON.stringify(JSON.parse(file.markdown),null,2)+'\n');
 if(extension==='xlsx'){
  const sheets:WorkbookSheet[]=file.sheets.map(sheet=>({name:sheet.name,columns:sheet.columns,rows:sheet.rows.map(values=>Object.fromEntries(sheet.columns.map((column,index)=>[column,values[index]])))}));
  if(file.markdown.trim())sheets.push({name:'正文说明',columns:['行','正文'],rows:file.markdown.split('\n').map((text,index)=>({'行':index+1,'正文':text})),columnWidths:{'行':8,'正文':120},rowHeight:150});
  return buildXlsx(sheets);
 }
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
 attachments:{name:string;text:string;material_mode?:'redacted'|'original';selected_materials?:boolean;documents?:RedactedDocumentStructure[];prepared_documents?:{id:string;title:string;text:string;document?:RedactedDocumentStructure}[];original_files?:{name:string;sha256:string;content_base64:string}[]}[];simulation:Simulation;
}
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const safe=(value:unknown)=>typeof value==='string'?value.trim():'';
const json=(value:unknown)=>JSON.stringify(value??'',null,2);
const fileNames=['任务说明.docx','题目信息表.docx','评分要点.xlsx','input_files','golden_output'];
const SIRISER_CONFIRMATION_RENDERER_VERSION='siriser-confirmation-office-v10';
/** 历史题只识别明确标注的时点和约束，保持完整原题面；不拿开庭日或法条年份猜基准日。 */
export function legacyInstruction(question:string){
 const patterns=[/基准(?:时间点|日期|日)\s*(?:[:：]|为|是)?\s*(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})/g,/(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})日?\s*(?:为|作为|这一)?(?:本次|本案|判断|业务|准备|办理){0,3}基准(?:时间点|日期|日)/g];
 const dates=patterns.flatMap(pattern=>[...question.matchAll(pattern)].map(match=>`${match[1]}-${match[2]!.padStart(2,'0')}-${match[3]!.padStart(2,'0')}`));
 const unique=[...new Set(dates)],date=unique[0];
 const baselineDate=unique.length===1&&date&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date?date:'';
 const hardConstraints:string[]=[],requests=question.split(/\n\s*\n/).filter(p=>/^(?:#{1,6}\s*)?(?:\d+[.、）)]\s*|[-*]\s+)/.test(p));
 let active=false;
 for(const line of question.split('\n')){
  const heading=/^\s*(?:#{1,6}\s*)?(?:\d+[.、]\s*)?(?:硬性约束|硬约束|特别约定|约束条件)\s*[:：]?\s*(.*)$/.exec(line);
  if(heading){active=true;if(heading[1]?.trim())hardConstraints.push(heading[1].trim());continue;}
  if(active&&/^\s*(?:#{1,6}\s+|(?:背景|委托方诉求|交付物要求|成果要求|基准日|附件说明)(?:\s*[:：]|\s*$))/.test(line)){active=false;}
  if(active&&line.trim()){const item=line.trim().replace(/^(?:\d+[.、）)]|[-*])\s*/,'');if(item)hardConstraints.push(item);}
 }
 return{baselineDate,hardConstraints,requests:requests.length?requests:['按上述委托任务及以下成果清单完成工作。']};
}
async function writeAtomic(path:string,bytes:Uint8Array|string){
 const temporary=join(dirname(path),`.${randomUUID()}.tmp`);
 try{await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}
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
/** 旧Harbor副本必须含对应Office正文，不能把纯文本改扩展名后复制交付。 */
async function assertOfficeFile(source:string,path:string){
 try{
  const member=path.toLowerCase().endsWith('.docx')?'word/document.xml':'xl/workbook.xml';
  const child=Bun.spawn(['unzip','-p',source,member],{stdout:'pipe',stderr:'pipe'});
  const [xml,,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(exit!==0||!xml.includes(member.startsWith('word/')?'<w:document':'<workbook'))throw new Error('invalid Office package');
 }catch{throw new Error(`交付文件不是有效Office成果：${path}`);}
}
function assertRelative(path:string){
 if(!path||Buffer.byteLength(path,'utf8')>200||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\u0000-\u001f\u007f]/.test(path))throw new Error(`五件套交付文件路径无效：${path}`);
}

/** macOS自带zip会写入UTF-8路径字节却不设置ZIP通用标志位；补上bit 11，避免接收端按CP437显示中文乱码。 */
export function markZipFilenamesUtf8(input:Uint8Array){
 const bytes=Buffer.from(input),minimum=22,searchFrom=Math.max(0,bytes.length-minimum-0xffff);let end=-1;
 for(let offset=bytes.length-minimum;offset>=searchFrom;offset--)if(bytes.readUInt32LE(offset)===0x06054b50&&offset+minimum+bytes.readUInt16LE(offset+20)===bytes.length){end=offset;break;}
 if(end<0)throw new Error('五件套ZIP缺少有效的结束记录');
 const disk=bytes.readUInt16LE(end+4),centralDisk=bytes.readUInt16LE(end+6),diskCount=bytes.readUInt16LE(end+8),count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),centralStart=bytes.readUInt32LE(end+16);
 if(disk!==0||centralDisk!==0||diskCount!==count||count===0xffff||centralSize===0xffffffff||centralStart===0xffffffff)throw new Error('五件套ZIP使用了不支持的分卷或ZIP64格式');
 const centralEnd=centralStart+centralSize;if(centralEnd>end)throw new Error('五件套ZIP中央目录越界');
 const decodeName=(name:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(name);
 let offset=centralStart;
 for(let index=0;index<count;index++){
  if(offset+46>centralEnd||bytes.readUInt32LE(offset)!==0x02014b50)throw new Error('五件套ZIP中央目录损坏');
  const nameLength=bytes.readUInt16LE(offset+28),extraLength=bytes.readUInt16LE(offset+30),commentLength=bytes.readUInt16LE(offset+32),localOffset=bytes.readUInt32LE(offset+42),centralName=bytes.subarray(offset+46,offset+46+nameLength);
  if(offset+46+nameLength+extraLength+commentLength>centralEnd||localOffset+30>centralStart||localOffset+30>bytes.length||decodeName(centralName).length===0)throw new Error('五件套ZIP文件名或本地目录越界');
  if(bytes.readUInt32LE(localOffset)!==0x04034b50)throw new Error('五件套ZIP本地文件头损坏');
  const localNameLength=bytes.readUInt16LE(localOffset+26),localExtraLength=bytes.readUInt16LE(localOffset+28),localNameStart=localOffset+30,localName=bytes.subarray(localNameStart,localNameStart+localNameLength);
  if(localNameLength!==nameLength||!localName.equals(centralName)||localNameStart+localNameLength+localExtraLength>centralStart)throw new Error('五件套ZIP本地与中央文件名不一致');
  decodeName(localName);
  bytes.writeUInt16LE(bytes.readUInt16LE(offset+8)|0x0800,offset+8);
  bytes.writeUInt16LE(bytes.readUInt16LE(localOffset+6)|0x0800,localOffset+6);
  offset+=46+nameLength+extraLength+commentLength;
 }
 if(offset!==centralEnd)throw new Error('五件套ZIP中央目录长度不匹配');
 return bytes;
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
 return ['# AI 模拟生成记录','','生成性质：AI 模拟专家成果，不代表真人律师或专家办理、签署、核定。',`生成时间：${input.simulation.generated_at}`,`工作流 ID：${input.workflow_id}`,`题面版本：${input.question_version}`,`Rubric 版本：${input.rubric_version}`,`来源摘要：${input.source_digest}`,`生成模型：${input.simulation.model}`,`推理强度：${input.simulation.reasoning_effort}`,`成果类型：${input.simulation.deliverable_type}`,`读取的${input.attachments[0]?.material_mode==='original'?'原文':'脱敏'}材料：${input.attachments.map(item=>item.name).join('、')}`,input.simulation.model==='author_snapshot'?'实际检索：采用作者冻结记录，归档未重新联网；详情见《法规案例检索轨迹.xlsx》。':'实际检索：由网页搜索事件核对查询词及打开URL；详情见《法规案例检索轨迹.xlsx》。','未决事项：',...(input.simulation.unresolved.length?input.simulation.unresolved.map(item=>`- ${item}`):['- 未记录未决事项']), '','自动状态：已完成内容文件组装；Oracle、Harbor 自测、三模型运行、人工质量复核和平台验收均未由本流程执行。',''].join('\n');
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

/** 将已由服务端按题目快照校验的原件逐字节落入ZIP输入目录；不重渲染或改写原文件。 */
export async function writeOriginalInputFiles(directory:string,files:{name:string;sha256:string;content_base64:string}[]){
 if(!Array.isArray(files)||!files.length)throw new Error('原文模式缺少原始输入文件');
 const seen=new Set<string>(),written:{name:string;sha256:string;bytes:number}[]=[];
 for(const file of files){
  if(typeof file?.name!=='string'||!file.name.trim()||basename(file.name)!==file.name||/[\\/\u0000-\u001f<>:"|?*]/.test(file.name)||!/^([a-f0-9]{64})$/i.test(file.sha256)||typeof file.content_base64!=='string'||file.content_base64.length>140*1024*1024||seen.has(file.name))throw new Error('原始输入文件清单无效');
  const bytes=Buffer.from(file.content_base64,'base64');
  if(!bytes.length||bytes.toString('base64')!==file.content_base64||sha(bytes)!==file.sha256)throw new Error('原始输入文件摘要校验失败');
  if(file.name.toLowerCase().endsWith('.pdf')&&!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('原始PDF文件头校验失败');
  seen.add(file.name);await writeFile(join(directory,file.name),bytes,{mode:0o600,flag:'wx'});written.push({name:file.name,sha256:file.sha256,bytes:bytes.length});
 }
 return written;
}

/** 原子生成内容稿五件套；同一来源只复用文件摘要完全一致的包。 */
export async function generateSiriserFivePiece(parent:string,input:PackageInput,harborGoldenDirectory?:string){
 if(input.question.content_contract==='work_legal_v1')assertWorkSubmissionReady(input.question);
 else assertWorkBusinessRequirements(input.question.rubric,input.simulation?.harbor_files??[]);
 if(!input.simulation||!input.attachments.length||!Array.isArray(input.simulation.harbor_files)||!input.simulation.harbor_files.length||! /^[a-f0-9]{64}$/i.test(input.source_digest)||! /^[a-f0-9]{64}$/i.test(input.delivery_digest))throw new Error('五件套输入绑定不完整');
 if(input.simulation.research_entries.length<1||!input.simulation.deliverable_markdown.trim())throw new Error('模拟专家成果或实际检索记录缺失');
 assertBusinessBody(input.simulation.deliverable_markdown,'主成果.docx');
 input.simulation.harbor_files.forEach(assertBusinessFile);
 const paths=input.simulation.harbor_files.map(file=>file.path),reserved=['主成果.docx','法规案例检索轨迹.xlsx','模拟生成记录.md'];
 if(new Set(paths).size!==paths.length||paths.some(path=>reserved.some(other=>path===other||path.startsWith(`${other}/`)||other.startsWith(`${path}/`))))throw new Error('Harbor 交付文件路径重复或与五件套固定文件冲突');
 const root=join(parent,'Siriser五件套'),packageName=`法律-AI模拟-${input.workflow_id.slice(0,8)}-${input.source_digest.slice(0,8)}-${input.delivery_digest.slice(0,8)}-office-v2`;
 const target=join(root,packageName),stateDir=join(parent,'交付状态'),statePath=join(stateDir,`siriser-${input.source_digest}-${input.delivery_digest}-office-v2.json`);
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
  await writeFile(join(temp,'任务说明.docx'),await buildDocx(taskText),{mode:0o600});
  await writeFile(join(temp,'题目信息表.docx'),await buildDocx(infoText),{mode:0o600});
  await writeFile(join(temp,'评分要点.xlsx'),buildXlsx([rubricWorkbook(input.question.rubric)]),{mode:0o600});
  for(const attachment of input.attachments){
   const index=String(input.attachments.indexOf(attachment)+1).padStart(3,'0');
  await writeFile(join(temp,'input_files',`材料-${index}-${attachment.material_mode==='original'?'原文':'脱敏'}.docx`),await buildDocx(confirmationDocument(attachment.text,[{start:0,end:attachment.text.length}],attachment.documents)),{mode:0o600});
  }
  await writeFile(join(temp,'golden_output','主成果.docx'),await buildDocx(input.simulation.deliverable_markdown,{style:'legal'}),{mode:0o600});
  const goldenRoot=harborGoldenDirectory?await realpath(harborGoldenDirectory):undefined;
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
   await assertOfficeFile(source,relativePath);
   await writeFile(destination,await readFile(source),{mode:0o600,flag:'wx'});
  }
  await writeFile(join(temp,'golden_output','法规案例检索轨迹.xlsx'),buildXlsx([{name:'检索轨迹',columns:['编号','检索词','正文来源','URL','核验要点','版本','成果引用'],rows:input.simulation.research_entries.map(r=>({'编号':r.id,'检索词':r.query,'正文来源':r.title,'URL':r.url,'核验要点':r.finding,'版本':r.version_or_date,'成果引用':r.used_in}))}]),{mode:0o600});
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
async function sourceDocumentFiles(name:string,text:string,prepared?:{id:string;title:string;text:string;document?:RedactedDocumentStructure}[],selected=false){
 if(prepared){
  if(!prepared.length||(selected?prepared.map(doc=>`# ${doc.title}\n\n${doc.text}`).join('\n\n---\n\n'):prepared.map(doc=>doc.text).join('\n\n'))!==text)throw new Error('冻结分册与附件正文不一致');
  let offset=0;
  return prepared.map((doc,i)=>{
   const title=selected?(doc.title.trim().replace(/[\\/<>:"|?*\u0000-\u001f]/g,'_').slice(0,100)||'文书'):doc.title;
   if(!title.trim()||/[\\/<>:"|?*\u0000-\u001f]/.test(title)||title.length>100)throw new Error('冻结分册名称无效');
   const start=offset;offset+=doc.text.length+(i<prepared.length-1?2:0);
   const document=doc.document??preparedTextDocument(doc.text,doc.id);
   return{name:`${name}-${String(i+1).padStart(3,'0')}-${title}.docx`,text:doc.text,ranges:[{start,end:start+doc.text.length}],document};
  });
 }

 const manifest=JSON.parse(await readFile(join(import.meta.dir,'document-boundaries.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.sources))throw new Error('文书分册清单版本无效');
 const source=manifest.sources.find((s:{sha256:string})=>s.sha256===sha(text));
 if(!source)return[{name:`${name}.docx`,text,ranges:[{start:0,end:text.length}],document:undefined as RedactedDocumentStructure|undefined}];
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
 return files as {name:string;text:string;ranges:{start:number;end:number}[];document?:RedactedDocumentStructure}[];
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
 for(const {offset,page} of locations){
  if(!ranges.some(range=>offset>=range.start&&offset<range.end))continue;
  const unresolved=page.issues?.filter(issue=>issue!=='empty_page')??[];
  if(!documentBlocksToText(page.blocks).trim()){
   if(!unresolved.length)continue;
  }
  // 页身份和识别问题留在结构元数据中，不添加到交付正文。
  pages.push({...page,blocks:page.blocks});
 }
 if(!pages.length)throw new Error('确认稿分册未包含脱敏结构页');
 return{format:'redacted-structure-v1',pages};
}

/** 平台确认稿：投影冻结作者内容，独立于Harbor；不改事实、判据或捏造认领码。 */
export async function generateSiriserConfirmation(parent:string,input:PackageInput,options:{expertName?:string;date?:string}={}){
 assertWorkSubmissionReady(input.question);
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
 const name=`法律-${code}-${date}-${expertName}`,packageRootName=`${input.source_digest.slice(0,16)}-${input.delivery_digest.slice(0,16)}-${SIRISER_CONFIRMATION_RENDERER_VERSION}`,root=join(parent,'Siriser五件套',packageRootName),target=join(root,name),statePath=join(parent,'Siriser五件套.json');
 const sceneCategory:Record<string,string>={LS02:'1.1 案件受理与策略',LS03:'1.1 案件受理与策略',LS04:'1.2 庭审与文书',LS05:'1.2 庭审与文书'};
 // 保持完整原题面，诉求拆分只提取已存在段落；不使用另一轮模型重写任务。
 const question=safe(q.question),legacy=legacyInstruction(question),structured=m.instruction;
 const projected=await Promise.all(q.input_files.map((file,index)=>sourceDocumentFiles(file.name,input.attachments[index]!.text,input.attachments[index]!.prepared_documents,input.attachments[index]!.selected_materials)));
 const originalInputFiles=input.attachments.flatMap(attachment=>attachment.material_mode==='original'&&!attachment.selected_materials?(attachment.original_files??[]):[]);
 if(input.attachments.some(attachment=>attachment.material_mode==='original'&&!attachment.selected_materials&&!attachment.original_files?.length))throw new Error('原文模式缺少已校验的原件字节');
 if(originalInputFiles.length&&input.attachments.some(attachment=>attachment.material_mode!=='original'))throw new Error('原文与脱敏附件混合时不能合并物理输入文件');
 if(input.attachments.length>1&&input.attachments.some(attachment=>attachment.material_mode==='original'&&!attachment.selected_materials))throw new Error('多份逻辑附件的原件映射不明确，拒绝错配');
 const projectionNote=projected.some(files=>files.length>1)?'\n\n材料定位说明：合订附件按完整文书分册；文件名前缀“附件N”仍对应题面同一附件，各分册名称见附件文件清单，正文不添加原页定位或处理标记。未增加或删减原文。':'';
 const instruction={background:(structured?.background??question)+projectionNote,requests:structured?.requests??legacy.requests,deliverableReqs:q.deliverables.map(f=>`${f.path}（${f.required?'必交':'选交'}）：${f.description}`).join('\n'),baselineDate:structured?structured.baseline_date??'':legacy.baselineDate,hardConstraints:structured?.hard_constraints??legacy.hardConstraints,commissionerType:'professional',tone:'法律专业人士'};
 const metadata:Record<string,unknown>={title:safe(q.task_name)||input.title,domain:'法律',claimCode:code,taskType:safe(q.task_type).match(/^F[1-5]/)?.[0]??'',longevity:m.target_level,businessArea:sceneCategory[code]??m.domain_l2??'',summary:safe(q.task_name)||input.title,abilities:m.capabilities,dependsVl:m.vl_dependency,vlFiles:m.vl_dependency?(originalInputFiles.length?originalInputFiles.map(file=>file.name):projected.flat().map(f=>f.name)):[],taskDesc:m.level_basis.explanation,expertHours:m.level_basis.estimated_hours,dataSource:m.source_note,neededTools:m.tools,neededKnowledge:m.professional_knowledge};
 const anchors:Record<string,string[]>={F1:['Q3','Q4'],F2:['Q2','Q3'],F3:['Q1','Q4'],F4:['Q4','Q6'],F5:['Q1','Q5']};
 const items=(q.rubric as RubricItem[]).map(item=>{
  if(!item.id||!item.metadata||typeof item.metadata!=='object')throw new Error('Work评分条目缺少原始字段');
  return{id:item.id,...item.metadata};
 });
 const rubric={task_id:name,domain:'法律',task_type:q.task_type,difficulty_tier:m.target_level,anchor_dimensions:anchors[String(metadata.taskType)]??[],items};
 const contentHash=sha(JSON.stringify({input_format:originalInputFiles.length?'original-files-v1':REDACTED_DOCX_RENDERER_VERSION,confirmation_renderer:SIRISER_CONFIRMATION_RENDERER_VERSION,question:q,attachments:input.attachments.map(({original_files,...attachment})=>({...attachment,...(original_files?{original_files:original_files.map(({name,sha256})=>({name,sha256}))}:{})})),projection:projected.map(files=>files.map(({name,ranges})=>({name,ranges}))),expertName,date}));
 await mkdir(root,{recursive:true,mode:0o700});
 const previous=await lstat(target).catch(error=>(error as NodeJS.ErrnoException).code==='ENOENT'?undefined:Promise.reject(error));
 if(previous){
  if(!previous.isDirectory()||previous.isSymbolicLink())throw new Error('已有确认稿路径不是普通目录');
  const statePathForPackage=join(root,`${name}.state.json`),zipPath=join(root,`${name}.zip`),state=JSON.parse(await readFile(statePathForPackage,'utf8'));
  const files=await inventory(target),bytes=await readFile(zipPath);
  if(state.content_sha256!==contentHash||JSON.stringify(state.files)!==JSON.stringify(files)||state.zip_sha256!==sha(bytes))throw new Error('已有确认稿与冻结输入或文件摘要不一致');
  const normalized=markZipFilenamesUtf8(bytes);
  if(!normalized.equals(bytes)){
   const updated={...state,zip_sha256:sha(normalized),zip_bytes:normalized.byteLength},serialized=JSON.stringify(updated,null,2)+'\n';
   await writeAtomic(zipPath,normalized);
   await writeAtomic(statePathForPackage,serialized);
   await writeAtomic(statePath,serialized);
   return{directory:target,zip_path:zipPath,filename:`${name}.zip`,sha256:updated.zip_sha256,files:files.length,reused:true};
  }
  await writeAtomic(statePath,JSON.stringify(state,null,2)+'\n');
  return{directory:target,zip_path:zipPath,filename:`${name}.zip`,sha256:state.zip_sha256,files:files.length,reused:true};
 }
 const scanChecks:{name:string;status:'scanned'|'not_scanned'|'unknown';reason:string}[]=[];
 for(const file of originalInputFiles)scanChecks.push({name:file.name,...(file.name.toLowerCase().endsWith('.pdf')?await inspectPdfScan(Buffer.from(file.content_base64,'base64')):{status:'unknown',reason:'非PDF原件未执行扫描属性检测'})});
 const scanFiles=scanChecks.filter(check=>check.status==='scanned').map(check=>check.name),scanUnknown=scanChecks.some(check=>check.status==='unknown');
 // DOCX投影无扫描原件；未知原件不伪造false，也不自动改写作者的视觉依赖声明。
 if(scanFiles.length||!scanUnknown){metadata.hasScan=!!scanFiles.length;metadata.scanFiles=scanFiles;}
 const qualityWarnings=[...workLevelWarnings(m),...(!structured?['历史题未提供结构化任务说明，使用兼容提取；未识别的语义约束需人工核对']:[]),...scanChecks.filter(check=>check.status==='unknown').map(check=>`${check.name}扫描属性未知：${check.reason}`),...(scanFiles.length&&!m.vl_dependency?['原件含无文字层扫描页；视觉依赖声明为false，请核对候选实际输入及OCR工具能力']:[])];
 const temp=join(root,`.${randomUUID()}.tmp`),folder=join(temp,name);
 await mkdir(join(folder,'input_files'),{recursive:true,mode:0o700});await mkdir(join(folder,'golden_output'),{mode:0o700});
 try{
  for(const [file,value] of [['instruction.json',instruction],['metadata.json',metadata],['rubric.json',rubric]] as const)await writeFile(join(folder,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});
  for(const [index,files] of projected.entries()){
   const attachment=input.attachments[index]!;
   if(attachment.material_mode==='original'&&!attachment.selected_materials){
    await writeOriginalInputFiles(join(folder,'input_files'),attachment.original_files??[]);
    continue;
   }
   for(const file of files){
   if(!file.text.trim())throw new Error('确认稿缺少冻结材料正文');
   await writeFile(join(folder,'input_files',file.name),await buildDocx(file.document??confirmationDocument(attachment.text,file.ranges,attachment.documents)),{mode:0o600,flag:'wx'});
   }
  }
  const paths=new Set<string>();
  for(const file of q.deliverables){
   assertRelative(file.path);if(paths.has(file.path))throw new Error('标准成果路径重复');paths.add(file.path);
   const output=q.reference_outputs.find(item=>item.deliverable_id===file.id);if(!output)throw new Error('缺少完整标准成果');
   const destination=join(folder,'golden_output',file.path);await mkdir(dirname(destination),{recursive:true,mode:0o700});
   await writeFile(destination,await deliverableBytes({path:file.path,markdown:output.content,sheets:output.sheets}),{mode:0o600,flag:'wx'});
  }
  // 作者检索记录保存在包外私有状态；候选成果仅按冻结deliverables生成。
  const files=await inventory(folder),zipPath=join(temp,`${name}.zip`);
  const child=Bun.spawn(['zip','-qr',zipPath,name],{cwd:temp,stdout:'ignore',stderr:'pipe'});
  const [,exit]=await Promise.all([new Response(child.stderr).text(),child.exited]);if(exit!==0)throw new Error('五件套ZIP生成失败');
  const bytes=markZipFilenamesUtf8(await readFile(zipPath));await writeFile(zipPath,bytes,{mode:0o600});
  const relativeZip=`Siriser五件套/${packageRootName}/${name}.zip`;
  const inputMode=input.attachments[0]?.material_mode??'redacted';
  const state={format:'siriser_confirmation_v1',input_format:originalInputFiles.length?(originalInputFiles.every(file=>file.name.toLowerCase().endsWith('.pdf'))?'pdf':'original'):'docx',material_mode:inputMode,input_renderer:originalInputFiles.length?'original-byte-copy-v1':REDACTED_DOCX_RENDERER_VERSION,confirmation_renderer:SIRISER_CONFIRMATION_RENDERER_VERSION,workflow_id:input.workflow_id,source_digest:input.source_digest,delivery_digest:input.delivery_digest,question_version:input.question_version,rubric_version:input.rubric_version,content_sha256:contentHash,filename:`${name}.zip`,zip_relative_path:relativeZip,zip_sha256:sha(bytes),zip_bytes:bytes.length,files,physical_input_files:originalInputFiles.length||projected.flat().length,input_projection:originalInputFiles.length?input.attachments.map((attachment,index)=>({source_name:q.input_files![index]!.name,material_mode:'original',files:(attachment.original_files??[]).map(({name,sha256})=>({name,sha256}))})):projected.map((files,index)=>({source_name:q.input_files![index]!.name,material_mode:input.attachments[index]?.material_mode??'redacted',structure_mode:input.attachments[index]!.documents?.length?'structured':'legacy-markdown',source_sha256:sha(input.attachments[index]!.text),files:files.map(({name,ranges,text})=>({name,ranges,sha256:sha(text)}))})),declared_document_entries:m.level_basis.documents.length,author_generation_note:m.generation_note,author_research_records:q.research_records,quality_warnings:qualityWarnings,scan_checks:scanChecks,submission_ready:false,submitted:false};
  await rename(folder,target);await rename(zipPath,join(root,`${name}.zip`));
  await writeFile(join(root,`${name}.state.json`),JSON.stringify(state,null,2)+'\n',{mode:0o600});await writeFile(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
  return{directory:target,zip_path:join(root,`${name}.zip`),filename:`${name}.zip`,sha256:state.zip_sha256,files:files.length,reused:false};
 }finally{await rm(temp,{recursive:true,force:true});}
}
