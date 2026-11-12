/**
 * 文件职责：离线作业台 CLI：按阶段（脱敏/整理/出题）挑选N个待处理项，经现有HTTP接口以 web_settings.mode='offline' 派发，由本机worker生成与真实执行完全一致的输入并打包为每任务一个zip；交回时读取人工保存的网页回复，回放给同一执行器校验并入库。
 * 关键入口：`offlineExport()`、`offlineImport()`、`offlineStatus()`；由 `commands.ts` 的 `offline export|import|status` 调用。
 * 作业台目录：`<out>/对账台.json`（机器可读）与 `<out>/对账台.md`（人读），`<out>/脱敏|整理|出题/` 下放各任务zip，旧轮次zip移入同级 `历史/`。
 * 边界：只调用本机HTTP、读写作业台目录与本机 `<STORAGE_DIR>/web-offline` 交换目录；不连接数据库、不调用模型；校验与入库由服务端原执行器完成。
 */
import {mkdir,readdir,readFile,rename,rm,stat,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CliError} from './client';
import {readOfflineTask,importOfflineReply,offlineRoot} from '../server/web-agent/offline-transport';
import {stitchReplies} from '../server/web-executors/chat-loop';
import type {WebAgentProvider} from '../shared/web-agent';

export type OfflineStage='redact'|'prepare'|'author';
export const OFFLINE_STAGES:readonly OfflineStage[]=['redact','prepare','author'];
const STAGE_DIR:Record<OfflineStage,string>={redact:'脱敏',prepare:'整理',author:'出题'};
const DEFAULT_PROVIDER:Record<OfflineStage,WebAgentProvider>={redact:'deepseek',prepare:'deepseek',author:'gemini'};
type Status='待交回'|'已入库'|'失败';
export interface LedgerItem{
  seq:number;task:string;stage:OfflineStage;title:string;provider:WebAgentProvider;
  package_id?:string;revision_id?:string;extraction_job_id?:string;redaction_id?:string;project_id?:string;workflow_id?:string;
  job_id:string|null;round:number;status:Status;zip:string|null;exported_at:string;updated_at:string;message?:string;
  history:{at:string;event:string;detail?:string}[];
}
interface Ledger{version:1;updated_at:string;items:LedgerItem[]}
export interface OfflineHttp{get(path:string):Promise<any>;post(path:string,body?:unknown):Promise<any>}
interface Candidate{task:string;title:string;package_id?:string;revision_id?:string;extraction_job_id?:string;redaction_id?:string;project_id?:string;workflow_id?:string}

