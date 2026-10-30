/**
 * 职责：过滤完整英文说明段，保留网址、邮箱、编号、单位及中英混排。
 * 入口：isEnglishOnlyParagraph()供入库审计使用；filterEnglishOnlyBlocks()/filterEnglishOnlyText()供材料导出及旧提取使用。
 * 只操作内存副本，不判断英文是否具有业务价值；数字、标点及中英混合段落保留。
 */
import type {DocumentBlock} from './document-structure';
import {documentBlockFields} from './prepared-structure';

// 至少两个英文单词、完整句末标点，仅含英文字母/空白/英文标点；不将任意ASCII字段当作说明段。
const englishOnlyParagraph=/^(?=[\s\S]*\b[A-Za-z]+\s+[A-Za-z]+\b)[A-Za-z\s,.;:!?"'“”‘’()\[\]—–-]+[.!?]["'“”‘’)]*$/u;
export function isEnglishOnlyParagraph(text:string):boolean{return englishOnlyParagraph.test(text.trim());}

/** 一个结构字段视为一个段落；换行仍属于该段，表格逐单元格、列表逐项处理，保留ID和合并关系。 */
export function filterEnglishOnlyBlocks(blocks:DocumentBlock[]):DocumentBlock[]{
 const result=structuredClone(blocks);
 for(const block of result)for(const field of documentBlockFields(block))if(isEnglishOnlyParagraph(field.text))field.set('');
 return result;
}

/** 无结构的材料导出与现有Markdown渲染器一致，每行是一个段落；制表符字段分别判定。 */
export function filterEnglishOnlyText(text:string):string{
 return text.split(/(\r\n|\r|\n)/).map(part=>part.split('\t').map(field=>isEnglishOnlyParagraph(field)?'':field).join('\t')).join('');
}
