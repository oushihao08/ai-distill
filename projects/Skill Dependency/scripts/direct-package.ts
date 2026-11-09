/**
 * 文件职责：Skill Dependency 项目的出题后直交 ZIP；只读当前出题结果与题目冻结材料。
 * 公开入口：buildSkillDependencyPackage() 供 HTTP 下载路由调用；不写步骤、归档或平台状态。
 */
import {validateDependencyDelivery} from './contract';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {readQuestionMaterials} from '../../../server/question-materials';
import {assertAuthoringMaterialBinding} from '../../../server/publishing/feishu-verification';
import {buildDocx,preparedTextDocument} from '../../../server/document-generation/docx';
import {buildXlsx,type WorkbookSheet} from '../../../server/document-generation/xlsx';
import {filterMaterialDocxSource,planMaterialDocxExports} from '../../../server/materials/redacted-docx-export';

const required=(value:unknown,label:string)=>{
 if(typeof value!=='string'||!value.trim())throw new HTTPException(409,{message:`当前题包缺少${label}`});
 return value;
};
const safeFile=(value:unknown)=>typeof value==='string'&&value.length<=160&&value.trim()===value&&value!=='.'&&value!=='..'&&!value.startsWith('.')&&!/[\\/\x00-\x1f\x7f<>:"|?*]/.test(value);

/** macOS zip writes UTF-8 path bytes without the ZIP UTF-8 flag. Validate headers before setting it. */
function markZipNamesUtf8(input:Uint8Array){
 const bytes=Buffer.from(input),minimum=22,searchFrom=Math.max(0,bytes.length-minimum-0xffff);let end=-1;
 for(let offset=bytes.length-minimum;offset>=searchFrom;offset--)if(bytes.readUInt32LE(offset)===0x06054b50&&offset+minimum+bytes.readUInt16LE(offset+20)===bytes.length){end=offset;break;}
 if(end<0)throw new Error('交付ZIP缺少结束记录');
 const disk=bytes.readUInt16LE(end+4),centralDisk=bytes.readUInt16LE(end+6),diskCount=bytes.readUInt16LE(end+8),count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),centralStart=bytes.readUInt32LE(end+16);
 if(disk!==0||centralDisk!==0||diskCount!==count||count===0xffff||centralSize===0xffffffff||centralStart===0xffffffff)throw new Error('交付ZIP使用不支持的分卷或ZIP64格式');
 const centralEnd=centralStart+centralSize;if(centralEnd>end)throw new Error('交付ZIP中央目录越界');
 const decodeName=(name:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(name);
 let offset=centralStart;
 for(let index=0;index<count;index++){
  if(offset+46>centralEnd||bytes.readUInt32LE(offset)!==0x02014b50)throw new Error('交付ZIP中央目录损坏');
  const nameLength=bytes.readUInt16LE(offset+28),extraLength=bytes.readUInt16LE(offset+30),commentLength=bytes.readUInt16LE(offset+32),localOffset=bytes.readUInt32LE(offset+42),centralName=bytes.subarray(offset+46,offset+46+nameLength);
  if(offset+46+nameLength+extraLength+commentLength>centralEnd||localOffset+30>centralStart||decodeName(centralName).length===0)throw new Error('交付ZIP文件名或本地目录越界');
  if(bytes.readUInt32LE(localOffset)!==0x04034b50)throw new Error('交付ZIP本地文件头损坏');
  const localNameLength=bytes.readUInt16LE(localOffset+26),localExtraLength=bytes.readUInt16LE(localOffset+28),localNameStart=localOffset+30,localName=bytes.subarray(localNameStart,localNameStart+localNameLength);
  if(localNameLength!==nameLength||!localName.equals(centralName)||localNameStart+localNameLength+localExtraLength>centralStart)throw new Error('交付ZIP本地与中央文件名不一致');
  decodeName(localName);
  bytes.writeUInt16LE(bytes.readUInt16LE(offset+8)|0x0800,offset+8);
  bytes.writeUInt16LE(bytes.readUInt16LE(localOffset+6)|0x0800,localOffset+6);
  offset+=46+nameLength+extraLength+commentLength;
 }
 if(offset!==centralEnd)throw new Error('交付ZIP中央目录长度不匹配');
 return bytes;
}

async function goldenFileBytes(file:any):Promise<Uint8Array>{
 const name=String(file.path),extension=name.split('.').at(-1)?.toLowerCase(),markdown=required(file.markdown,`Golden File ${name}`);
 if(extension==='docx')return buildDocx(markdown,{style:'legal'});
 if(['md','txt','csv','tsv'].includes(extension??''))return Uint8Array.from(Buffer.from(markdown,'utf8'));
 if(extension==='json'){
  try{return Uint8Array.from(Buffer.from(JSON.stringify(JSON.parse(markdown),null,2)+'\n'));}
  catch{throw new HTTPException(409,{message:`Golden File ${name} 不是有效JSON`});}
 }
 if(extension==='xlsx'){
  if(!Array.isArray(file.sheets)||!file.sheets.length)throw new HTTPException(409,{message:`Golden File ${name} 缺少工作表`});
  const sheets:WorkbookSheet[]=file.sheets.map((sheet:any)=>{
   if(typeof sheet?.name!=='string'||!sheet.name.trim()||!Array.isArray(sheet.columns)||!sheet.columns.length||!Array.isArray(sheet.rows)||sheet.rows.some((row:any)=>!Array.isArray(row)||row.length!==sheet.columns.length))throw new HTTPException(409,{message:`Golden File ${name} 工作表结构无效`});
   return{name:sheet.name,columns:sheet.columns,rows:sheet.rows.map((row:any[])=>Object.fromEntries(sheet.columns.map((column:string,index:number)=>[column,row[index]])))};
  });
  return buildXlsx(sheets);
 }
 throw new HTTPException(409,{message:`Golden File ${name} 的格式尚不能生成`});
}
const platformOutputName=(name:string)=>name.endsWith('.md')?`${name.slice(0,-3)}.docx`:name;
function platformNames(text:string,goldenFiles:any[],inputCount:number){
 let result=text;
 for(const file of goldenFiles)result=result.replaceAll(file.path,platformOutputName(file.path));
 for(let index=1;index<=inputCount;index++)result=result.replaceAll(`附件${index}.txt`,`附件${index}.docx`);
 result=result.replaceAll('渲染Markdown阅读稿','渲染 DOCX 阅读稿').replaceAll('Markdown生成与打开读回','DOCX 生成与打开读回');
 return result;
}

export async function buildSkillDependencyPackage(pool:Pool,workflowId:string,storageRoot:string){
 const db=await pool.connect();let temporary:string|undefined;
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const row=(await db.query(`SELECT w.project_id,w.workflow_kind,p.parent_name,s.result,
   a.id AS attempt_id,a.input
   FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL
   JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=4 AND s.status='succeeded'
   JOIN LATERAL (SELECT id,input,result FROM ai_distill.step_attempts WHERE workflow_id=w.id AND ordinal=4 AND status='succeeded' ORDER BY attempt DESC LIMIT 1) a ON a.result->>'question_version'=s.result->>'question_version' AND a.result->>'rubric_version'=s.result->>'rubric_version'
   WHERE w.id=$1 AND w.deleted_at IS NULL`,[workflowId])).rows[0];
  if(!row||row.parent_name!=='Skill Dependency'||row.workflow_kind!=='question')throw new HTTPException(404,{message:'该题没有可直接交付的 Skill Dependency 出题结果'});
  const question=row.result;
  required(question?.question,'Instruction');required(question?.reference_answer,'Golden Answer');
  if(!Array.isArray(question?.rubric)||!question.rubric.length)throw new HTTPException(409,{message:'当前题包缺少Rubric'});
  if(!Array.isArray(question?.skill_files)||question.skill_files.length<1||question.skill_files.length>3)throw new HTTPException(409,{message:'当前题包须有1至3个逐题Skill'});
  if(!Array.isArray(question?.golden_files)||question.golden_files.length>20)throw new HTTPException(409,{message:'Golden Files 清单无效'});
  if(!question.task_requirements||!['text','file'].includes(question.task_requirements.output_mode))throw new HTTPException(409,{message:'任务能力声明无效'});
  if(question.task_requirements.output_mode==='file'&&!question.golden_files.length)throw new HTTPException(409,{message:'题面要求文件成果，但未提供Golden Files'});
  if(!question.metadata||typeof question.metadata!=='object'||Array.isArray(question.metadata))throw new HTTPException(409,{message:'当前题包缺少Metadata'});
  for(const key of ['domain','complexity','skill_dependency'])required(question.metadata[key],`Metadata.${key}`);
  if(!Array.isArray(question.metadata.capability_tags))throw new HTTPException(409,{message:'当前题包缺少能力标签'});
  const materials=await readQuestionMaterials(db,workflowId,storageRoot);
  assertAuthoringMaterialBinding(row.input,materials);
  if(!materials.attachments.length)throw new HTTPException(409,{message:'当前题包缺少冻结输入附件'});
  const source=(await db.query('SELECT snapshot_manifest,index_artifact_id FROM ai_distill.question_library_sources WHERE workflow_id=$1',[workflowId])).rows[0];
  if(!source||!Array.isArray(source.snapshot_manifest?.files))throw new HTTPException(409,{message:'当前题目缺少冻结文件清单'});
  const indexArtifact=(await db.query('SELECT content,sha256 FROM ai_distill.artifacts WHERE id=$1 AND workflow_id=$2 AND attempt_id IS NULL',[source.index_artifact_id,workflowId])).rows[0];
  const indexExpected=source.snapshot_manifest.material_index??source.snapshot_manifest.redacted_index;
  if(typeof indexArtifact?.content!=='string'||createHash('sha256').update(indexArtifact.content).digest('hex')!==indexArtifact.sha256||indexExpected?.sha256!==indexArtifact.sha256)throw new HTTPException(409,{message:'冻结文件索引缺失或摘要不匹配'});
  let index:any;try{index=JSON.parse(indexArtifact.content);}catch{throw new HTTPException(409,{message:'冻结文件索引格式无效'});}
  const listed=source.snapshot_manifest.files as {material_id:string;original_name:string}[];
  if(!Array.isArray(index.materials)||listed.length!==index.materials.length)throw new HTTPException(409,{message:'冻结文件数量与结构索引不匹配'});
  const sourceFiles=listed.map((file,position)=>{
   const item=index.materials.find((candidate:any)=>candidate.material_id===file.material_id);
   if(!item||typeof item.markdown!=='string'||!item.markdown.trim()||typeof file.original_name!=='string')throw new HTTPException(409,{message:`冻结文件${position+1}正文缺失`});
   return{path:`input_files/attachment-${position+1}.md`,content:item.markdown,source_name:file.original_name};
  });
  if(materials.attachments.length!==1)throw new HTTPException(409,{message:'当前题目须有一份冻结合并附件'});
  const sections=listed.map(file=>{const item=index.materials.find((candidate:any)=>candidate.material_id===file.material_id);return{id:file.material_id,title:file.original_name,document:item.document?.format==='redacted-structure-v1'?item.document:preparedTextDocument(item.markdown,file.material_id)};});
  const mode=materials.origin.kind==='library_v1'?materials.origin.material_mode:'redacted';
  const combined=planMaterialDocxExports(sections,'combined',mode)[0]!;
  const materialDocx=await buildDocx(filterMaterialDocxSource(combined.document),{materialMath:true});
  const inputFiles=[{path:'附件1.docx',content:materialDocx,source_name:listed.map(file=>file.original_name).join('、')},...sourceFiles];
  const names=new Set<string>();
  for(const skill of question.skill_files){
   if(!safeFile(skill?.name)||skill.name.length>80||!skill.name.toLowerCase().endsWith('.md')||names.has(skill.name))throw new HTTPException(409,{message:'逐题Skill文件名不安全或重复'});
   names.add(skill.name);required(skill.content,`Skill ${skill.name}`);
  }
  const outputNames=new Set<string>();
  for(const file of question.golden_files){if(!safeFile(file?.path)||outputNames.has(file.path))throw new HTTPException(409,{message:'Golden File 文件名不安全或重复'});outputNames.add(file.path);}
  const validation=validateDependencyDelivery(question,materials.attachments.map((_,i)=>`附件${i+1}.txt`));
  const expected={project_id:row.project_id,attempt_id:row.attempt_id,question_version:question.question_version,rubric_version:question.rubric_version,material_digest:materials.digest};
  await db.query('COMMIT');
  temporary=await mkdtemp(join(tmpdir(),'skill-dependency-'));
  const root=join(temporary,'Skill-Dependency');
  await mkdir(join(root,'input_files'),{recursive:true,mode:0o700});await mkdir(join(root,'skills'),{mode:0o700});await mkdir(join(root,'golden_output'),{mode:0o700});
  await writeFile(join(root,'instruction.md'),platformNames(question.question,question.golden_files,1),{mode:0o600});
  await writeFile(join(root,'rubric.json'),JSON.stringify({rubrics:question.platform_rubric.map((item:any)=>({id:item.id,description:platformNames(item.description,question.golden_files,1),weight:item.weight,dimension:item.dimension,criterion_type:item.criterion_type,criterion_necessity:item.criterion_necessity,check_files:'artifacts',type:item.type.toLowerCase(),levels:item.levels}))},null,2)+'\n',{mode:0o600});
  await writeFile(join(root,'golden_answer.md'),platformNames(question.reference_answer,question.golden_files,1),{mode:0o600});
  await writeFile(join(root,'metadata.json'),JSON.stringify({...question.platform_metadata,source_mode:materials.origin.kind==='library_v1'?materials.origin.material_mode:'redacted',source_digest:materials.digest},null,2)+'\n',{mode:0o600});
  // 平台编号由建题页分配；本地作者编号仅作追踪，不填入平台题目编号。
  const meta=question.platform_metadata;
  const submission={
   '题目编号':'由平台自动分配',
   '题目类型':'skill dependency',
   '所属领域':[meta.domain_l1,meta.domain_l2,meta.domain_l3,meta.domain_l4],
   '评测的能力':meta.capabilities,
   '分差范围':'待按本题目标在平台选择；本地未实测',
   '是否依赖VL':meta.requires_vl?'是':'否',
   '任务说明':meta.task_description,
   '所需工具':meta.required_tools.map((tool:string)=>platformNames(tool,question.golden_files,1)),
   '领域知识依赖':meta.domain_knowledge,
   'Skill必要性/依赖性说明':meta.skill_dependency,
   '任务复杂度':meta.complexity,
   '任务描述':'instruction.md',
   '参考文件':['附件1.docx'],
   'Skill包与专项材料':question.skill_files.map((skill:any)=>`skills/${skill.name}`),
   '参考答案':question.golden_files.map((file:any)=>`golden_output/${platformOutputName(file.path)}`),
   '评分规则':'rubric.json',
   '本地追踪编号':meta.task_id,
  };
  await writeFile(join(root,'平台提交字段.json'),JSON.stringify(submission,null,2)+'\n',{mode:0o600});
  const cell=(value:unknown)=>String(value??'').replaceAll('|','\\|').replaceAll('\n','<br>');
  const guide=`# Siriser 逐项填写指南

适用：本 ZIP 对应的单道 Skill Dependency 题。先解压 ZIP；以下路径均相对于解压后的 \`Skill-Dependency/\`。平台不接收本 ZIP 作为整题上传。

## 任务基本信息

| 平台字段 | 填写或选择 |
| --- | --- |
| 题目编号 | 平台自动分配；不要填本地追踪编号 \`${cell(meta.task_id)}\` |
| 题目类型 | skill dependency（页面固定） |
| 所属领域 | 页面一级选“法律”；其余层级按平台现有标签核对后选择，必须选到四级。本地建议分类：${cell([meta.domain_l1,meta.domain_l2,meta.domain_l3,meta.domain_l4].join(' / '))}，不能直接当作平台标签。 |
| 评测的能力 | ${cell(meta.capabilities.join('、'))} |
| 分差范围 | 页面当前显示 S1；本地没有带／不带 Skill 的模型分差实测，不把默认选项当成已达标。 |
| 是否依赖 VL | ${meta.requires_vl?'是':'否'} |
| 任务说明 | ${cell(meta.task_description.replace(/；task_id为作者本地标识，不是平台已分配编号。?$/,''))} |
| 所需工具 | ${cell(meta.required_tools.join('、'))} |
| 领域知识依赖（选填） | ${cell(meta.domain_knowledge)} |
| skill必要性/依赖性说明 | ${cell(meta.skill_dependency)} |
| 任务复杂度 | ${cell(meta.complexity)}；按页面定义确认。 |

## 题目材料和参考答案

| 平台位置 | 操作 | ZIP 内路径 |
| --- | --- | --- |
| 任务描述 | 打开并将全文填入编辑器 | \`instruction.md\` |
| 参考文件 | 上传按冻结来源顺序合并的一份 DOCX；这是脱敏/原文结构的可见副本，不冒称原始 PDF/DOCX 字节 | \`附件1.docx\` |
| Skill 包与专项材料 | 逐个上传 .md；文件内已有 name 字段 | ${question.skill_files.map((skill:any)=>`\`skills/${cell(skill.name)}\``).join('、')} |
| 参考答案 | 只上传题面逐名要求的成果文件，保持文件名和数量一致 | ${question.golden_files.map((file:any)=>`\`golden_output/${cell(platformOutputName(file.path))}\``).join('、')} |

