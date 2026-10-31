/**
 * 职责：从任一轮单包主体复核回执提取 unresolved，生成保留原候选证据和父回执绑定的下一轮请求。
 * 入口：bun .../build-unresolved-review-requests.ts <本轮请求目录> <本轮响应目录> <下一轮输出目录>。
 * 影响：只在 .storage 私有目录原子写入 0600 请求、绑定与清单；不调用模型/API，不写业务数据库。
 */
import {createHash,randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {validateNameMappingReview,type NameMappingPackage} from '../../../../server/material-library/name-mapping-review';
import {canonicalJson} from '../../../../shared/workflow-config';

const [requestArg,responseArg,outputArg]=process.argv.slice(2);
if(!requestArg||!responseArg||!outputArg)throw new Error('用法：build-unresolved-review-requests.ts <本轮请求目录> <本轮响应目录> <下一轮输出目录>');
const root=resolve(process.cwd()),storage=join(root,'.storage');
const requests=resolve(requestArg),responses=resolve(responseArg),output=resolve(outputArg);
function insideStorage(path:string){const value=relative(storage,path);return value!==''&&!value.startsWith('..')&&!isAbsolute(value);}
if(!insideStorage(requests)||!insideStorage(responses)||!insideStorage(output))throw new Error('请求、响应和输出目录必须位于当前仓库 .storage 私有目录');
if(new Set([requests,responses,output]).size!==3)throw new Error('请求、响应和输出目录不能相同');

type RecordValue=Record<string,unknown>;
const object=(value:unknown):value is RecordValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function parse(path:string){return JSON.parse(await readFile(path,'utf8')) as unknown;}
async function writePrivate(path:string,value:unknown){
 await mkdir(output,{recursive:true,mode:0o700});await chmod(output,0o700);
 const temporary=join(output,`.${randomUUID()}.tmp`);
 try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);await chmod(path,0o600);}finally{await rm(temporary,{force:true});}
}

const requestFiles=(await readdir(requests)).filter(name=>/^\d{2}\.request\.json$/.test(name)).sort();
if(!requestFiles.length)throw new Error('本轮请求目录没有单包复核请求');
const responseFiles=new Set((await readdir(responses)).filter(name=>/^\d{2}\.response\.json$/.test(name)));
const knownResponses=new Set(requestFiles.map(name=>name.replace('.request.json','.response.json')));
const unexpected=[...responseFiles].filter(name=>!knownResponses.has(name));
if(unexpected.length)throw new Error(`存在无对应本轮请求的响应：${unexpected.join(', ')}`);

await mkdir(output,{recursive:true,mode:0o700});await chmod(output,0o700);
for(const name of await readdir(output))if(/^\d{2}\.(?:request|binding)\.json$/.test(name))await rm(join(output,name),{force:true});

