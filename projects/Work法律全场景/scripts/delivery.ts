/**
 * 职责：为 Work 达标题目生成 AI 模拟专家成果、Siriser 五件套、Harbor 六件套预备包及私有归档快照。
 * 关键入口：`deliver()` 在“归档达标题目”时由服务端独立进程调用。
 * 使用边界：Harbor 包缺少题目元数据、精确文件清单或可用成果时失败关闭；生成预备包不代表 Harbor 或平台验收通过。
 */
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {generateSiriserFivePiece} from './siriser/generate-five-piece';
import {exportAcceptedTask,HARBOR_TOOL_SET,type HarborTaskMetadata} from './harbor/export-accepted-task';
import type {WorkContent} from '../../../server/authoring/work-contract';
import {buildRedactedDocx} from '../../../server/materials/redacted-docx';
import {buildXlsx,type WorkbookSheet} from '../../../server/reporting/xlsx';

interface DeliveryInput{
 version:1;
 project_id:string;
 workflow_id:string;
 title:string;
 source_digest:string;
 delivery_digest:string;
 question_version:string;
 rubric_version:string;
 question:{task_name:unknown;task_type:unknown;header:unknown;question:unknown;attachment_ids:unknown;rubric:unknown;answer_approach:unknown;reference_answer:unknown;delivery_identity?:{task_id:string;org:string}}&Partial<WorkContent>;
 acceptance:unknown;
 attachments:{id:string;sha256:string;name:string;text:string}[];
 simulation:{deliverable_type:'F1'|'F2'|'F3'|'F4'|'F5';deliverable_title:string;deliverable_markdown:string;harbor_files:{path:string;markdown:string;sheets:{name:string;columns:string[];rows:(string|number|boolean)[][]}[]}[];research_entries:{id:string;query:string;title:string;url:string;finding:string;version_or_date:string;used_in:string}[];unresolved:string[];generated_at:string;model:string;reasoning_effort:string;actual_search_queries:string[];actually_opened_urls:string[]};
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=/^[0-9a-f]{64}$/i;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export function harborMapping(question:DeliveryInput['question']){
 if(question.content_contract==='work_legal_v1'){
  const q=question as any,m=q.task_metadata,identity=q.delivery_identity;
  if(!identity?.task_id||!identity?.org)throw new Error('Work专业内容已保存；归档尚缺外部task_id/org，不能由作者猜造');
  if(typeof m?.domain_l2!=='string'||!m.domain_l2.trim())throw new Error('尚缺已登记的二级分类标签，不能用案由或任务描述替代');
  return {task_id:identity.task_id,metadata:{org:identity.org,domain_l2:m.domain_l2,capabilities:m.capabilities.join('、'),vl_dependency:m.vl_dependency?'是':'否',source_note:m.source_note,tools:m.tools.join('、')||'无额外工具',domain_knowledge:m.professional_knowledge.join('、'),task_complexity:m.target_level,tool_set:[...HARBOR_TOOL_SET],skill_set:[],expected_tool_dependencies:[],expected_skill_dependencies:[],deliverables:q.deliverables.map((f:any)=>({path:f.path,description:f.description,required:f.required}))} as HarborTaskMetadata,input_files:q.input_files.map((f:any,index:number)=>({path:`材料-${String(index+1).padStart(3,'0')}.md`,description:f.description,alias:f.name}))};
 }
 const rubric=question.rubric;
 if(!Array.isArray(rubric))throw new Error('Harbor 归档映射缺少 Rubric');
 const context=rubric.map(item=>item&&typeof item==='object'?(item as any).metadata?.project_context:undefined).find(item=>item&&typeof item==='object'&&!Array.isArray(item));
 const harbor=(context as Record<string,unknown>|undefined)?.harbor;
 if(!harbor||typeof harbor!=='object'||Array.isArray(harbor))throw new Error('缺少 project_context.harbor，不能归档 Work Harbor 六件套');
 const value=harbor as Record<string,unknown>;
 if(typeof value.task_id!=='string'||typeof value.org!=='string'||!value.metadata||typeof value.metadata!=='object'||!Array.isArray(value.input_files))throw new Error('project_context.harbor 字段不完整');
 return{task_id:value.task_id,metadata:{...(value.metadata as HarborTaskMetadata),org:value.org},input_files:value.input_files as {path:string;description:string}[]};
}

function assertHarborRelative(path:string){
 if(!path||Buffer.byteLength(path,'utf8')>200||path.includes('\\')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\u0000-\u001f\u007f]/.test(path))throw new Error(`Harbor 文件路径无效：${path}`);
}

