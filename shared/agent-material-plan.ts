/** 职责：将Agent的主体表、字段语义编辑和结构块分册编译为既有精确计划。供材料库Agent执行器调用；不运行模型、不访问存储。 */
import {findScanNoiseEdits} from './scan-noise';
import {documentBlocksToText,type DocumentBlock} from './document-structure';
import {documentFieldRanges,prepareStructuredMaterialData} from './prepared-structure';

export type PreparationFile={file_id:string;text_sha256:string;pages:{page:number;text:string;structure:DocumentBlock[];issues?:string[]}[]};
export interface AgentMaterialPlan {
 entities:{id:string;kind:'person'|'organization';alias:string;variants:{text:string;targets:string[]}[]}[];
 edits:{target_id:string;source_text:string;occurrence:number;kind:'identifier'|'phone'|'address'|'scan_watermark'|'corner_stamp'|'ocr_placeholder';keep_prefix:string}[];
 documents:{id:string;title:string;ranges:{first_block_id:string;last_block_id:string}[];duplicate_of:string|null}[];
 unresolved:{target_id:string;kind:'identity'|'boundary'|'extraction'|'noise';blocking:boolean;reason:string}[];
}
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const string={type:'string'},array=(items:unknown)=>({type:'array',items});
export const AGENT_MATERIAL_PLAN_SCHEMA=object({
 entities:array(object({id:string,kind:{enum:['person','organization']},alias:string,variants:array(object({text:string,targets:array(string)}))})),
 edits:array(object({target_id:string,source_text:string,occurrence:{type:'integer',minimum:0},kind:{enum:['identifier','phone','address','scan_watermark','corner_stamp','ocr_placeholder']},keep_prefix:string})),
 documents:array(object({id:string,title:string,ranges:array(object({first_block_id:string,last_block_id:string})),duplicate_of:{type:['string','null']}})),
 unresolved:array(object({target_id:string,kind:{enum:['identity','boundary','extraction','noise']},blocking:{type:'boolean'},reason:string})),
});
function fail(code:string):never{throw Object.assign(new Error('Agent材料计划校验失败'),{reason_code:code});}
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
/** 编译后仍调用原精确编辑/完整覆盖/结构校验器；新增语义入口不放宽既有发布条件。 */
export function compileAgentMaterialPlan(value:AgentMaterialPlan,files:PreparationFile[],identity:{revision_id:string;extraction_job_id:string;template_id:string;template_digest:string}){
 if(!value||!['entities','edits','documents','unresolved'].every(k=>Array.isArray((value as any)[k])))fail('agent_plan_shape_invalid');
 if(value.unresolved.some(x=>x.blocking))fail('agent_plan_unresolved');
 const {fields,blocks}=agentMaterialSource(files),allText=files.flatMap(f=>f.pages.map(p=>p.text)).join('\n');
 for(const issue of value.unresolved){
  if((issue.kind==='identity'||issue.kind==='boundary')&&!fields.has(issue.target_id)&&!blocks.some(block=>block.id===issue.target_id))fail('agent_uncertainty_target_invalid');
  if(issue.kind==='identity'){
   const field=fields.get(issue.target_id);
   const mapped=field&&value.entities.some(entity=>entity.variants.some(variant=>(!variant.targets.length||variant.targets.includes(issue.target_id))&&field.text.includes(variant.text)));
   if(!field||!mapped&&!/[*＊]/.test(field.text))fail('agent_identity_not_processed');
  }
 }
 const edits:any[]=[],entityIds=new Set<string>(),aliases=new Set<string>();
 for(const entity of value.entities){
  if(!entity.id||entityIds.has(entity.id)||!entity.alias?.trim()||aliases.has(entity.alias)||!entity.variants?.length||allText.includes(entity.alias)||/^(?:人员|自然人|当事人)?[甲乙丙丁戊己庚辛壬癸]+$|某某/.test(entity.alias))fail('agent_entity_alias_invalid');
  entityIds.add(entity.id);aliases.add(entity.alias);
  for(const variant of entity.variants){
   if(!variant.text?.trim()||/[*＊]/.test(variant.text)||entity.kind==='organization'&&/法院|银行|邮政/.test(variant.text))fail('agent_entity_variant_invalid');
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
  let replacement:string;
  if(edit.kind==='identifier'){
   if(/^\d{4}[年./-]\d{1,2}(?:[月./-]\d{1,2})?日?$/.test(edit.source_text)||/[元圆%％]|人民币/.test(edit.source_text))fail('agent_business_value_edit');
   replacement=maskIdentifier(edit.source_text);
  }else if(edit.kind==='phone'){if(!/^[+\d\s()（）\-－—]+$/.test(edit.source_text))fail('agent_phone_invalid');replacement=maskPhone(edit.source_text);}
  else if(edit.kind==='address'){
   if(!edit.keep_prefix||!edit.source_text.startsWith(edit.keep_prefix)||edit.keep_prefix.length>=edit.source_text.length)fail('agent_address_prefix_invalid');
   replacement=edit.keep_prefix+edit.source_text.slice(edit.keep_prefix.length).replace(/\S/g,'*');
  }else if(['scan_watermark','corner_stamp','ocr_placeholder'].includes(edit.kind))replacement='';
  else fail('agent_edit_kind_invalid');
  if(replacement!==edit.source_text)for(const at of starts as number[])edits.push({file_id:f.file_id,page:f.page,start:f.start+at,end:f.start+at+edit.source_text.length,source_text:edit.source_text,replacement_text:replacement});
 }
 // 程序只补充重复扫描签名/页角码的精确清理，纳入同一原文编辑与分册覆盖校验。
 for(const noise of findScanNoiseEdits(files.flatMap(file=>file.pages.map(page=>({file_id:file.file_id,page:page.page,blocks:page.structure}))))){
  const overlapping=edits.filter(edit=>edit.file_id===noise.file_id&&edit.page===noise.page&&edit.start<noise.end&&edit.end>noise.start);
  if(overlapping.some(edit=>edit.start<noise.start||edit.end>noise.end))continue;
  for(const edit of overlapping)edits.splice(edits.indexOf(edit),1);
  edits.push(noise);
 }
 // 全称/简称在同一主体的同一位置重叠时使用最长称呼；不同主体或其他编辑重叠仍拒绝。
 edits.sort((a,b)=>a.file_id.localeCompare(b.file_id)||a.page-b.page||a.start-b.start||b.end-a.end);
 const exact:any[]=[];
 for(const edit of edits){const prior=exact.at(-1);if(prior&&prior.file_id===edit.file_id&&prior.page===edit.page&&prior.end>edit.start){if(prior.entity_id&&prior.entity_id===edit.entity_id&&prior.end>=edit.end)continue;fail('agent_edit_overlap');}exact.push(edit);}
 const shift=(file:string,page:number,pos:number)=>pos+exact.filter(e=>e.file_id===file&&e.page===page&&e.end<=pos).reduce((n,e)=>n+e.replacement_text.length-(e.end-e.start),0);
 const used=new Set<string>();
 const documentIds=new Set(value.documents.map(document=>document.id));
 const documents=value.documents.map(doc=>{
  if(doc.duplicate_of!==null&&(!documentIds.has(doc.duplicate_of)||doc.duplicate_of===doc.id))fail('agent_duplicate_reference_invalid');
  if(value.entities.some(e=>e.variants.some(v=>doc.title?.includes(v.text))))fail('agent_title_contains_identity');
  const segments:{file_id:string;page:number;start:number;end:number}[]=[];
  for(const range of doc.ranges){
   const a=blocks.findIndex(b=>b.id===range.first_block_id),b=blocks.findIndex(b=>b.id===range.last_block_id);
   if(a<0||b<a||blocks[a]!.file_id!==blocks[b]!.file_id)fail('agent_document_range_invalid');
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