\`golden_answer.md\` 是作者的总说明，\`input_files/\` 是逐来源文字投影，\`rubric.json\` 可在下一步的 JSON 源码编辑器填写；它们不是上表要求额外上传的参考答案或重复输入。\`附件1.docx\` 使用与豆包合册相同的结构拼接方法生成，不是原始 PDF／DOCX 的逐字节副本。

填写和上传后先运行页面的重复度检测、出题质检，再按平台步骤生成评分标准、执行模型评分和验收。本 ZIP 不含这些平台回执。
`;
  await writeFile(join(root,'平台逐项填写指南.md'),guide,{mode:0o600});
  for(const file of inputFiles)await writeFile(join(root,file.path),file.content,{mode:0o600});
  for(const skill of question.skill_files)await writeFile(join(root,'skills',skill.name),platformNames(skill.content,question.golden_files,1),{mode:0o600});
  for(const file of question.golden_files)await writeFile(join(root,'golden_output',platformOutputName(file.path)),await goldenFileBytes({...file,path:platformOutputName(file.path),markdown:platformNames(file.markdown,question.golden_files,1)}),{mode:0o600});
  await writeFile(join(root,'validation.json'),JSON.stringify(validation,null,2)+'\n',{mode:0o600});
  await writeFile(join(root,'dependency_checks.json'),JSON.stringify(question.delivery_contract.dependency_rules,null,2)+'\n',{mode:0o600});
  const inventory:{path:string;sha256:string;bytes:number}[]=[];
  const collect=async(directory:string,prefix=''):Promise<void>=>{try{for(const entry of await readdir(directory,{withFileTypes:true})){const path=prefix+entry.name;if(entry.isDirectory())await collect(join(directory,entry.name),path+'/');else{const content=await readFile(join(directory,entry.name));inventory.push({path,sha256:createHash('sha256').update(content).digest('hex'),bytes:content.length});}}}catch(error){throw error;}};
  await collect(root);inventory.sort((a,b)=>a.path.localeCompare(b.path));
  await writeFile(join(root,'manifest.json'),JSON.stringify({format:'skill-dependency-local-v2',files:inventory,workflow_id:workflowId,...expected,input_files:inputFiles.map(file=>({file:file.path,source_name:file.source_name,sha256:createHash('sha256').update(file.content).digest('hex')})),skill_files:question.skill_files.map((skill:any)=>`skills/${skill.name}`),golden_files:question.golden_files.map((file:any)=>`golden_output/${platformOutputName(file.path)}`),platform_verified:false},null,2)+'\n',{mode:0o600});
  const output=join(temporary,'Skill-Dependency.zip');
  const child=Bun.spawn(['zip','-qr',output,'Skill-Dependency'],{cwd:temporary,stdout:'ignore',stderr:'pipe'});
  const exit=await child.exited;if(exit!==0)throw new HTTPException(500,{message:'本地题包压缩失败'});
  const bytes=markZipNamesUtf8(await readFile(output));
  const latest=(await pool.query("SELECT p.parent_name,s.status,s.result->>'question_version' AS question_version,s.result->>'rubric_version' AS rubric_version,a.id AS attempt_id FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=4 LEFT JOIN LATERAL (SELECT id FROM ai_distill.step_attempts WHERE workflow_id=w.id AND ordinal=4 AND status='succeeded' ORDER BY attempt DESC LIMIT 1) a ON true WHERE w.id=$1 AND w.deleted_at IS NULL",[workflowId])).rows[0];
  if(latest?.parent_name!=='Skill Dependency'||latest.status!=='succeeded'||latest.attempt_id!==expected.attempt_id||latest.question_version!==expected.question_version||latest.rubric_version!==expected.rubric_version)throw new HTTPException(409,{message:'出题结果在导出期间变化，请重新下载'});
  return{bytes,filename:`Skill-Dependency-${workflowId}.zip`,sha256:createHash('sha256').update(bytes).digest('hex')};
 }catch(error){try{await db.query('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'交付读取事务回滚失败');}throw error;}
 finally{db.release();if(temporary)await rm(temporary,{recursive:true,force:true});}
}
