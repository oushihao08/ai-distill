/**
 * 职责：读取已入库提取原文，校验Codex提供的精确编辑与分册计划，导出本地出题输入。
 * 入口：exportPreparedMaterials()，供library documents export调用；仅GET API及写入全新本地目录，不提交业务结果。
 * 输入坐标按JavaScript UTF-16索引；编辑定位原文，分册定位应用编辑后的页文本。所有原页须恰好覆盖一次。
 */
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ApiClient,CliError} from './client';
import {prepareStructuredMaterialData} from '../shared/prepared-structure';
import {prepareMaterialData,validateMaterialPreparationPlan} from '../shared/material-preparation';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(message:string):never=>{throw new CliError(message,{kind:'invalid_material_plan'});};
type Page={file_id:string;page:number;text:string;structure?:any[]};
const key=(file:string,page:number)=>`${file}:${page}`;

export async function exportPreparedMaterials(client:ApiClient,planPath:string,outPath:string,signal?:AbortSignal){
 let plan:any;
 try{plan=JSON.parse(await readFile(resolve(planPath),'utf8'));}catch{throw new CliError('不能读取材料处理计划');}
 try{validateMaterialPreparationPlan(plan);}catch(error){fail(error instanceof Error?error.message:'材料计划格式无效');}
 const base=`/api/material-library/revisions/${plan.revision_id}/documents?extraction_job_id=${plan.extraction_job_id}`;
 const summary=await client.json(base,'GET',undefined,signal);
 const files=plan.files;
 if(!Array.isArray(summary?.items)||summary.items.length!==files.length||new Set(files.map((f:any)=>f.file_id)).size!==files.length)fail('处理计划未覆盖本次全部来源附件');
 const pages=new Map<string,Page>();
 for(const f of files){
  if(!uuid.test(f.file_id)||!summary.items.some((item:any)=>item.file_id===f.file_id))fail('处理计划中的来源附件不匹配');
  const response=await client.json(`${base}&file_id=${f.file_id}`,'GET',undefined,signal);
  const item=response?.items?.[0];
  if(item?.file_id!==f.file_id||!Array.isArray(item.pages)||item.pages.length!==item.page_count||!item.pages.length||item.pages.some((p:any)=>!Number.isSafeInteger(p.page)||typeof p.text!=='string'))fail('提取原文页数据不完整');
  if(sha(item.pages.map((p:any)=>p.text).join('\n'))!==f.text_sha256)fail('原文已变化，不能应用旧处理计划');
  for(const p of item.pages){const k=key(f.file_id,p.page);if(pages.has(k))fail('提取原文页身份重复');pages.set(k,{file_id:f.file_id,page:p.page,text:p.text,structure:p.structure});}
 }
 if(plan.template_id){const catalog=await client.json('/api/material-library/redaction-templates','GET',undefined,signal);const template=catalog.items.find((t:any)=>t.id===plan.template_id);if(!template||template.workflow!=='codex_plan'||template.digest!==plan.template_digest)fail('模板流程或摘要不匹配，请重新审阅计划');}
 const {documents}=plan.template_id?prepareStructuredMaterialData(plan,[...pages.values()] as any):prepareMaterialData(plan,[...pages.values()]);
 const out=resolve(outPath);let created=false;
 try{
  await mkdir(out,{mode:0o700});created=true;await mkdir(join(out,'材料'),{mode:0o700});
  for(const doc of documents){if(signal?.aborted)throw new CliError('导出已中断');await writeFile(join(out,doc.file),doc.text+'\n',{mode:0o600,flag:'wx'});}
  await writeFile(join(out,'出题材料.json'),JSON.stringify({format:'authoring-material-candidate-v1',documents},null,2)+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(out,'材料清单.md'),'# 出题材料\n\n'+documents.map(d=>`- [${d.title.replace(/[\[\]]/g,'')}](${encodeURI(d.file).replace(/\(/g,'%28').replace(/\)/g,'%29')})`).join('\n')+'\n',{mode:0o600,flag:'wx'});
  const notes=typeof plan.notes==='string'?plan.notes:'本地出题输入候选，未提交数据库；模型的主体判断和材料边界仍需内容复核。';
  await writeFile(join(out,'使用说明.md'),notes+'\n',{mode:0o600,flag:'wx'});
  return{output_directory:out,file_count:files.length,page_count:pages.size,document_count:documents.length,database_imported:false,model_invoked:false,source_verified:true,plan_sha256:sha(JSON.stringify(plan))};
 }catch(error){
  if(created)await rm(out,{recursive:true,force:true});
  if(error instanceof CliError)throw error;
  throw new CliError(created?'材料导出失败，已清理本轮新目录':'输出目录必须不存在，且父目录须已建立',{kind:'file_error'});
 }
}
