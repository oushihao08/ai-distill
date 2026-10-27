/**
 * 职责：将Agent的主体表、字段语义编辑和结构块分册编译为精确计划，并合并确定性扫描清理。
 * 入口：compileAgentMaterialPlan同时供Agent本地validate-plan.mjs与Agent完成后的宿主发布前校验调用。
 * 边界：Agent负责结合上下文的语义判断，本模块负责精确执行与机械校验；不运行模型、不访问存储。
 * 垃圾编辑是有意支持的能力，其职责与审查依据见AgentMaterialPlan.edits及编译分支；共用清理规则见scan-noise.ts。
 */
import {findScanNoiseEdits} from './scan-noise';
import {documentBlocksToText,type DocumentBlock} from './document-structure';
import {documentFieldRanges,prepareStructuredMaterialData} from './prepared-structure';

export type PreparationFile={file_id:string;text_sha256:string;pages:{page:number;text:string;structure:DocumentBlock[];issues?:string[]}[]};
export interface AgentMaterialPlan {
 entities:{id:string;kind:'person'|'organization';alias:string;variants:{text:string;targets:string[]}[]}[];
 /**
  * Agent已结合上下文确认的字段内编辑：target_id定位结构字段，source_text须匹配连续原文；
  * occurrence=0处理该字段内全部同文片段，正整数只处理第n次，不是跨整包的全局关键词删除。
  * scan_watermark=扫描附加水印/时间戳；corner_stamp=无语义页角码/扫描戳，不等同于业务印章；
  * ocr_placeholder=识别工具占位标记（如[Image]/[QR Code]/独立“无法识别”），不等同于正常业务表述。
  * 三类都以删除执行；分类/保留条件由本次冻结模板指导Agent判断，不能仅凭字符形状判定垃圾。
  * 默认规则保留真实业务日期、金额、条款、证据页码和已有脱敏值；不确定噪声保留并可写unresolved。
  */
 edits:{target_id:string;source_text:string;occurrence:number;kind:'identifier'|'phone'|'credential'|'address'|'scan_watermark'|'corner_stamp'|'ocr_placeholder';keep_prefix:string}[];
 documents:{id:string;title:string;ranges:{first_block_id:string;last_block_id:string}[];duplicate_of:string|null}[];
 unresolved:{target_id:string;kind:'identity'|'boundary'|'extraction'|'noise';blocking:boolean;reason:string}[];
}
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const string={type:'string'},array=(items:unknown)=>({type:'array',items});
export const AGENT_MATERIAL_PLAN_SCHEMA=object({
 entities:array(object({id:string,kind:{enum:['person','organization']},alias:string,variants:array(object({text:string,targets:array(string)}))})),
 edits:array(object({target_id:string,source_text:string,occurrence:{type:'integer',minimum:0},kind:{enum:['identifier','phone','credential','address','scan_watermark','corner_stamp','ocr_placeholder']},keep_prefix:string})),
 documents:array(object({id:string,title:string,ranges:array(object({first_block_id:string,last_block_id:string})),duplicate_of:{type:['string','null']}})),
 unresolved:array(object({target_id:string,kind:{enum:['identity','boundary','extraction','noise']},blocking:{type:'boolean'},reason:string})),
});
function fail(code:string,validation_details?:Record<string,unknown>):never{throw Object.assign(new Error('Agent材料计划校验失败'),{reason_code:code,...(validation_details?{validation_details}:{})});}
/** 输入仅一次展开正文；字段ID定位编辑，块ID定位分册，避免要求模型计算字符数。 */
export function agentMaterialSource(files:PreparationFile[]){
 const fields=new Map<string,{file_id:string;page:number;text:string;start:number;end:number}>();
 const blocks:{id:string;file_id:string;page:number;start:number;end:number}[]=[];
 const source=files.map((file,fi)=>({file_id:file.file_id,pages:file.pages.map(page=>{
  if(documentBlocksToText(page.structure)!==page.text)fail('agent_source_structure_invalid');
  const ranges=documentFieldRanges(page.structure);let cursor=0;
  return {page:page.page,issues:page.issues??[],blocks:page.structure.map((block,bi)=>{
   const id=`f${fi+1}p${page.page}b${bi+1}`,start=cursor,text=documentBlocksToText([block]);cursor+=text.length+(bi<page.structure.length-1?1:0);
   blocks.push({id,file_id:file.file_id,page:page.page,start,end:cursor});
   const values=ranges.filter(r=>r.block_id===block.id).map(r=>{
    const target_id=`${id}f${r.field_index+1}`,text=page.text.slice(r.start,r.end);
    fields.set(target_id,{file_id:file.file_id,page:page.page,text,start:r.start,end:r.end});return {target_id,text};
   });
   return {id,kind:block.kind,...(block.kind==='table'?{row_cell_counts:block.rows.map(row=>row.cells.length)}:{}),fields:values};
  })};
 })}));
 return {source,fields,blocks};
}
function locations(text:string,needle:string){const out:number[]=[];let i=0;while((i=text.indexOf(needle,i))>=0){out.push(i);i+=Math.max(1,needle.length);}return out;}
function maskIdentifier(text:string){
 const chars=Array.from(text),positions=chars.flatMap((c,i)=>/[\s\-－—]/.test(c)?[]:[i]);
 return chars.map((c,i)=>!positions.includes(i)||positions.length>=5&&(positions.indexOf(i)<2||positions.indexOf(i)>=positions.length-2)?c:'*').join('');
}
function maskPhone(text:string){
 const count=(text.match(/\d/g)??[]).length;let i=0;
 if(['110','119','120','122','11183','12368','12345'].includes(text.replace(/\D/g,'')))return text;
 return text.replace(/\d/g,c=>{const keep=count>=6&&(i<3||i>=count-2);i++;return keep?c:'*';});
}
/** 只编译Agent语义决定并校验精确编辑/完整覆盖/结构，不以语义猜测否决发布。 */
export function compileAgentMaterialPlan(value:AgentMaterialPlan,files:PreparationFile[],identity:{revision_id:string;extraction_job_id:string;template_id:string;template_digest:string}){
 if(!value||!['entities','edits','documents','unresolved'].every(k=>Array.isArray((value as any)[k])))fail('agent_plan_shape_invalid');
 const {fields,blocks}=agentMaterialSource(files);
 const edits:any[]=[],entityIds=new Set<string>();
 for(const entity of value.entities){
  if(!entity.id||entityIds.has(entity.id)||typeof entity.alias!=='string'||!entity.alias.trim()||!Array.isArray(entity.variants)||!entity.variants.length)fail('agent_entity_alias_invalid');
  entityIds.add(entity.id);
  for(const variant of entity.variants){
   if(typeof variant.text!=='string'||!variant.text.trim()||!Array.isArray(variant.targets))fail('agent_entity_variant_invalid');
   const targets=variant.targets.length?variant.targets:[...fields.keys()];let found=0;
   for(const target of targets){const f=fields.get(target);if(!f)fail('agent_target_unknown');
    for(const start of locations(f.text,variant.text)){found++;edits.push({file_id:f.file_id,page:f.page,start:f.start+start,end:f.start+start+variant.text.length,source_text:variant.text,replacement_text:entity.alias,entity_id:entity.id});}
   }
   if(!found)fail('agent_entity_source_missing');
  }
 }
 for(const edit of value.edits){
  const f=fields.get(edit.target_id);if(!f||!edit.source_text||!Number.isSafeInteger(edit.occurrence)||edit.occurrence<0)fail('agent_edit_target_invalid');
  const found=locations(f.text,edit.source_text),starts=edit.occurrence===0?found:[found[edit.occurrence-1]];
  if(!starts.length||starts.some(at=>at===undefined))fail('agent_edit_source_missing');
  // 垃圾分支的设计约定：执行Agent按本次模板确认的删除，而非由程序再做一次全面语义识别。
  // 扫描水印可合法包含数字/日期；不能机械套用编号遮盖的金额/日期禁改条件，否则会阻断正常清理。
  // 审查时不能仅因三个垃圾kind会删除原文，就认定“Agent可以借清理垃圾删除业务正文”为P1缺陷：
  // 人为构造违反模板的错误语义计划，只能证明接口接受该决定，不能证明当前设计或实际任务发生误删。
  // 这不是安全豁免：仍需检查具体规则是否扩大范围、违反明确保留条件，或有可核实的实际误删证据。
  // 下方合并的程序加固也不负责恢复Agent删掉的内容；机械覆盖通过不能冒充业务语义正确。
  let replacement:string;
  if(edit.kind==='identifier'||edit.kind==='credential'){
   replacement=edit.kind==='credential'?'**':maskIdentifier(edit.source_text);
  }else if(edit.kind==='phone')replacement=maskPhone(edit.source_text);
  else if(edit.kind==='address'){
   if(typeof edit.keep_prefix!=='string'||!edit.source_text.startsWith(edit.keep_prefix))fail('agent_address_prefix_invalid');
   replacement=edit.keep_prefix+edit.source_text.slice(edit.keep_prefix.length).replace(/\S/g,'*');
  }else if(['scan_watermark','corner_stamp','ocr_placeholder'].includes(edit.kind))replacement='';
  else fail('agent_edit_kind_invalid');
  if(replacement!==edit.source_text)for(const at of starts as number[])edits.push({file_id:f.file_id,page:f.page,start:f.start+at,end:f.start+at+edit.source_text.length,source_text:edit.source_text,replacement_text:replacement});
 }
 // Agent完成后的确定性加固：与提取后的cleanScanNoisePages复用findScanNoiseEdits，不新增一套识别规则或模型调用。
 // 重叠编辑完全落在本次清理范围内时由清理替代；跨出范围的既有编辑保留，不能为合并而扩大删除范围。
 // 随后统一检查重叠并重算分册坐标，最后做结构/覆盖校验；各项检查均不是全文语义复审。
 for(const noise of findScanNoiseEdits(files.flatMap(file=>file.pages.map(page=>({file_id:file.file_id,page:page.page,blocks:page.structure}))),edits)){
  const overlapping=edits.filter(edit=>edit.file_id===noise.file_id&&edit.page===noise.page&&edit.start<noise.end&&edit.end>noise.start);
  if(overlapping.some(edit=>edit.start<noise.start||edit.end>noise.end))continue;
  for(const edit of overlapping)edits.splice(edits.indexOf(edit),1);
  edits.push(noise);
 }
 // 全称/简称在同一主体的同一位置重叠时使用最长称呼；不同主体或其他编辑重叠仍拒绝。
 edits.sort((a,b)=>a.file_id.localeCompare(b.file_id)||a.page-b.page||a.start-b.start||b.end-a.end);
 // 私有校验器只返回定位ID、条目序号和字段内坐标，不回显原称、号码或正文。
 const describeEdit=(edit:any)=>{
  const field=[...fields].find(([,f])=>f.file_id===edit.file_id&&f.page===edit.page&&f.start<=edit.start&&f.end>=edit.end);
  const target_id=field?.[0];
  const entity_index=edit.entity_id?value.entities.findIndex(entity=>entity.id===edit.entity_id):-1;
  return{target_id:target_id??null,page:edit.page,start:edit.start-(field?.[1].start??0),end:edit.end-(field?.[1].start??0),
   plan_edit_indices:value.edits.flatMap((candidate,index)=>candidate.target_id===target_id&&candidate.source_text===edit.source_text?[index]:[]),
   ...(entity_index>=0?{entity_index,entity_variant_indices:value.entities[entity_index]!.variants.flatMap((variant,index)=>variant.text===edit.source_text?[index]:[])}:{})};
 };
 const exact:any[]=[];
 for(const edit of edits){const prior=exact.at(-1);if(prior&&prior.file_id===edit.file_id&&prior.page===edit.page&&prior.end>edit.start){if(prior.entity_id&&prior.entity_id===edit.entity_id&&prior.end>=edit.end)continue;fail('agent_edit_overlap',{left:describeEdit(prior),right:describeEdit(edit)});}exact.push(edit);}
 const shift=(file:string,page:number,pos:number)=>pos+exact.filter(e=>e.file_id===file&&e.page===page&&e.end<=pos).reduce((n,e)=>n+e.replacement_text.length-(e.end-e.start),0);
 const used=new Set<string>();
 const documentIds=new Set(value.documents.map(document=>document.id));
 const documents=value.documents.map(doc=>{
  if(doc.duplicate_of!==null&&(!documentIds.has(doc.duplicate_of)||doc.duplicate_of===doc.id))fail('agent_duplicate_reference_invalid');
  // 标题内容由Agent按本次模板生成，不在编译器中做主体原称匹配；输出文件名由prepareMaterialData独立净化。
  const segments:{file_id:string;page:number;start:number;end:number}[]=[];
  for(const range of doc.ranges){
   const a=blocks.findIndex(b=>b.id===range.first_block_id),b=blocks.findIndex(b=>b.id===range.last_block_id);
   if(a<0||b<a)fail('agent_document_range_invalid');
   for(const block of blocks.slice(a,b+1)){
    if(used.has(block.id))fail('agent_document_overlap');used.add(block.id);
    const start=shift(block.file_id,block.page,block.start),end=shift(block.file_id,block.page,block.end);if(end===start)continue;
    const previous=segments.at(-1);if(previous?.file_id===block.file_id&&previous.page===block.page&&previous.end===start)previous.end=end;else segments.push({file_id:block.file_id,page:block.page,start,end});
   }
  }
  return {id:doc.id,title:doc.title,duplicate_of:doc.duplicate_of,segments};
 });
 if(used.size!==blocks.length)fail('agent_document_coverage_missing');
 const plan={format:'codex-material-export-v1',...identity,files:files.map(f=>({file_id:f.file_id,text_sha256:f.text_sha256})),edits:exact.map(({entity_id,...edit})=>edit),documents};
 const prepared=prepareStructuredMaterialData(plan,files.flatMap(f=>f.pages.map(p=>({file_id:f.file_id,...p}))));
 return {plan,prepared};
}
