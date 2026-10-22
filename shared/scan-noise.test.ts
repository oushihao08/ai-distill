/** 职责：验证重复扫描噪声的精确删除范围及业务数字/日期/表格保留边界；不调用数据库或模型。 */
import {expect,test} from 'bun:test';
import {cleanScanNoisePages,type ScanNoisePage} from './scan-noise';
import {documentBlocksToText} from './document-structure';
const page=(n:number,texts:string[]):ScanNoisePage=>({file_id:'f',page:n,blocks:texts.map((text,i)=>({id:`p${n}-${i}`,kind:'paragraph',text}))});
test('cleans repeated scanner signatures and adjacent page-corner fragments, retaining business date prefix',()=>{
 const pages=[page(1,['业务事实：款项18836元，2025-03-26。','8836\\_2025-03-26 15:27:50','00!','1']),page(2,['业务事实','8836\\_2025-03-26 15:27:51','002','1']),page(3,['业务事实','2022/2/9 8836 2025-03-26 15:27:52','003'])];
 const before=JSON.stringify(pages),out=cleanScanNoisePages(pages),text=out.pages.map(p=>documentBlocksToText(p.blocks)).join('\n');
 expect(text).not.toContain('15:27');expect(text).not.toContain('00!');expect(text).toContain('款项18836元，2025-03-26');expect(text).toContain('2022/2/9');expect(JSON.stringify(pages)).toBe(before);
 for(const edit of out.edits){const original=pages.find(p=>p.page===edit.page)!;expect(documentBlocksToText(original.blocks).slice(edit.start,edit.end)).toBe(edit.source_text);}
});
test('isolated dates, counters without sequence, prose and table values remain unchanged',()=>{
 const pages=[page(1,['2025-03-26 15:27:50','8836_2025-03-26 15:27:50','1','10000']),page(2,['记录8836_2025-03-26 15:27:51作为业务流水号','2'])];
 pages[1]!.blocks.push({id:'table',kind:'table',rows:[{cells:[{text:'8836_2025-03-26 15:27:51'},{text:'2'}]}]});
 expect(cleanScanNoisePages(pages).edits).toHaveLength(0);
});
test('only confirmed margin counters are removed; original numeric business blocks and distinct IDs survive',()=>{
 const pages=[1,2,3].map(n=>page(n,['12345','付款金额','1000',String(n).padStart(3,'0')]));
 for(const p of pages)p.blocks.unshift({id:'stamp',kind:'paragraph',text:`8836_2025-03-26 15:27:5${p.page}`});
 const out=cleanScanNoisePages(pages);expect(out.edits).toHaveLength(6);
 for(const p of out.pages){expect(documentBlocksToText(p.blocks)).toContain('12345\n付款金额\n1000');}
});


test('recognizes truncated scan times and removes overlay prefix only, preserving following postal heading',()=>{
 const pages=[page(1,['8836_2025-03-26 15:27','正文']),page(2,['8836_2025-03-26 15:27:51 EMS邮政记录','正文'])];
 const out=cleanScanNoisePages(pages);
 expect(out.edits).toHaveLength(2);expect(documentBlocksToText(out.pages[1]!.blocks)).toContain('EMS邮政记录');expect(documentBlocksToText(out.pages[0]!.blocks)).not.toContain('2025-03-26');
});
