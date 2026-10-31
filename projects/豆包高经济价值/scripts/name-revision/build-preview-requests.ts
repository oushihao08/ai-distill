/**
 * 职责：汇总已冻结的主体映射复核响应，校验请求绑定，并生成逐包 preview 请求；不调用模型、不访问 API、不应用替换。
 * 入口：bun .../build-preview-requests.ts <请求目录> <响应目录> <输出目录> <项目ID> <固定范围JSON>。
 * 影响：只在仓库 .storage 私有目录原子写入 0600 清单及请求；有未决项的包不会生成 preview 请求。
 */
import {createHash,randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {validateNameMappingReview,type NameMappingPackage} from '../../../../server/material-library/name-mapping-review';
import {canonicalJson} from '../../../../shared/workflow-config';

const [requestArg,responseArg,outputArg,projectId,scopeArg]=process.argv.slice(2);
if(!requestArg||!responseArg||!outputArg||!projectId||!scopeArg)throw new Error('用法：build-preview-requests.ts <请求目录> <响应目录> <输出目录> <项目ID> <固定范围JSON>');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if(!uuid.test(projectId))throw new Error('项目ID无效');

const root=resolve(process.cwd()),storage=join(root,'.storage');
const requests=resolve(requestArg),responses=resolve(responseArg),output=resolve(outputArg),scopePath=resolve(scopeArg);
function insideStorage(path:string){const value=relative(storage,path);return value!==''&&!value.startsWith('..')&&!isAbsolute(value);}
function insideRoot(path:string){const value=relative(root,path);return value===''||!value.startsWith('..')&&!isAbsolute(value);}
if(!insideStorage(requests)||!insideStorage(responses)||!insideStorage(output))throw new Error('请求、响应和输出目录必须位于当前仓库 .storage 私有目录');
if(new Set([requests,responses,output]).size!==3)throw new Error('请求、响应和输出目录不能相同');
if(!insideRoot(scopePath))throw new Error('固定范围JSON必须位于当前仓库内');

type RecordValue=Record<string,unknown>;
const object=(value:unknown):value is RecordValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
async function parse(path:string){return JSON.parse(await readFile(path,'utf8')) as unknown;}
async function writePrivate(path:string,value:unknown){
 await mkdir(output,{recursive:true,mode:0o700});await chmod(output,0o700);
 const temporary=join(output,`.${randomUUID()}.tmp`);
 try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);await chmod(path,0o600);}finally{await rm(temporary,{force:true});}
}

const rawScope=await parse(scopePath);
if(!Array.isArray(rawScope)||rawScope.length!==54)throw new Error('固定范围必须恰好包含54个材料包');
const scopeTuples=new Map<string,{package_id:string;redaction_id:string;workflow_id:string}>();
const scopeRedactions=new Set<string>(),scopeWorkflows=new Set<string>();
for(const raw of rawScope){
 if(!object(raw)||!uuid.test(String(raw.package_id))||!uuid.test(String(raw.redaction_id))||!Array.isArray(raw.workflows)||raw.workflows.length!==1||!object(raw.workflows[0])||!uuid.test(String(raw.workflows[0].id)))throw new Error('固定范围存在无效或非唯一的包/脱敏/题目身份');
 const tuple={package_id:String(raw.package_id),redaction_id:String(raw.redaction_id),workflow_id:String(raw.workflows[0].id)};
 if(scopeTuples.has(tuple.package_id)||scopeRedactions.has(tuple.redaction_id)||scopeWorkflows.has(tuple.workflow_id))throw new Error('固定范围存在重复身份');
 scopeTuples.set(tuple.package_id,tuple);scopeRedactions.add(tuple.redaction_id);scopeWorkflows.add(tuple.workflow_id);
}
const scopeDigest=sha256(canonicalJson([...scopeTuples.values()].sort((a,b)=>a.package_id.localeCompare(b.package_id))));

