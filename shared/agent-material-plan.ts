/**
 * 职责：将ID/文本脱敏结果回填原结构，并编译分册和确定性扫描清理；兼容历史主体/编辑计划。
 * 入口：compileAgentTextMaterialPlan供新任务校验和发布；compileAgentMaterialPlan兼容历史计划重验。
 * 边界：Agent负责结合上下文的语义判断，本模块负责精确执行与机械校验；不运行模型、不访问存储。
 * 垃圾编辑是有意支持的能力，其职责与审查依据见AgentMaterialPlan.edits及编译分支；共用清理规则见scan-noise.ts。
 */
import {findScanNoiseEdits} from './scan-noise';
import {documentBlocksToText,type DocumentBlock} from './document-structure';
import {documentBlockFields,prepareStructuredMaterialData} from './prepared-structure';

export type PreparationFile={file_id:string;text_sha256:string;pages:{page:number;text:string;structure:DocumentBlock[];issues?:string[]}[]};
export const AGENT_TEXT_REDACTION_PROTOCOL='id-text-v2';
/** 历史主体/编辑计划；新任务使用AgentTextMaterialPlan。 */
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
export type AgentTextMaterialPlan=Pick<AgentMaterialPlan,'documents'|'unresolved'>&{texts:{id:string;text:string}[]};
export type AgentRedactionPlan=AgentMaterialPlan|AgentTextMaterialPlan;
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const string={type:'string'},array=(items:unknown)=>({type:'array',items});
export const AGENT_MATERIAL_PLAN_SCHEMA=object({
 texts:array(object({id:string,text:string})),
 documents:array(object({id:string,title:string,ranges:array(object({first_block_id:string,last_block_id:string})),duplicate_of:{type:['string','null']}})),
 unresolved:array(object({target_id:string,kind:{enum:['identity','boundary','extraction','noise']},blocking:{type:'boolean'},reason:string})),
});
function fail(code:string,validation_details?:Record<string,unknown>):never{throw Object.assign(new Error('Agent材料计划校验失败'),{reason_code:code,...(validation_details?{validation_details}:{})});}
/** 新任务只接受ID/文本契约；不将旧计划或混合格式静默转换为成功结果。 */
export function compileAgentTextMaterialPlan(input:unknown,files:PreparationFile[],identity:Parameters<typeof compileAgentMaterialPlan>[2]){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('agent_text_shape_invalid');
 const value=input as Record<string,unknown>;
 if(Object.keys(value).some(key=>!['texts','documents','unresolved'].includes(key))||!['texts','documents','unresolved'].every(key=>Array.isArray(value[key])))fail('agent_text_shape_invalid');
 return compileAgentMaterialPlan(value as AgentTextMaterialPlan,files,identity,false);
}
/** 新任务沿用原块ID并补文件/页作用域与字段路径；旧位置ID仅用于历史重验。映射直接由当前块字段建立。 */
export function agentMaterialSource(files:PreparationFile[],legacyIds=false){
 const fields=new Map<string,{file_id:string;page:number;text:string;start:number;end:number}>();
 const blocks:{id:string;file_id:string;page:number;start:number;end:number}[]=[],fileIds=new Set<string>();
 const source=files.map((file,fi)=>{
  if(fileIds.has(file.file_id))fail('agent_source_identity_invalid');fileIds.add(file.file_id);
  const pageIds=new Set<number>();
  return {file_id:file.file_id,pages:file.pages.map(page=>{
   if(!Number.isSafeInteger(page.page)||page.page<1||pageIds.has(page.page))fail('agent_source_identity_invalid');pageIds.add(page.page);
   const projections=page.structure.map(block=>documentBlocksToText([block]));
   if(projections.join('\n')!==page.text)fail('agent_source_structure_invalid');
   const idCounts=new Map<string,number>();
   for(const block of page.structure)idCounts.set(block.id,(idCounts.get(block.id)??0)+1);
   if(legacyIds&&[...idCounts.values()].some(count=>count>1))fail('agent_legacy_source_block_id_ambiguous');
   let cursor=0;
   return {page:page.page,issues:page.issues??[],blocks:page.structure.map((block,bi)=>{
    // @位置只补缺失/重复的原块ID；编码有效原ID以隔离分隔符，不改原结构ID。
    const blockKey=typeof block.id==='string'&&block.id.length&&idCounts.get(block.id)===1?encodeURIComponent(block.id):`@${bi+1}`;
    const id=legacyIds?`f${fi+1}p${page.page}b${bi+1}`:`f${fi+1}p${page.page}/${blockKey}`,start=cursor;
    cursor+=projections[bi]!.length+(bi<page.structure.length-1?1:0);
    blocks.push({id,file_id:file.file_id,page:page.page,start,end:cursor});
    const values=documentBlockFields(block).map((field,fieldIndex)=>{
     const target_id=legacyIds?`${id}f${fieldIndex+1}`:`${id}#${field.path}`;
     if(fields.has(target_id))fail('agent_source_field_id_duplicate');
     fields.set(target_id,{file_id:file.file_id,page:page.page,text:field.text,start:start+field.start,end:start+field.end});
     return {target_id,text:field.text};
    });
    return {id,kind:block.kind,...(block.kind==='table'?{row_cell_counts:block.rows.map(row=>row.cells.length)}:{}),fields:values};
   })};
  })};
 });
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
export function compileAgentMaterialPlan(input:AgentRedactionPlan,files:PreparationFile[],identity:{revision_id:string;extraction_job_id:string;template_id:string;template_digest:string},legacyIds=true){
 const textPlan=input&&'texts' in input?input:undefined;
 if(textPlan&&!Array.isArray(textPlan.texts))fail('agent_text_shape_invalid');
 const value:AgentMaterialPlan=textPlan?{...textPlan,entities:[],edits:[]}:input as AgentMaterialPlan;
 if(!value||!['entities','edits','documents','unresolved'].every(k=>Array.isArray((value as any)[k])))fail('agent_plan_shape_invalid');
 const {fields,blocks}=agentMaterialSource(files,legacyIds);
 const edits:any[]=[],entityIds=new Set<string>();
 if(textPlan){
  const seen=new Set<string>();
  for(const item of textPlan.texts){
   if(!item||typeof item.id!=='string'||typeof item.text!=='string'||Object.keys(item).some(key=>key!=='id'&&key!=='text'))fail('agent_text_shape_invalid');
   if(seen.has(item.id)||!fields.has(item.id))fail('agent_text_id_invalid',{target_id:item.id});
   seen.add(item.id);const field=fields.get(item.id)!;
   if(!field.text&&item.text)fail('agent_text_empty_source_changed',{target_id:item.id});
   // 文本比较只判断是否有修改；定位键始终是item.id。
   if(item.text!==field.text){
    // 仅写回实际变更的连续区间，避免把同字段内未变化的格式/垃圾片段也标成重叠编辑。
    let start=0,suffix=0;
    while(start<field.text.length&&start<item.text.length&&field.text[start]===item.text[start])start++;
    while(suffix<field.text.length-start&&suffix<item.text.length-start&&field.text[field.text.length-1-suffix]===item.text[item.text.length-1-suffix])suffix++;
    // 现有精确编辑契约不接受零长插入；纯插入时保留整字段替换，仍按ID定位。
    if(start===field.text.length-suffix){start=0;suffix=0;}
    edits.push({file_id:field.file_id,page:field.page,start:field.start+start,end:field.end-suffix,source_text:field.text.slice(start,field.text.length-suffix),replacement_text:item.text.slice(start,item.text.length-suffix)});
   }
  }
  if(seen.size!==fields.size)fail('agent_text_coverage_missing',{expected_count:fields.size,actual_count:seen.size,missing_ids:[...fields.keys()].filter(id=>!seen.has(id)).slice(0,20)});
 }

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
  // 历史垃圾编辑按冻结模板的语义决定执行；扫描水印可含数字/日期，不套用编号遮盖约束。
  // 精确位置与结构校验不代表删除在业务上正确，仍须独立验收。
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
 const shifts=new Map<string,{end:number;delta:number}[]>();
 for(const edit of exact){
  const key=`${edit.file_id}:${edit.page}`,list=shifts.get(key)??[];
  list.push({end:edit.end,delta:(list.at(-1)?.delta??0)+edit.replacement_text.length-(edit.end-edit.start)});shifts.set(key,list);
 }
 const shift=(file:string,page:number,pos:number)=>{
  const list=shifts.get(`${file}:${page}`)??[];let lo=0,hi=list.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(list[mid]!.end<=pos)lo=mid+1;else hi=mid;}
  return pos+(lo?list[lo-1]!.delta:0);
 };
 const blockIndexes=new Map(blocks.map((block,index)=>[block.id,index]));
 const used=new Set<string>();
 const documentIds=new Set(value.documents.map(document=>document.id));
 const documents=value.documents.map(doc=>{
  if(doc.duplicate_of!==null&&(!documentIds.has(doc.duplicate_of)||doc.duplicate_of===doc.id))fail('agent_duplicate_reference_invalid');
  // 标题内容由Agent按本次模板生成，不在编译器中做主体原称匹配；输出文件名由prepareMaterialData独立净化。
  const segments:{file_id:string;page:number;start:number;end:number}[]=[];
  for(const range of doc.ranges){
   const a=blockIndexes.get(range.first_block_id)??-1,b=blockIndexes.get(range.last_block_id)??-1;
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
