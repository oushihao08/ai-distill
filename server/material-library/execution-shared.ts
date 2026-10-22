/** 职责：材料执行器共用摘要、私有任务目录和提取结构校验；不派发模型或写数据库。 */
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import type {Page} from '../materials/pdf';
import {documentBlocksToText} from '../../shared/document-structure';
import {canonicalJson} from '../../shared/workflow-config';
export const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:canonicalJson(value)).digest('hex');
export const jobDirectory=(root:string,id:string)=>join(resolve(root),'material-library','jobs',id);

export function ensurePages(pages:Page[],sourceSha:string){
 if(!Array.isArray(pages)||!pages.length||pages.some((page,index)=>!page||page.page!==index+1||typeof page.text!=='string'||!Array.isArray(page.structure)||documentBlocksToText(page.structure)!==page.text||!['text','ocr'].includes(page.method)))throw new Error('提取结果结构无效');
 return{version:1,source_sha256:sourceSha,pages};
}

