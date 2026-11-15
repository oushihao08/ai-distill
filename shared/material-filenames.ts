/** 职责：材料交付文件名净化与同名消歧；供DOCX导出及飞书DOCX/PDF上传共用，不改变正文、来源身份或校验摘要。 */
export function materialFilenameStem(value:string,fallback='材料'):string{
 const cleaned=value.normalize('NFKC')
  .replace(/\.(?:docx?|pdf|ofd|txt|md)$/i,'')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'')
  .replace(/[0-9a-f]{16,}/gi,'')
  .replace(/[\\/\u0000-\u001f<>:"|?*]/g,'_').replace(/\s+/g,' ')
  .replace(/[-_ ]{2,}/g,'-').replace(/^[.\s_-]+|[.\s_-]+$/g,'');
 let stem='';for(const character of cleaned){if(new TextEncoder().encode(stem+character).length>180)break;stem+=character;}
 return stem.replace(/[.\s_-]+$/g,'')||fallback;
}

/** 预留全部原名称，避免“同名第二份”撞上原本就有同名序号的文书。 */
export function materialDeliveryStems(files:ReadonlyArray<{filename?:string;name?:string}>):string[]{
 const stems=files.map(file=>materialFilenameStem(file.filename?.trim()||file.name?.trim()||'','材料'));
 const reserved=new Set(stems.map(stem=>stem.toLowerCase())),used=new Set<string>();
 return stems.map(stem=>{
  let name=stem,ordinal=2;
  while(used.has(name.toLowerCase())){
   do{name=`${stem}（${ordinal++}）`;}while(reserved.has(name.toLowerCase()));
  }
  used.add(name.toLowerCase());return name;
 });
}
