/**
 * 职责：将Agent的主体表、字段语义编辑和结构块分册编译为精确计划，并合并确定性扫描清理。
 * 入口：compileAgentMaterialPlan同时供Agent本地validate-plan.mjs与Agent完成后的宿主发布前校验调用。
 * 边界：Agent负责结合上下文的语义判断，本模块负责精确执行与机械校验；不运行模型、不访问存储。
 * 垃圾编辑是有意支持的能力，其职责与审查依据见AgentMaterialPlan.edits及编译分支；共用清理规则见scan-noise.ts。
 */
import {cleanRedactionText,findScanNoiseEdits} from './scan-noise';
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
function numericRuns(text:string){return [...text.matchAll(/(?<!\d)\d(?:[\s\-－—]*\d){5,17}[Xx]?(?!\d)/g)].map(match=>({start:match.index!,raw:match[0],digits:match[0].replace(/[^0-9Xx]/g,'').toUpperCase()}));}
function assertNoSensitiveSourceRemains(files:PreparationFile[],prepared:{pages:{file_id:string;page:number;text:string}[]},fields:Map<string,{file_id:string;page:number;text:string;start:number;end:number}>,entities:AgentMaterialPlan['entities'],edits:{file_id:string;page:number;start:number;end:number;replacement_text:string}[]){
 const output=new Map(prepared.pages.map(page=>[`${page.file_id}:${page.page}`,page.text]));
 const ranges=new Map<string,{id:string;start:number;end:number}[]>();
 for(const [id,field] of fields){const key=`${field.file_id}:${field.page}`,list=ranges.get(key)??[];list.push({id,start:field.start,end:field.end});ranges.set(key,list);}
 for(const list of ranges.values())list.sort((a,b)=>a.start-b.start);
 const findings:{kind:string;target_id:string|null;page:number}[]=[],seen=new Set<string>();
 const add=(kind:string,file_id:string,page:number,start:number)=>{
  const key=`${file_id}:${page}`,target=ranges.get(key)?.find(field=>start>=field.start&&start<field.end)?.id??null,signature=`${kind}:${target??key}`;
  if(seen.has(signature)||findings.length>=100)return;seen.add(signature);findings.push({kind,target_id:target,page});
 };
 for(const file of files)for(const page of file.pages){
  const key=`${file.file_id}:${page.page}`,result=output.get(key)??'';
  // Already partially masked identifiers are safe to preserve; raw values next to their explicit label are not.
  const identityLabel=/(?:公民身份号码|居民身份证号码|身份证(?:号码|号)?|证件号码|证件号)[ \t]*[:：]?[ \t]*([\dXx \t\-－—*＊]{8,28})/g;
  for(const match of page.text.matchAll(identityLabel)){
   const raw=match[1]!.trim(),digits=raw.replace(/[^0-9Xx]/g,'').toUpperCase();
   if(/[*＊]/.test(raw)||![15,18].includes(digits.length))continue;
   if(numericRuns(result).some(run=>run.digits===digits))add('identifier',file.file_id,page.page,match.index!+match[0].indexOf(match[1]!));
  }
  const accessLabel=/(?:统一社会信用代码|社会统一代码|查询密码|查询口令|查询编码|查询码|验证码)[ \t]*[:：]?[ \t]*([0-9A-Za-z*＊]{4,32})/g;
  for(const match of page.text.matchAll(accessLabel)){
   const raw=match[1]!,start=match.index!+match[0].indexOf(raw);
   const processed=edits.some(edit=>edit.file_id===file.file_id&&edit.page===page.page&&edit.start<=start&&edit.end>=start+raw.length&&!edit.replacement_text.includes(raw));
   if(!/[*＊]/.test(raw)&&!processed&&result.includes(raw))add('identifier',file.file_id,page.page,start);
  }
  const contactLabel=/(?:联系电话|联系号码|联系方式|电话号码|移动电话|手机号码|手机号|手机|电话)[ \t]*[:：]?[ \t]*([+\d\t ()（）\-－—]{7,30})/g;
  for(const match of page.text.matchAll(contactLabel)){
   for(const run of numericRuns(match[1]!)){
    // 邮件轨迹常在电话右括号后紧接下一条日期；日期不是第二个电话号码。
    if(/^(?:19|20)\d{2}[-－—]\d{1,2}[-－—]\d{1,2}(?:[ \t]+\d{1,2})?$/.test(run.raw))continue;
    if(run.digits.length<7||run.digits.length>15||/^(?:110|119|120|122|12345|12368)$/.test(run.digits))continue;
    const start=match.index!+match[0].indexOf(match[1]!)+run.start;
    if(numericRuns(result).some(out=>out.digits===run.digits))add('phone',file.file_id,page.page,start);
   }
  }
  // 联系人后的括号号码也可能是电话，尤其在OCR损坏的投递记录中；不泛匹配业务数字。
  const parentheticalContact=/(?:联系人|收件人|发件人|受试人|受注人)[：: \t]*[\u4e00-\u9fff]{1,8}[ \t]*[（(][ \t]*(1[3-9]\d{9})[ \t]*[)）]/g;
  for(const match of page.text.matchAll(parentheticalContact)){
   const raw=match[1]!,start=match.index!+match[0].indexOf(raw);
   const processed=edits.some(edit=>edit.file_id===file.file_id&&edit.page===page.page&&edit.start<=start&&edit.end>=start+raw.length&&!edit.replacement_text.includes(raw));
   if(!processed&&result.includes(raw))add('phone',file.file_id,page.page,start);
  }
  const addressLabel=/(?:联系地址|通讯地址|居住地址|住宅地址|住址|地址|住所地)[ \t]*[:：][ \t]*([^\t，,。；;\n]{6,100})/g;
  for(const match of page.text.matchAll(addressLabel)){
   const value=match[1]!.trim();
   // 邮政回执中的通用收件部门指令不是街道、门牌或个人地址。
   if(/^(?:邮政局|速递局|邮政速递|法院专递|业务档案室|档案室|收|[ \t])+$/.test(value))continue;
   if(!/[*＊]/.test(value)&&/[省市区县镇乡路街巷号栋楼室小区]/.test(value)&&result.includes(value))add('address',file.file_id,page.page,match.index!+match[0].indexOf(match[1]!));
  }
  const partyLabel=/(?:原告|被告|申请人|被申请人|被执行人|申请执行人|被申请执行人|法定代表人|委托诉讼代理人|委托代理人|联系人|证人)[ \t]*[:：][ \t]*([\u4e00-\u9fff]{2,4})(?=[ \t]*(?:[，,、]|男|女|身份证|联系方式|联系电话|住址|地址|系))/g;
  for(const match of page.text.matchAll(partyLabel)){
   const name=match[1]!;
   // 笔录的程序问答保留原意；带身份介绍特征的同名人员仍须处理。
   const before=page.text.slice(Math.max(0,match.index!-220),match.index!),after=page.text.slice(match.index!+match[0].length);
   if(/^(?:清楚|不清楚|明白|没有|同意|属实|是的|不是)$/.test(name)
    &&/(?:回避|听清楚|上诉|诉讼权利|诉讼义务)[^\n]*[?？][ \t]*\n[ \t]*$/.test(before)
    &&!/^\s*[，,、]?\s*(?:男|女|身份证|住址|住所|地址|联系方式|联系电话|系)/.test(after))continue;
   if(/[某＊*]/.test(name)||/(?:市|省|区|县|法院|银行|邮政|公司|事务所|委员会)$/.test(name))continue;
   if(result.includes(name))add('party_name',file.file_id,page.page,match.index!+match[0].indexOf(name));
  }
  for(const entity of entities)for(const variant of entity.variants)for(const at of locations(page.text,variant.text)){
   const replaced=edits.some(edit=>edit.file_id===file.file_id&&edit.page===page.page&&edit.start<=at&&edit.end>=at+variant.text.length&&edit.replacement_text!==variant.text);
   if(!replaced)add('planned_entity',file.file_id,page.page,at);
  }
 }
 if(findings.length)fail('agent_sensitive_value_remaining',{findings});
}
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
  // 模型可能只提交金额数字、不带单位；必须从原字段上下文识别金额/比例，不能只检查source_text。
  if(edit.kind==='identifier'||edit.kind==='phone'||edit.kind==='credential'){
   const values=[...f.text.matchAll(/\d[\d,，. \t]*(?:万|亿)?[ \t]*[元圆%％]/g)];
   if((starts as number[]).some(at=>values.some(value=>at<value.index+value[0].length&&at+edit.source_text.length>value.index)))fail('agent_business_value_edit');
  }
  // 垃圾分支的设计约定：执行Agent按本次模板确认的删除，而非由程序再做一次全面语义识别。
  // 扫描水印可合法包含数字/日期；不能机械套用编号遮盖的金额/日期禁改条件，否则会阻断正常清理。
  // 审查时不能仅因三个垃圾kind会删除原文，就认定“Agent可以借清理垃圾删除业务正文”为P1缺陷：
  // 人为构造违反模板的错误语义计划，只能证明接口接受该决定，不能证明当前设计或实际任务发生误删。
  // 这不是安全豁免：仍需检查具体规则是否扩大范围、违反明确保留条件，或有可核实的实际误删证据。
  // 下方合并的程序加固也不负责恢复Agent删掉的内容；机械覆盖通过不能冒充业务语义正确。
  let replacement:string;
  if(edit.kind==='identifier'||edit.kind==='credential'){
   if(/^\d{4}[年./-]\d{1,2}(?:[月./-]\d{1,2})?日?$/.test(edit.source_text)||/[元圆%％]|人民币/.test(edit.source_text))fail('agent_business_value_edit');
   replacement=edit.kind==='credential'?'**':maskIdentifier(edit.source_text);
  }else if(edit.kind==='phone'){if(!/^[+\d\s()（）\-－—]+$/.test(edit.source_text))fail('agent_phone_invalid');replacement=maskPhone(edit.source_text);}
  else if(edit.kind==='address'){
   if(typeof edit.keep_prefix!=='string'||!edit.source_text.startsWith(edit.keep_prefix)||edit.keep_prefix.length>=edit.source_text.length)fail('agent_address_prefix_invalid');
   replacement=edit.keep_prefix+edit.source_text.slice(edit.keep_prefix.length).replace(/\S/g,'*');
  }else if(['scan_watermark','corner_stamp','ocr_placeholder'].includes(edit.kind))replacement='';
  else fail('agent_edit_kind_invalid');
  if(replacement!==edit.source_text)for(const at of starts as number[])edits.push({file_id:f.file_id,page:f.page,start:f.start+at,end:f.start+at+edit.source_text.length,source_text:edit.source_text,replacement_text:replacement});
 }
 // Agent完成后的确定性加固：与提取后的cleanScanNoisePages复用findScanNoiseEdits，不新增一套识别规则或模型调用。
 // 重叠编辑完全落在本次清理范围内时由清理替代；跨出范围的既有编辑保留，不能为合并而扩大删除范围。
 // 随后统一检查重叠并重算分册坐标，最后做结构/覆盖与残留校验；各项检查均不是全文语义复审。
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
  // 标题内容由Agent按本次模板生成，不在编译器中做主体原称匹配；基础文件名格式仍由prepareMaterialData校验。
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
 assertNoSensitiveSourceRemains(files,prepared,fields,value.entities,exact);
 const knownPlaceholderRemains=prepared.pages.some(page=>page.structure.some(block=>{
  const text=documentBlocksToText([block]);
  return documentFieldRanges([block]).some(range=>{
   const field=text.slice(range.start,range.end);
   return cleanRedactionText(field,{removeStandaloneNumbers:false})!==field;
  });
 }));
 if(knownPlaceholderRemains)fail('agent_ocr_placeholder_remaining');
 return {plan,prepared};
}
