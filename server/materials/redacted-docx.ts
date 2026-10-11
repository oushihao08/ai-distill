/**
 * 职责：将数据库中的当前脱敏 Markdown 转为标准 DOCX 文档结构。
 * 主要入口：`buildRedactedDocx()` 异步生成包含标题、段落、分页和表格的 DOCX 字节。
 * 使用场景：由手动脱敏 DOCX 导出流程调用；不读取原件或修改数据库。
 */
import {Document,HeadingLevel,Packer,Paragraph,Table,TableCell,TableRow,TextRun,WidthType} from 'docx';

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

/** Convert the already-redacted database text; no original source is opened here. */
export async function buildRedactedDocx(markdown:string):Promise<Uint8Array>{
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
