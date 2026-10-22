/** 职责：将精确原页编辑应用于原结构字段，按文书范围切片；遇到跨字段编辑或切断表格明确拒绝，禁止静默压平。 */
import {documentBlocksToText,type DocumentBlock} from './document-structure';
import {prepareMaterialData,type PreparedPage} from './material-preparation';
type StructuredPage=PreparedPage&{structure:DocumentBlock[]};
function fields(block:DocumentBlock){
 const entries:{text:string;set:(value:string)=>void;start:number;end:number}[]=[];let cursor=0;
 const add=(text:string,set:(value:string)=>void,separator:string)=>{cursor+=separator.length;entries.push({text,set,start:cursor,end:cursor+text.length});cursor+=text.length;};
 if(block.kind==='table'){
  if(block.caption!==undefined)add(block.caption,v=>{block.caption=v;},'');
  block.rows.forEach((row,r)=>row.cells.forEach((cell,c)=>add(cell.text,v=>{cell.text=v;},c?'\t':r||block.caption!==undefined?'\n':'')));
  block.footnotes?.forEach((value,i)=>add(value,v=>{block.footnotes![i]=v;},'\n'));
 }else if(block.kind==='list')block.items.forEach((value,i)=>add(value,v=>{block.items[i]=v;},i?'\n':''));
 else add(block.text,v=>{block.text=v;},'');
 return entries;
}
/** 原页文字中的字段范围；CLI与Agent据此避免跨单元格编辑。空字段保留但不可用非空编辑覆盖。 */
export function documentFieldRanges(blocks:DocumentBlock[]){
 let cursor=0;
 return blocks.flatMap((block,i)=>{if(i)cursor++;const base=cursor;const result=fields(structuredClone(block)).map((f,index)=>({block_id:block.id,field_index:index,start:base+f.start,end:base+f.end}));cursor+=documentBlocksToText([block]).length;return result;});
}
export function prepareStructuredMaterialData(plan:any,input:StructuredPage[]){
 const prepared=prepareMaterialData(plan,input);
 const pages=input.map(source=>{
  if(documentBlocksToText(source.structure)!==source.text)throw new Error('原结构与页正文不一致');
  const structure=structuredClone(source.structure);let cursor=0;
  const slots=structure.flatMap((block,i)=>{if(i)cursor++;const base=cursor;const list=fields(block).map(f=>({...f,start:f.start+base,end:f.end+base,edits:[] as any[]}));cursor+=documentBlocksToText([block]).length;return list;});
  for(const edit of plan.edits.filter((e:any)=>e.file_id===source.file_id&&e.page===source.page)){
   const slot=slots.find(f=>f.start<=edit.start&&f.end>=edit.end);
   if(!slot)throw new Error('编辑跨越段落或单元格，须按结构字段重新定位');
   slot.edits.push(edit);
  }
  for(const slot of slots){let text=slot.text;for(const edit of slot.edits.sort((a,b)=>b.start-a.start))text=text.slice(0,edit.start-slot.start)+edit.replacement_text+text.slice(edit.end-slot.start);slot.set(text);}
  const text=documentBlocksToText(structure),expected=prepared.pages.find(p=>p.file_id===source.file_id&&p.page===source.page)!;
  if(text!==expected.text)throw new Error('结构编辑与原文映射不一致');
  return {...source,text,structure};
 });
 const documents=prepared.documents.map((doc,i)=>{
  const selected:{page:number;blocks:DocumentBlock[]}[]=plan.documents[i].segments.map((segment:any)=>{
   const page=pages.find(p=>p.file_id===segment.file_id&&p.page===segment.page)!;let cursor=0;const blocks:DocumentBlock[]=[];
   for(const block of page.structure){const text=documentBlocksToText([block]),start=cursor,end=start+text.length;cursor=end+1;
    if(end<=segment.start||start>=segment.end)continue;
    const a=Math.max(start,segment.start)-start,b=Math.min(end,segment.end)-start;
    if(a===0&&b===text.length)blocks.push(structuredClone(block));
    else if(block.kind!=='table'&&block.kind!=='list')blocks.push({...block,text:text.slice(a,b)});
    else throw new Error('分册边界切断表格或列表，须重新定位完整结构边界');
   }
   const text=page.text.slice(segment.start,segment.end),projected=documentBlocksToText(blocks);
   const prefix=text.slice(0,text.indexOf(projected)),suffix=text.slice(prefix.length+projected.length);
   if(projected!==text&&!projected&&/^\n+$/.test(text)){
    // 清理后的扫描尾注可能只剩段落分隔符；保持精确覆盖，渲染时跳过这些空段。
    blocks.splice(0,blocks.length,...Array.from({length:text.length+1},(_,n)=>({id:`split-blank-${n}`,kind:'paragraph' as const,text:''})));
   }else if(projected!==text){
    if(!projected||prefix.replace(/\n/g,'')||suffix.replace(/\n/g,'')||prefix+projected+suffix!==text)throw new Error('分册结构与范围正文不一致');
    for(let n=0;n<prefix.length;n++)blocks.unshift({id:`split-prefix-${n}`,kind:'paragraph',text:''});
    for(let n=0;n<suffix.length;n++)blocks.push({id:`split-suffix-${n}`,kind:'paragraph',text:''});
   }
   if(documentBlocksToText(blocks)!==text)throw new Error('分册投影不一致');
   return {page:page.page,blocks};
  });
  return {...doc,document:{format:'redacted-structure-v1' as const,pages:selected}};
 });
 return {pages,documents};
}
