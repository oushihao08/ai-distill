/**
 * 职责：定义材料整理结果及其结构块投影；由材料库整理任务、建题快照和出题输入共用。
 * 关键入口：`compilePreparation()`保存Agent摘要/支持范围，`materializePreparation()`按原结构回看文书。
 * 边界：只整理可用信息，不代替出题Agent选择最终方向、场景或交付，也不改写材料正文。
 */
import {createHash} from 'node:crypto';
import {documentBlocksToText,type DocumentBlock} from './document-structure';
export interface RedactedDocumentStructure {format:'redacted-structure-v1';pages:{page:number;blocks:DocumentBlock[]}[]}
export interface PreparationUnit {id:string;title:string;pages:{page:number;blocks:DocumentBlock[]}[];source_refs?:unknown}
export interface PreparationBlock {id:string;unit_id:string;page:number;block:DocumentBlock}
export interface PreparationDocument {id:string;title:string;block_ids:string[];summary:string;document_type:string;tags:string[];notes:string}
export interface PreparationSummaryTask {id:string;title:string;block_ids:string[];kind:'existing'|'unassigned';raw_index?:number}
export interface PreparationScene {scene:string;as_of:string}
export interface PreparationCombination {id:string;direction:string;party:string;scenes:PreparationScene[];core_work:string;deliverables:string[];document_ids:string[];notes:string}
export interface MaterialPreparationResult {format:'material-preparation-v2';package_summary:string;documents:PreparationDocument[];combinations:PreparationCombination[];warnings:string[]}
export interface MaterialScopeSelection {direction:string;party:string;scenes:string[];deliverables:string[]}
export interface MaterialScopeContext {preparation_id:string;result:MaterialPreparationResult;used_combinations:{direction:string;scene:string}[]}
export interface PreparedSelectionDocument {id:string;title:string;text:string;document:RedactedDocumentStructure;source_refs:unknown}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const text=(v:unknown)=>typeof v==='string'?v:'';
const strings=(v:unknown)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string').map(x=>x.trim()).filter(Boolean):[];
export function preparationBlocks(units:PreparationUnit[]):PreparationBlock[]{return units.flatMap((unit,ui)=>unit.pages.flatMap((p,pi)=>p.blocks.map((block,bi)=>({id:`u${ui+1}p${pi+1}b${bi+1}`,unit_id:unit.id,page:p.page,block}))));}
/** 已有分册直接采用；没有分册则保留逐文件原结构，Agent可用块ID界定材料。 */
export function preparationUnits(index:any):PreparationUnit[]{
 if(Array.isArray(index?.prepared_documents)&&index.prepared_documents.length)return index.prepared_documents.map((d:any,i:number)=>({id:String(d.id??`u${i+1}`),title:text(d.title)||`材料${i+1}`,pages:d.document?.pages??[{page:1,blocks:[{id:'text',kind:'paragraph',text:text(d.text)}]}],source_refs:d.segments??[]}));
 if(!Array.isArray(index?.materials))throw new Error('材料整理缺少结构化来源');
 return index.materials.map((m:any,i:number)=>({id:String(m.material_id),title:text(m.title)||`材料${i+1}`,pages:(m.document?.pages??[]).map((p:any)=>({page:p.page,blocks:p.blocks??p.structure??[{id:'text',kind:'paragraph',text:text(p.text)}]})),source_refs:[{file_id:m.material_id}]}));
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
  if(remaining.length)tasks.push({id:`unassigned:${index}`,title:unit.title||`未归类材料${index+1}`,block_ids:remaining,kind:'unassigned'});
 }
 return tasks;
}
/** 将补摘要结果按原始文书索引或未覆盖块集合并回初次响应，不采纳模型改写的来源坐标。 */
export function mergePreparationSummaryRepairs(raw:any,tasks:PreparationSummaryTask[],response:any){
 const merged={...raw,documents:Array.isArray(raw?.documents)?raw.documents.map((doc:any)=>({...doc})):[],warnings:strings(raw?.warnings)};
 const expected=new Map(tasks.map(task=>[task.id,task]));
 for(const repair of Array.isArray(response?.documents)?response.documents:[]){
  const task=expected.get(text(repair?.id)),summary=text(repair?.summary).trim();if(!task||!summary)continue;
  const patch={summary,document_type:text(repair?.document_type).trim(),tags:strings(repair?.tags),notes:text(repair?.notes).trim()};
  if(task.kind==='existing'&&task.raw_index!==undefined){
   const original=merged.documents[task.raw_index];if(!original)continue;
   merged.documents[task.raw_index]={...original,summary:patch.summary,document_type:text(original.document_type).trim()||patch.document_type,tags:strings(original.tags).length?strings(original.tags):patch.tags,notes:text(original.notes).trim()||patch.notes};
  }else merged.documents.push({id:task.id,title:task.title,block_ids:task.block_ids,...patch});
 }
 return merged;
}
/** 引用失效时保留未归类正文；摘要和范围只作作者上下文，不作内容准入。 */
export function compilePreparation(raw:any,units:PreparationUnit[]):MaterialPreparationResult{
 if(!raw||!Array.isArray(raw.documents))throw new Error('材料整理返回的文书目录不是有效JSON数组');
 const blocks=preparationBlocks(units),known=new Map(blocks.map(b=>[b.id,b])),used=new Set<string>(),ids=new Map<string,string>(),documents:PreparationDocument[]=[];
 const warnings=strings(raw.warnings),ambiguousIds=new Set<string>();
 if(!text(raw.package_summary).trim())warnings.push('材料包总摘要为空');
 for(const [n,d] of raw.documents.entries()){
  const selected=[...new Set(strings(d?.block_ids))];if(!selected.length)continue;
  if(ids.has(text(d.id)))ambiguousIds.add(text(d.id));
  if(selected.some(id=>!known.has(id)||used.has(id))||ids.has(text(d.id))){warnings.push('一份材料的结构引用无效，相关正文仍完整保留');continue;}
  const ordered=blocks.filter(b=>selected.includes(b.id)).map(b=>b.id),id=`doc_${sha(ordered.map(id=>`${id}:${sha(JSON.stringify(known.get(id)!.block))}`).join('|')).slice(0,24)}`;
  ordered.forEach(b=>used.add(b));ids.set(text(d.id)||`D${n+1}`,id);
  const summary=text(d.summary).trim();if(!summary)warnings.push(`材料“${text(d.title)||`材料${n+1}`}”摘要为空`);
  documents.push({id,title:text(d.title)||`材料${n+1}`,block_ids:ordered,summary,document_type:text(d.document_type).trim(),tags:strings(d.tags),notes:text(d.notes).trim()});
 }
 for(const [n,u] of units.entries()){
  const remaining=blocks.filter(b=>b.unit_id===u.id&&!used.has(b.id)).map(b=>b.id);if(!remaining.length)continue;
  documents.push({id:`doc_${sha(remaining.join('|')).slice(0,24)}`,title:u.title||`未归类材料${n+1}`,block_ids:remaining,summary:'',document_type:'',tags:[],notes:''});warnings.push('部分正文未被整理，已完整保留');warnings.push(`材料“${u.title||`未归类材料${n+1}`}”摘要为空`);
 }
 const combinations:PreparationCombination[]=[],combinationIds=new Set<string>();
 for(const [n,c] of (Array.isArray(raw.combinations)?raw.combinations:[]).entries()){
  const id=text(c?.id)||`S${n+1}`,refs=[...new Set(strings(c?.document_ids))],scenes=(Array.isArray(c?.scenes)?c.scenes:[]).map((s:any):PreparationScene=>({scene:text(s?.scene).trim(),as_of:text(s?.as_of).trim()})).filter((s:PreparationScene)=>s.scene.length>0);
  if(!refs.length||refs.some(ref=>!ids.has(ref)||ambiguousIds.has(ref))||combinationIds.has(id)){warnings.push('一组使用范围引用不完整，已忽略该组建议');continue;}
  combinationIds.add(id);combinations.push({id,direction:text(c.direction).trim(),party:text(c.party).trim(),scenes,core_work:text(c.core_work).trim(),deliverables:strings(c.deliverables),document_ids:refs.map(ref=>ids.get(ref)!),notes:text(c.notes).trim()});
 }
 return{format:'material-preparation-v2',package_summary:text(raw.package_summary).trim(),documents,combinations,warnings};
}
export function materializePreparation(result:MaterialPreparationResult,units:PreparationUnit[]):PreparedSelectionDocument[]{
 const blocks=preparationBlocks(units),byId=new Map(blocks.map(b=>[b.id,b]));
 return result.documents.map(d=>{
  const pages:{page:number;blocks:DocumentBlock[]}[]=[];let lastUnit='';
  for(const id of d.block_ids){const b=byId.get(id);if(!b)throw new Error('整理结果与确切来源结构不匹配');const last=pages.at(-1);if(last&&lastUnit===b.unit_id&&last.page===b.page)last.blocks.push(structuredClone(b.block));else pages.push({page:b.page,blocks:[structuredClone(b.block)]});lastUnit=b.unit_id;}
  const document:RedactedDocumentStructure={format:'redacted-structure-v1',pages};
  return{id:d.id,title:d.title,text:pages.map(p=>documentBlocksToText(p.blocks)).join('\n\n'),document,source_refs:[...new Set(d.block_ids.map(id=>byId.get(id)!.unit_id))].map(id=>units.find(u=>u.id===id)?.source_refs??[])};
 });
}
const str={type:'string'},arr=(items:unknown)=>({type:'array',items}),obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const MATERIAL_PREPARATION_SCHEMA=obj({package_summary:str,documents:arr(obj({id:str,title:str,block_ids:arr(str),summary:str,document_type:str,tags:arr(str),notes:str})),combinations:arr(obj({id:str,direction:str,party:str,scenes:arr(obj({scene:str,as_of:str})),core_work:str,deliverables:arr(str),document_ids:arr(str),notes:str})),warnings:arr(str)});
export const MATERIAL_PREPARATION_SUMMARY_SCHEMA=obj({documents:arr(obj({id:str,summary:str,document_type:str,tags:arr(str),notes:str}))});

/** 历史选用快照只读校验；新建题不再从整理结果过滤材料。 */
export function validateSelectedMaterialIndex(index:any,markdown:string,checkProjection=true){
 if(index?.format!=='selected-material-index-v1'||!Array.isArray(index.prepared_documents)||!index.prepared_documents.length||index.markdown_sha256!==sha(markdown))throw new Error('选用材料快照无效');
 const seen=new Set<string>();for(const d of index.prepared_documents){if(typeof d.id!=='string'||seen.has(d.id)||typeof d.title!=='string'||typeof d.text!=='string'||d.document?.format!=='redacted-structure-v1'||!Array.isArray(d.document.pages))throw new Error('选用文书结构缺失');seen.add(d.id);if(checkProjection&&d.document.pages.map((p:any)=>documentBlocksToText(p.blocks)).join('\n\n')!==d.text)throw new Error('选用文书正文与结构不一致');}
 if(checkProjection&&index.prepared_documents.map((d:any)=>`# ${d.title}\n\n${d.text}`).join('\n\n---\n\n')!==markdown)throw new Error('选用文书清单与正文不一致');return index.prepared_documents as PreparedSelectionDocument[];
}
