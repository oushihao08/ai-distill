/**
 * 职责：将当前脱敏合并正文转换为不依赖第三方包的 DOCX OOXML 文件。
 * 主要入口：`buildRedactedDocx()` 保留附件边界、原页码、段落、标题和 Markdown 表格。
 * 使用场景：单题工作流完成后由独立可选导出接口调用；不读取原始 OCR 或工作流状态。
 */
import {deflateRawSync} from 'node:zlib';

const xml=(value:string)=>value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function zip(files:{name:string;data:string}[]){
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const file of files){const name=Buffer.from(file.name),raw=Buffer.from(file.data,'utf8'),compressed=deflateRawSync(raw),crc=crc32(raw),header=Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(name.length,26);
  const entry=Buffer.concat([header,name,compressed]);local.push(entry);const directory=Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(8,10);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(raw.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);central.push(Buffer.concat([directory,name]));offset+=entry.length;
 }
 const centralBytes=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,centralBytes,end]);
}
const run=(value:string)=>`<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="PingFang SC"/></w:rPr><w:t xml:space="preserve">${xml(value)}</w:t></w:r>`;
function paragraph(value:string,style?:string,pageBreak=false){return`<w:p>${style||pageBreak?`<w:pPr>${style?`<w:pStyle w:val="${style}"/>`:''}${pageBreak?'<w:pageBreakBefore/>':''}</w:pPr>`:''}${run(value)}</w:p>`;}
function tableRow(line:string){return line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());}
function isTableSeparator(line:string){return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);}
function table(lines:string[]){
 const rows=lines.filter(line=>!isTableSeparator(line)).map(tableRow),columns=Math.max(...rows.map(row=>row.length));
 return`<w:tbl><w:tblPr><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(edge=>`<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="B7C3D0"/>`).join('')}</w:tblBorders></w:tblPr>${rows.map((row,index)=>`<w:tr>${Array.from({length:columns},(_,column)=>`<w:tc><w:tcPr>${index===0?'<w:shd w:fill="EAF0F8"/>':''}</w:tcPr>${paragraph(row[column]??'',index===0?'TableHeader':undefined)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
}
function documentXml(markdown:string){
 const lines=markdown.replace(/\r\n?/g,'\n').split('\n'),body:string[]=[];let seenPage=false;
 for(let index=0;index<lines.length;){
  const line=lines[index]!.trim();if(!line){index++;continue;}
  if(/^【附件\s+\d+】$/.test(line)){body.push(paragraph(line,'Heading1'));index++;continue;}
  if(/^【附件\s+\d+\s+结束】$/.test(line)){body.push(paragraph(line,'Heading2'));index++;continue;}
  if(/^【原附件第\s+\d+\s+页】$/.test(line)){body.push(paragraph(line,'Heading2',seenPage));seenPage=true;index++;continue;}
  if(line.startsWith('|')){const rows=[line];index++;while(index<lines.length&&lines[index]!.trim().startsWith('|'))rows.push(lines[index++]!.trim());body.push(table(rows));continue;}
  const heading=/^(#{1,3})\s+(.+)$/.exec(line);if(heading){body.push(paragraph(heading[2]!,`Heading${heading[1]!.length}`));index++;continue;}
  const block=[line];index++;while(index<lines.length&&lines[index]!.trim()&&!/^【(?:附件\s+\d+(?:\s+结束)?|原附件第\s+\d+\s+页)】$/.test(lines[index]!.trim())&&!lines[index]!.trim().startsWith('|')&&!/^#{1,3}\s+/.test(lines[index]!.trim()))block.push(lines[index++]!.trim());
  body.push(paragraph(block.join(' ')));
 }
 const sectPr='<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
 return`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}${sectPr}</w:body></w:document>`;
}
/** Build a minimal Office Open XML DOCX without opening or modifying source attachments. */
export function buildRedactedDocx(markdown:string):Uint8Array{
 if(typeof markdown!=='string'||!markdown.trim())throw new Error('脱敏文本为空');
 const contentTypes='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
 const relationships='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
 const documentRelationships='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
 const styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="PingFang SC"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style></w:styles>';
 return zip([{name:'[Content_Types].xml',data:contentTypes},{name:'_rels/.rels',data:relationships},{name:'word/document.xml',data:documentXml(markdown)},{name:'word/_rels/document.xml.rels',data:documentRelationships},{name:'word/styles.xml',data:styles}]);
}
