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
