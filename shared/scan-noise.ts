/** 职责：提供提取入库前与脱敏后的保守扫描清理及格式还原，输出精确编辑；不改原件，不按普通数字或业务关键词泛删。 */
import {documentBlocksToText,type DocumentBlock} from './document-structure';
import {documentFieldRanges} from './prepared-structure';
export interface ScanNoisePage {file_id:string;page:number;blocks:DocumentBlock[]}
export interface ScanNoiseEdit {file_id:string;page:number;start:number;end:number;source_text:string;replacement_text:string}
const placeholder=/\\?\[[ \t]*(?:NO[ _-]+TEXT(?:[ _-]+(?:DETECTED|FOUND)(?:[ _-]+IN[ _-]+IMAGE\.?)?)?|QR[ _-]*CODE|IMAGE|BAR[ _-]*CODE|UNREADABLE|无法识别|无文字)[ \t]*\\?\]/giu;
const date='(?:19|20)\\d{2}(?:[-/.]\\d{1,2}[-/.]\\d{1,2}|年\\d{1,2}月\\d{1,2}日)';
const time='(?:[01]?\\d|2[0-3])[:：][0-5]\\d(?:[:：][0-5]\\d)?(?:\\.\\d{1,3})?';
const watermark=new RegExp(`(?<![\\p{L}\\p{N}])(?:\\d{3,10}(?:\\\\?[_＿]|[ \\t.])+|(?:扫描时间|扫描日期|打印时间)[ \\t]*[:：]?[ \\t]*)${date}[ Tt]+${time}(?!\\d)`,'gu');
const numberLine=/^(?:[0-9０-９]+|[-－—][ \t]*[0-9０-９]+[ \t]*[-－—])$/u;
const valueLabel=/(?:金额|价款|本金|利息|余额|单价|数量|数额|总额|合计|总计|编号|案号|证件号|账号|电话)[：:\s]*$/u;
interface NoiseRange {start:number;end:number;kind:'fixed'|'number_line'}
function noiseRanges(text:string,removeStandaloneNumbers:boolean):NoiseRange[]{
 const ranges:NoiseRange[]=[];
 for(const pattern of [placeholder,watermark])for(const match of text.matchAll(pattern))ranges.push({start:match.index,end:match.index+match[0].length,kind:'fixed'});
 let previous='';
 for(const line of text.matchAll(/[^\r\n]+/g)){
  const visible=line[0].replace(placeholder,'').replace(watermark,'').trim();
  // 编号和条码标记独占同一字段行，才将二者认定为同一个扫描对象。
  if(/^\s*\d+[ \t]+\\?\[[ \t]*BAR[ _-]*CODE[ \t]*\\?\]\s*$/iu.test(line[0]))ranges.push({start:line.index,end:line.index+line[0].length,kind:'fixed'});
  if(visible==='无法识别'||removeStandaloneNumbers&&numberLine.test(visible)&&!valueLabel.test(previous))ranges.push({start:line.index,end:line.index+line[0].length,kind:visible==='无法识别'?'fixed':'number_line'});
  if(visible)previous=visible;
 }
 return ranges;
}
/** AI返回后调用的纯文本清理：默认只删除固定噪声并保留换行/数字。removeStandaloneNumbers仅用于显式已确认数字为噪声的旧调用。 */
export function cleanRedactionText(text:string,options:{removeStandaloneNumbers?:boolean}={}){
 const ranges=noiseRanges(text,options.removeStandaloneNumbers??false).sort((a,b)=>a.start-b.start||b.end-a.end),merged:{start:number;end:number}[]=[];
 for(const range of ranges){const prior=merged.at(-1);if(prior&&range.start<=prior.end)prior.end=Math.max(prior.end,range.end);else merged.push({...range});}
 for(const range of merged.reverse())text=text.slice(0,range.start)+text.slice(range.end);
 return text;
}
function blockFields(block:DocumentBlock){
 if(block.kind==='table'){
  const fields:{text:string;set:(value:string)=>void}[]=[];
  if(block.caption!==undefined)fields.push({text:block.caption,set:value=>{block.caption=value;}});
  for(const row of block.rows)for(const cell of row.cells)fields.push({text:cell.text,set:value=>{cell.text=value;}});
  for(let i=0;i<(block.footnotes?.length??0);i++)fields.push({text:block.footnotes![i]!,set:value=>{block.footnotes![i]=value;}});
  return fields;
 }
 if(block.kind==='list')return block.items.map((text,index)=>({text,set:(value:string)=>{block.items[index]=value;}}));
 return [{text:block.text,set:(value:string)=>{block.text=value;}}];
}
/** 先应用固定垃圾正则；其余扫描签名/页角串再按跨页证据补充。表格/列表数值及已脱敏编号不按独立数字删除。 */
export function findScanNoiseEdits(pages:ScanNoisePage[],sensitiveEdits:Pick<ScanNoiseEdit,'file_id'|'page'|'start'|'end'>[]=[]):ScanNoiseEdit[]{
 const entries=pages.flatMap(page=>{let cursor=0;return page.blocks.map((block,index)=>{
  const value=documentBlocksToText([block]),start=cursor;cursor+=value.length+1;
  return {...page,block,index,projection:value,text:block.kind==='table'||block.kind==='list'?'':block.text,start};
 });});
 const stampPattern=/(?<![\p{L}\p{N}])(\d{4,9})(?:\\?[_＿]|[ \t])*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?![\p{L}\p{N}])/gu;
 const candidates=entries.flatMap(entry=>[...entry.text.matchAll(stampPattern)].filter(match=>!entry.text.slice(0,match.index).replace(/[\d\s/\\_.:!\-]/g,'')).map(match=>({entry,match})));
 const groups=new Map<string,{markedPages:Set<number>}>();
 for(const {entry,match} of candidates){const key=`${entry.file_id}:${match[2]}`,group=groups.get(key)??{markedPages:new Set<number>()};if(/[_＿]/.test(match[0]))group.markedPages.add(entry.page);groups.set(key,group);}
 const stamps=candidates.filter(({entry,match})=>{const group=groups.get(`${entry.file_id}:${match[2]}`)!;return group.markedPages.size>=2;});
 const scannerIds=new Map<string,Set<string>>();
 for(const {entry,match} of stamps){const ids=scannerIds.get(entry.file_id)??new Set<string>();ids.add(match[1]!);scannerIds.set(entry.file_id,ids);}
 const edits:ScanNoiseEdit[]=[];
 const add=(entry:typeof entries[number],a=0,b=entry.text.length)=>{if(numberLine.test(entry.text.trim())&&sensitiveEdits.some(edit=>edit.file_id===entry.file_id&&edit.page===entry.page&&edit.start<entry.start+b&&edit.end>entry.start+a))return;if(b>a&&!edits.some(edit=>edit.file_id===entry.file_id&&edit.page===entry.page&&edit.start===entry.start+a&&edit.end===entry.start+b))edits.push({file_id:entry.file_id,page:entry.page,start:entry.start+a,end:entry.start+b,source_text:entry.text.slice(a,b),replacement_text:''});};
 const addProjection=(entry:typeof entries[number],a:number,b:number)=>{if(b>a&&!edits.some(edit=>edit.file_id===entry.file_id&&edit.page===entry.page&&edit.start===entry.start+a&&edit.end===entry.start+b))edits.push({file_id:entry.file_id,page:entry.page,start:entry.start+a,end:entry.start+b,source_text:entry.projection.slice(a,b),replacement_text:''});};
 // AI返回后仅清理固定占位符与时间戳；普通数字保留，页角数字由下方跨页证据判断。
 for(const entry of entries){
  // 固定噪声只在单个结构字段内匹配，不能拼接相邻单元格/列表项的业务值。
  for(const field of documentFieldRanges([entry.block])){
   const text=entry.projection.slice(field.start,field.end);
   for(const range of noiseRanges(text,false))addProjection(entry,field.start+range.start,field.start+range.end);
   for(const match of text.matchAll(/\$([+-]?\d+(?:\.\d+)?)\\%\$/g))edits.push({file_id:entry.file_id,page:entry.page,start:entry.start+field.start+match.index!,end:entry.start+field.start+match.index!+match[0].length,source_text:match[0],replacement_text:match[1]+'%'});
   for(const match of text.matchAll(/\\_/g))edits.push({file_id:entry.file_id,page:entry.page,start:entry.start+field.start+match.index!,end:entry.start+field.start+match.index!+match[0].length,source_text:match[0],replacement_text:'_'});
  }
 }
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
 // C类角码仅在页边界且已有同文件重复扫描签名证据时清理，正文/表格里的同形业务值保留。
 for(const entry of entries)if(scannerIds.has(entry.file_id)&&(entry.index===0||entry.index===entry.blocks.length-1)&&/^(?:C{1,2}[. ]?\d+|\[[ \t]*C[ \t]*\]\d+)$/i.test(entry.text.trim()))add(entry);
 // 已确认扫描签名之后的短页角串，例如“00! / 1”；业务段落或表格会中断该尾部簇。
 for(const page of pages){const local=entries.filter(entry=>entry.file_id===page.file_id&&entry.page===page.page);let suffix=false;
  for(const entry of local){const isStamp=stamps.some(stamp=>stamp.entry===entry);if(isStamp){suffix=true;continue;}
   if(!entry.text.trim()&&entry.block.kind!=='table'&&entry.block.kind!=='list')continue;
   if(suffix&&numeric(entry.text)!==null&&entry.text.trim().length<=3){add(entry);continue;}
   suffix=false;
  }
 }
 const merged:ScanNoiseEdit[]=[];
 for(const edit of edits.sort((a,b)=>a.file_id.localeCompare(b.file_id)||a.page-b.page||a.start-b.start||b.end-a.end)){
  const prior=merged.at(-1);
  if(prior&&prior.file_id===edit.file_id&&prior.page===edit.page&&edit.start<=prior.end&&prior.replacement_text===''&&edit.replacement_text===''){
   prior.end=Math.max(prior.end,edit.end);const page=pages.find(page=>page.file_id===edit.file_id&&page.page===edit.page)!;prior.source_text=documentBlocksToText(page.blocks).slice(prior.start,prior.end);
  }else if(prior&&prior.file_id===edit.file_id&&prior.page===edit.page&&edit.start<prior.end){
   // 已覆盖的格式片段无需重复编辑；其他冲突不扩大既有范围，忽略后项。
   continue;
  }else merged.push({...edit});
 }
 return merged;
}
/** 返回结构化清理副本供API脱敏返回后及预览使用；Agent编译器将同一规则纳入原文计划及完整覆盖校验。 */
export function cleanScanNoisePages(pages:ScanNoisePage[]){
 const edits=findScanNoiseEdits(pages);
 return {edits,pages:pages.map(page=>{
  const blocks=structuredClone(page.blocks);let blockStart=0;
  for(let blockIndex=0;blockIndex<blocks.length;blockIndex++){
   const block=blocks[blockIndex]!,sourceBlock=page.blocks[blockIndex]!;
   const projection=documentBlocksToText([sourceBlock]),ranges=documentFieldRanges([sourceBlock]).map(range=>({...range,start:range.start+blockStart,end:range.end+blockStart}));
   blockStart+=projection.length+(blockIndex<blocks.length-1?1:0);
   const fields=blockFields(block);
   for(let fieldIndex=0;fieldIndex<fields.length;fieldIndex++){
    const range=ranges.find(item=>item.block_id===block.id&&item.field_index===fieldIndex);if(!range)continue;
    let text=fields[fieldIndex]!.text;
    for(const edit of edits.filter(item=>item.file_id===page.file_id&&item.page===page.page&&item.start>=range.start&&item.end<=range.end).sort((a,b)=>b.start-a.start))text=text.slice(0,edit.start-range.start)+edit.replacement_text+text.slice(edit.end-range.start);
    fields[fieldIndex]!.set(text);
   }
  }
  return {...page,blocks};
 })};
}