const requestFiles=(await readdir(requests)).filter(name=>/^\d{2}\.request\.json$/.test(name)).sort();
if(!requestFiles.length)throw new Error('请求目录没有复核批次');
const responseFiles=new Set((await readdir(responses)).filter(name=>/^\d{2}\.response\.json$/.test(name)));
const knownResponses=new Set(requestFiles.map(name=>name.replace('.request.json','.response.json')));
const unexpected=[...responseFiles].filter(name=>!knownResponses.has(name));
if(unexpected.length)throw new Error(`存在无对应请求的响应：${unexpected.join(', ')}`);

const packagesSeen=new Set<string>(),redactionsSeen=new Set<string>(),workflowsSeen=new Set<string>();
const manifestPackages:RecordValue[]=[],previewFiles:Array<{path:string;value:unknown}>=[],missingBatches:string[]=[];
let mappingCount=0,unresolvedCount=0,ignoredCount=0,completedBatchCount=0;

for(const requestFile of requestFiles){
 const batch=requestFile.slice(0,2),rawRequest=await parse(join(requests,requestFile));
 if(!object(rawRequest)||Object.keys(rawRequest).some(key=>!['model','reasoning_effort','packages'].includes(key))||typeof rawRequest.model!=='string'||typeof rawRequest.reasoning_effort!=='string'||!Array.isArray(rawRequest.packages)||!rawRequest.packages.length)throw new Error(`批次${batch}请求结构无效`);
 if(rawRequest.model!=='gpt-5.6-sol'||rawRequest.reasoning_effort!=='medium')throw new Error(`批次${batch}未使用固定的 gpt-5.6-sol / medium`);
 const sourcePackages=rawRequest.packages as unknown as NameMappingPackage[];
 for(const source of sourcePackages){
  if(!object(source)||!uuid.test(String(source.package_id))||!uuid.test(String(source.redaction_id))||!uuid.test(String(source.workflow_id))||!Array.isArray(source.candidates)||!source.candidates.length)throw new Error(`批次${batch}材料包请求无效`);
  const scope=scopeTuples.get(String(source.package_id));
  if(!scope||scope.redaction_id!==source.redaction_id||scope.workflow_id!==source.workflow_id)throw new Error(`批次${batch}材料包身份未绑定固定范围`);
  if(packagesSeen.has(source.package_id)||redactionsSeen.has(source.redaction_id)||workflowsSeen.has(source.workflow_id))throw new Error(`批次${batch}存在跨批次重复身份`);
  packagesSeen.add(source.package_id);redactionsSeen.add(source.redaction_id);workflowsSeen.add(source.workflow_id);
 }
 const responseFile=`${batch}.response.json`;
 if(!responseFiles.has(responseFile)){missingBatches.push(batch);continue;}
 const rawResponse=await parse(join(responses,responseFile));
 const allowed=['format','call_id','request_digest','requested_model','reasoning_effort','returned_model','session_id','usage','duration_ms','packages'];
 if(!object(rawResponse)||Object.keys(rawResponse).some(key=>!allowed.includes(key))||rawResponse.format!=='name-mapping-review-v1'||typeof rawResponse.call_id!=='string'||typeof rawResponse.request_digest!=='string'||rawResponse.requested_model!==rawRequest.model||rawResponse.reasoning_effort!==rawRequest.reasoning_effort||!Array.isArray(rawResponse.packages))throw new Error(`批次${batch}响应元数据无效或与请求不一致`);
 const expectedDigest=sha256(canonicalJson({format:'name-mapping-candidates-v1',packages:sourcePackages}));
 if(rawResponse.request_digest!==expectedDigest)throw new Error(`批次${batch}响应摘要未绑定当前请求`);
 const reviewed=validateNameMappingReview({packages:rawResponse.packages},sourcePackages);
 completedBatchCount++;
 const sourceByRedaction=new Map(sourcePackages.map(item=>[item.redaction_id,item]));
 for(const result of reviewed.packages){
  const source=sourceByRedaction.get(result.redaction_id)!;
  mappingCount+=result.mappings.length;unresolvedCount+=result.unresolved.length;ignoredCount+=result.ignored.length;
  const decisions=[...result.mappings.map(item=>({...item,bucket:'mapping'})),...result.unresolved.map(item=>({...item,bucket:'unresolved'})),...result.ignored.map(item=>({...item,bucket:'ignored'}))];
  const byBefore=new Map<string,Array<{original:string;bucket:string}>>();
  for(const decision of decisions){const values=byBefore.get(decision.before)??[];values.push({original:decision.original,bucket:decision.bucket});byBefore.set(decision.before,values);}
  const safetyBlocks:string[]=[];
  for(const values of byBefore.values())if(new Set(values.map(item=>item.original)).size>1||new Set(values.map(item=>item.bucket)).size>1)safetyBlocks.push('ambiguous_before');
  const candidateNames=new Set(source.candidates.flatMap(item=>[item.original,item.before]));
  if(result.mappings.some(mapping=>candidateNames.has(mapping.after)))safetyBlocks.push('conflicting_after');
  let state:'ready_for_preview'|'blocked_by_ambiguity'|'blocked_by_unresolved'|'no_changes';
  let previewFile:string|undefined;
  if(safetyBlocks.length)state='blocked_by_ambiguity';
  else if(result.unresolved.length)state='blocked_by_unresolved';
  else if(!result.mappings.length)state='no_changes';
  else{
   state='ready_for_preview';
   previewFile=`${result.package_id}.${String(rawResponse.request_digest).slice(0,12)}.preview.json`;
   previewFiles.push({path:join(output,previewFile),value:{format:'name-revision-preview-request-v1',package_id:result.package_id,redaction_id:result.redaction_id,scope_digest:scopeDigest,review_call_id:rawResponse.call_id,review_request_digest:rawResponse.request_digest,method:'POST',path:`/api/material-library/redactions/${result.redaction_id}/name-revisions/preview`,body:{project_id:projectId,review_call_id:rawResponse.call_id}}});
  }
  manifestPackages.push({batch,package_id:result.package_id,redaction_id:result.redaction_id,workflow_id:source.workflow_id,state,...(safetyBlocks.length?{safety_blocks:[...new Set(safetyBlocks)]}:{}),review_call_id:rawResponse.call_id,review_request_digest:rawResponse.request_digest,mapping_count:result.mappings.length,unresolved_count:result.unresolved.length,ignored_count:result.ignored.length,...(previewFile?{preview_file:previewFile}:{})});
 }
}

