/** 验证模型共用正文的页码、阅读顺序、表格合并及转义；不验证OCR识别质量或DOCX排版。 */
import {test,expect} from 'bun:test';
import {documentBlocksToText,documentPagesToModelText,type DocumentBlock} from './document-structure';
import {isEnglishOnlyParagraph,filterEnglishOnlyBlocks,filterEnglishOnlyText} from './material-paragraph-filter';

test('材料英文段落过滤保留中文混排、纯数字及表格形状，不修改来源',()=>{
 for(const text of ['The image provided is a QR code.','English\nparagraph.','This is an English explanation.'])expect(isEnglishOnlyParagraph(text)).toBe(true);
 for(const text of ['英文 English','𠀀 English','12345','---',' \n ','https://example.com','ABC123','English。','NATIONAL ENTERPRISE CREDIT INFORMATION PUBLICITY SYSTEM','example@test.com','25m2'])expect(isEnglishOnlyParagraph(text)).toBe(false);
 const blocks:DocumentBlock[]=[{id:'p',kind:'paragraph',text:'The image provided is a QR code.'},{id:'mixed',kind:'paragraph',text:'中文\nEnglish'},{id:'t',kind:'table',caption:'English caption.',rows:[{cells:[{text:'English description.',rowSpan:2},{text:'10000'}]},{cells:[{text:'中文 English',columnSpan:2}]}],footnotes:['English footnote.','中文备注']},{id:'l',kind:'list',items:['English item.','中文项']}];
 const before=JSON.stringify(blocks),clean=filterEnglishOnlyBlocks(blocks);
 expect(clean[0]).toMatchObject({id:'p',text:''});expect(clean[1]).toMatchObject({text:'中文\nEnglish'});
 expect(clean[2]).toMatchObject({caption:'',rows:[{cells:[{text:'',rowSpan:2},{text:'10000'}]},{cells:[{text:'中文 English',columnSpan:2}]}],footnotes:['','中文备注']});
 expect(clean[3]).toMatchObject({items:['','中文项']});expect(JSON.stringify(blocks)).toBe(before);
 expect(filterEnglishOnlyBlocks(clean)).toEqual(clean);
 expect(filterEnglishOnlyText('中文\r\nEnglish\r\n10000\n中文\tABC123')).toBe('中文\r\nEnglish\r\n10000\n中文\tABC123');
});
test('模型正文保留跨行跨列、空格、换行及脚注，稳定投影保持原值且不改输入',()=>{
 const blocks:DocumentBlock[]=[{id:'h',kind:'heading',text:'金额核对',level:2},{id:'t',kind:'table',caption:'费用表',rows:[{cells:[{text:'项目',rowSpan:2},{text:'金额',columnSpan:2}]},{cells:[{text:'本金\n<100 & 200>'},{text:''}]}],footnotes:['备注：以原件为准']},{id:'l',kind:'list',items:['第一项','第二项']}];
 const before=JSON.stringify(blocks),stable=documentBlocksToText(blocks),model=documentPagesToModelText([{page:3,blocks}]);
 expect(model).toContain('【第 3 页】');expect(model).toContain('## 金额核对');expect(model).toContain('<td rowspan="2">项目</td>');expect(model).toContain('<td colspan="2">金额</td>');expect(model).toContain('本金<br>&lt;100 &amp; 200&gt;');expect(model).toContain('<td></td>');expect(model).toContain('备注：以原件为准');expect(model).toContain('- 第一项\n- 第二项');expect(JSON.stringify(blocks)).toBe(before);expect(documentBlocksToText(blocks)).toBe(stable);
});
test('提取structure与脱敏blocks采用同一正文投影，旧文字页保留正文',()=>{
 const blocks:DocumentBlock[]=[{id:'p',kind:'paragraph',text:'完整正文'}];
 expect(documentPagesToModelText([{page:1,structure:blocks}])).toBe(documentPagesToModelText([{page:1,blocks}]));
 expect(documentPagesToModelText([{page:2,text:'旧页正文'}])).toBe('【第 2 页】\n旧页正文');
});
