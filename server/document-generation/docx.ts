/**
 * 职责：项目无关的 DOCX 公共生成器，将调用方已核验的文本/结构渲染为文件字节。
 * 主要入口：`buildDocx()` 异步生成包含标题、段落、分页和表格的 DOCX 字节。
 * 使用场景：由材料DOCX导出和项目五件套工具调用；不读取原件或修改数据库。
 */
import {AlignmentType,TableLayoutType,Document,HeadingLevel,Packer,Paragraph,Table,TableCell,TableRow,TextRun,WidthType} from 'docx';
import {planTableLayout} from './table-layout';
import {materialMathRuns} from './material-math-docx';
import type {DocumentBlock} from '../../shared/document-structure';

export interface DocumentStructure {format:'redacted-structure-v1';pages:{page:number;blocks:DocumentBlock[];issues?:string[]}[]}
export type RedactedDocumentStructure=DocumentStructure;
export const DOCX_RENDERER_VERSION='redacted-structure-docx-v10';
export const REDACTED_DOCX_RENDERER_VERSION=DOCX_RENDERER_VERSION;

/** 已提取页文本的保真结构：保留换行和制表符列，不推断表头或恢复不存在的合并单元格。 */
export function preparedTextDocument(text:string,id:string):RedactedDocumentStructure{
 const blocks:DocumentBlock[]=[],lines=text.split('\n');
 for(let i=0;i<lines.length;){
  const line=lines[i]!;
  if(line.includes('\t')){
   const rows=[];
   while(i<lines.length&&lines[i]!.includes('\t'))rows.push({cells:lines[i++]!.split('\t').map(text=>({text}))});
   blocks.push({id:`${id}-${i}`,kind:'table',rows});
  }else blocks.push({id:`${id}-${i}`,kind:'paragraph',text:lines[i++]!});
 }
 return{format:'redacted-structure-v1',pages:[{page:1,blocks}]};
}

