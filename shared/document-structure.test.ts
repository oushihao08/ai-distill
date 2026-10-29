/** 验证模型共用正文的页码、阅读顺序、表格合并及转义；不验证OCR识别质量或DOCX排版。 */
import {test,expect} from 'bun:test';
import {documentBlocksToText,documentPagesToModelText,type DocumentBlock} from './document-structure';
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
