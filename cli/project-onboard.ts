/**
 * 职责：面向 Agent 与批量操作的期次材料包自动选版加载与一键建题编排（纯 HTTP API 客户端，不直连数据库）。
 * 核心入口：
 *   1. `resolvePackageSourceForProject()`：按期次 material_processing_mode 自动解析材料包最新可用脱敏或提取版本，并校验 10 页门槛与可选整理状态；
 *   2. `loadPackageIntoProject()`：支持显式或自动选版加载（及跨期复用参数）到指定期次；
 *   3. `onboardProjectMaterials()`：支持单包（--package）、多包列表（--packages）、按候选自动挑选（--count）或清单续跑（--file），一步完成加载与幂等建题并返回 workflow_ids。
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ApiClient,CliError} from './client';
import {atomicWriteJson,isUuid,UUID_PATTERN,writeExclusiveJson} from './shared';

const STRICT_UUID_V5_SOURCE='ai-distill:project-materials-onboard:v1';

export interface PackageSourceSelection {
 package_id:string;
 package_name:string;
 revision_id:string;
 redaction_id:string|null;
 extraction_job_id:string|null;
 load_eligible:boolean|null;
 load_estimated_docx_pages:number|null;
 preparation_id?:string|null;
}

export interface OnboardItemSpec {
 package_id:string;
 redaction_id?:string;
 revision_id?:string;
 request_key?:string;
 title?:string;
 scenario?:string;
 role?:string;
 level?:string;
 direction?:string;
 tags?:string[];
 reuse_source_workflow_id?:string;
}

export interface OnboardOptions {
 projectId:string;
 mode:'single'|'packages'|'count'|'file';
 single?:OnboardItemSpec;
 packageIds?:string[];
 count?:number;
 query?:string;
 filePath?:string;
 outPath?:string;
 requirePrepared?:boolean;
 loadOnly?:boolean;
 allowShort?:boolean;
 defaultScenario?:string;
 defaultRole?:string;
 defaultLevel?:string;
 defaultDirection?:string;
 defaultTags?:string[];
}

/** 生成符合服务端版本校验正则（v5/89ab变体）的确定性幂等UUID，保证无 --request-key 重放时仍严格幂等不重复建题。 */
export function deterministicRequestKey(parts:ReadonlyArray<string|null|undefined>):string{
 const digest=createHash('sha256').update([STRICT_UUID_V5_SOURCE,...parts.map(part=>part??'')].join('\0')).digest();
 const bytes=Uint8Array.from(digest.subarray(0,16));
 bytes[6]=(bytes[6]!&0x0f)|0x50;
 bytes[8]=(bytes[8]!&0x3f)|0x80;
 const hex=Buffer.from(bytes).toString('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

function inferPackageLevel(packageName:string):string|undefined{
 const match=/(?:^|[-_\s])L([2-5])(?=$|[-_\s])/i.exec(packageName);
 return match?`L${match[1]}`:undefined;
}

function clampTitle(raw:string):string{
 const trimmed=raw.trim();
 if(!trimmed)throw new CliError('题目标题不能为空');
 return trimmed.length<=180?trimmed:trimmed.slice(0,180).trim();
}

function unwrapItems(value:any):any[]{
 return Array.isArray(value)?value:Array.isArray(value?.items)?value.items:[];
}

export async function readPhaseProcessingMode(api:ApiClient,projectId:string,signal?:AbortSignal):Promise<'aliases'|'original'>{
 const resp=await api.json(`/api/projects/${projectId}/material-processing`,'GET',undefined,signal);
 const mode=resp?.material_processing_mode;
 if(mode==='mask')throw new CliError('当前期次处于已退役的遮挡模式（mask），请先在期次设置切换为 aliases 或 original');
 return mode==='original'?'original':'aliases';
}

export async function resolvePackageSourceForProject(
 api:ApiClient,
 projectId:string,
 packageId:string,
 options:{
  processingMode?:'aliases'|'original';
  explicitRedactionId?:string;
  explicitRevisionId?:string;
  requirePrepared?:boolean;
  allowShort?:boolean;
  knownPackage?:{name?:string;current_revision_id?:string|null;deleted_at?:string|null};
  signal?:AbortSignal;
 }={}
):Promise<{ok:true;selection:PackageSourceSelection}|{ok:false;reason:string;package_name?:string}>{
 const mode=options.processingMode??await readPhaseProcessingMode(api,projectId,options.signal);
 if(options.explicitRedactionId&&options.explicitRevisionId){
  throw new CliError('--redaction 与 --revision 不能同时指定');
 }
 if(mode==='original'&&options.explicitRedactionId){
  return{ok:false,reason:'当前期次为原文模式（original），不能加载脱敏结果'};
 }
 if(mode!=='original'&&options.explicitRevisionId){
  return{ok:false,reason:'当前期次为脱敏模式（aliases），不能直接按未脱敏 revision 加载'};
 }

 const [pkg,revisionsRaw]=options.knownPackage&&options.knownPackage.name!==undefined&&options.knownPackage.current_revision_id!==undefined
  ?[options.knownPackage,await api.json(`/api/material-library/packages/${packageId}/revisions?page=1&page_size=50`,'GET',undefined,options.signal)]
  :await Promise.all([
   api.json(`/api/material-library/packages/${packageId}`,'GET',undefined,options.signal),
   api.json(`/api/material-library/packages/${packageId}/revisions?page=1&page_size=50`,'GET',undefined,options.signal),
  ]);
 if(!pkg||pkg.deleted_at)return{ok:false,reason:'材料包不存在或已归档'};
 const packageName=String(pkg.name??'').trim()||packageId;
 const revisions=unwrapItems(revisionsRaw);
 if(!revisions.length)return{ok:false,reason:'材料包尚无可用版本',package_name:packageName};

 let targetRev:any;
 let selectedRedaction:any=null;
 let extractionJobId:string|null=null;

 if(mode==='original'){
  const wantedRevId=options.explicitRevisionId??pkg.current_revision_id;
  targetRev=revisions.find((r:any)=>r.id===wantedRevId);
  if(!targetRev||targetRev.state!=='ready')return{ok:false,reason:'目标 revision 未就绪',package_name:packageName};
  const extractJob=(Array.isArray(targetRev.jobs)?targetRev.jobs:[]).find((j:any)=>j.kind==='extract'&&j.status==='succeeded');
  if(!extractJob)return{ok:false,reason:'目标 revision 尚无成功的文本提取结果',package_name:packageName};
  extractionJobId=String(extractJob.id);
 }else{
  if(options.explicitRedactionId){
   for(const rev of revisions){
    const hit=(Array.isArray(rev.redactions)?rev.redactions:[]).find((r:any)=>r.id===options.explicitRedactionId);
    if(hit){targetRev=rev;selectedRedaction=hit;break;}
   }
   if(!targetRev||!selectedRedaction)return{ok:false,reason:'指定的脱敏结果不属于该材料包',package_name:packageName};
  }else{
   const preferredRevs=pkg.current_revision_id?[revisions.find((r:any)=>r.id===pkg.current_revision_id),...revisions.filter((r:any)=>r.id!==pkg.current_revision_id)].filter(Boolean):revisions;
   for(const rev of preferredRevs){
    if(rev.state!=='ready')continue;
    const usable=(Array.isArray(rev.redactions)?rev.redactions:[]).find((r:any)=>
     (r.usable_for_question===true||r.usable_for_question==='true')&&(r.redaction_template_workflow==='codex_plan'||r.redaction_template_id==='aliases')
    );
    if(usable){targetRev=rev;selectedRedaction=usable;break;}
   }
   if(!targetRev||!selectedRedaction)return{ok:false,reason:'材料包尚无可用于建题的 aliases 脱敏结果',package_name:packageName};
  }
  if(!(selectedRedaction.usable_for_question===true||selectedRedaction.usable_for_question==='true')){
   return{ok:false,reason:'所选脱敏结果未通过建题可用性校验',package_name:packageName};
  }
  extractionJobId=selectedRedaction.extraction_job_id?String(selectedRedaction.extraction_job_id):null;
 }

 const loadEligible=selectedRedaction?.load_eligible??targetRev.load_eligible??null;
 const estimatedPages=selectedRedaction?.load_estimated_docx_pages??targetRev.load_estimated_docx_pages??null;
 if(!options.allowShort&&(loadEligible===false||(typeof estimatedPages==='number'&&estimatedPages<=10))){
  return{ok:false,reason:`拼接材料DOCX估算仅 ${estimatedPages??'<=10'} 页（不足11页门槛）`,package_name:packageName};
 }

 let preparationId:string|null=null;
 if(options.requirePrepared){
  const params=new URLSearchParams({
   revision_id:String(targetRev.id),
   redaction_id:selectedRedaction?String(selectedRedaction.id):'',
   project_id:projectId,
   summary_only:'true',
   page_size:'5',
  });
  const prepResp=await api.json(`/api/material-library/packages/${packageId}/preparations?${params}`,'GET',undefined,options.signal);
  const validPrep=unwrapItems(prepResp).find((item:any)=>item?.result?.format==='material-preparation-v2');
  if(!prepResp?.available||!validPrep){
   return{ok:false,reason:'材料包尚未完成匹配当前来源的材料整理（prepare）',package_name:packageName};
  }
  preparationId=String(validPrep.id);
 }

 return{
  ok:true,
  selection:{
   package_id:packageId,
   package_name:packageName,
   revision_id:String(targetRev.id),
   redaction_id:selectedRedaction?String(selectedRedaction.id):null,
   extraction_job_id:extractionJobId,
   load_eligible:loadEligible===null?null:Boolean(loadEligible),
   load_estimated_docx_pages:typeof estimatedPages==='number'?estimatedPages:null,
   ...(options.requirePrepared?{preparation_id:preparationId}:{}),
  },
 };
}

export async function loadPackageIntoProject(
 api:ApiClient,
 projectId:string,
 packageId:string,
 options:{
  redactionId?:string;
  revisionId?:string;
  reuseSourceWorkflowId?:string;
  reuseDirection?:string;
  allowShort?:boolean;
  processingMode?:'aliases'|'original';
  signal?:AbortSignal;
 }={}
){
 if((options.reuseSourceWorkflowId===undefined)!==(options.reuseDirection===undefined)){
  throw new CliError('跨期复用须同时提供 --reuse-workflow 与 --direction');
 }
 let redactionId=options.redactionId;
 let revisionId=options.revisionId;
 let resolvedMeta:PackageSourceSelection|undefined;
 if(!redactionId&&!revisionId){
  const resolved=await resolvePackageSourceForProject(api,projectId,packageId,{
   processingMode:options.processingMode,
   allowShort:options.allowShort,
   signal:options.signal,
  });
  if(!resolved.ok)throw new CliError(`${resolved.package_name?`[${resolved.package_name}] `:''}${resolved.reason}`);
  resolvedMeta=resolved.selection;
  if(resolvedMeta.redaction_id)redactionId=resolvedMeta.redaction_id;
  else revisionId=resolvedMeta.revision_id;
 }
 const loaded=await api.json(`/api/projects/${projectId}/loaded-materials`,'POST',{
  package_id:packageId,
  ...(redactionId?{redaction_id:redactionId}:{revision_id:revisionId}),
  ...(options.reuseSourceWorkflowId?{reuse_source_workflow_id:options.reuseSourceWorkflowId,reuse_direction:options.reuseDirection}:{}),
 },options.signal);
 if(!options.allowShort&&(loaded?.load_eligible===false||(typeof loaded?.load_estimated_docx_pages==='number'&&loaded.load_estimated_docx_pages<=10))){
  throw new CliError(`材料包估算仅 ${loaded.load_estimated_docx_pages??'<=10'} 页（不足11页门槛）；若确需保留低页数包请显式传 --allow-short`);
 }
 return{...loaded,...(resolvedMeta?{resolved_source:resolvedMeta}:{})};
}

async function listAllLoadedByPackage(api:ApiClient,projectId:string,signal?:AbortSignal):Promise<Map<string,any>>{
 const map=new Map<string,any>();
 for(let page=1;;page++){
  const res=await api.json(`/api/projects/${projectId}/loaded-materials?page=${page}&page_size=200`,'GET',undefined,signal);
  for(const item of unwrapItems(res))if(item?.package_id&&!item.removed_at)map.set(String(item.package_id),item);
  if(!res?.has_more)break;
 }
 return map;
}

async function listExistingQuestionTitles(api:ApiClient,projectId:string,signal?:AbortSignal):Promise<Map<string,string>>{
 const byPackageOrTitle=new Map<string,string>();
 for(let page=1;;page++){
  const res=await api.json(`/api/projects/${projectId}/questions?page=${page}&limit=200`,'GET',undefined,signal);
  const workflows=Array.isArray(res?.workflows)?res.workflows:[];
  for(const wf of workflows){
   if(typeof wf?.package_id==='string'&&typeof wf?.id==='string')byPackageOrTitle.set(`pkg:${wf.package_id}`,wf.id);
   if(typeof wf?.title==='string'&&typeof wf?.id==='string')byPackageOrTitle.set(`title:${wf.title}`,wf.id);
  }
  if(!res?.has_more)break;
 }
 return byPackageOrTitle;
}

function normalizeSpecItem(raw:any,index:number):OnboardItemSpec&{state?:string;workflow_id?:string;link_id?:string}{
 if(typeof raw==='string'){
  if(!UUID_PATTERN.test(raw))throw new CliError(`清单第${index+1}项材料包ID须为UUID`);
  return{package_id:raw.toLowerCase()};
 }
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new CliError(`清单第${index+1}项须为对象或材料包UUID`);
 const allowed=['package_id','package_name','redaction_id','revision_id','request_key','title','scenario','role','role_perspective','level','target_level','direction','authoring_direction','tags','question_tags','reuse_source_workflow_id','state','status','workflow_id','link_id','link_version','reused','reason','error','load_estimated_docx_pages','preparation_id','source_digest','snapshot_digest'];
 for(const key of Object.keys(raw))if(!allowed.includes(key))throw new CliError(`清单第${index+1}项包含未知字段：${key}`);
 if(typeof raw.package_id!=='string'||!UUID_PATTERN.test(raw.package_id))throw new CliError(`清单第${index+1}项缺少有效 package_id`);
 for(const field of ['redaction_id','revision_id','request_key','reuse_source_workflow_id'] as const){
  if(raw[field]!==undefined&&raw[field]!==null&&(typeof raw[field]!=='string'||!UUID_PATTERN.test(raw[field]))){
   throw new CliError(`清单第${index+1}项 ${field} 须为UUID`);
  }
 }
 const isPersistedReceipt=raw.state!==undefined||raw.status!==undefined;
 if(!isPersistedReceipt&&raw.redaction_id&&raw.revision_id)throw new CliError(`清单第${index+1}项不能同时指定 redaction_id 与 revision_id`);
 const level=raw.level??raw.target_level;
 if(level!==undefined&&level!==null&&!['L2','L3','L4','L5'].includes(String(level)))throw new CliError(`清单第${index+1}项 level 须为 L2 至 L5`);
 const rawTags=raw.tags??raw.question_tags;
 const tags=Array.isArray(rawTags)?rawTags.map((t:unknown)=>String(t).trim()).filter(Boolean):typeof rawTags==='string'?rawTags.split(',').map((t:string)=>t.trim()).filter(Boolean):undefined;
 return{
  package_id:raw.package_id.toLowerCase(),
  ...(raw.redaction_id?{redaction_id:raw.redaction_id.toLowerCase()}:raw.revision_id?{revision_id:raw.revision_id.toLowerCase()}:{}),
  ...(raw.request_key?{request_key:raw.request_key.toLowerCase()}:{}),
  ...(typeof raw.title==='string'&&raw.title.trim()?{title:raw.title.trim()}:{}),
  ...(typeof raw.scenario==='string'&&raw.scenario.trim()?{scenario:raw.scenario}:{}),
  ...(typeof (raw.role??raw.role_perspective)==='string'&&String(raw.role??raw.role_perspective).trim()?{role:String(raw.role??raw.role_perspective)}:{}),
  ...(level?{level:String(level)}:{}),
  ...(typeof (raw.direction??raw.authoring_direction)==='string'&&String(raw.direction??raw.authoring_direction).trim()?{direction:String(raw.direction??raw.authoring_direction)}:{}),
  ...(tags?.length?{tags}:{}),
  ...(raw.reuse_source_workflow_id?{reuse_source_workflow_id:raw.reuse_source_workflow_id.toLowerCase()}:{}),
  ...(typeof (raw.state??raw.status)==='string'?{state:String(raw.state??raw.status)}:{}),
  ...(typeof raw.workflow_id==='string'?{workflow_id:raw.workflow_id}:{}),
  ...(typeof raw.link_id==='string'?{link_id:raw.link_id}:{}),
 };
}

export async function onboardProjectMaterials(api:ApiClient,options:OnboardOptions,signal?:AbortSignal){
 const projectId=options.projectId.toLowerCase();
 const processingMode=await readPhaseProcessingMode(api,projectId,signal);
 const sourceMode=processingMode==='original'?'original':'redacted';

 const outPath=options.outPath?resolve(options.outPath):undefined;
 const state:any={
  version:1,
  project_id:projectId,
  material_processing_mode:processingMode,
  load_only:Boolean(options.loadOnly),
  require_prepared:Boolean(options.requirePrepared),
  created_at:new Date().toISOString(),
  items:[] as any[],
 };

 const persist=async(initial=false)=>{
  if(!outPath)return;
  if(initial){
   await writeExclusiveJson(outPath,state,'输出回执文件必须尚不存在且目录可写');
   return;
  }
  await atomicWriteJson(outPath,state);
 };

 let specs:Array<OnboardItemSpec&{state?:string;workflow_id?:string;link_id?:string}>=[];
 if(options.mode==='single'&&options.single){
  specs=[{...options.single,package_id:options.single.package_id.toLowerCase()}];
 }else if(options.mode==='packages'&&options.packageIds){
  specs=options.packageIds.map(pkgId=>({package_id:pkgId.toLowerCase()}));
 }else if(options.mode==='file'&&options.filePath){
  let rawText:string;
  try{rawText=await readFile(resolve(options.filePath),'utf8');}catch{throw new CliError('建题清单文件无法读取',{kind:'file_error'});}
  let parsed:any;
  try{parsed=JSON.parse(rawText);}catch{throw new CliError('建题清单文件不是有效JSON',{kind:'file_error'});}
  if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&parsed.project_id&&String(parsed.project_id).toLowerCase()!==projectId){
   throw new CliError('清单中的 project_id 与命令行 --project 不一致');
  }
  const rawList=Array.isArray(parsed)?parsed:Array.isArray(parsed?.items)?parsed.items:null;
  if(!rawList||!rawList.length||rawList.length>1000)throw new CliError('建题清单须包含 1 至 1000 项 items');
  specs=rawList.map((entry:any,idx:number)=>normalizeSpecItem(entry,idx));
 }

 const [loadedByPkg,existingQuestions]=options.mode==='single'
  ?[new Map<string,any>(),new Map<string,string>()]
  :await Promise.all([listAllLoadedByPackage(api,projectId,signal),listExistingQuestionTitles(api,projectId,signal)]);

 if(options.mode==='count'){
  state.requested_count=options.count!;
 }else{
  state.items=specs.map(spec=>({
   package_id:spec.package_id,
   ...(spec.redaction_id?{redaction_id:spec.redaction_id}:{}),
   ...(spec.revision_id?{revision_id:spec.revision_id}:{}),
   ...(spec.request_key?{request_key:spec.request_key}:{}),
   ...(spec.title?{title:spec.title}:{}),
   ...(spec.scenario?{scenario:spec.scenario}:{}),
   ...(spec.role?{role:spec.role}:{}),
   ...(spec.level?{level:spec.level}:{}),
   ...(spec.direction?{direction:spec.direction}:{}),
   ...(spec.tags?.length?{tags:spec.tags}:{}),
   ...(spec.reuse_source_workflow_id?{reuse_source_workflow_id:spec.reuse_source_workflow_id}:{}),
   ...(spec.workflow_id?{workflow_id:spec.workflow_id}:{}),
   ...(spec.link_id?{link_id:spec.link_id}:{}),
   state:spec.state&&['created','reused','loaded_only'].includes(spec.state)?spec.state:'pending',
  }));
 }
 await persist(true);

 let acceptedCount=0;
 let haltedByUnknown=false;
 const maxToAccept=options.mode==='count'?options.count!:Number.MAX_SAFE_INTEGER;

 const processSpecRow=async(
  spec:OnboardItemSpec&{state?:string;workflow_id?:string;link_id?:string},
  row:any,
  knownPackage?:{name?:string;current_revision_id?:string|null;deleted_at?:string|null},
 )=>{
  if(['created','reused','loaded_only'].includes(row.state)){
   acceptedCount++;
   return;
  }
  if(acceptedCount>=maxToAccept){
   row.state='not_needed';
   return;
  }

  // 批量模式若该包已在本期建过题，直接记录跳过，避免 Work 等项目触发 409 或在多包批次制造重复题目。
  if(options.mode!=='single'&&!options.loadOnly&&existingQuestions.has(`pkg:${spec.package_id}`)){
   row.state='skipped';
   row.workflow_id=existingQuestions.get(`pkg:${spec.package_id}`);
   row.reason='该材料包在本期已有题目工作流';
   await persist();
   return;
  }

  const resolved=await resolvePackageSourceForProject(api,projectId,spec.package_id,{
   processingMode,
   explicitRedactionId:spec.redaction_id,
   explicitRevisionId:spec.revision_id,
   requirePrepared:options.requirePrepared,
   allowShort:options.allowShort,
   knownPackage,
   signal,
  });
  if(!resolved.ok){
   row.package_name=resolved.package_name;
   row.state=options.mode==='count'?'skipped':'failed';
   row.reason=resolved.reason;
   if(options.mode!=='count')await persist();
   if(options.mode==='single')throw new CliError(`${resolved.package_name?`[${resolved.package_name}] `:''}${resolved.reason}`);
   return;
  }

  const sel=resolved.selection;
  row.package_name=sel.package_name;
  row.revision_id=sel.revision_id;
  row.redaction_id=sel.redaction_id;
  if(sel.load_estimated_docx_pages!==null)row.load_estimated_docx_pages=sel.load_estimated_docx_pages;
  if(sel.preparation_id)row.preparation_id=sel.preparation_id;

  const direction=spec.direction??options.defaultDirection;
  if(spec.reuse_source_workflow_id&&!direction){
   row.state='failed';row.reason='跨期复用须提供出题方向（direction）';await persist();
   if(options.mode==='single')throw new CliError(row.reason);
   return;
  }

  let loaded:any;
  try{
   loaded=await api.json(`/api/projects/${projectId}/loaded-materials`,'POST',{
    package_id:spec.package_id,
    ...(sel.redaction_id?{redaction_id:sel.redaction_id}:{revision_id:sel.revision_id}),
    ...(spec.reuse_source_workflow_id?{reuse_source_workflow_id:spec.reuse_source_workflow_id,reuse_direction:direction}:{}),
   },signal);
  }catch(error){
   row.state=options.mode==='count'&&(error instanceof CliError&&error.detail.http_status===409)?'skipped':'failed';
   row.reason=error instanceof Error?error.message:'加载材料包失败';
   await persist();
   if(options.mode==='single')throw error;
   if(error instanceof CliError&&error.detail.outcome_unknown===true)haltedByUnknown=true;
   return;
  }

  row.link_id=String(loaded.id);
  row.link_version=Number(loaded.lock_version);
  if(typeof loaded.load_estimated_docx_pages==='number')row.load_estimated_docx_pages=loaded.load_estimated_docx_pages;
  if(!options.allowShort&&(loaded.load_eligible===false||(typeof loaded.load_estimated_docx_pages==='number'&&loaded.load_estimated_docx_pages<=10))){
   row.state=options.mode==='count'?'skipped':'failed';
   row.reason=`拼接材料DOCX估算仅 ${loaded.load_estimated_docx_pages??'<=10'} 页（不足11页门槛）`;
   await persist();
   if(options.mode==='single')throw new CliError(row.reason);
   return;
  }

  if(options.loadOnly){
   row.state='loaded_only';
   acceptedCount++;
   await persist();
   return;
  }

  const title=clampTitle(spec.title??sel.package_name);
  const level=spec.level??options.defaultLevel??inferPackageLevel(sel.package_name);
  const scenario=spec.scenario??options.defaultScenario;
  const role=spec.role??options.defaultRole;
  const tags=spec.tags??options.defaultTags;
  const requestKey=spec.request_key??row.request_key??deterministicRequestKey([
   projectId,
   spec.package_id,
   sel.redaction_id??sel.revision_id,
   title,
   direction??null,
   level??null,
   scenario??null,
   role??null,
   tags?.join(',')??null,
  ]);
  row.title=title;
  row.request_key=requestKey;
  row.state='creating_question';
  await persist();

  try{
   const created=await api.json(`/api/projects/${projectId}/loaded-materials/${row.link_id}/questions`,'POST',{
    request_key:requestKey,
    expected_link_version:row.link_version,
    ...(sel.redaction_id?{redaction_id:sel.redaction_id}:{revision_id:sel.revision_id}),
    title,
    ...(scenario?{scenario}:{}),
    ...(role?{role_perspective:role}:{}),
    ...(level?{target_level:level}:{}),
    ...(direction?{authoring_direction:direction}:{}),
    ...(tags?.length?{question_tags:tags}:{}),
   },signal);
   row.workflow_id=String(created.id);
   row.reused=Boolean(created.reused);
   row.source_digest=created.source_digest;
   row.snapshot_digest=created.snapshot_digest;
   row.state=created.reused?'reused':'created';
   delete row.reason;
   existingQuestions.set(`pkg:${spec.package_id}`,row.workflow_id);
   acceptedCount++;
   await persist();
  }catch(error){
   const unknown=error instanceof CliError&&error.detail.outcome_unknown===true;
   row.state=unknown?'unknown':'failed';
   row.reason=error instanceof Error?error.message:'创建题目失败';
   await persist();
   if(options.mode==='single')throw error;
   if(unknown)haltedByUnknown=true;
  }
 };

 if(options.mode==='count'){
  const targetCount=options.count!;
  const pageSize=Math.min(100,Math.max(20,targetCount*4));
  const seen=new Set<string>();
  for(let page=1;!signal?.aborted&&!haltedByUnknown&&acceptedCount<maxToAccept;page++){
   const qParams=new URLSearchParams({
    page:String(page),
    page_size:String(pageSize),
    source_mode:sourceMode,
    ...(options.requirePrepared?{preparation_state:'ready'}:{}),
    ...(options.query?{q:options.query}:{}),
   });
   const catalog=await api.json(`/api/projects/${projectId}/material-candidates?${qParams}`,'GET',undefined,signal);
   const items=unwrapItems(catalog);
   for(const candidate of items){
    if(signal?.aborted||haltedByUnknown||acceptedCount>=maxToAccept)break;
    const pkgId=String(candidate?.id??'').toLowerCase();
    if(!UUID_PATTERN.test(pkgId)||seen.has(pkgId))continue;
    seen.add(pkgId);
    const alreadyLoadedHere=loadedByPkg.has(pkgId);
    if(candidate.used_in_project&&!alreadyLoadedHere)continue;
    if(existingQuestions.has(`pkg:${pkgId}`))continue;
    if(!options.allowShort&&(candidate.load_eligible===false||(typeof candidate.load_estimated_docx_pages==='number'&&candidate.load_estimated_docx_pages<=10)))continue;
    const spec={package_id:pkgId};
    const row:any={package_id:pkgId,state:'pending'};
    state.items.push(row);
    const knownPkg=(typeof candidate.name==='string'&&'current_revision_id' in candidate)
     ?{name:candidate.name,current_revision_id:candidate.current_revision_id??null,deleted_at:candidate.deleted_at??null}
     :undefined;
    await processSpecRow(spec,row,knownPkg);
   }
   if(page*pageSize>=Number(catalog?.total_count??0)||!items.length)break;
  }
  state.items=state.items.filter((item:any)=>item.state!=='pending'&&item.state!=='not_needed');
  await persist();
 }else{
  for(const [index,spec] of specs.entries()){
   if(signal?.aborted||haltedByUnknown)break;
   await processSpecRow(spec,state.items[index]!);
  }
 }

 const counts=state.items.reduce((acc:Record<string,number>,item:any)=>{
  acc[item.state]=(acc[item.state]??0)+1;
  return acc;
 },{});
 const workflowIds=state.items.filter((item:any)=>typeof item.workflow_id==='string'&&['created','reused'].includes(item.state)).map((item:any)=>item.workflow_id as string);
 const linkIds=[...new Set(state.items.filter((item:any)=>typeof item.link_id==='string').map((item:any)=>item.link_id as string))];
 const countShortfall=options.mode==='count'&&acceptedCount<options.count!;
 const hasFailureOrUnknown=state.items.some((item:any)=>item.state==='failed'||item.state==='unknown');

 return{
  outcome:hasFailureOrUnknown||countShortfall?'partial':'complete',
  data:{
   project_id:projectId,
   material_processing_mode:processingMode,
   ...(outPath?{receipt_file:outPath}:{}),
   ...(options.mode==='count'?{requested_count:options.count,accepted_count:acceptedCount}:{}),
   counts,
   workflow_ids:workflowIds,
   link_ids:linkIds,
   items:state.items,
  },
 };
}