const now=()=>new Date().toISOString();
/** 对账台展示用本机时区时间（JSON仍存ISO）。 */
const local=(iso:string)=>{const d=new Date(iso),p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;};
const safeTitle=(title:string)=>title.replace(/[\\/:*?"<>|\s]+/g,'_').slice(0,60)||'任务';
const exists=async(path:string)=>Boolean(await stat(path).catch(()=>null));

async function loadLedger(out:string):Promise<Ledger>{
  try{const ledger=JSON.parse(await readFile(join(out,'对账台.json'),'utf8'));if(ledger?.version===1&&Array.isArray(ledger.items))return ledger;throw new CliError('对账台.json 格式无效');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{version:1,updated_at:now(),items:[]};throw error;}
}
function renderLedger(ledger:Ledger){
  const count=(s:Status)=>ledger.items.filter(item=>item.status===s).length;
  const rows=ledger.items.map(item=>`| ${item.seq} | ${STAGE_DIR[item.stage]} | ${item.title.replaceAll('|','／')} | ${item.round||'-'} | ${item.status} | ${item.zip??'-'} | ${local(item.updated_at)} | ${(item.message??'').replaceAll('|','／').replaceAll('\n',' ').slice(0,120)} |`);
  return[
    '# 离线作业台对账台','',
    `更新：${local(ledger.updated_at)}　共 ${ledger.items.length} 项：待交回 ${count('待交回')}，已入库 ${count('已入库')}，失败 ${count('失败')}`,'',
    '交回方法：打开对应 zip 的 `README.md` 在网页完成后，把回复存为 zip 内（或解压后同名文件夹内）的 `reply/reply-1.md`（续写依次 reply-2.md…），然后运行 `bun run ai-distill offline import --out <本目录>`。','',
    '| 序号 | 阶段 | 任务 | 轮次 | 状态 | zip | 更新时间 | 说明 |','| --- | --- | --- | --- | --- | --- | --- | --- |',...rows,'',
  ].join('\n');
}
async function saveLedger(out:string,ledger:Ledger){
  ledger.updated_at=now();
  const json=join(out,'对账台.json'),tmp=`${json}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify(ledger,null,2));await rename(tmp,json);
  await writeFile(join(out,'对账台.md'),renderLedger(ledger));
}

async function candidates(http:OfflineHttp,stage:OfflineStage,options:{project?:string;ids?:string[];limit?:number;skip?:Set<string>}):Promise<Candidate[]>{
  if(stage==='author'){
    if(!options.project)throw new CliError('出题阶段需要 --project');
    if(options.ids){
      // 指定题目时逐题读取轻量详情，避免读取整期项目清单。
      const rows:Candidate[]=[];
      for(const id of options.ids){
        const detail=await http.get(`/api/workflows/${id}`);
        const workflow=detail?.workflow??detail;
        if(workflow?.project_id&&workflow.project_id!==options.project)throw new CliError(`题目 ${id} 不属于该期次`);
        rows.push({task:`author-${id}`,title:String(workflow?.title??id),workflow_id:id,project_id:options.project});
      }
      return rows;
    }
    const data=await http.get(`/api/projects/${options.project}`);
    const steps:any[]=Array.isArray(data?.steps)?data.steps:[];
    const workflows:any[]=(Array.isArray(data?.workflows)?data.workflows:[]).filter((w:any)=>w.workflow_kind!=='material_package');
    const picked=options.ids?workflows.filter(w=>options.ids!.includes(w.id)):workflows.filter(w=>{const step=steps.find(s=>s.workflow_id===w.id&&s.ordinal===4);return !step||!['succeeded','running'].includes(step.status);});
    if(options.ids&&picked.length!==options.ids.length)throw new CliError('部分 --ids 不属于该期次的题目');
    return picked.map(w=>({task:`author-${w.id}`,title:String(w.title??w.id),workflow_id:w.id,project_id:options.project}));
  }
  if(stage==='prepare'){
    if(options.ids){
      const rows:Candidate[]=[];
      for(const redaction of options.ids){
        const meta=await http.get(`/api/material-library/redactions/${redaction}/preview?metadata_only=true`);
        const pkg=await http.get(`/api/material-library/packages/${meta.package_id}`);
        rows.push({task:`prepare-${redaction}`,title:String(pkg.name),package_id:meta.package_id,revision_id:meta.revision_id,redaction_id:redaction,...(options.project?{project_id:options.project}:{})});
      }
      return rows;
    }
    if(!options.project)throw new CliError('整理阶段需要 --project 或 --ids（脱敏结果ID）');
    const loaded=(await http.get(`/api/projects/${options.project}/loaded-materials`))?.items??[];
    const rows:Candidate[]=[];
    for(const item of loaded){
      if(!item.selected_redaction_id)continue;
      const existing=await http.get(`/api/material-library/packages/${item.package_id}/preparations?redaction_id=${item.selected_redaction_id}&project_id=${options.project}`);
      if(Array.isArray(existing?.items)&&existing.items.length)continue;
      rows.push({task:`prepare-${item.selected_redaction_id}`,title:String(item.package_name),package_id:item.package_id,revision_id:item.selected_revision_id,redaction_id:item.selected_redaction_id,project_id:options.project});
    }
    return rows;
  }
  // redact：材料库中当前版本已成功提取、尚无可用脱敏结果的材料包
  let packages:any[];
  if(options.ids)packages=await Promise.all(options.ids.map(id=>http.get(`/api/material-library/packages/${id}`)));
  else{
    const items:any[]=[];
    for(let page=1;page<=50;page++){
      const list=await http.get(`/api/material-library/packages?page=${page}&page_size=100`);
      const rows:any[]=Array.isArray(list?.items)?list.items:[];items.push(...rows);
      if(!rows.length||items.length>=Number(list?.total_count??0))break;
    }
    packages=items.filter(p=>p.extraction_status==='succeeded'&&Number(p.available_redaction_count)===0&&!['queued','running'].includes(p.redaction_status));
  }
  const rows:Candidate[]=[];
  for(const pkg of packages){
    // 只逐个查到够用为止，避免对全部候选逐一请求版本详情。
    if(options.limit!==undefined&&rows.length>=options.limit)break;
    const listed=await http.get(`/api/material-library/packages/${pkg.id}/revisions`);
    const revisions:any[]=Array.isArray(listed?.items)?listed.items:Array.isArray(listed)?listed:[];
    const revision=revisions.find(r=>r.id===pkg.current_revision_id)??revisions[0];
    const extraction=(revision?.jobs??[]).find((j:any)=>j.kind==='extract'&&j.status==='succeeded');
    if(!revision||!extraction){if(options.ids)throw new CliError(`材料包 ${pkg.id} 当前版本没有成功的文本提取`);continue;}
    if(options.skip?.has(`redact-${revision.id}`))continue;
    rows.push({task:`redact-${revision.id}`,title:String(pkg.name),package_id:pkg.id,revision_id:revision.id,extraction_job_id:extraction.id,...(options.project?{project_id:options.project}:{})});
  }
  return rows;
}

function webSettings(item:LedgerItem){return{provider:item.provider,mode:'offline',task:item.task};}
/** 派发（首次或交回后的重放）；返回本次任务/尝试ID。 */
async function dispatch(http:OfflineHttp,item:LedgerItem):Promise<string>{
  const request_key=randomUUID();
  if(item.stage==='redact'){
    const data=await http.post(`/api/material-library/revisions/${item.revision_id}/jobs`,{kind:'redact',request_key,execution_target:'local',extraction_job_id:item.extraction_job_id,...(item.project_id?{project_id:item.project_id}:{}),...(item.job_id?{previous_job_id:item.job_id}:{}),web_settings:webSettings(item)});
    return String(data.id);
  }
  if(item.stage==='prepare'){
    const data=item.job_id
      ?await http.post(`/api/material-library/jobs/${item.job_id}/prepare-resume`,{request_key})
      :await http.post(`/api/material-library/revisions/${item.revision_id}/prepare`,{request_key,redaction_id:item.redaction_id,...(item.project_id?{project_id:item.project_id}:{}),web_settings:webSettings(item)});
    return String(data.id);
  }
  const data=await http.post(`/api/projects/${item.project_id}/steps/4/run-batch`,{workflow_ids:[item.workflow_id],web_settings:webSettings(item)});
  const row=Array.isArray(data?.results)?data.results[0]:undefined;
  if(row?.status!=='queued'||!row.attempt_id)throw new CliError(`出题未进入排队：${row?.reason??row?.status??'未知'}`);
  return String(row.attempt_id);
}
/** 等待任务终态；返回 {ok,message}。 */
async function waitTerminal(http:OfflineHttp,item:LedgerItem,id:string,timeoutMs:number){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(item.stage==='author'){
      const history=await http.get(`/api/workflows/${item.workflow_id}/steps/4/attempts`);
      const attempt=(history?.attempts??[]).find((a:any)=>a.id===id);
      if(attempt&&['succeeded','failed','skipped','cancelled'].includes(attempt.status))return{ok:attempt.status==='succeeded',message:attempt.error?String(attempt.error):attempt.status};
    }else{
      const job=await http.get(`/api/material-library/jobs/${id}`);
      if(['succeeded','failed','cancelled'].includes(job?.status))return{ok:job.status==='succeeded',message:job.error_message?String(job.error_message):job.status,code:job.error_code};
    }
    await Bun.sleep(1500);
  }
  throw new CliError('等待本机 worker 处理超时；请确认 worker 已以 local 队列运行后再执行 offline import 重试');
}
/** 根据交换目录状态把结果落到作业台：导出新一轮zip / 已入库 / 失败。 */
async function settle(out:string,item:LedgerItem,result:{ok:boolean;message:string},startedAt:string){
  const state=await readOfflineTask(item.task);
  const stageDir=join(out,STAGE_DIR[item.stage]);await mkdir(stageDir,{recursive:true});
  if(result.ok){
    item.status='已入库';item.message='校验通过并已入库';item.history.push({at:now(),event:'imported'});
  }else if(state?.status==='exported'&&state.zip_path&&state.updated_at>=startedAt){
    if(item.zip&&await exists(join(out,item.zip))){
      await mkdir(join(stageDir,'历史'),{recursive:true});
      await rename(join(out,item.zip),join(stageDir,'历史',basename(item.zip)));
    }
    const name=`${String(item.seq).padStart(3,'0')}-${safeTitle(item.title)}-第${state.round}轮.zip`;
    await copyFile(state.zip_path,join(stageDir,name));
    const corrected=state.round>1;
    item.round=state.round;item.zip=join(STAGE_DIR[item.stage],name);item.status='待交回';
    item.message=corrected?`上一轮回复未通过校验，已导出第${state.round}轮修正（见 prompt.md）`:'已导出，等待交回';
    item.history.push({at:now(),event:corrected?'exported_correction':'exported',detail:`round ${state.round}`});
  }else{
    item.status='失败';item.message=result.message;item.history.push({at:now(),event:'failed',detail:result.message});
  }
  item.updated_at=now();
}

export async function offlineExport(http:OfflineHttp,options:{stage:OfflineStage;out:string;count?:number;provider?:WebAgentProvider;project?:string;ids?:string[];timeoutMs?:number}){
  const out=resolve(options.out);await mkdir(out,{recursive:true});
  const ledger=await loadLedger(out);
  const busy=new Set(ledger.items.filter(item=>item.status!=='失败').map(item=>item.task));
  const pool=(await candidates(http,options.stage,{...options,skip:busy,...(options.count!==undefined?{limit:options.count}:{})})).filter(c=>!busy.has(c.task));
  const picked=options.count===undefined?pool:pool.slice(0,options.count);
  const results:any[]=[];
  for(const candidate of picked){
    let item=ledger.items.find(row=>row.task===candidate.task);
    // 失败项重新导出：清掉旧的交换目录，避免回放已失败的旧回复。
    if(item){item.status='待交回';item.job_id=null;item.round=0;await rm(join(offlineRoot(),item.task),{recursive:true,force:true});}
    else{item={seq:ledger.items.length+1,...candidate,stage:options.stage,provider:options.provider??DEFAULT_PROVIDER[options.stage],job_id:null,round:0,status:'待交回',zip:null,exported_at:now(),updated_at:now(),history:[]};ledger.items.push(item);}
    const startedAt=now();
    try{
      item.job_id=await dispatch(http,item);
      await settle(out,item,await waitTerminal(http,item,item.job_id,options.timeoutMs??600000),startedAt);
    }catch(error){item.status='失败';item.message=error instanceof Error?error.message:'导出失败';item.history.push({at:now(),event:'export_failed',detail:item.message});item.updated_at=now();}
    await saveLedger(out,ledger);
    results.push({seq:item.seq,task:item.task,title:item.title,status:item.status,zip:item.zip,message:item.message});
  }
  await saveLedger(out,ledger);
  return{out,stage:options.stage,candidates:pool.length,exported:results.length,results,ledger:join(out,'对账台.md')};
}

/** 读取某任务当前轮交回的回复：优先解压后的文件夹（任意深度的 `reply/`），其次zip内 `reply/reply-N.md`。 */
async function readReplies(out:string,item:LedgerItem):Promise<string[]|null>{
  if(!item.zip)return null;
  const zipPath=join(out,item.zip),folder=zipPath.replace(/\.zip$/,'');
  const fromDir=async(dir:string):Promise<string[]|null>=>{
    const entries=await readdir(dir,{withFileTypes:true}).catch(()=>null);if(!entries)return null;
    if(basename(dir)==='reply'){
      const names=entries.filter(e=>e.isFile()&&/^reply-\d+\.(md|txt)$/.test(e.name)).map(e=>e.name).sort((a,b)=>Number(a.match(/\d+/)![0])-Number(b.match(/\d+/)![0]));
      if(names.length)return Promise.all(names.map(name=>readFile(join(dir,name),'utf8')));
    }
    for(const entry of entries)if(entry.isDirectory()){const found=await fromDir(join(dir,entry.name));if(found)return found;}
    return null;
  };
  const dirReplies=await fromDir(folder);if(dirReplies)return dirReplies;
  if(!await exists(zipPath))return null;
  const list=Bun.spawn(['unzip','-Z1',zipPath],{stdout:'pipe',stderr:'ignore'});
  const names=(await new Response(list.stdout).text()).split('\n').map(line=>line.trim()).filter(name=>/(^|\/)reply\/reply-\d+\.(md|txt)$/.test(name))
    .sort((a,b)=>Number(a.match(/reply-(\d+)/)![1])-Number(b.match(/reply-(\d+)/)![1]));
  await list.exited;
  if(!names.length)return null;
  const parts:string[]=[];
  for(const name of names){const proc=Bun.spawn(['unzip','-p',zipPath,name],{stdout:'pipe',stderr:'ignore'});parts.push(await new Response(proc.stdout).text());await proc.exited;}
  return parts.some(part=>part.trim())?parts:null;
}

export async function offlineImport(http:OfflineHttp,options:{out:string;timeoutMs?:number}){
  const out=resolve(options.out),ledger=await loadLedger(out);
  if(!ledger.items.length)throw new CliError('作业台没有对账记录，请先运行 offline export');
  const results:any[]=[];
  for(const item of ledger.items.filter(row=>row.status==='待交回')){
    const parts=await readReplies(out,item);
    if(!parts){results.push({seq:item.seq,title:item.title,status:'待交回',message:'未找到交回的 reply-1.md'});continue;}
    try{await importOfflineReply(item.task,item.round,stitchReplies(parts.map(part=>part.trim())));}
    catch(error){item.message=`交回内容不是完整的单个JSON，请检查后重存：${error instanceof Error?error.message:''}`;item.updated_at=now();await saveLedger(out,ledger);results.push({seq:item.seq,title:item.title,status:'待交回',message:item.message});continue;}
    item.history.push({at:now(),event:'returned',detail:`round ${item.round}, ${parts.length} part(s)`});
    const startedAt=now();
    try{
      item.job_id=await dispatch(http,item);
      await settle(out,item,await waitTerminal(http,item,item.job_id,options.timeoutMs??600000),startedAt);
    }catch(error){item.status='失败';item.message=error instanceof Error?error.message:'交回处理失败';item.history.push({at:now(),event:'import_failed',detail:item.message});item.updated_at=now();}
    await saveLedger(out,ledger);
    results.push({seq:item.seq,title:item.title,status:item.status,round:item.round,zip:item.zip,message:item.message});
  }
  await saveLedger(out,ledger);
  return{out,processed:results.length,results,ledger:join(out,'对账台.md')};
}

export async function offlineStatus(options:{out:string}){
  const out=resolve(options.out),ledger=await loadLedger(out);
  const summary=Object.fromEntries((['待交回','已入库','失败'] as Status[]).map(s=>[s,ledger.items.filter(item=>item.status===s).length]));
  return{out,summary,items:ledger.items.map(({history,...item})=>item)};
}