const missingBatches:string[]=[],packages:RecordValue[]=[];
let reviewedPackageCount=0,followupPackageCount=0,unresolvedCount=0;
for(const requestFile of requestFiles){
 const batch=requestFile.slice(0,2),rawRequest=await parse(join(requests,requestFile));
 if(!object(rawRequest)||Object.keys(rawRequest).some(key=>!['model','reasoning_effort','parent_review_call_id','packages'].includes(key))||rawRequest.model!=='gpt-5.6-sol'||rawRequest.reasoning_effort!=='medium'||
  (rawRequest.parent_review_call_id!==undefined&&(typeof rawRequest.parent_review_call_id!=='string'||!uuid.test(rawRequest.parent_review_call_id)))||
  !Array.isArray(rawRequest.packages)||rawRequest.packages.length!==1)throw new Error(`本轮批次${batch}不是固定 gpt-5.6-sol / medium 单包请求`);
 const source=(rawRequest.packages as unknown as NameMappingPackage[])[0];
 if(!source||!Array.isArray(source.candidates)||!source.candidates.length)throw new Error(`本轮批次${batch}候选为空`);
 const responseFile=`${batch}.response.json`;
 if(!responseFiles.has(responseFile)){missingBatches.push(batch);continue;}
 const rawResponse=await parse(join(responses,responseFile));
 if(!object(rawResponse)||rawResponse.format!=='name-mapping-review-v1'||typeof rawResponse.call_id!=='string'||typeof rawResponse.request_digest!=='string'||rawResponse.requested_model!=='gpt-5.6-sol'||rawResponse.reasoning_effort!=='medium'||!Array.isArray(rawResponse.packages))throw new Error(`本轮批次${batch}响应元数据无效`);
 const parentReviewCallId=rawRequest.parent_review_call_id===undefined?undefined:String(rawRequest.parent_review_call_id);
 if((rawResponse.parent_review_call_id===undefined?undefined:String(rawResponse.parent_review_call_id))!==parentReviewCallId)throw new Error(`本轮批次${batch}响应父回执未绑定请求`);
 const expectedDigest=hash(canonicalJson({format:'name-mapping-candidates-v1',...(parentReviewCallId?{parent_review_call_id:parentReviewCallId}:{}),packages:[source]}));
 if(rawResponse.request_digest!==expectedDigest)throw new Error(`本轮批次${batch}响应摘要未绑定请求`);
 const reviewed=validateNameMappingReview({packages:rawResponse.packages},[source]).packages[0];
 reviewedPackageCount++;
 const candidates=new Map(source.candidates.map(candidate=>[canonicalJson([candidate.original,candidate.before]),candidate]));
 const unresolvedCandidates=reviewed.unresolved.map(item=>{
  const candidate=candidates.get(canonicalJson([item.original,item.before]));
  if(!candidate)throw new Error(`本轮批次${batch}未决项丢失原候选证据`);
  return candidate;
 });
 if(!unresolvedCandidates.length){packages.push({batch,package_id:source.package_id,redaction_id:source.redaction_id,workflow_id:source.workflow_id,state:'no_unresolved',unresolved_count:0,source_review_call_id:rawResponse.call_id,source_review_request_digest:rawResponse.request_digest});continue;}
 unresolvedCount+=unresolvedCandidates.length;followupPackageCount++;
 const followup={model:'gpt-5.6-sol',reasoning_effort:'medium',parent_review_call_id:rawResponse.call_id,
  packages:[{package_id:source.package_id,redaction_id:source.redaction_id,workflow_id:source.workflow_id,candidates:unresolvedCandidates}]};
 const requestName=`${batch}.request.json`,bindingName=`${batch}.binding.json`;
 await writePrivate(join(output,requestName),followup);
 await writePrivate(join(output,bindingName),{format:'name-mapping-unresolved-followup-binding-v1',source_batch:batch,package_id:source.package_id,redaction_id:source.redaction_id,workflow_id:source.workflow_id,source_parent_review_call_id:parentReviewCallId??null,source_review_call_id:rawResponse.call_id,source_review_request_digest:rawResponse.request_digest,source_review_unresolved:reviewed.unresolved,followup_candidate_digest:hash(canonicalJson(unresolvedCandidates)),followup_request_file:requestName});
 packages.push({batch,package_id:source.package_id,redaction_id:source.redaction_id,workflow_id:source.workflow_id,state:'ready_for_unresolved_review',unresolved_count:unresolvedCandidates.length,source_review_call_id:rawResponse.call_id,source_review_request_digest:rawResponse.request_digest,request_file:requestName,binding_file:bindingName});
}

const manifest={format:'name-mapping-unresolved-followup-manifest-v1',generated_at:new Date().toISOString(),model:'gpt-5.6-sol',reasoning_effort:'medium',complete:missingBatches.length===0,request_batch_count:requestFiles.length,reviewed_package_count:reviewedPackageCount,followup_package_count:followupPackageCount,unresolved_count:unresolvedCount,missing_batches:missingBatches,packages};
await writePrivate(join(output,'manifest.json'),manifest);
console.log(JSON.stringify({...manifest,packages:undefined}));
