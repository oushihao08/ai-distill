/**
 * 职责：将材料文本中的HTML/XML、实体及文字转义转换为纯文本精确编辑，不操作DOCX、数据库或模型。
 * 入口：materialMarkupEdits由scan-noise在提取发布和脱敏编译中共用；标签内正文及比较符号保留。
 * 编辑始终使用原文UTF-16坐标，不整字段覆盖其他化名/号码遮盖；代码与公式可保留语法转义。
 */
export interface MaterialMarkupEdit {start:number;end:number;source_text:string;replacement_text:string}
export function materialMarkupEdits(source:string,options:{preserveEscapes?:boolean}={}):MaterialMarkupEdit[]{
 if(!/[<&\\]/.test(source))return [];
 const named:Record<string,string>={lt:'<',gt:'>',amp:'&',quot:'"',apos:"'",nbsp:' ',ensp:' ',emsp:' ',thinsp:' ',ndash:'–',mdash:'—',hellip:'…',copy:'©',reg:'®',trade:'™',times:'×',divide:'÷',le:'≤',ge:'≥',ne:'≠',sect:'§',deg:'°',plusmn:'±',bull:'•',middot:'·',euro:'€',pound:'£',yen:'¥',bsol:'\\'};
 let entityEdits:MaterialMarkupEdit[]=[],text=source;
 let mapping=Array.from({length:source.length},(_,i)=>({start:i,end:i+1}));
 // 解码投影同时保留原文位置；实体与Unicode嵌套继续还原，不留下编码后的标签。
 for(;;){
  const references:{start:number;end:number;value:string}[]=[];
  for(const match of text.matchAll(/&(?:(?:amp|#0*38|#x0*26);)*(?:(#x[\da-f]+|#\d+|[a-z][a-z\d]+);|(nbsp|ensp|emsp|thinsp|amp|lt|gt|quot|apos)(?![a-z\d]))/gi)){
   const entity=(match[1]??match[2])!;let value:string;
   if(entity[0]==='#'){
    const point=entity[1]?.toLowerCase()==='x'?Number.parseInt(entity.slice(2),16):Number(entity.slice(1));
    value=point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff)?String.fromCodePoint(point):'�';
   }else value=named[entity.toLowerCase()]??entity;
   references.push({start:match.index!,end:match.index!+match[0].length,value});
  }
  if(!options.preserveEscapes){
   for(const match of text.matchAll(/\\+(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2}))/gi)){
    const point=Number.parseInt((match[1]??match[2]??match[3])!,16);
    if(point>0&&point<=0x10ffff&&!(point>=0xd800&&point<=0xdfff))references.push({start:match.index!,end:match.index!+match[0].length,value:String.fromCodePoint(point)});
   }
   for(const match of text.matchAll(/\\+([<>])/g))references.push({start:match.index!,end:match.index!+match[0].length,value:match[1]!});
  }
  if(!references.length)break;
  for(const ref of references.sort((a,b)=>b.start-a.start)){
   const start=mapping[ref.start]!.start,end=mapping[ref.end-1]!.end;
   entityEdits=entityEdits.filter(edit=>!(edit.start<end&&edit.end>start));
   entityEdits.push({start,end,source_text:source.slice(start,end),replacement_text:ref.value});
   text=text.slice(0,ref.start)+ref.value+text.slice(ref.end);
   mapping=[...mapping.slice(0,ref.start),...Array.from({length:ref.value.length},()=>({start,end})),...mapping.slice(ref.end)];
  }
 }
 const edits:MaterialMarkupEdit[]=[];
 const add=(start:number,end:number,replacement:string)=>{
  const a=mapping[start]!.start,b=mapping[end-1]!.end;
  if(!edits.some(edit=>edit.start<b&&edit.end>a))edits.push({start:a,end:b,source_text:source.slice(a,b),replacement_text:replacement});
 };
 let prefix='',last=0;
 const blockTags=new Set(['p','div','tr','li','h1','h2','h3','h4','h5','h6','table','section','article','blockquote']);
 const pattern=/<(\/?)([\p{L}_][\p{L}\p{N}_.:-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'"<>])*)>/gu;
 for(const match of text.matchAll(pattern)){
  prefix+=text.slice(last,match.index);
  const name=match[2]!,lower=name.toLowerCase().split(':').at(-1)!,closing=Boolean(match[1]),tail=text.slice(match.index!+match[0].length);let replacement='';
  const visiblePrefix=prefix.replace(/<\?[\s\S]*?\?>|<!DOCTYPE\b[^>]*>/gi,'');
  if(!closing&&!match[3]!.trim()&&/[\p{Script=Han}]/u.test(name)&&/(?:法典|法|条例|规定|解释|办法|意见|通知|决定|细则|规则|指引|准则)$/.test(name))replacement=`《${name}》`;
  else if(lower==='br')replacement='\n';
  else if(lower==='tab')replacement='\t';
  else if(blockTags.has(lower)&&visiblePrefix.trim()&&!visiblePrefix.endsWith('\n')&&tail)replacement='\n';
  else if(closing&&['td','th'].includes(lower)&&/^\s*<(?:td|th)\b/i.test(tail))replacement='\t';
  add(match.index!,match.index!+match[0].length,replacement);prefix+=replacement;last=match.index!+match[0].length;
 }
 // 去掉注释/CDATA外壳，保留其中的文字；XML声明和处理指令不属于正文。
 for(const match of text.matchAll(/<!--|-->|<!\[CDATA\[|\]\]>|<!DOCTYPE\b[^>]*>|<\?[\s\S]*?\?>/gi))add(match.index!,match.index!+match[0].length,'');
 for(const match of text.matchAll(/<\/?(br|span|div|strong|table|tr|td|th|html|body|p|b)(?=\s|$)/gi)){
  if(match[1]!.length===1&&!edits.length)continue;
  add(match.index!,match.index!+match[0].length,'');
 }
 if(!options.preserveEscapes){
  // 已在真实材料中出现的LaTeX角度/百分号排版：还原符号，不猜测OCR本来应是什么数字。
  for(const match of text.matchAll(/\\angle(?![a-z])/gi))add(match.index!,match.index!+match[0].length,'∠');
  for(const match of text.matchAll(/\$([^$\r\n]*\\(?:angle|%)[^$\r\n]*)\$/g)){
   add(match.index!,match.index!+1,'');add(match.index!+match[0].length-1,match.index!+match[0].length,'');
  }
  // 路径规范分隔符，不把路径中的\n、\t误解为换行/制表符。
  for(const match of text.matchAll(/\b[A-Za-z]:\\[^\s<>"'；，。]+/g))add(match.index!,match.index!+match[0].length,match[0].replace(/\\+/g,'/'));
  for(const match of text.matchAll(/\\+([nrt"'\/\\*_#%\[\]`{}()~!|])/g)){
   const value=match[1]!,replacement=({n:'\n',r:'\n',t:'\t'} as Record<string,string>)[value]??(value==='\\'?'/':value);
   add(match.index!,match.index!+match[0].length,replacement);
  }
 }
 return [...edits,...entityEdits.filter(entity=>!edits.some(edit=>edit.start<entity.end&&edit.end>entity.start))].sort((a,b)=>a.start-b.start);
}