if(packagesSeen.size!==scopeTuples.size)throw new Error(`复核请求包数量${packagesSeen.size}与固定范围${scopeTuples.size}不一致`);
for(const [packageId,scope] of scopeTuples){
 if(!packagesSeen.has(packageId)||!redactionsSeen.has(scope.redaction_id)||!workflowsSeen.has(scope.workflow_id))throw new Error(`复核请求未精确覆盖固定范围包${packageId}`);
}
for(const item of manifestPackages){
 const scope=scopeTuples.get(String(item.package_id));
 if(!scope||scope.redaction_id!==item.redaction_id||scope.workflow_id!==item.workflow_id)throw new Error(`复核结果身份未绑定固定范围包${String(item.package_id)}`);
}
await mkdir(output,{recursive:true,mode:0o700});await chmod(output,0o700);
for(const name of await readdir(output))if(name.endsWith('.preview.json'))await rm(join(output,name),{force:true});
for(const file of previewFiles)await writePrivate(file.path,file.value);
const count=(state:string)=>manifestPackages.filter(item=>item.state===state).length;
const manifest={format:'phase7-name-preview-requests-v1',generated_at:new Date().toISOString(),project_id:projectId,scope_path:relative(root,scopePath),scope_digest:scopeDigest,scope_package_count:scopeTuples.size,model:'gpt-5.6-sol',reasoning_effort:'medium',complete:missingBatches.length===0,request_batch_count:requestFiles.length,completed_batch_count:completedBatchCount,missing_batches:missingBatches,package_count:packagesSeen.size,reviewed_package_count:manifestPackages.length,ready_for_preview_count:count('ready_for_preview'),blocked_by_ambiguity_count:count('blocked_by_ambiguity'),blocked_by_unresolved_count:count('blocked_by_unresolved'),no_changes_count:count('no_changes'),mapping_count: mappingCount,unresolved_count:unresolvedCount,ignored_count:ignoredCount,packages:manifestPackages};
await writePrivate(join(output,'manifest.json'),manifest);
console.log(JSON.stringify({...manifest,packages:undefined}));
