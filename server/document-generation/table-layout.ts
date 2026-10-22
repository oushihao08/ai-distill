/** 职责：为公共DOCX生成器计算可读表格网格；异常OCR跨度仅在显示副本中展平，保留全部非空单元格文字及顺序，不修改来源。
 * 入口：planTableLayout()由docx.ts调用；不推断字段含义，不恢复无法证明的合并关系。 */
import type {DocumentBlock,DocumentRow} from '../../shared/document-structure';
type TableBlock=Extract<DocumentBlock,{kind:'table'}>;
export function planTableLayout(block:TableBlock){
 const widths=block.rows.map(row=>row.cells.reduce((sum,cell)=>sum+(cell.columnSpan??1),0));
 const columns=Math.max(1,...widths);
 const invalid=columns>24||block.rows.some((row,r)=>row.cells.some(cell=>
  !Number.isSafeInteger(cell.columnSpan??1)||(cell.columnSpan??1)<1||
  !Number.isSafeInteger(cell.rowSpan??1)||(cell.rowSpan??1)<1||(cell.rowSpan??1)>block.rows.length-r));
 let rows:DocumentRow[]=structuredClone(block.rows),columnCount=columns;
 if(invalid){
  // OCR may invent a hundred-column grid containing mostly empty cells. Do not
  // reproduce that geometry or guess headers; preserve each text-bearing row.
  rows=block.rows.map(row=>({cells:row.cells.filter(cell=>cell.text.trim()).map(cell=>({text:cell.text}))})).filter(row=>row.cells.length);
  if(!rows.length)rows=[{cells:[{text:''}]}];
  // Invalid geometry cannot prove column relationships. Display each original
  // text-bearing row across the page instead of inventing a replacement grid.
  rows=rows.map(row=>({cells:[{text:row.cells.map(cell=>cell.text).join('\n')}]}));
  columnCount=1;
 }
 return{rows,columnCount,columnWidth:Math.floor(9360/columnCount),fallback:invalid};
}
