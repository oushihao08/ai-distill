/**
 * 职责：将调用方已核验的文字/结构渲染为DOCX；兼容名称保留，来源可为脱敏或明确选择的原文。
 * 主要入口：`buildRedactedDocx()` 异步生成包含标题、段落、分页和表格的 DOCX 字节。
 * 使用场景：由材料DOCX导出和项目五件套工具调用；不读取原件或修改数据库。
 */
import {Document,HeadingLevel,Packer,Paragraph,Table,TableCell,TableRow,TextRun,WidthType} from 'docx';
import type {DocumentBlock} from './pdf';

export interface RedactedDocumentStructure {format:'redacted-structure-v1';pages:{page:number;blocks:DocumentBlock[];issues?:string[]}[]}
export const REDACTED_DOCX_RENDERER_VERSION='redacted-structure-docx-v1';

function tableCells(line:string){return line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());}
function isTableSeparator(line:string){return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);}
const inlineMarkup=/(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)|(?<!_)__(?!_)(.+?)(?<!_)__(?!_)|`([^`]+)`/g;
function textRuns(value:string,forceBold=false){
 const runs:TextRun[]=[];let cursor=0;
 for(const match of value.matchAll(inlineMarkup)){
  const token=match[0],start=match.index??0;if(start>cursor)runs.push(new TextRun({text:value.slice(cursor,start),...(forceBold?{bold:true}:{})}));
  if(match[1]!==undefined||match[2]!==undefined)runs.push(new TextRun({text:match[1]??match[2]!,bold:true}));
  else runs.push(new TextRun({text:match[3]!,font:'Consolas'}));
  cursor=start+token.length;
 }
 if(cursor<value.length)runs.push(new TextRun({text:value.slice(cursor),...(forceBold?{bold:true}:{})}));
 if(!runs.length)runs.push(new TextRun({text:'',...(forceBold?{bold:true}:{})}));
 return runs;
}
function asTable(lines:string[]){
 const rows=lines.filter(line=>!isTableSeparator(line)).map(tableCells),columnCount=Math.max(...rows.map(row=>row.length));
 return new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:rows.map((row,rowIndex)=>new TableRow({children:Array.from({length:columnCount},(_,columnIndex)=>new TableCell({children:[new Paragraph({children:textRuns(row[columnIndex]??'',rowIndex===0)})]}))}))});
}

function plainRuns(value:string){return value?[new TextRun({text:value})]:[new TextRun({text:''})];}
function structuredTable(block:Extract<DocumentBlock,{kind:'table'}>){
 const rows=block.rows.map(row=>new TableRow({children:row.cells.map(cell=>new TableCell({
  ...(cell.rowSpan?{rowSpan:cell.rowSpan}:{}),...(cell.columnSpan?{columnSpan:cell.columnSpan}:{}),
  children:[new Paragraph({children:plainRuns(cell.text)})],
 }))}));
 return new Table({width:{size:100,type:WidthType.PERCENTAGE},rows});
}
function structuredPageChildren(blocks:DocumentBlock[]):(Paragraph|Table)[]{
 const children:(Paragraph|Table)[]=[];
 for(const block of blocks){
  if(block.kind==='table'){
   if(block.caption!==undefined)children.push(new Paragraph({children:plainRuns(block.caption),style:'Caption'}));
   children.push(structuredTable(block));
   for(const footnote of block.footnotes??[])children.push(new Paragraph({children:plainRuns(footnote),style:'Caption'}));
  }else if(block.kind==='list'){
   for(const item of block.items)children.push(new Paragraph({children:plainRuns(item),bullet:{level:0},spacing:{after:100}}));
  }else if(block.kind==='heading'){
   const level=Math.max(1,Math.min(3,Number.isSafeInteger(block.level)?block.level!:1));
   const heading=level===1?HeadingLevel.HEADING_1:level===2?HeadingLevel.HEADING_2:HeadingLevel.HEADING_3;
   children.push(new Paragraph({children:plainRuns(block.text),heading}));
  }else{
   children.push(new Paragraph({children:plainRuns(block.text),...(block.kind==='footnote'?{style:'Caption'}:{})}));
  }
 }
 return children;
}

/** Render supplied text/structure only; caller owns source-mode verification, this function never opens original material. */
export async function buildRedactedDocx(source:string|RedactedDocumentStructure):Promise<Uint8Array>{
 if(typeof source==='string')return buildMarkdownRedactedDocx(source);
 if(!source||source.format!=='redacted-structure-v1'||!Array.isArray(source.pages)||!source.pages.length||source.pages.some(page=>!Number.isSafeInteger(page.page)||!Array.isArray(page.blocks)))throw new Error('脱敏文档结构无效');
 const children:(Paragraph|Table)[]=[];
 for(const [index,page] of source.pages.entries()){
  if(index)children.push(new Paragraph({text:'',pageBreakBefore:true}));
  children.push(...structuredPageChildren(page.blocks));
 }
 const document=new Document({creator:'',lastModifiedBy:'',revision:0,sections:[{properties:{page:{margin:{top:1134,right:1134,bottom:1134,left:1134}}},children}]});
 return new Uint8Array(await Packer.toBuffer(document));
}

async function buildMarkdownRedactedDocx(markdown:string):Promise<Uint8Array>{
 if(typeof markdown!=='string'||!markdown.trim())throw new Error('脱敏文本为空');
 const lines=markdown.replace(/\r\n?/g,'\n').split('\n'),children:(Paragraph|Table)[]=[];let seenPage=false,pendingPageBreak=false;
 for(let index=0;index<lines.length;){
  const line=lines[index]!.trim();if(!line){index++;continue;}
  if(/^【附件\s+\d+(?:\s+结束)?】$/.test(line)){index++;continue;}
  if(/^【原附件第\s+\d+\s+页】$/.test(line)){if(seenPage)pendingPageBreak=true;seenPage=true;index++;continue;}
  if(line.startsWith('|')){const rows=[line];index++;while(index<lines.length&&lines[index]!.trim().startsWith('|'))rows.push(lines[index++]!.trim());if(pendingPageBreak){children.push(new Paragraph({text:'',pageBreakBefore:true}));pendingPageBreak=false;}children.push(asTable(rows));continue;}
  const heading=/^(#{1,3})\s+(.+)$/.exec(line);if(heading){const level=heading[1]!.length,headingLevel=level===1?HeadingLevel.HEADING_1:level===2?HeadingLevel.HEADING_2:HeadingLevel.HEADING_3;children.push(new Paragraph({children:textRuns(heading[2]!),heading:headingLevel,...(pendingPageBreak?{pageBreakBefore:true}:{})}));pendingPageBreak=false;index++;continue;}
  const block=[line];index++;
  while(index<lines.length&&lines[index]!.trim()&&!/^【(?:附件\s+\d+(?:\s+结束)?|原附件第\s+\d+\s+页)】$/.test(lines[index]!.trim())&&!lines[index]!.trim().startsWith('|')&&!/^#{1,3}\s+/.test(lines[index]!.trim()))block.push(lines[index++]!.trim());
  children.push(new Paragraph({children:textRuns(block.join(' ')),...(pendingPageBreak?{pageBreakBefore:true}:{})}));pendingPageBreak=false;
 }
 const document=new Document({creator:'',lastModifiedBy:'',revision:0,sections:[{properties:{page:{margin:{top:1134,right:1134,bottom:1134,left:1134}}},children}]});
 return new Uint8Array(await Packer.toBuffer(document));
}