async function harborFileBytes(file:{path:string;markdown:string;sheets:{name:string;columns:string[];rows:(string|number|boolean)[][]}[]}){
 const extension=file.path.split('.').at(-1)?.toLowerCase();
 if(extension==='docx')return buildRedactedDocx(file.markdown);
 if(extension==='md'||extension==='txt'||extension==='csv')return Buffer.from(file.markdown,'utf8');
 if(extension==='json'){
  const parsed=JSON.parse(file.markdown);
  return Buffer.from(JSON.stringify(parsed,null,2)+'\n','utf8');
 }
 if(extension==='xlsx'){
  const sheets:WorkbookSheet[]=file.sheets.map(sheet=>({name:sheet.name,columns:sheet.columns,rows:sheet.rows.map(values=>Object.fromEntries(sheet.columns.map((column,index)=>[column,values[index]])))}));
  return buildXlsx(sheets);
 }
 throw new Error(`Harbor 暂不支持输出格式：${file.path}`);
}

async function generateHarborPackage(parent:string,input:DeliveryInput){
 const mapping=harborMapping(input.question),simulation=input.simulation;
 if(mapping.input_files.length!==input.attachments.length||mapping.input_files.some((file,index)=>file.path!==input.attachments[index]?.name||typeof file.description!=='string'||!file.description.trim()))throw new Error('Harbor 输入材料清单必须按实际脱敏附件顺序逐一映射并提供说明');
 for(const item of mapping.input_files)assertHarborRelative(item.path);
 if(!Array.isArray(simulation.harbor_files)||!simulation.harbor_files.length)throw new Error('模拟专家成果没有 Harbor 文件映射');
 const workspace=await mkdtemp(join(tmpdir(),'ai-distill-harbor-'));
 try{
  const attachmentFiles=[];
  for(let index=0;index<input.attachments.length;index++){
   const attachment=input.attachments[index]!,description=mapping.input_files[index]!;
   const path=join(workspace,description.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,attachment.text,{mode:0o600});
   attachmentFiles.push({relativePath:description.path,sourcePath:path,description:description.description,...('alias'in description?{alias:description.alias as string}:{})});
  }
  const goldenFiles=[];
  for(const file of simulation.harbor_files){
   assertHarborRelative(file.path);
   const path=join(workspace,'golden',file.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,await harborFileBytes(file),{mode:0o600});
   goldenFiles.push({relativePath:file.path,sourcePath:path});
  }
  const template=await readFile(join(import.meta.dir,'harbor/judge-prompt-template.md'),'utf8');
  const result=await exportAcceptedTask({
   outputDirectory:join(parent,'Harbor六件套'),taskId:mapping.task_id,title:input.title,
   instruction:input.question.question as string,rubric:input.question.rubric,metadata:mapping.metadata,
   attachments:attachmentFiles,goldenFiles,
   officialTestSh:join(import.meta.dir,'harbor/official/tests/test.sh'),
   officialFinalizePy:join(import.meta.dir,'harbor/official/tests/finalize.py'),judgePromptTemplate:template,
  });
  return result;
 }finally{await rm(workspace,{recursive:true,force:true});}
}

function parseInput(value:unknown):DeliveryInput{
 if(!value||typeof value!=='object')throw new Error('交付输入缺失');
 const input=value as DeliveryInput;
 if(input.version!==1||!uuid.test(input.project_id)||!uuid.test(input.workflow_id)||!sha.test(input.source_digest)||!sha.test(input.delivery_digest)||typeof input.title!=='string'||!input.title.trim()||typeof input.question_version!=='string'||!input.question_version||typeof input.rubric_version!=='string'||!input.rubric_version)throw new Error('交付身份或版本无效');
 const question=input.question;
 if(!question||typeof question.question!=='string'||!question.question.trim()||typeof question.reference_answer!=='string'||!question.reference_answer.trim()||!Array.isArray(question.rubric)||!question.rubric.length||!Array.isArray(question.attachment_ids)||!question.attachment_ids.length||!Array.isArray(input.attachments)||!input.attachments.length)throw new Error('题目快照不完整');
 if(input.attachments.some(item=>!uuid.test(item.id)||!sha.test(item.sha256)||!/^材料-\d{3}\.md$/.test(item.name)||typeof item.text!=='string'||!item.text.trim())||question.attachment_ids.some(id=>typeof id!=='string'||!input.attachments.some(item=>item.id===id)))throw new Error('附件身份或脱敏正文不一致');
 if(!input.simulation||!input.simulation.deliverable_markdown?.trim()||!Array.isArray(input.simulation.harbor_files)||!input.simulation.harbor_files.length||!Array.isArray(input.simulation.research_entries)||!input.simulation.research_entries.length||!Array.isArray(input.simulation.actual_search_queries)||!Array.isArray(input.simulation.actually_opened_urls))throw new Error('模拟专家成果或实际检索证据缺失');
 if(!input.acceptance||typeof input.acceptance!=='object'||(input.acceptance as {decision?:unknown}).decision!=='accepted')throw new Error('达标结果无效');
 return input;
}

