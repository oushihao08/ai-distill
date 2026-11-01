/**
 * 职责：验证脱敏 Markdown 到 DOCX 的转换边界与附件页码呈现。
 * 主要验证：OOXML ZIP 可解析，系统标记被隐藏，正文转义、按需源页分页与默认连续排版及常见 Markdown 表格均保留。
 * 验证边界：直接检查生成的 OOXML ZIP 字节，不启动 Word/Office；修改 `redacted-docx.ts` 时可定向回归。
 */
import {test,expect} from 'bun:test';
import {inflateRawSync} from 'node:zlib';
import {buildRedactedDocx} from './redacted-docx';
import type {DocumentBlock} from './pdf';

function docxParts(bytes:Uint8Array){
 const buffer=Buffer.from(bytes),parts=new Map<string,string>();let offset=0;
 while(offset+30<buffer.length&&buffer.readUInt32LE(offset)===0x04034b50){
  const method=buffer.readUInt16LE(offset+8),compressedSize=buffer.readUInt32LE(offset+18),nameSize=buffer.readUInt16LE(offset+26),extraSize=buffer.readUInt16LE(offset+28),name=buffer.toString('utf8',offset+30,offset+30+nameSize),start=offset+30+nameSize+extraSize,compressed=buffer.subarray(start,start+compressedSize);
  parts.set(name,(method===8?inflateRawSync(compressed):compressed).toString('utf8'));offset=start+compressedSize;
 }
 return parts;
}

test('DOCX uses only supplied redacted text and preserves attachment/page structure and tables',async()=>{
 const source='【附件 1】\n\n【原附件第 1 页】\n# 执行申请\n\n申请人支付 43****33 元 & <已脱敏>，需 **重点核对**。\n\n| 项目 | 金额 |\n| --- | --- |\n| 本金 | 100 元 |\n\n【原附件第 3 页】\n第二页后内容\n\n【附件 1 结束】';
 const parts=docxParts(await buildRedactedDocx(source));
 const xml=parts.get('word/document.xml');
 expect(parts.has('[Content_Types].xml')).toBe(true);
 expect(parts.has('_rels/.rels')).toBe(true);expect(parts.has('word/styles.xml')).toBe(true);
 expect(xml).not.toContain('【附件 1】');expect(xml).not.toContain('【原附件第 1 页】');expect(xml).not.toContain('【原附件第 3 页】');expect(xml).not.toContain('【附件 1 结束】');
 expect(xml).toContain('43****33 元 &amp; &lt;已脱敏&gt;');expect(xml).not.toContain('**重点核对**');expect(xml).toContain('<w:b');expect(xml).toContain('<w:tbl>');expect(xml).not.toContain('<w:pageBreakBefore');
 expect(xml).not.toContain('原始OCR');
});

test('DOCX rejects an empty redacted source',async()=>{
 await expect(buildRedactedDocx(' \n ')).rejects.toThrow('脱敏文本为空');
});

