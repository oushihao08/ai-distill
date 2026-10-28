/** 职责：验证重复扫描噪声的精确删除范围及业务数字/日期/表格保留边界；不调用数据库或模型。 */
import {expect,test} from 'bun:test';
import {cleanScanNoisePages,type ScanNoisePage} from './scan-noise';
import {documentBlocksToText} from './document-structure';
const cleanText=(text:string)=>documentBlocksToText(cleanScanNoisePages([page(1,[text])]).pages[0]!.blocks);
const page=(n:number,texts:string[]):ScanNoisePage=>({file_id:'f',page:n,blocks:texts.map((text,i)=>({id:`p${n}-${i}`,kind:'paragraph',text}))});
test('cleans repeated scanner signatures and adjacent page-corner fragments, retaining business date prefix',()=>{
 const pages=[page(1,['业务事实：款项18836元，2025-03-26。','8836\\_2025-03-26 15:27:50','00!','1']),page(2,['业务事实','8836\\_2025-03-26 15:27:51','002','1']),page(3,['业务事实','2022/2/9 8836 2025-03-26 15:27:52','003'])];
 const before=JSON.stringify(pages),out=cleanScanNoisePages(pages),text=out.pages.map(p=>documentBlocksToText(p.blocks)).join('\n');
 expect(text).not.toContain('15:27');expect(text).not.toContain('00!');expect(text).toContain('款项18836元，2025-03-26');expect(text).toContain('2022/2/9');expect(JSON.stringify(pages)).toBe(before);
 for(const edit of out.edits){const original=pages.find(p=>p.page===edit.page)!;expect(documentBlocksToText(original.blocks).slice(edit.start,edit.end)).toBe(edit.source_text);}
});
test('preserves unproven numeric lines while removing explicit watermarks',()=>{
 const pages=[page(1,['2025-03-26 15:27:50','8836_2025-03-26 15:27:50','1','10000']),page(2,['记录8836_2025-03-26 15:27:51作为业务流水号','2'])];
 pages[1]!.blocks.push({id:'table',kind:'table',rows:[{cells:[{text:'8836_2025-03-26 15:27:51'},{text:'2'}]}]});
 const out=cleanScanNoisePages(pages),text=out.pages.map(p=>documentBlocksToText(p.blocks)).join('\n');
 expect(text).toContain('2025-03-26 15:27:50');expect(text).toContain('记录8836_2025-03-26 15:27:51作为业务流水号');
 expect(text).toMatch(/^10000$/m);expect((out.pages[1]!.blocks.at(-1) as any).rows[0].cells[1].text).toBe('2');
});
test('cross-page corner evidence removes page numbers, preserving other numeric fields',()=>{
 const pages=[1,2,3].map(n=>page(n,['12345','付款金额','1000',String(n).padStart(3,'0')]));
 for(const p of pages)p.blocks.unshift({id:'stamp',kind:'paragraph',text:`8836_2025-03-26 15:27:5${p.page}`});
 const out=cleanScanNoisePages(pages);expect(out.edits).toHaveLength(6);
 for(const p of out.pages){expect(documentBlocksToText(p.blocks)).toContain('付款金额\n1000');expect(documentBlocksToText(p.blocks)).toContain('12345');}
});