/** 同一来源摘要只生成同一份资料；成果目录里已有的 DOCX 不删除。快照不一致时拒绝覆盖。 */
export async function deliver(value:unknown):Promise<void>{
 const input=parseInput(value);
 const parent=process.env.AI_DISTILL_DELIVERY_PARENT_DIR;
 if(!parent||!isAbsolute(parent))throw new Error('交付持久目录未配置');
 const snapshot=JSON.stringify(input,null,2)+'\n';
 const snapshotHash=digest(snapshot);
 const harbor=await generateHarborPackage(parent,input);
 const fivePiece=await generateSiriserFivePiece(parent,input,join(harbor.directory,'solution/golden_output'));
 const checklist=[
  '# Work 法律全场景｜逐题交付准备',
  '',
  `题目：${input.title.replace(/[\r\n]+/g,' ')}`,
  `工作流 ID：${input.workflow_id}`,
  `达标来源摘要：${input.source_digest}`,
  `题目版本：${input.question_version}`,
  `Rubric 版本：${input.rubric_version}`,
  `快照 SHA-256：${snapshotHash}`,
  '',
  '此目录保存归档冻结的私有题目快照。AI 模拟专家内容稿五件套已生成；这不是真人专家成果，也不是平台提交凭据。',
  '快照含题面、Rubric、作答思路、参考答案和内部附件 ID，不得直接作为公开题包发送。',
  '',
  '## 正式提交前仍需完成',
  '',
  `- Siriser 内容稿五件套：已写入 ${fivePiece.directory}，包含任务说明、题目信息、评分要点、脱敏输入材料、模拟专家主成果、Harbor 清单要求的全部交付文件及实际检索轨迹。`,
  '- 题目脱敏 DOCX 和通用单题 Excel 由归档 API 自动生成；通用 Excel 不替代 Siriser 或 Harbor 专用交付文件。',
  '- 本地内部评测可使用上述 AI 模拟成果；若用于外部正式提交，另按项目方要求核验真人专家来源、签署／核定等条件。当前归档快照只作为制作依据，不替代完整题包。',
  `- Harbor 六件套目录：已生成 ${harbor.directory}；固定脚本摘要校验通过，Harbor Judge prompt 尚未核验为项目方原始模板，状态文件仍标记不可提交。`,
  '- 核对 `task.toml` 中 artifacts 和 name/org 的项目方口径，完成镜像、Oracle、三模型及人工质检。',
  '- 归档执行不会运行 Oracle、Harbor 自测、三模型评测或人工质检，也不会上传平台；以上状态不得写成通过。',
  '',
  '系统“归档达标题目”只说明本次内部达标版本已归档，不表示通过外部题包验收。',
  '',
 ].join('\n');
 await mkdir(parent,{recursive:true});
 const snapshotPath=join(parent,'题目快照.json'),checklistPath=join(parent,'交付缺口.md');
 try{
  const existing=await readFile(snapshotPath,'utf8');
  if(digest(existing)!==snapshotHash)throw new Error('已有交付快照与本次数据不一致');
  await writeFile(checklistPath,checklist,{mode:0o600});
  return;
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const temporary=join(parent,`.${input.source_digest}.${randomUUID()}.tmp`);
 try{
  await mkdir(temporary,{mode:0o700});
  await writeFile(join(temporary,'题目快照.json'),snapshot,{mode:0o600});
  await writeFile(join(temporary,'交付缺口.md'),checklist,{mode:0o600});
  await rename(join(temporary,'题目快照.json'),snapshotPath);
  await rename(join(temporary,'交付缺口.md'),checklistPath);
  await rm(temporary,{recursive:true,force:true});
 }catch(error){
  await rm(temporary,{recursive:true,force:true});
  throw error;
 }
}

if(import.meta.main){
 try{
  const input=await Bun.stdin.text();
  await deliver(JSON.parse(input));
 }catch{
  // 子进程退出码通知归档失败；不向日志输出含私有题目的异常正文。
  process.exitCode=1;
 }
}
