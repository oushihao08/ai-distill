/** 职责：校验Codex材料编辑和分册范围；供CLI本地导出及HTTP正式导入共同调用。只处理内存中的冻结原文，不运行模型或访问数据库。 */
function fail(message:string):never{throw new Error(message);}
export type PreparedPage={file_id:string;page:number;text:string};
const key=(file:string,page:number)=>`${file}:${page}`;
/** CLI导入/导出与HTTP共用的计划入口校验；不读取来源，精确编辑/覆盖仍由prepareMaterialData核对。 */
export function validateMaterialPreparationPlan(plan:any){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!plan||plan.format!=='codex-material-export-v1'||typeof plan.revision_id!=='string'||!uuid.test(plan.revision_id)||typeof plan.extraction_job_id!=='string'||!uuid.test(plan.extraction_job_id)||!Array.isArray(plan.files)||!plan.files.length||!Array.isArray(plan.edits)||!Array.isArray(plan.documents)||!plan.documents.length)fail('材料计划格式无效');
 if(plan.files.some((file:any)=>!file||typeof file.file_id!=='string'||!uuid.test(file.file_id)||typeof file.text_sha256!=='string'||!/^[0-9a-f]{64}$/i.test(file.text_sha256))||new Set(plan.files.map((file:any)=>file.file_id)).size!==plan.files.length)fail('材料计划来源身份或摘要无效');
 if(plan.template_id!==undefined||plan.template_digest!==undefined){
  if(typeof plan.template_id!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(plan.template_id)||typeof plan.template_digest!=='string'||!/^[0-9a-f]{64}$/i.test(plan.template_digest))fail('模板身份和摘要必须同时提供且有效');
 }
}
function range(start:unknown,end:unknown,text:string){
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||(start as number)<0||(end as number)<=(start as number)||(end as number)>text.length)fail('材料计划的文字范围无效');
 return{start:start as number,end:end as number};
}
export function prepareMaterialData(plan:any,input:PreparedPage[]){
 if(!Array.isArray(plan?.edits)||!Array.isArray(plan?.documents)||!plan.documents.length)fail('材料处理计划格式无效');
 // 旧文本计划只返回已编辑文字，不能把输入对象附带的旧structure冒充编辑后的结构。
 // 结构计划由prepareStructuredMaterialData单独生成新结构。
 const pages=new Map(input.map(p=>[key(p.file_id,p.page),{file_id:p.file_id,page:p.page,text:p.text}]));
 const grouped=new Map<string,any[]>();
 for(const edit of plan.edits){
  const k=key(edit?.file_id,edit?.page),p=pages.get(k);if(!p)fail('编辑引用了不存在的来源页');
  const r=range(edit.start,edit.end,p.text);
  if(typeof edit.source_text!=='string'||typeof edit.replacement_text!=='string'||p.text.slice(r.start,r.end)!==edit.source_text)fail('编辑与原文字面不匹配');
  const list=grouped.get(k)??[];list.push({...r,replacement:edit.replacement_text});grouped.set(k,list);
 }
 for(const [k,list] of grouped){
  list.sort((a,b)=>a.start-b.start);
  if(list.some((e,i)=>i>0&&e.start<list[i-1].end))fail('编辑范围发生重叠');
  const p=pages.get(k)!;for(const e of list.reverse())p.text=p.text.slice(0,e.start)+e.replacement+p.text.slice(e.end);
 }
 const coverage=new Map<string,{start:number;end:number}[]>();
 const ids=new Set<string>();const documents:{id:string;title:string;file:string;text:string}[]=[];
 for(const [i,doc] of plan.documents.entries()){
  if(typeof doc?.id!=='string'||ids.has(doc.id)||typeof doc.title!=='string'||!doc.title.trim()||doc.title.length>100||/[\\/<>:"|?*\u0000-\u001f]/.test(doc.title)||!Array.isArray(doc.segments)||!doc.segments.length)fail('文书身份、名称或分册范围无效');
  ids.add(doc.id);const parts:string[]=[];
  for(const segment of doc.segments){
   const k=key(segment?.file_id,segment?.page),p=pages.get(k);if(!p)fail('分册引用了不存在的来源页');
   const r=range(segment.start,segment.end,p.text);parts.push(p.text.slice(r.start,r.end));
   const list=coverage.get(k)??[];list.push(r);coverage.set(k,list);
  }
  documents.push({id:doc.id,title:doc.title,file:`材料/${String(i+1).padStart(3,'0')}-${doc.title}.md`,text:parts.join('\n\n')});
 }
 for(const [k,p] of pages){
  if(!p.text.length)continue;
  const spans=(coverage.get(k)??[]).sort((a,b)=>a.start-b.start);
  if(!spans.length||spans[0].start!==0||spans.at(-1)!.end!==p.text.length||spans.some((r,i)=>i>0&&r.start!==spans[i-1].end))fail('分册存在正文遗漏或重复覆盖');
 }
 return{pages:[...pages.values()],documents};
}
