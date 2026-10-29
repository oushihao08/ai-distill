/** 职责：材料执行器共用摘要、私有目录、提取结构校验与保守清理归档；沿用调用方事务，不派发模型。 */
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import type {Page} from '../materials/pdf';
import {documentBlocksToText} from '../../shared/document-structure';
import {canonicalJson} from '../../shared/workflow-config';
import type {PoolClient} from 'pg';
import {cleanScanNoisePages} from '../../shared/scan-noise';
import {insertLibraryTextBlob} from './storage';
export const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:canonicalJson(value)).digest('hex');
export const jobDirectory=(root:string,id:string)=>join(resolve(root),'material-library','jobs',id);

export function ensurePages(pages:Page[],sourceSha:string){
 if(!Array.isArray(pages)||!pages.length||pages.some((page,index)=>!page||page.page!==index+1||typeof page.text!=='string'||!Array.isArray(page.structure)||documentBlocksToText(page.structure)!==page.text||!['text','ocr'].includes(page.method)))throw new Error('提取结果结构无效');
 return{version:1,source_sha256:sourceSha,pages};
}

/**
 * 新材料库的提取发布入口：普通runner与MinerU桌面导入共用，发生在Agent脱敏之前。
 * cleanScanNoisePages内部调用findScanNoiseEdits，与Agent完成后计划编译使用同一规则，外层发布流程不同。
 * 这里只做确定扫描垃圾/格式清理和结构投影校验，不运行Agent、不化名、不证明OCR或业务内容逐字准确。
 * 有编辑时另存原始OCR文本对象，正文对象的cleanup记录原始对象ID/摘要和原页精确编辑；无编辑不额外存副本。
 * 上传原件及其摘要不变；调用方在原事务中发布清理正文和匹配的text_sha256，不回写历史文档或题目快照。
 * 原始OCR与审计用于追溯，不代替业务核验；页尾数字的扫描证据与业务标签保护共用scan-noise.ts规则。
 */
export async function storeExtractedDocument(db:Pick<PoolClient,'query'>,input:ReturnType<typeof ensurePages>){
 const original=ensurePages(input.pages,input.source_sha256);
 const cleaned=cleanScanNoisePages(original.pages.map(p=>({file_id:input.source_sha256,page:p.page,blocks:p.structure!})));
 const document=ensurePages(original.pages.map((page,index)=>({...page,structure:cleaned.pages[index]!.blocks,text:documentBlocksToText(cleaned.pages[index]!.blocks)})),input.source_sha256);
 let cleanup:undefined|{protocol:string;raw_document_blob_id:string;raw_document_sha256:string;edits:typeof cleaned.edits};
 if(cleaned.edits.length){
  const raw=await insertLibraryTextBlob(db,JSON.stringify(original),'application/vnd.ai-distill.extracted-document+json');
  cleanup={protocol:'conservative-scan-cleanup-v1',raw_document_blob_id:raw.id,raw_document_sha256:raw.sha256,edits:cleaned.edits};
 }
 const blob=await insertLibraryTextBlob(db,JSON.stringify({...document,...(cleanup?{cleanup}:{})}),'application/vnd.ai-distill.extracted-document+json');
 return{blob,document,cleanup_edit_count:cleaned.edits.length};
}

