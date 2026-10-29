/** 职责：提取文档的稳定结构与文字投影；由提取、脱敏、CLI和交付共用，不调用外部工具。 */
export interface DocumentCell { text: string; rowSpan?: number; columnSpan?: number }
export interface DocumentRow { cells: DocumentCell[] }
export const DOCUMENT_STRUCTURE_VERSION = 'document-structure-v1';
export type DocumentBlock =
 | { id: string; kind: 'heading' | 'paragraph' | 'footnote' | 'caption' | 'formula' | 'code'; text: string; level?: number }
 | { id: string; kind: 'list'; items: string[] }
 | { id: string; kind: 'table'; rows: DocumentRow[]; caption?: string; footnotes?: string[] };
export function documentBlocksToText(blocks: DocumentBlock[]) {
 return blocks.map(block => {
  if (block.kind === 'table') return [block.caption, block.rows.map(row => row.cells.map(cell => cell.text).join('\t')).join('\n'), ...(block.footnotes ?? [])].filter((part): part is string => part !== undefined).join('\n');
  if (block.kind === 'list') return block.items.join('\n');
  return block.text;
 }).join('\n');
}

/** 模型共用正文：保留阅读顺序、页码及表格合并关系，不改变用于指纹/脱敏坐标的稳定文字投影。 */
export function documentPagesToModelText(pages:ReadonlyArray<{page:number;blocks?:DocumentBlock[];structure?:DocumentBlock[];text?:string}>):string{
 const escape=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\r?\n/g,'<br>');
 const span=(name:string,value:number|undefined)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>1?` ${name}="${value}"`:'';
 return pages.map(page=>{
  const blocks=page.blocks??page.structure;
  const body=blocks?blocks.map(block=>{
   if(block.kind==='table')return[
    ...(block.caption?[block.caption]:[]),
    '<table>',...block.rows.map(row=>'<tr>'+row.cells.map(cell=>`<td${span('rowspan',cell.rowSpan)}${span('colspan',cell.columnSpan)}>${escape(cell.text)}</td>`).join('')+'</tr>'),'</table>',...(block.footnotes??[]),
   ].join('\n');
   if(block.kind==='list')return block.items.map(item=>`- ${item}`).join('\n');
   if(block.kind==='heading')return `${'#'.repeat(Math.min(6,Math.max(1,block.level??1)))} ${block.text}`;
   return block.text;
  }).join('\n\n'):page.text??'';
  return `【第 ${page.page} 页】\n${body}`;
 }).join('\n\n');
}