test('recognizes truncated scan times and removes overlay prefix only, preserving following postal heading',()=>{
 const pages=[page(1,['8836_2025-03-26 15:27','正文']),page(2,['8836_2025-03-26 15:27:51 EMS邮政记录','正文'])];
 const out=cleanScanNoisePages(pages);
 expect(out.edits).toHaveLength(2);expect(documentBlocksToText(out.pages[1]!.blocks)).toContain('EMS邮政记录');expect(documentBlocksToText(out.pages[0]!.blocks)).not.toContain('2025-03-26');
});
test('removes explicit OCR placeholders in paragraphs and tables without deleting business text',()=>{
 const pages=[page(1,['正文[QR Code]继续','[Image]','无法识别','法院说明无法识别原因，金额334666元，日期2025-05-23。'])];
 pages[0]!.blocks.push({id:'table',kind:'table',rows:[{cells:[{text:'[Barcode] [Bar Code]'},{text:'无法识别'},{text:'10000元'}]}]});
 const text=cleanScanNoisePages(pages).pages.map(p=>documentBlocksToText(p.blocks)).join('\n');
 expect(text).not.toMatch(/\[(?:QR Code|Image|Barcode|Bar Code)\]/);expect(text).toContain('正文继续');
 expect(text).toContain('法院说明无法识别原因，金额334666元，日期2025-05-23。');expect(text).toContain('10000元');
 expect(text.match(/无法识别/g)).toHaveLength(1);
});
test('structured cleanup preserves number-only lines without structural evidence',()=>{
 const text='正文[NO TEXT][NO_TEXT][No text detected][UNREADABLE]\r\n1\r\n234\r\n221\r\n-1-\r\n-22-\r\n[证据1] 334666元\r\n本金：\r\n334666\r\n1、请求\r\n-1.5元\r\n43****33';
 const cleaned=cleanText(text);
 expect(cleaned).toBe('正文\r\n1\r\n234\r\n221\r\n-1-\r\n-22-\r\n[证据1] 334666元\r\n本金：\r\n334666\r\n1、请求\r\n-1.5元\r\n43****33');
 expect(cleanText(cleaned)).toBe(cleaned);
});
test('recognizes a small fixed set of scanner timestamp forms, deleting only matched fragments',()=>{
 for(const stamp of ['4751 2025-04-25 15:24:08','4751_2025/04/25 15:24:08','4751\\_2025.04.25 15：24：08','4751_2025-04-25T15:24:08.123','扫描时间：2025年4月25日 15:24:08']){
  expect(cleanText(`前文 ${stamp} 后文`)).toBe('前文  后文');
 }
 expect(cleanText('开庭时间2025-04-25 15:24:08，金额4751元')).toBe('开庭时间2025-04-25 15:24:08，金额4751元');
});

test('preserves unlabelled split business amounts, terms and identifiers in single-field and multi-block inputs',()=>{
 const texts=['欠款','20000','元','期限','12','个月','证据号码','8836','份数','4'];
 const input=texts.join('\n');
 expect(cleanText(input)).toBe(input);
 const source=[page(1,texts)],before=JSON.stringify(source),out=cleanScanNoisePages(source);
 expect(out.edits).toHaveLength(0);expect(documentBlocksToText(out.pages[0]!.blocks)).toBe(input);expect(JSON.stringify(source)).toBe(before);
});

test('fixed cleanup never spans neighboring table or list fields',()=>{
 const pages:ScanNoisePage[]=[{file_id:'f',page:1,blocks:[{id:'table',kind:'table',rows:[{cells:[{text:'706'},{text:'2020.8.21 15:07'},{text:'[NO TEXT]'},{text:'4751_2025-04-25 15:24:08'}]}]},{id:'list',kind:'list',items:['[NO','TEXT]','[QR Code]']}]}];
 const out=cleanScanNoisePages(pages);
 expect(documentBlocksToText(out.pages[0]!.blocks)).toBe('706\t2020.8.21 15:07\t\t\n[NO\nTEXT]\n');
 expect(out.edits.every(edit=>!edit.source_text.includes('\t'))).toBe(true);
 expect(cleanScanNoisePages(out.pages).edits).toHaveLength(0);
});

test('only removes a barcode number when the entire line identifies a scanner barcode object',()=>{
 const source=[page(1,['57660 [Barcode]','合同编号57660 [Barcode]，保留编号','金额57660元','开庭2025-03-26 15:20:36','[证据1]','**'])];
 const out=cleanScanNoisePages(source),text=documentBlocksToText(out.pages[0]!.blocks);
 expect(text).toBe('\n合同编号57660 ，保留编号\n金额57660元\n开庭2025-03-26 15:20:36\n[证据1]\n**');
 expect(cleanScanNoisePages(out.pages).edits).toHaveLength(0);
});

