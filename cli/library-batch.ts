/** 材料库搜索批次：模糊定位期次、按且关系固定全分页命中包，并通过现有HTTP单包入口派发；清单写前记录请求键，未知写入停止并保留原键。由commands.ts调用，不直连数据库。 */
import {readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {ApiClient,CliError} from './client';
type Stage='intake'|'extract'|'redact'|'prepare';
type Row={package_id:string;name:string;revision_id:string;request_key:string;state:string;reason?:string;job_id?:string;body?:Record<string,unknown>;response?:unknown};
type Plan={version:1;kind:Stage;project_id?:string;project_name?:string;filters:Record<string,string>;created_at:string;items:Row[]};
const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[一二三四五六七八九十]/g,c=>String('一二三四五六七八九十'.indexOf(c)+1)).replace(/[\s\-—_]/g,'');
function fuzzy(text:string,query:string){let at=0;const value=normalize(text);for(const c of normalize(query)){at=value.indexOf(c,at);if(at<0)return false;at++;}return true;}
function items(value:any):any[]{return Array.isArray(value)?value:value.items??[];}
export async function planLibraryBatch(api:ApiClient,flags:Map<string,string|boolean>,out:string,signal?:AbortSignal){
 const kind=flags.get('kind') as Stage;if(!['intake','extract','redact','prepare'].includes(kind))throw new CliError('--kind须为intake、extract、redact或prepare');
 const get=(p:string)=>api.json(p,'GET',undefined,signal);
 let project:any;
 if(flags.has('project-query')){const query=String(flags.get('project-query'));const projects=items(await get('/api/projects'));const exact=projects.filter(p=>normalize(p.name)===normalize(query));const matches=exact.length?exact:projects.filter(p=>fuzzy(p.name,query));if(matches.length!==1)throw new CliError(matches.length?'期次匹配不唯一，请用完整名称或--project':'未找到匹配期次',{kind:'usage_error',candidates:matches.map(p=>({id:p.id,name:p.name}))});project=matches[0];}
 if(flags.has('project')){if(project&&project.id!==flags.get('project'))throw new CliError('期次筛选冲突');project=await get(`/api/projects/${String(flags.get('project'))}`);}
 const filters:Record<string,string>={q:String(flags.get('q')??''),redaction_state:String(flags.get('redaction-state')??'all'),preparation_state:String(flags.get('preparation-state')??'all'),extraction_state:String(flags.get('extraction-state')??'all')};
 for(const k of ['redaction_state','preparation_state'])if(!['all','ready','not_ready'].includes(filters[k]!))throw new CliError(`${k}无效`);
 if(!['all','succeeded','not_started','failed','cancelled','running','queued'].includes(filters.extraction_state!))throw new CliError('extraction-state无效');
 if(!project&&!filters.q)throw new CliError('须指定--project-query、--project或--q，避免无范围批量操作');
 const found=new Map<string,any>();
 for(let page=1;;page++){const q=new URLSearchParams({page:String(page),page_size:'100',redaction_state:filters.redaction_state!,preparation_state:filters.preparation_state!});const result=await get(`/api/material-library/packages?${q}`);for(const p of result.items){if(p.deleted_at||!p.current_revision_id)continue;if(project&&!fuzzy(p.name,project.name))continue;if(filters.q&&!filters.q.split(/\s+/).every(term=>fuzzy(p.name,term)))continue;if(filters.extraction_state!=='all'&&p.extraction_status!==filters.extraction_state)continue;found.set(p.id,p);}if(page*100>=result.total_count)break;if(!result.items.length)throw new CliError('搜索分页变化，请重新生成清单');}
 const plan:Plan={version:1,kind,...(project?{project_id:project.id,project_name:project.name}:{}),filters,created_at:new Date().toISOString(),items:[...found.values()].map(p=>({package_id:p.id,name:p.name,revision_id:p.current_revision_id,request_key:crypto.randomUUID(),state:'planned'}))};
 await writeFile(out,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});return {...plan,file:out,count:plan.items.length,note:'仅固定搜索命中范围，未派发；不同筛选条件同时满足。'};
}
export async function runLibraryBatch(api:ApiClient,file:string,signal?:AbortSignal){
 const lock=await open(file+'.lock','wx',0o600);const temp=file+'.'+crypto.randomUUID()+'.tmp';
 try{
 const plan=JSON.parse(await readFile(file,'utf8')) as Plan;
 const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
 if(plan.version!==1||!['intake','extract','redact','prepare'].includes(plan.kind)||!Array.isArray(plan.items)||plan.items.some(r=>!uuid.test(r.package_id)||!uuid.test(r.revision_id)||!uuid.test(r.request_key))||(plan.project_id&&!uuid.test(plan.project_id)))throw new CliError('无效材料批次清单');
 const save=async()=>{await writeFile(temp,JSON.stringify(plan,null,2)+'\n',{mode:0o600});await rename(temp,file);};
 const get=(p:string)=>api.json(p,'GET',undefined,signal);
 const mode=plan.project_id?(await get(`/api/projects/${plan.project_id}/material-processing`)).material_processing_mode:'aliases';
 for(const row of plan.items){
  if(signal?.aborted)break;
  if(['submitted','skipped'].includes(row.state))continue;
  // 未知写入只按原request_key恢复；复用已保存body，不在恢复时改输入。
  if(row.state!=='unknown'){
   const pkg=await get(`/api/material-library/packages/${row.package_id}`);
   if(pkg.current_revision_id!==row.revision_id){row.state='skipped';row.reason='当前revision ID已变化';await save();continue;}
   const rev=items(await get(`/api/material-library/packages/${row.package_id}/revisions`)).find(r=>r.id===row.revision_id);
   const skip=async(reason:string)=>{row.state='skipped';row.reason=reason;await save();};
   if(!rev){await skip('版本不存在');continue;}
   if(rev.jobs.some((j:any)=>['running','queued'].includes(j.status))){await skip('已有活动任务');continue;}
   const ext=rev.jobs.find((j:any)=>j.kind==='extract'&&j.status==='succeeded'),red=rev.redactions.find((r:any)=>r.usable_for_question===true||r.usable_for_question==='true');
   if(plan.kind==='intake'&&rev.state==='ready'){await skip('已入库');continue;}
   if(plan.kind!=='intake'&&rev.state!=='ready'){await skip('尚未入库');continue;}
   if(plan.kind==='extract'&&ext){await skip('已提取成功');continue;}
   if(['redact','prepare'].includes(plan.kind)&&!ext){await skip('尚未提取成功');continue;}
   if(plan.kind==='redact'&&(red||mode==='original')){await skip(red?'已有可用脱敏结果':'期次使用原文');continue;}
   row.body={request_key:row.request_key,...(plan.project_id?{project_id:plan.project_id}:{})};
   if(plan.kind==='prepare'){
    if(mode!=='original'&&!red){await skip('尚无可用脱敏结果');continue;}
    const q=new URLSearchParams({revision_id:rev.id,redaction_id:mode==='original'?'':red.id,...(plan.project_id?{project_id:plan.project_id}:{})});const prepared=await get(`/api/material-library/packages/${row.package_id}/preparations?${q}`);
    if(!prepared.available||prepared.items.length){await skip(prepared.available?'已有整理成果':'整理未启用');continue;}
    Object.assign(row.body,mode==='original'?{extraction_job_id:ext.id}:{redaction_id:red.id});
   }else Object.assign(row.body,{kind:plan.kind,execution_target:'local',...(plan.kind==='redact'?{extraction_job_id:ext.id,template_id:'aliases'}:{})});
  }
  row.state='unknown';await save();
  try{const result=await api.json(`/api/material-library/revisions/${row.revision_id}/${plan.kind==='prepare'?'prepare':'jobs'}`,'POST',row.body,signal);row.response=result;row.job_id=result.id;row.state='submitted';delete row.reason;await save();}
  catch(error){row.reason=error instanceof Error?error.message:'派发失败';row.response=error instanceof CliError?error.detail:{};if(error instanceof CliError&&error.detail.dispatched===false)row.state='planned';await save();break;}
 }
 return{file,kind:plan.kind,project_id:plan.project_id,counts:plan.items.reduce((n,r)=>(n[r.state]=(n[r.state]??0)+1,n),{} as Record<string,number>),items:plan.items};
 }finally{await lock.close();await unlink(file+'.lock');}
}
