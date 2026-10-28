/**
 * 职责：材料提取发布前及Agent计划编译中共用的确定性垃圾清理与格式还原。
 * 入口：findScanNoiseEdits生成精确编辑；cleanScanNoisePages将编辑应用到结构副本。
 * 工具边界：只使用内存中的结构、文字投影和正则，不调用Agent/OCR、网络、文件或数据库；发布和审计由调用方负责。
 * 设计边界与已知数字保护遗漏见findScanNoiseEdits注释；“保守清理”是职责目标，不代表所有语义或输入均已验证安全。
 */
import {documentBlocksToText,type DocumentBlock} from './document-structure';
import {documentFieldRanges} from './prepared-structure';
import {materialMarkupEdits} from './material-markup';
export interface ScanNoisePage {file_id:string;page:number;blocks:DocumentBlock[]}
export interface ScanNoiseEdit {file_id:string;page:number;start:number;end:number;source_text:string;replacement_text:string}
const placeholder=/\\?\[[ \t]*(?:NO[ _-]+TEXT(?:[ _-]+(?:DETECTED|FOUND)(?:[ _-]+IN[ _-]+IMAGE\.?)?)?|QR[ _-]*CODE|IMAGE|BAR[ _-]*CODE|UNREADABLE|无法识别|无文字)[ \t]*\\?\]/giu;
const date='(?:19|20)\\d{2}(?:[-/.]\\d{1,2}[-/.]\\d{1,2}|年\\d{1,2}月\\d{1,2}日)';
const time='(?:[01]?\\d|2[0-3])[:：][0-5]\\d(?:[:：][0-5]\\d)?(?:\\.\\d{1,3})?';
const watermark=new RegExp(`(?<![\\p{L}\\p{N}])(?:\\d{3,10}(?:\\\\?[_＿]|[ \\t.])+|(?:扫描时间|扫描日期|打印时间)[ \\t]*[:：]?[ \\t]*)${date}[ Tt]+${time}(?!\\d)`,'gu');
const numberLine=/^(?:[0-9０-９]+|[-－—][ \t]*[0-9０-９]+[ \t]*[-－—])$/u;
interface NoiseRange {start:number;end:number}
function noiseRanges(text:string):NoiseRange[]{
 const ranges:NoiseRange[]=[];
 for(const pattern of [placeholder,watermark])for(const match of text.matchAll(pattern))ranges.push({start:match.index,end:match.index+match[0].length});
 for(const line of text.matchAll(/[^\r\n]+/g)){
  const visible=line[0].replace(placeholder,'').replace(watermark,'').trim();
  // 编号和条码标记独占同一字段行，才将二者认定为同一个扫描对象。
  if(/^\s*\d+[ \t]+\\?\[[ \t]*BAR[ _-]*CODE[ \t]*\\?\]\s*$/iu.test(line[0])||visible==='无法识别')ranges.push({start:line.index,end:line.index+line[0].length});
 }
 return ranges;
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
/**
 * 共用规则入口：在冻结来源上识别确定扫描噪声，返回原页UTF-16坐标、原文和替换文本；本函数不修改pages。
 *
 * 调用关系（复用规则，不共用整条业务流程）：
 * - 新材料库提取/桌面结果导入：storeExtractedDocument -> cleanScanNoisePages -> 本函数。
 *   调用方发布清理后的提取正文；发生改动时另存原始OCR及cleanup编辑审计，不修改上传原件。
 * - Agent完成后：prepareAgentLibraryMaterials -> compileAgentMaterialPlan -> 本函数。
 *   编译器把这里的编辑合并进Agent计划，重算分册范围，再检查原文定位、重叠、结构和覆盖，之后才允许发布。
 *   Agent工作区的validate-plan.mjs也调用同一编译器；本地工具通过不替代宿主在Agent返回后的再次校验。
 *
 * 与Agent语义清理的分工：
 * - Agent根据正文/位置判断scan_watermark、corner_stamp、ocr_placeholder等片段；不确定的噪声应保留。
 * - 本函数补清理已知占位符、扫描时间戳、具有扫描/跨页证据的角码，以及正文中的百分比/下划线/星号转义；代码和公式不执行格式还原。
 *   不尝试用正则穷举所有乱码、页眉页脚或替Agent判断任意正文；不能为省事泛删数字、日期或符号。
 * - 后续结构/覆盖校验针对编辑后的正文，只证明编辑与结构自洽，不能证明被删片段在业务上确实无意义，
 *   也不会恢复Agent已决定删除的内容；语义判断与机械校验不是互相替代的两次审查。
 *
 * 输入/输出与保护范围：
 * - file_id/page隔离各来源；固定噪声按documentFieldRanges逐字段匹配，不拼接相邻表格单元格或列表项。
 * - 表格/列表不参与独立页角数字推断；普通数字默认保留，扫描签名/角码使用下方各自证据条件。
 * - sensitiveEdits是已有编辑的原页坐标，不是全部业务值清单；add仅对重叠的纯数字候选做避让。
 *   Agent通常不会编辑应保留的金额，因此“未命中sensitiveEdits”不等于数字可安全删除。
 * - 返回编辑包含删除和确定格式替换；调用方须沿同一来源应用/校验，不能当作已发布正文或零误删证明。
 */
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
   for(const range of noiseRanges(text))addProjection(entry,field.start+range.start,field.start+range.end);
   for(const edit of materialMarkupEdits(text,{preserveEscapes:entry.block.kind==='code'||entry.block.kind==='formula'}))edits.push({...edit,file_id:entry.file_id,page:entry.page,start:entry.start+field.start+edit.start,end:entry.start+field.start+edit.end});
   // 代码和公式里的反斜杠有语法意义，不按正文格式残留还原。
   if(entry.block.kind==='code'||entry.block.kind==='formula')continue;
   for(const match of text.matchAll(/\$([+-]?\d+(?:\.\d+)?)\\%\$/g))edits.push({file_id:entry.file_id,page:entry.page,start:entry.start+field.start+match.index!,end:entry.start+field.start+match.index!+match[0].length,source_text:match[0],replacement_text:match[1]+'%'});
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
 // 已知待核修复点：此分支未检查前一结构块的业务标签。
 // 静态触发场景：同文件两页有8836_日期时间扫描签名，某页最后两块为“付款金额”“8836”；
 // 最后一块既是业务金额，又等于scannerIds，仍会进入add删除。示例号码可替换，不是固定黑名单。
 // 这是确定规则的上下文保护遗漏，与允许Agent语义判断垃圾是两件事；目前未以运行回归或真实误删记录确认。
 // 修复时应验证业务标签/值与扫描证据冲突的边界，不能通过禁止全部角码清理或删除Agent三种kind来处理。
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
/**
 * 将共用规则应用到结构副本，返回{edits,pages}；保留页/块和表格形状，不写入原件或发布结果。
 * 提取发布前使用本适配器；Agent编译器直接取findScanNoiseEdits的编辑合并计划，避免另改正文导致坐标失配。
 * 本函数不调用Agent，也不做敏感信息或业务语义验收；提取原始OCR/编辑审计由storeExtractedDocument保存。
 */
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
