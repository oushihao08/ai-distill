/**
 * 职责：将Agent化名或人工声明的正文/结构渲染为统一附件索引。
 * 入口：renderRedactedMaterials供材料库Agent、精确计划导入和人工声明直通使用。
 * 不包含字段映射模型执行；历史协议常量仅用于读取旧快照和摘要兼容，不恢复旧模型调用。
 */
import {createHash} from 'node:crypto';
import {documentBlocksToText,type DocumentBlock,type Page} from './pdf';
import {logEvent} from '../logging';
export interface ExtractedMaterial {material_id:string;source_sha256:string;pages:Page[]}
export interface RedactedPage {page:number;text:string;structure?:DocumentBlock[];issues?:string[]}
export interface RedactedMaterial {material_id:string;pages:RedactedPage[]}
export const REDACTION_PROTOCOL_VERSION='attachment-field-redaction-v32';
function outputError(reason_code:string,message:string){
 logEvent('redaction.validation.failed',{level:'error',error_kind:'invalid_response',reason_code});
 return Object.assign(new Error(message),{kind:'invalid_response' as const,reason_code});
}
function renderMaterialPages(material:RedactedMaterial){return material.pages.map(page=>`【原附件第 ${page.page} 页】\n${page.text}`).join('\n\n');}

/** One index format for model-redacted and explicitly declared already-redacted materials. */
export function renderRedactedMaterials(materials:RedactedMaterial[]){
 if(!materials.length||materials.some(material=>!material.pages.length||material.pages.some(page=>!Array.isArray(page.structure)||documentBlocksToText(page.structure)!==page.text)))throw outputError('source_structure_invalid','脱敏附件结构与正文不一致');
 const pageIndex=materials.flatMap(material=>material.pages.map(page=>({material_id:material.material_id,page:page.page})));
 const markdown=materials.map((material,index)=>`【附件 ${index+1}】\n\n${renderMaterialPages(material)}\n\n【附件 ${index+1} 结束】`).join('\n\n');
 const materialMarkdown=materials.map(material=>({material_id:material.material_id,markdown:material.pages.map(page=>page.text).join('\n\n')}));
 const indexedMaterials=materials.map(material=>{
  const markdownText=material.pages.map(page=>page.text).join('\n\n'),document={format:'redacted-structure-v1',pages:material.pages.map(page=>({page:page.page,blocks:page.structure??[],...(page.issues?.length?{issues:page.issues}:{})}))};
  return{material_id:material.material_id,markdown:markdownText,document,structure_sha256:createHash('sha256').update(JSON.stringify(document)).digest('hex')};
 });
 const index=JSON.stringify({format:'redacted-index-v2',pages:pageIndex,materials:indexedMaterials,redacted_sha256:createHash('sha256').update(markdown).digest('hex'),material_count:materials.length,page_count:pageIndex.length});
 return{markdown,index,materialMarkdown,materials};
}
