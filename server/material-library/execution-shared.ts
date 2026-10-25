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

/** 提取发布前复用脱敏后的保守清理；有改动才保存原始OCR对象与逐项原文编辑，原件摘要及页/表结构不变。 */
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

