/** 职责：对已审阅的逐包名称映射执行同时置换并统计差异；供名称修订预览及应用共用，不访问数据库或判断姓名读音。 */
export interface NameReplacement {original:string;before:string;after:string;kind:'person'|'organization'}
export interface NameChange {path:string;before:string;after:string;counts:Record<string,number>}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** 同一个旧化名不能指向两个主体；不同主体不得合并到同一个新名称。简称须由调用方提供单独且已审阅的映射。 */
export function validateNameReplacements(value:unknown):NameReplacement[]{
 if(!Array.isArray(value)||!value.length||value.length>1000)throw new Error('名称映射须为1至1000项');
 const previous=new Map<string,string>(),targets=new Map<string,string>();
 return value.map(item=>{
  if(!object(item)||Object.keys(item).some(key=>!['original','before','after','kind'].includes(key))||!['person','organization'].includes(String(item.kind)))throw new Error('名称映射结构无效');
  for(const key of ['original','before','after'])if(typeof item[key]!=='string'||!String(item[key]).trim()||String(item[key]).length>300||/[\r\n\t]/.test(String(item[key])))throw new Error('名称映射字段无效');
  const replacement=item as unknown as NameReplacement;
  if(replacement.before===replacement.after)throw new Error('名称映射未改变名称');
  if(previous.has(replacement.before))throw new Error('旧名称重复或存在主体歧义');
  if(targets.has(replacement.after)&&targets.get(replacement.after)!==replacement.original)throw new Error('不同主体不能使用同一个新名称');
  previous.set(replacement.before,replacement.original);targets.set(replacement.after,replacement.original);
  return {...replacement};
 });
}

/** 一次扫描、最长名称优先；替换结果不会被后续映射再次替换。 */
export function replaceNames(text:string,mappings:NameReplacement[]){
 if(!mappings.length)return{text,counts:Object.create(null) as Record<string,number>};
 const byName=new Map(mappings.map(mapping=>[mapping.before,mapping.after]));
 const escaped=[...byName.keys()].sort((a,b)=>b.length-a.length||a.localeCompare(b)).map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const counts:Record<string,number>=Object.create(null);
 const result=text.replace(new RegExp(escaped.join('|'),'gu'),name=>{counts[name]=(counts[name]??0)+1;return byName.get(name)!;});
 return {text:result,counts};
}

/** 只遍历调用方明确选定的正文树；对象键及身份字段始终不替换。 */
export function replaceNameTextTree<T>(input:T,mappings:NameReplacement[],textKeys:ReadonlySet<string>,inheritText=false){
 const changes:NameChange[]=[];
 function visit(value:unknown,path:string,active=false):unknown{
  if(typeof value==='string'){
   if(!active)return value;
   const replacement=replaceNames(value,mappings);
   if(replacement.text!==value)changes.push({path,before:value,after:replacement.text,counts:replacement.counts});
   return replacement.text;
  }
  if(Array.isArray(value))return value.map((item,index)=>visit(item,`${path}/${index}`,active));
  if(!object(value))return value;
  return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,visit(entry,`${path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`,
   inheritText&&active?!/^(?:id|format|contract)$|_(?:id|ids|version|sha256|digest)$/.test(key):textKeys.has(key))]));
 }
 return {value:visit(input,'') as T,changes};
}