test('structured DOCX keeps exact text in headings, lists, tables and footnotes without image content',async()=>{
 const document={format:'redacted-structure-v1',pages:[
  {page:1,blocks:[
   {id:'h1',kind:'heading',level:1,text:' 标题 & <脱敏> '},
   {id:'l1',kind:'list',items:['第一项  ','第二项']},
   {id:'t1',kind:'table',caption:'付款表',rows:[{cells:[{text:'日期'},{text:'金额'}]},{cells:[{text:'2025-01-02'},{text:'甲某 100 元'}]}],footnotes:['脚注内容']},
  ] as DocumentBlock[]},
  {page:3,blocks:[{id:'p2',kind:'paragraph',text:'重复文本\n重复文本  '}] as DocumentBlock[]},
 ]};
 const parts=docxParts(await buildRedactedDocx(document as any)),xml=parts.get('word/document.xml')!;
 expect(xml).toContain(' 标题 &amp; &lt;脱敏&gt; ');
 expect(xml).toContain('第一项  ');expect(xml).toContain('第二项');
 expect(xml).toContain('付款表');expect(xml).toContain('2025-01-02');expect(xml).toContain('甲某 100 元');expect(xml).toContain('脚注内容');
 expect(xml.match(/重复文本/g)).toHaveLength(2);expect(xml).toContain('<w:tbl>');expect(xml).not.toContain('<w:pageBreakBefore');
 const renderedText=[...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match=>match[1]!.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"));
 expect(renderedText).toEqual([' 标题 & <脱敏> ','第一项  ','第二项','付款表','日期','金额','2025-01-02','甲某 100 元','脚注内容','重复文本\n重复文本  ']);
 expect(parts.get('word/_rels/document.xml.rels')??'').not.toContain('/media/');
});


test('source pagination is explicit and skips blank source pages while flow keeps every real paragraph',async()=>{
 const structure:any={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'a',kind:'paragraph',text:'完整正文甲'}]},{page:2,blocks:[{id:'b',kind:'paragraph',text:'   '}]},{page:3,blocks:[{id:'c',kind:'paragraph',text:'完整正文乙'}]}]};
 const flow=docxParts(await buildRedactedDocx(structure)).get('word/document.xml')!;
 expect(flow).not.toContain('<w:pageBreakBefore');expect(flow.match(/<w:p>/g)).toHaveLength(2);expect(flow).toContain('完整正文甲');expect(flow).toContain('完整正文乙');
 const source=docxParts(await buildRedactedDocx(structure,{pagination:'source'})).get('word/document.xml')!;
 expect(source.match(/<w:pageBreakBefore/g)).toHaveLength(1);
 await expect(buildRedactedDocx({format:'redacted-structure-v1',pages:[{page:1,blocks:[]}]})).rejects.toThrow('脱敏文本为空');
});


test('control characters in extracted text never produce invalid OOXML',async()=>{
 const {buildDocx}=await import('../document-generation/docx');
 const doc:any={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'p',kind:'paragraph',text:'正文\x0c换页\x01控制'}]}]};
 const xml=docxParts(await buildDocx(doc)).get('word/document.xml')!;
 expect(xml).toContain('正文换页控制');
 expect(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml)).toBe(false);
});

test('table cells use compact paragraph spacing without changing amounts or dates',async()=>{
 const doc:any={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'t',kind:'table',rows:[{cells:[{text:'本金10000元'},{text:'2025-03-26'}]}]}]}]};
 const xml=docxParts(await buildRedactedDocx(doc)).get('word/document.xml')!;
 expect(xml).toContain('本金10000元');expect(xml).toContain('2025-03-26');expect(xml).toContain('w:after="0"');expect(xml).toContain('w:line="240"');
});

test('material cleanup removes unknown HTML before DOCX generation, preserving body and masked values',async()=>{
 const {parseMineruDocxJson}=await import('./pdf-extraction/mineru-cli');
 const {cleanScanNoisePages}=await import('../../shared/scan-noise');
 const source=[{type:'html',html:'<p><哈哈>本金10000元</哈哈><br>日期2026-10-27</p>'},{type:'text',text:'<哈哈></哈哈>；依据<中华人民共和国民法典>'},{type:'text',text:String.raw`622848\\*\\*8919`},{type:'table',table_body:'<table><tr><td>&lt;哈哈&gt;附件&lt;/哈哈&gt;</td><td>10000元</td></tr></table>'}];
 const original=JSON.stringify(source),pages=parseMineruDocxJson(source),cleaned=cleanScanNoisePages(pages.map(page=>({file_id:'synthetic',page:page.page,blocks:page.structure!})));
 const xml=docxParts(await buildRedactedDocx({format:'redacted-structure-v1',pages:cleaned.pages.map(page=>({page:page.page,blocks:page.blocks}))})).get('word/document.xml')!;
 expect(xml).toContain('本金10000元\n日期2026-10-27');
 expect(xml).toContain('；依据《中华人民共和国民法典》');
 expect(xml).toContain('622848**8919');expect(xml).toContain('附件');expect(xml).not.toContain('哈哈');
 expect(xml).not.toContain('\\*');expect(xml).not.toContain('&lt;p&gt;');expect(xml).not.toContain('&lt;br&gt;');expect(xml).toContain('<w:tbl>');
 expect(JSON.stringify(source)).toBe(original);
});
