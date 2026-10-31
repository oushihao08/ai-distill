/**
 * 职责：过滤英文说明段及较长的纯英文OCR截断段，保留网址、邮箱、编号、单位及中英混排。
 * 入口：isEnglishOnlyParagraph()供入库审计使用；filterEnglishOnlyBlocks()/filterEnglishOnlyText()供材料导出及旧提取使用。
 * 只操作内存副本，不判断英文是否具有业务价值；数字、标点及中英混合段落保留。
 */
import type {DocumentBlock} from './document-structure';
import {documentBlockFields} from './prepared-structure';

// 完整英文句至少两词；无句末标点时，至少八词且含小写字母才视为OCR说明残片，避免删除全大写英文标题。
const englishOnlyCharacters=/^[A-Za-z\s,.;:!?"'“”‘’()\[\]—–-]+$/u;
const englishSentenceEnding=/[.!?]["'“”‘’)]*$/u;
export function isEnglishOnlyParagraph(text:string):boolean{
 const normalized=text.trim();
 if(!englishOnlyCharacters.test(normalized))return false;
 const words=normalized.match(/\b[A-Za-z]+\b/g)??[];
 return words.length>=2&&(englishSentenceEnding.test(normalized)||(words.length>=8&&/[a-z]/.test(normalized)));
}

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
