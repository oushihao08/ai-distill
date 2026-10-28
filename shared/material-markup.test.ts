/** 职责：验证材料文本去HTML精确编辑；覆盖未知/错配标签、实体、法规和比较符号，不处理DOCX。 */
import {expect,test} from 'bun:test';
import {materialMarkupEdits} from './material-markup';
function clean(text:string){const edits=materialMarkupEdits(text);let output=text;for(const e of [...edits].reverse()){expect(text.slice(e.start,e.end)).toBe(e.source_text);output=output.slice(0,e.start)+e.replacement_text+output.slice(e.end);}return output;}
test.each([
 ['<哈哈></哈哈>',''],
 ['<哈哈>本金10000元</哈哈>','本金10000元'],
 ['<p><哈哈>正文2026-10-27</哈哈></p>','正文2026-10-27'],
 ['<b>金额10000元</哈哈>','金额10000元'],
 ['&lt;哈哈&gt;',''],
 ['&amp;lt;哈哈&amp;gt;',''],
 ['&#38;lt;哈哈&#38;gt;',''],
 ['<p>本金10000元<br','本金10000元'],
 ['<custom data-x="1">甲&amp;乙</custom>','甲&乙'],
 ['依据<中华人民共和国民法典>；1 < 2；3 > 2','依据《中华人民共和国民法典》；1 < 2；3 > 2'],
 ['a < b and c > d','a < b and c > d'],
 ['<p>甲</p><p>乙<br>丙</p>','甲\n乙\n丙'],
 ['<!--重要说明--><哈哈>本金10000元</哈哈>','重要说明本金10000元'],
 ['<!DOCTYPE html><html><body>正文</body></html>','正文'],
])('material text cleans %s without dropping body', (input,expected)=>{expect(clean(input)).toBe(expected);expect(clean(expected)).toBe(expected);});

test.each([
 ['甲&nbsp;乙&nbsp丙','甲 乙 丙'],
 ['甲&amp;nbsp;乙&amp;nbsp丙','甲 乙 丙'],
 ['<?xml version="1.0"?><w:p><w:r><w:t>本金10000元</w:t></w:r></w:p>','本金10000元'],
 ['<![CDATA[正文10000元]]>','正文10000元'],
 ['<根><正文>金额10000元</正文><日期>2026-10-27</日期></根>','金额10000元2026-10-27'],
 [String.raw`622848\*\*8919`+'；'+String.raw`a\_b`+'；'+String.raw`50\%`,'622848**8919；a_b；50%'],
 [String.raw`\u003c`+'哈哈'+String.raw`\u003e`, ''],
 [String.raw`\u0026lt;`+'哈哈'+String.raw`\u0026gt;`, ''],
 ['账户&#92;*&#92;*8919','账户**8919'],
 ['甲'+String.raw`\n`+'乙'+String.raw`\t`+'丙'+String.raw`\"`+'丁'+String.raw`\"`, '甲\n乙\t丙"丁"'],
 [String.raw`C:\new\test\file.pdf`,'C:/new/test/file.pdf'],
 [String.raw`$\angle \%$`,'∠ %'],
])('technical text residue %s becomes readable text', (input,expected)=>{expect(clean(input)).toBe(expected);expect(clean(expected)).toBe(expected);});
