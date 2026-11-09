/**
 * 职责：轻量 XLSX 写入：构建 OOXML 与 ZIP，处理表名、XML 字符及超长单元格拆分。
 * 关键方法与用途：`buildXlsx()` 从工作表数据构造 OOXML ZIP；`writeXlsx()` 将生成字节写入指定输出。
 * 使用场景：报表结构模块调用；不负责读取业务数据库或决定可发布内容。
 */
import {deflateRawSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
export interface WorkbookFormula {formula:string;cached_value:number|null}
const formula=(value:unknown):value is WorkbookFormula=>Boolean(value&&typeof value==='object'&&'formula'in value);
export interface WorkbookHyperlink {text:string;target:string}
export interface WorkbookSheet {name:string;columns:string[];rows:Record<string,unknown>[];columnWidths?:Record<string,number>;rowHeight?:number}
const hyperlink=(value:unknown):value is WorkbookHyperlink=>Boolean(value&&typeof value==='object'&&'text'in value&&typeof value.text==='string'&&'target'in value&&typeof value.target==='string');
const MAX_CELL=30_000;
const xml=(value:string)=>value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function columnName(index:number){let name='';for(index++;index;index=Math.floor((index-1)/26))name=String.fromCharCode(65+(index-1)%26)+name;return name;}
function uniqueSheetNames(sheets:WorkbookSheet[]){
 const used=new Set<string>();return sheets.map(sheet=>{
  const base=(sheet.name.replace(/[\\/?*\[\]:]/g,' ').trim()||'Sheet').slice(0,31);let name=base,n=2;
  while(used.has(name.toLowerCase())){const suffix=` (${n++})`;name=base.slice(0,31-suffix.length)+suffix;}
  used.add(name.toLowerCase());return name;
 });
}
function sheetXml(sheet:WorkbookSheet){
 if(!Array.isArray(sheet.columns)||new Set(sheet.columns).size!==sheet.columns.length||sheet.columns.some(c=>typeof c!=='string'||!c.trim())||!Array.isArray(sheet.rows))throw new Error('Excel列或行数据无效');
 const partCount=new Map<string,number>();
 for(const column of sheet.columns){let count=1;for(const row of sheet.rows){const value=row[column];if(typeof value==='string')count=Math.max(count,Math.ceil(value.length/MAX_CELL));}partCount.set(column,count);}
 const columns=sheet.columns.flatMap(column=>Array.from({length:partCount.get(column)!},(_,i)=>i===0?column:`${column}（续${i+1}）`));
 const rows=[columns,...sheet.rows.map(row=>sheet.columns.flatMap(column=>{
  const value=row[column];if(typeof value==='string')return Array.from({length:partCount.get(column)!},(_,i)=>value.slice(i*MAX_CELL,(i+1)*MAX_CELL));
  return Array.from({length:partCount.get(column)!},(_,i)=>i===0?value??'':'');
 }))];
 if(rows.length>1_048_576||columns.length>16_384)throw new Error('Excel工作表超过行列上限');
 const widths=sheet.columns.flatMap(column=>Array.from({length:partCount.get(column)!},()=>sheet.columnWidths?.[column]??24));
 const cols=widths.map((width,index)=>`<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`).join('');
 const links:{ref:string;id:string;target:string}[]=[];
 const data=rows.map((row,r)=>`<row r="${r+1}" ht="${r===0?30:sheet.rowHeight??90}" customHeight="1">${row.map((value,c)=>{
  const ref=`${columnName(c)}${r+1}`;
  const linked=hyperlink(value);
  if(linked){if(!/^(file|https?):\/\//i.test(value.target))throw new Error('Excel附件链接无效');links.push({ref,id:`link${links.length+1}`,target:value.target});}
  const style=r===0?2:linked?3:1;
  if(formula(value)){
   const expression=typeof value.formula==='string'?value.formula.replace(/^=/,''):'';
   if(!expression.trim()||expression.length>8192||/[\x00-\x1f\[\]]/.test(expression)||expression.includes('#REF!')||(value.cached_value!==null&&(typeof value.cached_value!=='number'||!Number.isFinite(value.cached_value))))throw new Error('Excel公式或缓存值无效');
   return `<c r="${ref}" s="${style}"><f>${xml(expression)}</f>${value.cached_value===null?'':`<v>${value.cached_value}</v>`}</c>`;
  }
  if(typeof value==='number'&&Number.isFinite(value))return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  if(typeof value==='boolean')return `<c r="${ref}" s="${style}" t="b"><v>${value?1:0}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(linked?value.text:String(value??''))}</t></is></c>`;
 }).join('')}</row>`).join('');
 const linkXml=links.length?`<hyperlinks>${links.map(link=>`<hyperlink ref="${link.ref}" r:id="${link.id}"/>`).join('')}</hyperlinks>`:'';
 return {xml:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cols>${cols}</cols><sheetData>${data}</sheetData>${linkXml}</worksheet>`,relationships:links.length?`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map(link=>`<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.target)}" TargetMode="External"/>`).join('')}</Relationships>`:null};
}
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function zip(files:{name:string;data:string}[]){
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const file of files){const name=Buffer.from(file.name),raw=Buffer.from(file.data,'utf8'),compressed=deflateRawSync(raw),crc=crc32(raw);
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(name.length,26);
  const entry=Buffer.concat([header,name,compressed]);local.push(entry);
  const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(8,10);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(raw.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);central.push(Buffer.concat([directory,name]));offset+=entry.length;
 }
 const centralBytes=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,centralBytes,end]);
}
export function buildXlsx(sheets:WorkbookSheet[]):Uint8Array{
 if(!Array.isArray(sheets)||!sheets.length||sheets.length>200)throw new Error('Excel工作表数量无效');
 const names=uniqueSheetNames(sheets);
 const hasFormulas=sheets.some(sheet=>sheet.rows.some(row=>Object.values(row).some(formula)));
 if(hasFormulas&&(sheets.some((sheet,i)=>sheet.name!==names[i])||sheets.some(sheet=>sheet.rows.some(row=>Object.values(row).some(v=>typeof v==='string'&&v.length>MAX_CELL)))))throw new Error('含公式工作簿不能自动重命名工作表或拆列，以免改变引用');
 const contentTypes=`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
 const workbook=`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name,i)=>`<sheet name="${xml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets><calcPr calcId="0" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
 const relationships=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
 const styles=`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
 return zip([{name:'[Content_Types].xml',data:contentTypes},{name:'_rels/.rels',data:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},{name:'xl/workbook.xml',data:workbook},{name:'xl/_rels/workbook.xml.rels',data:relationships},{name:'xl/styles.xml',data:styles},...sheets.flatMap((sheet,i)=>{const rendered=sheetXml(sheet);return [{name:`xl/worksheets/sheet${i+1}.xml`,data:rendered.xml},...(rendered.relationships?[{name:`xl/worksheets/_rels/sheet${i+1}.xml.rels`,data:rendered.relationships}]:[])];})]);
}
export async function writeXlsx(path:string,sheets:WorkbookSheet[]){const bytes=buildXlsx(sheets);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});return bytes;}