function tableCells(line:string){return line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());}
function isTableSeparator(line:string){return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);}
const inlineMarkup=/(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)|(?<!_)__(?!_)(.+?)(?<!_)__(?!_)|`([^`]+)`/g;
const controlCharacters=/[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
/** XML 1.0 禁止控制字符；来源文本可能带换页符或 OCR 控制符，渲染前统一剔除。 */
function cleanText(value:string){return value.replace(controlCharacters,'');}
function textRuns(value:string,forceBold=false,materialMath=false){
 value=cleanText(value);
 if(materialMath)return materialMathRuns(value);
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
function asTable(lines:string[],materialMath=false){
 const rows=lines.filter(line=>!isTableSeparator(line)).map(tableCells);
 return structuredTable({id:'markdown-table',kind:'table',rows:rows.map(row=>({cells:row.map(text=>({text}))}))},!materialMath,materialMath);
}

function plainRuns(value:string,materialMath=false){const text=cleanText(value);return materialMath?materialMathRuns(text):[new TextRun({text})];}
function structuredTable(block:Extract<DocumentBlock,{kind:'table'}>,markdown=false,materialMath=false){
 const plan=planTableLayout(block);
 const rows=plan.rows.map((row,rowIndex)=>new TableRow({children:row.cells.map(cell=>new TableCell({
  ...(cell.rowSpan?{rowSpan:cell.rowSpan}:{}),...(cell.columnSpan?{columnSpan:cell.columnSpan}:{}),
  width:{size:plan.columnWidth*(cell.columnSpan??1),type:WidthType.DXA},
  children:[new Paragraph({children:markdown?textRuns(cell.text,rowIndex===0):plainRuns(cell.text,materialMath),spacing:{before:0,after:0,line:240}})],
 }))}));
 return new Table({width:{size:9360,type:WidthType.DXA},layout:TableLayoutType.FIXED,columnWidths:Array(plan.columnCount).fill(plan.columnWidth),rows});
}
/** 扫描件末页的版式提示不适用于连续重排；只隐藏独立提示段，不改来源或句内引用。 */
const isSourcePageNotice=(text:string)=>/^[(（]\s*此页无正文\s*[)）]$/.test(text.trim());

function structuredPageChildren(blocks:DocumentBlock[],materialMath=false):(Paragraph|Table)[]{
 const children:(Paragraph|Table)[]=[];
 for(const block of blocks){
  if(block.kind!=='table'&&block.kind!=='list'&&(!block.text.trim()||isSourcePageNotice(block.text)))continue;
  if(block.kind==='table'){
   if(block.caption!==undefined)children.push(new Paragraph({children:plainRuns(block.caption,materialMath),style:'Caption'}));
   children.push(structuredTable(block,false,materialMath));
   for(const footnote of block.footnotes??[])children.push(new Paragraph({children:plainRuns(footnote,materialMath),style:'Caption'}));
  }else if(block.kind==='list'){
   for(const item of block.items.filter(item=>item.trim()))children.push(new Paragraph({children:plainRuns(item,materialMath),bullet:{level:0},spacing:{after:100}}));
  }else if(block.kind==='heading'){
   const level=Math.max(1,Math.min(3,Number.isSafeInteger(block.level)?block.level!:1));
   const heading=level===1?HeadingLevel.HEADING_1:level===2?HeadingLevel.HEADING_2:HeadingLevel.HEADING_3;
   children.push(new Paragraph({children:plainRuns(block.text,materialMath),heading,keepNext:true}));
  }else{
   children.push(new Paragraph({children:plainRuns(block.text,materialMath),...(block.kind==='footnote'?{style:'Caption'}:{})}));
  }
 }
 return children;
}

/** Render supplied text/structure only; caller owns source-mode verification, this function never opens original material. */
export async function buildDocx(source:string|RedactedDocumentStructure,options:{style?:'legal';pagination?:'flow'|'source';materialMath?:boolean}={}):Promise<Uint8Array>{
 if(typeof source==='string')return buildMarkdownRedactedDocx(source,options);
 if(!source||source.format!=='redacted-structure-v1'||!Array.isArray(source.pages)||!source.pages.length||source.pages.some(page=>!Number.isSafeInteger(page.page)||!Array.isArray(page.blocks)))throw new Error('脱敏文档结构无效');
 const children:(Paragraph|Table)[]=[];
 for(const page of source.pages){
  const content=structuredPageChildren(page.blocks,options.materialMath);
  if(!content.length)continue;
  if(options.pagination==='source'&&children.length)children.push(new Paragraph({text:'',pageBreakBefore:true}));
  children.push(...content);
 }
 if(!children.length)throw new Error('脱敏文本为空');
 const document=new Document({creator:'',lastModifiedBy:'',revision:0,styles:{default:{document:{run:{font:{ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:'宋体'},size:22,color:'000000'},paragraph:{spacing:{line:280,after:80}}}},paragraphStyles:[{id:'Heading1',name:'Heading 1',basedOn:'Normal',next:'Normal',run:{color:'000000',size:28,bold:true},paragraph:{spacing:{before:160,after:120}}},{id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',run:{color:'000000',size:25,bold:true},paragraph:{spacing:{before:120,after:80}}},{id:'Heading3',name:'Heading 3',basedOn:'Normal',next:'Normal',run:{color:'000000',size:23,bold:true},paragraph:{spacing:{before:100,after:80}}}]},sections:[{properties:{page:{margin:{top:1134,right:1134,bottom:1134,left:1134}}},children}]});
 return new Uint8Array(await Packer.toBuffer(document));
}

async function buildMarkdownRedactedDocx(markdown:string,options:{style?:'legal';pagination?:'flow'|'source';materialMath?:boolean}={}):Promise<Uint8Array>{
 if(typeof markdown!=='string'||!markdown.trim())throw new Error('脱敏文本为空');
 const lines=markdown.replace(/\r\n?/g,'\n').split('\n'),children:(Paragraph|Table)[]=[];let seenPage=false,pendingPageBreak=false;
 for(let index=0;index<lines.length;){
  const line=lines[index]!.trim();if(isSourcePageNotice(line)){index++;continue;}if(!line){index++;continue;}
  if(/^【附件\s+\d+(?:\s+结束)?】$/.test(line)){index++;continue;}
  if(/^【原附件第\s+\d+\s+页】$/.test(line)){if(seenPage&&options.pagination==='source')pendingPageBreak=true;seenPage=true;index++;continue;}
  if(line.startsWith('|')){const rows=[line];index++;while(index<lines.length&&lines[index]!.trim().startsWith('|'))rows.push(lines[index++]!.trim());if(pendingPageBreak){children.push(new Paragraph({text:'',pageBreakBefore:true}));pendingPageBreak=false;}children.push(asTable(rows,options.materialMath));continue;}
  const heading=/^(#{1,3})\s+(.+)$/.exec(line);if(heading){const level=heading[1]!.length,headingLevel=level===1?HeadingLevel.HEADING_1:level===2?HeadingLevel.HEADING_2:HeadingLevel.HEADING_3;children.push(new Paragraph({children:textRuns(heading[2]!,false,options.materialMath),heading:headingLevel,...(pendingPageBreak?{pageBreakBefore:true}:{})}));pendingPageBreak=false;index++;continue;}
  const block=[line];index++;
  while(index<lines.length&&lines[index]!.trim()&&!/^【(?:附件\s+\d+(?:\s+结束)?|原附件第\s+\d+\s+页)】$/.test(lines[index]!.trim())&&!isSourcePageNotice(lines[index]!.trim())&&!lines[index]!.trim().startsWith('|')&&!/^#{1,3}\s+/.test(lines[index]!.trim()))block.push(lines[index++]!.trim());
  const paragraphs=options.style==='legal'?block:[block.join(' ')];
  for(const [lineIndex,value] of paragraphs.entries())children.push(new Paragraph({children:textRuns(value,false,options.materialMath),...(options.style==='legal'&&children.length===0&&block.length===1?{style:'Title'}:{}),...(pendingPageBreak&&lineIndex===0?{pageBreakBefore:true}:{})}));pendingPageBreak=false;
 }
 const styles=options.style==='legal'?{
  default:{document:{run:{font:{ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:'宋体',cs:'Times New Roman'},size:24,color:'000000'},paragraph:{spacing:{line:360,after:120}}}},
  paragraphStyles:[
   {id:'Title',name:'Title',basedOn:'Normal',next:'Normal',run:{font:{ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:'黑体'},size:32,bold:true,color:'000000'},paragraph:{alignment:AlignmentType.CENTER,spacing:{before:160,after:240},keepNext:true}},
   {id:'Heading1',name:'Heading 1',basedOn:'Normal',next:'Normal',run:{font:{ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:'黑体'},size:32,bold:true,color:'000000'},paragraph:{alignment:AlignmentType.CENTER,spacing:{before:160,after:240},keepNext:true}},
   {id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',run:{size:28,bold:true,color:'000000'},paragraph:{spacing:{before:180,after:120},keepNext:true}},
   {id:'Heading3',name:'Heading 3',basedOn:'Normal',next:'Normal',run:{size:24,bold:true,color:'000000'},paragraph:{spacing:{before:140,after:100},keepNext:true}},
  ],
 }:undefined;
 const document=new Document({creator:'',lastModifiedBy:'',revision:0,...(styles?{styles}:{}),sections:[{properties:{page:{margin:{top:1134,right:1134,bottom:1134,left:1134}}},children}]});
 return new Uint8Array(await Packer.toBuffer(document));
}