test('restores only known formatting residues inside individual fields and preserves table values',()=>{
 const pages:ScanNoisePage[]=[{file_id:'f',page:1,blocks:[{id:'p',kind:'paragraph',text:'比例$50\\%$，标记a\\_b；金额50元。'},{id:'t',kind:'table',rows:[{cells:[{text:'$5.5\\%$'},{text:'10000'},{text:'[证据1]'}]}]}]}];
 const before=JSON.stringify(pages),out=cleanScanNoisePages(pages);
 expect(documentBlocksToText(out.pages[0]!.blocks)).toBe('比例50%，标记a_b；金额50元。\n5.5%\t10000\t[证据1]');
 expect(JSON.stringify(pages)).toBe(before);expect(cleanScanNoisePages(out.pages).edits).toHaveLength(0);
 for(const edit of out.edits)expect(documentBlocksToText(pages[0]!.blocks).slice(edit.start,edit.end)).toBe(edit.source_text);
});

test('C-style codes need page-edge and repeated scanner evidence; ordinary codes and ambiguous symbols survive',()=>{
 const pages=[page(1,['正文C89是产品型号','8836_2025-03-26 15:27:50','C89']),page(2,['正文','8836_2025-03-26 15:27:51','[ C ]60'])];
 const out=cleanScanNoisePages(pages);
 expect(documentBlocksToText(out.pages[0]!.blocks)).toBe('正文C89是产品型号\n\n');
 expect(documentBlocksToText(out.pages[1]!.blocks)).toBe('正文\n\n');
 const ordinary=[page(1,['C89','004','**','B712 210×285mm','图2.10','123456','2025-03-26 15:27:50'])];
 expect(cleanScanNoisePages(ordinary).edits).toHaveLength(0);
});

test('restores escaped mask stars in prose and cells while keeping code and formula escapes',()=>{
 const masked=String.raw`622848\*\*\*\*\*\*\*\*8919`,code=String.raw`const pattern = /\*/; const key = 'a\_b';`,formula=String.raw`x\_i + a\*b`;
 const pages:ScanNoisePage[]=[{file_id:'f',page:1,blocks:[{id:'p',kind:'paragraph',text:masked},{id:'t',kind:'table',rows:[{cells:[{text:masked},{text:'10000元；2026-10-27'}]}]},{id:'c',kind:'code',text:code},{id:'m',kind:'formula',text:formula}]}];
 const before=JSON.stringify(pages),out=cleanScanNoisePages(pages);
 expect(documentBlocksToText(out.pages[0]!.blocks)).toBe('622848********8919\n622848********8919\t10000元；2026-10-27\n'+code+'\n'+formula);
 expect(cleanScanNoisePages(out.pages).edits).toHaveLength(0);expect(JSON.stringify(pages)).toBe(before);
 for(const edit of out.edits)expect(documentBlocksToText(pages[0]!.blocks).slice(edit.start,edit.end)).toBe(edit.source_text);
});

test('prose escapes and path separators become readable while real code escapes remain intact',()=>{
 const multi=String.raw`622848\\*\\*8919`,single=String.raw`622848\*\*8919`,other=String.raw`C:\case\files`+'；literal '+String.raw`\n \t`+'；<哈哈></哈哈>';
 const input:ScanNoisePage[]=[page(1,[multi,single,other])];
 input[0]!.blocks.push({id:'code',kind:'code',text:multi});
 const out=cleanScanNoisePages(input);
 expect(documentBlocksToText(out.pages[0]!.blocks)).toBe('622848**8919\n622848**8919\nC:/case/files；literal \n \t；\n'+multi);
 expect(cleanScanNoisePages(out.pages).edits).toHaveLength(0);
});
