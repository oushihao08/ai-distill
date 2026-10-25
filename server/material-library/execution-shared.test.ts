/** 验证新提取正文发布前的保守清理、原始OCR留存和精确编辑审计；使用合成文本与存储替身，不连接真实数据库或模型。 */
import {expect,test} from 'bun:test';
import {ensurePages,storeExtractedDocument,hash} from './execution-shared';
import {documentBlocksToText,type DocumentBlock} from '../../shared/document-structure';
function storage(){
 const contents:string[]=[];
 const db={query:async(_sql:string,values:any[])=>{contents.push(values[4]);return{rows:[{id:String(contents.length)}]};}} as any;
 return{db,contents};
}

test('preserves raw OCR and exact cleanup edits before publishing cleaned text without changing source or tables',async()=>{
 const blocks:DocumentBlock[]=[{id:'p',kind:'paragraph',text:'[Image]\n57660 [Barcode]\n款项10000元，日期2025年3月26日。\n**'},{id:'t',kind:'table',rows:[{cells:[{text:'$50\\%$',rowSpan:2},{text:'123456'}]},{cells:[{text:'[证据1]'}]}]}];
 const input=ensurePages([{page:1,text:documentBlocksToText(blocks),structure:blocks,method:'ocr',issues:['image_without_text']}],'source'),before=JSON.stringify(input),s=storage();
 const out=await storeExtractedDocument(s.db,input),stored=JSON.parse(s.contents[1]!);
 expect(s.contents).toHaveLength(2);expect(s.contents[0]).toBe(before);expect(stored.cleanup.raw_document_blob_id).toBe('1');expect(stored.cleanup.raw_document_sha256).toBe(hash(before));
 expect(stored.pages[0].text).toBe('\n\n款项10000元，日期2025年3月26日。\n**\n50%\t123456\n[证据1]');
 expect(stored.pages[0].issues).toEqual(['image_without_text']);expect(stored.pages[0].structure[1].rows[0].cells[0]).toEqual({text:'50%',rowSpan:2});
 for(const e of stored.cleanup.edits)expect(input.pages[0]!.text.slice(e.start,e.end)).toBe(e.source_text);
 expect(out.document.pages[0]!.text).toBe(stored.pages[0].text);expect(JSON.stringify(input)).toBe(before);
});

test('does not create a raw copy or remove ambiguous business information when nothing is confidently garbage',async()=>{
 const text='C89\n004\n本金\n10000\n元\n2025-03-26 15:20:36\n无法识别原因待核\n**';
 const input=ensurePages([{page:1,text,structure:[{id:'p',kind:'paragraph',text}],method:'text'}],'source'),s=storage();
 const out=await storeExtractedDocument(s.db,input);
 expect(s.contents).toHaveLength(1);expect(JSON.parse(s.contents[0]!).cleanup).toBeUndefined();expect(out.cleanup_edit_count).toBe(0);expect(out.document.pages[0]!.text).toBe(text);
});
