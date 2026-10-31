/** 职责：名称修订的纯预览，重建材料文本/结构摘要及题包版本；供材料库名称修订HTTP事务使用，不保存业务记录。 */
import {createHash} from 'node:crypto';
import {documentBlocksToText} from '../../shared/document-structure';
import {canonicalJson} from '../../shared/workflow-config';
import {replaceNames,replaceNameTextTree,type NameReplacement} from './name-replacements';
export const nameRevisionHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const materialTextKeys=new Set(['text','markdown','title','caption','items','footnote','label']);
const questionTextKeys=new Set(['header','question','task_name','task_type','answer_approach','reference_answer','answer_requirements','rubric','criterion','rule','description','title','party','direction','scene','core_work','deliverables','notes','material_scope_selection']);
export interface NameReplacementEvidence{original:string;before:string;count:number;question_hits:number;samples:Array<{file_id:string;page:number;path:string}>}

/** 对照投影检查每个文件与分册；不因重新计算摘要而掩盖旧结构已经损坏。 */
function checkIndex(index:any,markdown:string){
 if(!index||!['redacted-index-v2','selected-material-index-v1'].includes(index.format))throw new Error('不支持的名称修订材料结构');
 if((index.format==='redacted-index-v2'?index.redacted_sha256:index.markdown_sha256)!==nameRevisionHash(markdown))throw new Error('材料正文摘要不匹配');
 for(const material of index.materials??[]){
  if(!material.document||!Array.isArray(material.document.pages))throw new Error('材料缺少冻结结构');
  const text=material.document.pages.map((page:any)=>documentBlocksToText(page.blocks)).join('\n\n');
  if(text!==material.markdown)throw new Error('材料正文与结构投影不一致');
  if(material.structure_sha256&&material.structure_sha256!==nameRevisionHash(JSON.stringify(material.document)))throw new Error('材料结构摘要不匹配');
 }
 for(const document of index.prepared_documents??[]){
  if(!document.document||!Array.isArray(document.document.pages))throw new Error('分册缺少冻结结构');
  if(document.document.pages.map((page:any)=>documentBlocksToText(page.blocks)).join('\n\n')!==document.text)throw new Error('分册正文与结构投影不一致');
 }
}
function pointerSlot(root:unknown,path:string){
 const parts=path.split('/').slice(1).map(segment=>segment.replace(/~1/g,'/').replace(/~0/g,'~'));let parent:any=root;
 for(const part of parts.slice(0,-1)){if(parent===null||typeof parent!=='object'||!(part in parent))throw new Error('名称修订证据坐标不存在');parent=parent[part];}
 const key=parts.at(-1);if(key===undefined||parent===null||typeof parent!=='object'||!(key in parent)||typeof parent[key]!=='string')throw new Error('名称修订证据坐标不是文本字段');
 return{get:()=>parent[key] as string,set:(value:string)=>{parent[key]=value;}};
}
function replaceAllExact(text:string,before:string,after:string){
 let count=0,offset=0,result='';
 while(true){const at=text.indexOf(before,offset);if(at<0)break;result+=text.slice(offset,at)+after;offset=at+before.length;count++;}
 return{text:count?result+text.slice(offset):text,count};
}
function materialMarkdown(material:any){return material.document.pages.map((page:any)=>documentBlocksToText(page.blocks)).join('\n\n');}
function attachmentMarkdown(materials:any[]){return materials.map((material,index)=>`【附件 ${index+1}】\n\n${material.document.pages.map((page:any)=>`【原附件第 ${page.page} 页】\n${documentBlocksToText(page.blocks)}`).join('\n\n')}\n\n【附件 ${index+1} 结束】`).join('\n\n');}
function projectionMode(index:any,markdown:string){
 const prepared=Array.isArray(index.prepared_documents)&&index.prepared_documents.length?index.prepared_documents:null;
 if(index.format==='selected-material-index-v1'){
  const projected=prepared?.map((document:any)=>`# ${document.title}\n\n${document.text}`).join('\n\n---\n\n');
  if(projected!==markdown)throw new Error('选用材料正文不等于冻结分册投影');return'selected' as const;
 }
 if(prepared&&prepared.map((document:any)=>document.text).join('\n\n')===markdown)return'prepared' as const;
 if(attachmentMarkdown(index.materials??[])===markdown)return'attachments' as const;
 throw new Error('材料正文无法绑定冻结结构投影');
}
function renderProjection(index:any,mode:'selected'|'prepared'|'attachments'){
 if(mode==='selected')return index.prepared_documents.map((document:any)=>`# ${document.title}\n\n${document.text}`).join('\n\n---\n\n');
 if(mode==='prepared')return index.prepared_documents.map((document:any)=>document.text).join('\n\n');
 return attachmentMarkdown(index.materials??[]);
}
function replacePreparedEvidence(index:any,sample:{file_id:string;page:number;path:string},before:string,after:string){
 if(!Array.isArray(index.prepared_documents))return;
 const blockIndex=Number(sample.path.split('/')[1]);if(!Number.isSafeInteger(blockIndex)||blockIndex<0)throw new Error('名称修订证据块坐标无效');
 const source=index.materials.find((material:any)=>material.material_id===sample.file_id),sourcePage=source?.document?.pages?.find((page:any)=>page.page===sample.page),sourceBlock=sourcePage?.blocks?.[blockIndex];
 if(!sourceBlock||typeof sourceBlock.id!=='string')throw new Error('名称修订证据缺少稳定结构块');
 const fieldPath='/0'+sample.path.split('/').slice(2).map(part=>`/${part}`).join('');
 for(const document of index.prepared_documents){
  if(!document.document||!Array.isArray(document.document.pages))throw new Error('分册缺少冻结结构');
  const segments=Array.isArray(document.segments)?document.segments:null;
  document.document.pages.forEach((page:any,pageIndex:number)=>{
   const segment=segments?.[pageIndex];
   if(segments&&(!segment||segment.file_id!==sample.file_id||segment.page!==sample.page))return;
   if(!segments&&(index.materials?.length!==1||page.page!==sample.page))return;
   const candidates=(page.blocks??[]).filter((block:any)=>block?.id===sourceBlock.id);
   if(candidates.length>1)throw new Error('分册内结构块身份不唯一');
   if(!candidates.length)return;
   const slot=pointerSlot(candidates,fieldPath),replaced=replaceAllExact(slot.get(),before,after);
   if(replaced.count)slot.set(replaced.text);
  });
 }
}
function replaceMaterialAtEvidence(old:any,mappings:NameReplacement[],evidence:NameReplacementEvidence[]){
 const index=structuredClone(old),byBefore=new Map(mappings.map(mapping=>[mapping.before,mapping])),counts:Record<string,number>=Object.create(null),changes:any[]=[];
 for(const item of evidence){
  const mapping=byBefore.get(item.before);if(!mapping||mapping.original!==item.original)throw new Error('名称修订证据与映射不一致');
  const unique=new Map(item.samples.map(sample=>[canonicalJson([sample.file_id,sample.page,sample.path]),sample] as const));
  for(const sample of unique.values()){
   const material=index.materials?.find((entry:any)=>entry.material_id===sample.file_id),page=material?.document?.pages?.find((entry:any)=>entry.page===sample.page);
   if(!page)throw new Error('名称修订证据未绑定材料页');
   const slot=pointerSlot(page.blocks,sample.path),beforeText=slot.get(),replaced=replaceAllExact(beforeText,item.before,mapping.after);
   if(!replaced.count)throw new Error('名称修订证据坐标未命中旧名称');
   slot.set(replaced.text);counts[item.before]=(counts[item.before]??0)+replaced.count;
   changes.push({path:`/materials/${sample.file_id}/pages/${sample.page}${sample.path}`,before:beforeText,after:replaced.text,counts:{[item.before]:replaced.count}});
   replacePreparedEvidence(index,sample,item.before,mapping.after);
  }
 }
 for(const item of evidence)if((counts[item.before]??0)!==item.count)throw new Error('名称修订证据坐标未覆盖全部旧名称命中');
 for(const material of index.materials??[]){material.markdown=materialMarkdown(material);material.structure_sha256=nameRevisionHash(JSON.stringify(material.document));}
 for(const document of index.prepared_documents??[])document.text=document.document.pages.map((page:any)=>documentBlocksToText(page.blocks)).join('\n\n');
 return{index,counts,changes};
}
export function previewMaterialNames(markdown:string,indexText:string,mappings:NameReplacement[],evidence?:NameReplacementEvidence[]){
 const old=JSON.parse(indexText);checkIndex(old,markdown);
 if(evidence){
  const mode=projectionMode(old,markdown),transformed=replaceMaterialAtEvidence(old,mappings,evidence),nextMarkdown=renderProjection(transformed.index,mode);
  if(transformed.index.format==='redacted-index-v2')transformed.index.redacted_sha256=nameRevisionHash(nextMarkdown);else transformed.index.markdown_sha256=nameRevisionHash(nextMarkdown);
  checkIndex(transformed.index,nextMarkdown);return{markdown:nextMarkdown,index:JSON.stringify(transformed.index),counts:transformed.counts,changes:transformed.changes};
 }
 const replacement=replaceNames(markdown,mappings),transformed=replaceNameTextTree(old,mappings,materialTextKeys),index=transformed.value;
 for(const material of index.materials??[])material.structure_sha256=nameRevisionHash(JSON.stringify(material.document));
 if(index.format==='redacted-index-v2')index.redacted_sha256=nameRevisionHash(replacement.text);else index.markdown_sha256=nameRevisionHash(replacement.text);
 checkIndex(index,replacement.text);return{markdown:replacement.text,index:JSON.stringify(index),counts:replacement.counts,changes:transformed.changes};
}
export function previewQuestionNames(question:any,mappings:NameReplacement[],materialDigest:string,attachmentIds:string[]=question.attachment_ids){
 // 历史修订说明与模型执行元数据不纳入置换，保持原历史证据。
 const selected=Object.fromEntries(Object.entries(question).filter(([key])=>questionTextKeys.has(key)||key==='material_scope_selection'));
 const changed=replaceNameTextTree(selected,mappings,questionTextKeys,true);
 if(!Array.isArray(attachmentIds)||!attachmentIds.length||attachmentIds.some(id=>typeof id!=='string'||!id)||new Set(attachmentIds).size!==attachmentIds.length)throw new Error('名称修订后的附件身份无效');
 const next={...question,...changed.value,attachment_ids:[...attachmentIds]};
 next.question_version=nameRevisionHash(canonicalJson({question:next.question,attachment_ids:next.attachment_ids,answer_requirements:next.answer_requirements,material_snapshot_digest:materialDigest}));
 next.rubric_version=nameRevisionHash(canonicalJson(next.scoring_policy?.contract==='model_report_v1'?{rubric:next.rubric,scoring_policy:next.scoring_policy}:next.rubric));
 return{question:next,changes:changed.changes};
}
