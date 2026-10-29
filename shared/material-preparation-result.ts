/**
 * 职责：定义材料整理结果及其结构块投影；由材料库整理任务、建题快照和出题输入共用。
 * 关键入口：`compileFixedPreparation()`绑定新任务的固定目录描述，`materializePreparation()`按原结构回看材料。
 * 旧块级编译入口只保留兼容；新任务不由Agent重新分册。
 * 边界：只整理可用信息，不代替出题Agent选择最终方向、场景或交付，也不改写材料正文。
 */
import {createHash} from 'node:crypto';
import {documentBlocksToText,documentPagesToModelText,type DocumentBlock} from './document-structure';
import {preparationCounts} from './material-preparation-counts';
export {preparationCounts} from './material-preparation-counts';
export interface RedactedDocumentStructure {format:'redacted-structure-v1';pages:{page:number;blocks:DocumentBlock[]}[]}
export interface PreparationUnit {id:string;title:string;pages:{page:number;blocks:DocumentBlock[]}[];source_refs?:unknown;boundary?:'document';unit_kind?:PreparationDocumentKind}
export interface PreparationBlock {id:string;unit_id:string;page:number;block:DocumentBlock}
export type PreparationVisibility='visible'|'hidden';
export type PreparationDocumentKind='document'|'unassigned';
export interface PreparationDocument {id:string;title:string;block_ids:string[];summary:string;document_type:string;tags:string[];notes:string;unit_kind?:PreparationDocumentKind;visibility?:PreparationVisibility;visibility_reason?:string}
export interface PreparationSummaryTask {id:string;title:string;block_ids:string[];kind:'existing'|'document'|'unassigned';raw_index?:number}
export interface PreparationScene {scene:string;as_of:string}
export interface PreparationCombination {id:string;direction:string;party:string;scenes:PreparationScene[];core_work:string;deliverables:string[];document_ids:string[];notes:string}
export interface MaterialPreparationResult {summary_scope?:'visible';format:'material-preparation-v2';package_summary:string;documents:PreparationDocument[];combinations:PreparationCombination[];warnings:string[];document_count?:number;unassigned_group_count?:number;unassigned_block_count?:number}
export interface MaterialScopeSelection {direction:string;party:string;scenes:string[];deliverables:string[];additional_combinations?:Omit<MaterialScopeSelection,'additional_combinations'>[]}
export interface MaterialScopeContext {preparation_id:string;result:MaterialPreparationResult;used_combinations:{direction:string;scene:string}[]}
export interface PreparedSelectionDocument {id:string;title:string;text:string;document:RedactedDocumentStructure;source_refs:unknown;unit_kind?:PreparationDocumentKind;visibility?:PreparationVisibility;visibility_reason?:string}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const text=(v:unknown)=>typeof v==='string'?v:'';
const strings=(v:unknown)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string').map(x=>x.trim()).filter(Boolean):[];
export function preparationBlocks(units:PreparationUnit[]):PreparationBlock[]{return units.flatMap((unit,ui)=>unit.pages.flatMap((p,pi)=>p.blocks.map((block,bi)=>({id:`u${ui+1}p${pi+1}b${bi+1}`,unit_id:unit.id,page:p.page,block}))));}
export function preparationVisibility(document:Pick<PreparationDocument,'visibility'>):PreparationVisibility{return document.visibility==='hidden'?'hidden':'visible';}
export function preparationUnitKind(document:Pick<PreparationDocument,'unit_kind'>):PreparationDocumentKind|undefined{return document.unit_kind==='document'||document.unit_kind==='unassigned'?document.unit_kind:undefined;}
/** 仅生成可供作者读取的摘要投影，不暴露隐藏文书及只由隐藏文书支撑的范围。 */
export function visiblePreparationContext(result:MaterialPreparationResult):MaterialPreparationResult{
 const documents=result.documents.filter(document=>preparationVisibility(document)==='visible');
 const visibleIds=new Set(documents.map(document=>document.id));
 const combinations=result.combinations.filter(combination=>combination.document_ids.length>0&&combination.document_ids.every(id=>visibleIds.has(id)));
 const projection:MaterialPreparationResult={format:result.format,package_summary:result.summary_scope==='visible'?result.package_summary:documents.map(document=>`${document.title}${document.summary?`：${document.summary}`:''}`).join('\n'),...(result.summary_scope?{summary_scope:result.summary_scope}:{}),documents,combinations,warnings:[]};
 const counts=preparationCounts({...result,documents,document_count:result.document_count===undefined?undefined:documents.filter(document=>document.unit_kind==='document').length,unassigned_group_count:documents.filter(document=>document.unit_kind==='unassigned').length,unassigned_block_count:documents.filter(document=>document.unit_kind==='unassigned').reduce((sum,document)=>sum+document.block_ids.length,0)});
 return counts.known?{...projection,document_count:counts.document_count,unassigned_group_count:counts.unassigned_group_count,unassigned_block_count:counts.unassigned_block_count}:projection;
}
/** 按整理结果还原准确文书后，只向模型或DOCX提供标记为可见的份数。 */
export function visiblePreparedDocuments(result:MaterialPreparationResult,units:PreparationUnit[]):PreparedSelectionDocument[]{
 return materializePreparation(result,units).filter(document=>preparationVisibility(document)==='visible');
}
/** 为出题/作答生成可见文书正文；正文已有同名首标题时不再补一遍。 */
export function renderPreparationDocuments(documents:PreparedSelectionDocument[]):string{
 const key=(value:string)=>value.normalize('NFKC').replace(/^#+\s*/,'').replace(/\s+/g,'').trim();
 return documents.map(document=>{
  const first=document.document.pages.flatMap(page=>page.blocks).find(block=>documentBlocksToText([block]).trim());
  const titleAlreadyPresent=!!first&&(first.kind==='heading'||first.kind==='paragraph')&&key(first.text)===key(document.title);
  return[...(titleAlreadyPresent?[]:[`# ${document.title}`]),documentPagesToModelText(document.document.pages)].filter(Boolean).join('\n\n');
 }).join('\n\n---\n\n');
}
/** 已有分册直接采用；没有分册则保留逐文件原结构，整理阶段不拆合来源。 */
export function preparationUnits(index:any):PreparationUnit[]{
 if(Array.isArray(index?.prepared_documents)&&index.prepared_documents.length)return index.prepared_documents.map((d:any,i:number)=>({id:String(d.id??`u${i+1}`),title:text(d.title)||`材料${i+1}`,boundary:'document' as const,unit_kind:preparationUnitKind(d),pages:d.document?.pages??[{page:1,blocks:[{id:'text',kind:'paragraph',text:text(d.text)}]}],source_refs:d.segments??[]}));
 if(!Array.isArray(index?.materials))throw new Error('材料整理缺少结构化来源');
 return index.materials.map((m:any,i:number)=>({id:String(m.material_id),title:text(m.title)||`材料${i+1}`,pages:m.document?.pages?m.document.pages.map((p:any)=>({page:p.page,blocks:p.blocks??p.structure??[{id:'text',kind:'paragraph',text:text(p.text)}]})):[{page:1,blocks:[{id:'text',kind:'paragraph',text:text(m.markdown)||text(m.text)}]}],source_refs:[{file_id:m.material_id}]}));
}
/** 已确认分册仅有一份模型文书时沿用完整来源边界；扩充正文后重补摘要，避免遗漏块生成同名碎片。 */
export function completeKnownPreparationDocuments(raw:any,units:PreparationUnit[]){
 const blocks=preparationBlocks(units),byId=new Map(blocks.map(block=>[block.id,block]));
 const documents=Array.isArray(raw?.documents)?raw.documents:[];
 const owners=new Map<string,number[]>();
 documents.forEach((document:any,index:number)=>{
  const refs=strings(document?.block_ids),unitIds=new Set(refs.map(id=>byId.get(id)?.unit_id));
  for(const unitId of unitIds)if(unitId){const list=owners.get(unitId)??[];list.push(index);owners.set(unitId,list);}
 });
 return{...raw,documents:documents.map((document:any,index:number)=>{
  const refs=[...new Set(strings(document?.block_ids))];if(!refs.length||refs.some(id=>!byId.has(id)))return document;
  const unitIds=new Set(refs.map(id=>byId.get(id)!.unit_id));if(unitIds.size!==1)return document;
  const unit=units.find(unit=>unit.id===[...unitIds][0]);if(unit?.boundary!=='document'||owners.get(unit.id)?.length!==1)return document;
  const full=blocks.filter(block=>block.unit_id===unit.id).map(block=>block.id);
  return full.length===refs.length?document:{...document,block_ids:full,summary:'',tags:[],notes:'',visibility:undefined,visibility_reason:'',unit_kind:'document'};
 })};
}
/** 初次整理若受输出长度影响遗漏材料，只为无摘要文书和未覆盖原文生成定向补摘要任务。 */
export function missingPreparationSummaryTasks(raw:any,units:PreparationUnit[]):PreparationSummaryTask[]{
 const blocks=preparationBlocks(units),known=new Map(blocks.map(block=>[block.id,block])),used=new Set<string>(),ids=new Set<string>(),tasks:PreparationSummaryTask[]=[];
 for(const [index,doc] of (Array.isArray(raw?.documents)?raw.documents:[]).entries()){
  const id=text(doc?.id),selected=[...new Set(strings(doc?.block_ids))];
  if(selected.length===0||selected.some(blockId=>!known.has(blockId)||used.has(blockId))||ids.has(id))continue;
  selected.forEach(blockId=>used.add(blockId));ids.add(id);
  if(!text(doc?.summary).trim())tasks.push({id:`existing:${index}`,title:text(doc?.title)||`材料${index+1}`,block_ids:selected,kind:'existing',raw_index:index});
 }
 for(const [index,unit] of units.entries()){
  const remaining=blocks.filter(block=>block.unit_id===unit.id&&!used.has(block.id)).map(block=>block.id);
  if(remaining.length)tasks.push({id:`unassigned:${index}`,title:unit.title||`未归类材料${index+1}`,block_ids:remaining,kind:unit.boundary==='document'&&remaining.length===blocks.filter(block=>block.unit_id===unit.id).length?'document':'unassigned'});
 }
 return tasks;
}
/** 将补摘要结果按原始文书索引或未覆盖块集合并回初次响应，不采纳模型改写的来源坐标。 */
export function mergePreparationSummaryRepairs(raw:any,tasks:PreparationSummaryTask[],response:any){
 const merged={...raw,documents:Array.isArray(raw?.documents)?raw.documents.map((doc:any)=>({...doc})):[],warnings:strings(raw?.warnings)};
 const expected=new Map(tasks.map(task=>[task.id,task]));
 for(const repair of Array.isArray(response?.documents)?response.documents:[]){
  const task=expected.get(text(repair?.id)),summary=text(repair?.summary).trim();if(!task||!summary)continue;
  const patch={summary,document_type:text(repair?.document_type).trim(),tags:strings(repair?.tags),notes:text(repair?.notes).trim(),visibility:repair?.visibility==='hidden'?'hidden' as const:'visible' as const,visibility_reason:text(repair?.visibility_reason).trim()};
  if(task.kind==='existing'&&task.raw_index!==undefined){
   const original=merged.documents[task.raw_index];if(!original)continue;
   merged.documents[task.raw_index]={...original,summary:patch.summary,document_type:text(original.document_type).trim()||patch.document_type,tags:strings(original.tags).length?strings(original.tags):patch.tags,notes:text(original.notes).trim()||patch.notes,visibility:original.visibility==='visible'||original.visibility==='hidden'?original.visibility:patch.visibility,visibility_reason:text(original.visibility_reason).trim()||patch.visibility_reason};
  }else merged.documents.push({id:task.id,title:task.title,block_ids:task.block_ids,...patch,unit_kind:task.kind==='document'?'document':'unassigned'});
 }
 return merged;
}
/** 引用失效时保留未归类正文；摘要和范围只作作者上下文，不作内容准入。 */
export function compilePreparation(raw:any,units:PreparationUnit[]):MaterialPreparationResult{
 if(!raw||!Array.isArray(raw.documents))throw new Error('材料整理返回的文书目录不是有效JSON数组');
 const blocks=preparationBlocks(units),known=new Map(blocks.map(b=>[b.id,b])),used=new Set<string>(),ids=new Map<string,string>(),documents:PreparationDocument[]=[];
 // warnings仅记录编译发现的问题；模型的材料疑点保存在逐份notes中。
 const warnings:string[]=[],ambiguousIds=new Set<string>();
 if(!text(raw.package_summary).trim())warnings.push('材料包总摘要为空');
 for(const [n,d] of raw.documents.entries()){
  const selected=[...new Set(strings(d?.block_ids))];if(!selected.length)continue;
  if(ids.has(text(d.id)))ambiguousIds.add(text(d.id));
  if(selected.some(id=>!known.has(id)||used.has(id))||ids.has(text(d.id))){warnings.push('一份材料的结构引用无效，相关正文仍完整保留');continue;}
  const ordered=blocks.filter(b=>selected.includes(b.id)).map(b=>b.id),id=`doc_${sha(ordered.map(id=>`${id}:${sha(JSON.stringify(known.get(id)!.block))}`).join('|')).slice(0,24)}`;
  ordered.forEach(b=>used.add(b));ids.set(text(d.id)||`D${n+1}`,id);
  const summary=text(d.summary).trim();if(!summary)warnings.push(`材料“${text(d.title)||`材料${n+1}`}”摘要为空`);
  const visibility=d.visibility==='hidden'?'hidden':'visible';
  if(d.visibility!=='hidden'&&d.visibility!=='visible')warnings.push(`材料“${text(d.title)||`材料${n+1}`}”未提供可见状态，按可见处理`);
  documents.push({id,title:text(d.title)||`材料${n+1}`,block_ids:ordered,summary,document_type:text(d.document_type).trim(),tags:strings(d.tags),notes:text(d.notes).trim(),unit_kind:d.unit_kind==='unassigned'?'unassigned':'document',visibility,visibility_reason:text(d.visibility_reason).trim()||(visibility==='hidden'?'整理Agent标记为隐藏':'')});
 }
 for(const [n,u] of units.entries()){
  const remaining=blocks.filter(b=>b.unit_id===u.id&&!used.has(b.id)).map(b=>b.id);if(!remaining.length)continue;
  documents.push({id:`doc_${sha(remaining.join('|')).slice(0,24)}`,title:u.title||`未归类材料${n+1}`,block_ids:remaining,summary:'',document_type:'',tags:[],notes:'',unit_kind:'unassigned',visibility:'visible',visibility_reason:'未归类内容按可见处理，避免丢失来源正文'});warnings.push('部分正文未被整理，已完整保留');warnings.push(`材料“${u.title||`未归类材料${n+1}`}”摘要为空`);
 }
 const combinations:PreparationCombination[]=[],combinationIds=new Set<string>();
 for(const [n,c] of (Array.isArray(raw.combinations)?raw.combinations:[]).entries()){
  const id=text(c?.id)||`S${n+1}`,refs=[...new Set(strings(c?.document_ids))],scenes=(Array.isArray(c?.scenes)?c.scenes:[]).map((s:any):PreparationScene=>({scene:text(s?.scene).trim(),as_of:text(s?.as_of).trim()})).filter((s:PreparationScene)=>s.scene.length>0);
  if(!refs.length||refs.some(ref=>!ids.has(ref)||ambiguousIds.has(ref))||combinationIds.has(id)){warnings.push('一组使用范围引用不完整，已忽略该组建议');continue;}
  combinationIds.add(id);combinations.push({id,direction:text(c.direction).trim(),party:text(c.party).trim(),scenes,core_work:text(c.core_work).trim(),deliverables:strings(c.deliverables),document_ids:refs.map(ref=>ids.get(ref)!),notes:text(c.notes).trim()});
 }
 const document_count=documents.filter(document=>document.unit_kind==='document').length,unassigned=documents.filter(document=>document.unit_kind==='unassigned');
 return{format:'material-preparation-v2',package_summary:text(raw.package_summary).trim(),documents,combinations,warnings,document_count,unassigned_group_count:unassigned.length,unassigned_block_count:unassigned.reduce((sum,document)=>sum+document.block_ids.length,0)};
}
/** 新任务固定来源目录：Agent只提供描述和类别，ID、标题、正文边界及数量由程序保留。 */
export function compileFixedPreparation(raw:any,units:PreparationUnit[],inheritKindsOnly=false):MaterialPreparationResult{
 if(!raw||!Array.isArray(raw.documents))throw new Error('材料整理返回的逐份描述不是有效JSON数组');
 const blocks=preparationBlocks(units),warnings:string[]=[],known=new Set(units.map(unit=>unit.id));
 const metadata=new Map<string,any>(),duplicates=new Set<string>();
 for(const item of raw.documents){
  const id=text(item?.id);if(!known.has(id)){warnings.push('一条材料描述引用未知材料ID，已忽略');continue;}
  if(metadata.has(id)){duplicates.add(id);continue;}metadata.set(id,item);
 }
 const documents:PreparationDocument[]=units.map(unit=>{
  const item=duplicates.has(unit.id)?undefined:metadata.get(unit.id),selected=blocks.filter(block=>block.unit_id===unit.id);
  const summary=text(item?.summary).trim(),hasContent=selected.some(block=>documentBlocksToText([block.block]).trim());
  const unit_kind=hasContent?(unit.unit_kind??(inheritKindsOnly?undefined:preparationUnitKind(item??{})??'unassigned')):'unassigned';
  const reason=text(item?.visibility_reason).trim(),visibility=item?.visibility==='hidden'&&!!reason?'hidden':'visible';
  if(duplicates.has(unit.id))warnings.push(`材料“${unit.title}”返回重复描述，未采用冲突内容`);
  if(!text(item?.document_type).trim())warnings.push(`材料“${unit.title}”类型为空`);
  if(!strings(item?.tags).length)warnings.push(`材料“${unit.title}”标签为空`);
  if(!summary)warnings.push(`材料“${unit.title}”摘要为空`);
  if(item?.visibility==='hidden'&&!reason)warnings.push(`材料“${unit.title}”缺少目标成果隐藏理由，按可见处理`);
  return{id:unit.id,title:unit.title,block_ids:selected.map(block=>block.id),summary,document_type:text(item?.document_type).trim(),tags:strings(item?.tags),notes:text(item?.notes).trim(),unit_kind,visibility,visibility_reason:visibility==='hidden'?reason:''};
 });
 const byId=new Map(documents.map(document=>[document.id,document])),combinationIds=new Set<string>(),combinations:PreparationCombination[]=[];
 for(const item of Array.isArray(raw.combinations)?raw.combinations:[]){
  const id=text(item?.id).trim(),refs=[...new Set(strings(item?.document_ids))];
  const scenes=(Array.isArray(item?.scenes)?item.scenes:[]).map((scene:any)=>({scene:text(scene?.scene).trim(),as_of:text(scene?.as_of).trim()}));
  const direction=text(item?.direction).trim(),party=text(item?.party).trim(),core_work=text(item?.core_work).trim(),deliverables=strings(item?.deliverables);
  if(!id||combinationIds.has(id)||!refs.length||refs.some(ref=>!byId.has(ref)||byId.get(ref)!.visibility==='hidden')||!direction||!party||!core_work||!deliverables.length||!scenes.length||scenes.some((scene:PreparationScene)=>!scene.scene||!scene.as_of)){
   warnings.push('一组使用范围字段或可见材料引用不完整，已忽略该组建议');continue;
  }
  combinationIds.add(id);combinations.push({id,direction,party,scenes,core_work,deliverables,document_ids:refs,notes:text(item.notes).trim()});
 }
 const package_summary=text(raw.package_summary).trim();if(!package_summary)warnings.push('材料包总摘要为空');
 const unassigned=documents.filter(document=>document.unit_kind==='unassigned');
 return{...(inheritKindsOnly?{summary_scope:'visible' as const}:{}),format:'material-preparation-v2',package_summary,documents,combinations,warnings,...(documents.every(document=>document.unit_kind!==undefined)?{document_count:documents.length-unassigned.length,unassigned_group_count:unassigned.length,unassigned_block_count:unassigned.reduce((sum,document)=>sum+document.block_ids.length,0)}:{})};
}
export function materializePreparation(result:MaterialPreparationResult,units:PreparationUnit[]):PreparedSelectionDocument[]{
 const blocks=preparationBlocks(units),byId=new Map(blocks.map(b=>[b.id,b]));
 return result.documents.map(d=>{
  const pages:{page:number;blocks:DocumentBlock[]}[]=[];let lastUnit='';
  for(const id of d.block_ids){const b=byId.get(id);if(!b)throw new Error('整理结果与确切来源结构不匹配');const last=pages.at(-1);if(last&&lastUnit===b.unit_id&&last.page===b.page)last.blocks.push(structuredClone(b.block));else pages.push({page:b.page,blocks:[structuredClone(b.block)]});lastUnit=b.unit_id;}
  const document:RedactedDocumentStructure={format:'redacted-structure-v1',pages};
  return{id:d.id,title:d.title,text:pages.map(p=>documentBlocksToText(p.blocks)).join('\n\n'),document,source_refs:[...new Set(d.block_ids.map(id=>byId.get(id)!.unit_id))].map(id=>units.find(u=>u.id===id)?.source_refs??[]),unit_kind:d.unit_kind,visibility:preparationVisibility(d),visibility_reason:d.visibility_reason??''};
 });
}
const str={type:'string'},arr=(items:unknown)=>({type:'array',items}),obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const MATERIAL_PREPARATION_SCHEMA=obj({package_summary:str,documents:arr(obj({id:str,title:str,block_ids:arr(str),summary:str,document_type:str,tags:arr(str),notes:str,visibility:{type:'string',enum:['visible','hidden']},visibility_reason:str})),combinations:arr(obj({id:str,direction:str,party:str,scenes:arr(obj({scene:str,as_of:str})),core_work:str,deliverables:arr(str),document_ids:arr(str),notes:str}))});
export const MATERIAL_PREPARATION_SUMMARY_SCHEMA=obj({documents:arr(obj({id:str,summary:str,document_type:str,tags:arr(str),notes:str,visibility:{type:'string',enum:['visible','hidden']},visibility_reason:str}))});
/** 固定目录只允许回传元数据；不接收可用于重新划分正文的块ID或标题。 */
export const MATERIAL_PREPARATION_FIXED_DOCUMENTS_SCHEMA=obj({documents:arr(obj({id:str,summary:str,document_type:str,tags:arr(str),notes:str,unit_kind:{type:'string',enum:['document','unassigned']},visibility:{type:'string',enum:['visible','hidden']},visibility_reason:str}))});
export const MATERIAL_PREPARATION_OVERVIEW_SCHEMA=obj({package_summary:str,combinations:MATERIAL_PREPARATION_SCHEMA.properties.combinations});

/** 历史选用快照只读校验；新建题不再从整理结果过滤材料。 */
export function validateSelectedMaterialIndex(index:any,markdown:string,checkProjection=true){
 if(index?.format!=='selected-material-index-v1'||!Array.isArray(index.prepared_documents)||!index.prepared_documents.length||index.markdown_sha256!==sha(markdown))throw new Error('选用材料快照无效');
 const seen=new Set<string>();for(const d of index.prepared_documents){if(typeof d.id!=='string'||seen.has(d.id)||typeof d.title!=='string'||typeof d.text!=='string'||d.document?.format!=='redacted-structure-v1'||!Array.isArray(d.document.pages))throw new Error('选用文书结构缺失');seen.add(d.id);if(checkProjection&&d.document.pages.map((p:any)=>documentBlocksToText(p.blocks)).join('\n\n')!==d.text)throw new Error('选用文书正文与结构不一致');}
 if(checkProjection&&index.prepared_documents.map((d:any)=>`# ${d.title}\n\n${d.text}`).join('\n\n---\n\n')!==markdown)throw new Error('选用文书清单与正文不一致');return index.prepared_documents as PreparedSelectionDocument[];
}

/** 单次整理只返回描述，不让Agent重新判定上游文书类别或边界。 */
export const MATERIAL_PREPARATION_SINGLE_SCHEMA=obj({package_summary:str,documents:MATERIAL_PREPARATION_SUMMARY_SCHEMA.properties.documents,combinations:MATERIAL_PREPARATION_SCHEMA.properties.combinations});
