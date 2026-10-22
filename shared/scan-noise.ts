/** 职责：从同源多页结构识别可证明的扫描时间戳、扫描号与连续页角码，返回精确删除范围；不修改原文或判定业务事实。 */
import {documentBlocksToText,type DocumentBlock} from './document-structure';
export interface ScanNoisePage {file_id:string;page:number;blocks:DocumentBlock[]}
export interface ScanNoiseEdit {file_id:string;page:number;start:number;end:number;source_text:string;replacement_text:''}
/** 至少两页重复扫描签名才确认捕获日期；页角码需同文件至少三页存在同一页序偏移，表格/列表/正文数字不参与。 */
export function findScanNoiseEdits(pages:ScanNoisePage[]):ScanNoiseEdit[]{
 const entries=pages.flatMap(page=>{let cursor=0;return page.blocks.map((block,index)=>{
  const value=documentBlocksToText([block]),start=cursor;cursor+=value.length+1;
  return {...page,block,index,text:block.kind==='table'||block.kind==='list'?'':block.text,start};
 });});
 const stampPattern=/(?<![\p{L}\p{N}])(\d{4,9})(?:\\?[_＿]|[ \t])*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?![\p{L}\p{N}])/gu;
 const candidates=entries.flatMap(entry=>[...entry.text.matchAll(stampPattern)].filter(match=>!entry.text.slice(0,match.index).replace(/[\d\s/\\_.:!\-]/g,'')).map(match=>({entry,match})));
 const groups=new Map<string,{markedPages:Set<number>}>();
 for(const {entry,match} of candidates){const key=`${entry.file_id}:${match[2]}`,group=groups.get(key)??{markedPages:new Set<number>()};if(/[_＿]/.test(match[0]))group.markedPages.add(entry.page);groups.set(key,group);}
 const stamps=candidates.filter(({entry,match})=>{const group=groups.get(`${entry.file_id}:${match[2]}`)!;return group.markedPages.size>=2;});
 const scannerIds=new Map<string,Set<string>>();
 for(const {entry,match} of stamps){const ids=scannerIds.get(entry.file_id)??new Set<string>();ids.add(match[1]!);scannerIds.set(entry.file_id,ids);}
 const edits:ScanNoiseEdit[]=[];
 const add=(entry:typeof entries[number],a=0,b=entry.text.length)=>{if(b>a&&!edits.some(edit=>edit.file_id===entry.file_id&&edit.page===entry.page&&edit.start===entry.start+a&&edit.end===entry.start+b))edits.push({file_id:entry.file_id,page:entry.page,start:entry.start+a,end:entry.start+b,source_text:entry.text.slice(a,b),replacement_text:''});};
 for(const {entry,match} of stamps)add(entry,match.index!,match.index!+match[0].length);
 const numeric=(text:string)=>/^\d{1,3}[!Il]?$/.test(text.trim())?Number(text.trim().replace(/[!Il]$/,'1')):null;
 const margins=entries.filter(entry=>{
  if(!entry.text.trim()||!scannerIds.has(entry.file_id))return false;
  const before=entry.blocks.slice(0,entry.index),after=entry.blocks.slice(entry.index+1);
  const numericOrEmpty=(blocks:DocumentBlock[])=>blocks.every(block=>{const text=documentBlocksToText([block]);return !text.trim()||block.kind!=='table'&&block.kind!=='list'&&(numeric(text)!==null||scannerIds.get(entry.file_id)?.has(text.trim()));});
  return numericOrEmpty(after)||/^0\d{2}$/.test(entry.text.trim())&&numericOrEmpty(before);
 });
 const sequences=new Map<string,Set<number>>();
 for(const entry of margins){const value=numeric(entry.text);if(value===null||Math.abs(value-entry.page)>5)continue;const key=`${entry.file_id}:${value-entry.page}`,set=sequences.get(key)??new Set<number>();set.add(entry.page);sequences.set(key,set);}
 for(const entry of margins){const value=numeric(entry.text);if(scannerIds.get(entry.file_id)?.has(entry.text.trim())||value!==null&&(sequences.get(`${entry.file_id}:${value-entry.page}`)?.size??0)>=3)add(entry);}
 // 已确认扫描签名之后的短页角串，例如“00! / 1”；业务段落或表格会中断该尾部簇。
 for(const page of pages){const local=entries.filter(entry=>entry.file_id===page.file_id&&entry.page===page.page);let suffix=false;
  for(const entry of local){const isStamp=stamps.some(stamp=>stamp.entry===entry);if(isStamp){suffix=true;continue;}
   if(!entry.text.trim()&&entry.block.kind!=='table'&&entry.block.kind!=='list')continue;
   if(suffix&&numeric(entry.text)!==null&&entry.text.trim().length<=3){add(entry);continue;}
   suffix=false;
  }
 }
 return edits.sort((a,b)=>a.file_id.localeCompare(b.file_id)||a.page-b.page||a.start-b.start);
}
/** 显式清理预览副本；正式新脱敏由编译器将同一删除范围纳入原文计划和完整覆盖校验。 */
export function cleanScanNoisePages(pages:ScanNoisePage[]){
 const edits=findScanNoiseEdits(pages);
 return {edits,pages:pages.map(page=>{
  let cursor=0;const blocks=page.blocks.map(block=>{const value=documentBlocksToText([block]),start=cursor;cursor+=value.length+1;if(block.kind==='table'||block.kind==='list')return structuredClone(block);
   let text=block.text;for(const edit of edits.filter(edit=>edit.file_id===page.file_id&&edit.page===page.page&&edit.start>=start&&edit.end<=start+value.length).sort((a,b)=>b.start-a.start))text=text.slice(0,edit.start-start)+text.slice(edit.end-start);
   return {...block,text};});
  return {...page,blocks};
 })};
}
