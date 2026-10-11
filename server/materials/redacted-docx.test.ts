/**
 * 职责：验证脱敏 Markdown 到 DOCX 的转换边界与附件页码呈现。
 * 主要验证：OOXML ZIP 可解析，系统标记被隐藏，正文转义、分页及常见 Markdown 表格均保留。
 * 使用场景：修改 `redacted-docx.ts` 时由 Bun test 定向运行。
 */
import {test,expect} from 'bun:test';
import {inflateRawSync} from 'node:zlib';
import {buildRedactedDocx} from './redacted-docx';

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
 expect(xml).toContain('43****33 元 &amp; &lt;已脱敏&gt;');expect(xml).not.toContain('**重点核对**');expect(xml).toContain('<w:b');expect(xml).toContain('<w:tbl>');expect(xml).toContain('<w:pageBreakBefore');
 expect(xml).not.toContain('原始OCR');
});

test('DOCX rejects an empty redacted source',async()=>{
 await expect(buildRedactedDocx(' \n ')).rejects.toThrow('脱敏文本为空');
});
