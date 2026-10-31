/**
 * 职责：把HTTP客户端中断后已由服务端完整落盘的名称复核私有回执，按冻结请求安全恢复到响应目录。
 * 入口：bun .../recover-review-responses.ts <请求目录> <服务端私有回执目录> <响应目录> [批次编号逗号列表]。
 * 影响：不调用API、模型或数据库；只原子写入.storage下缺失的0600响应，缺失和多回执冲突均不猜测。
 */
import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {canonicalJson} from '../../../../shared/workflow-config';
import {validateNameMappingReview} from '../../../../server/material-library/name-mapping-review';

const [requestArg,reviewArg,responseArg,selectionArg]=process.argv.slice(2);
if(!requestArg||!reviewArg||!responseArg)throw new Error('用法：recover-review-responses.ts <请求目录> <服务端私有回执目录> <响应目录> [01,02]');
const root=process.cwd(),requests=resolve(requestArg),reviews=resolve(reviewArg),responses=resolve(responseArg);
for(const path of [requests,reviews,responses])if(!path.includes(`${root}/.storage/`))throw new Error('请求、回执和响应目录必须位于当前仓库.storage私有目录');
const selected=selectionArg?new Set(selectionArg.split(',').map(value=>value.padStart(2,'0'))):null;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

async function regularJson(path:string){
 const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`${path} 不是普通文件`);
 return JSON.parse(await readFile(path,'utf8'));
}
function expectedRequest(raw:unknown){
 if(!object(raw)||Object.keys(raw).some(key=>!['model','reasoning_effort','parent_review_call_id','packages'].includes(key))||raw.model!=='gpt-5.6-sol'||raw.reasoning_effort!=='medium'||
  (raw.parent_review_call_id!==undefined&&!uuid.test(String(raw.parent_review_call_id)))||!Array.isArray(raw.packages)||raw.packages.length!==1)throw new Error('只恢复固定gpt-5.6-sol/medium的单包复核请求');
 const item=raw.packages[0];
 if(!object(item)||!uuid.test(String(item.package_id))||!uuid.test(String(item.redaction_id))||!uuid.test(String(item.workflow_id))||!Array.isArray(item.candidates)||!item.candidates.length)throw new Error('单包请求身份或候选无效');
 const parentReviewCallId=raw.parent_review_call_id===undefined?undefined:String(raw.parent_review_call_id);
 return{body:raw,privateRequest:{format:'name-mapping-candidates-v1',...(parentReviewCallId?{parent_review_call_id:parentReviewCallId}:{}),packages:raw.packages},item,parentReviewCallId};
}
function validateReceipt(raw:unknown,callId:string,expected:ReturnType<typeof expectedRequest>){
 const receiptParent=object(raw)&&raw.parent_review_call_id!==undefined?String(raw.parent_review_call_id):undefined;
 if(!object(raw)||raw.format!=='name-mapping-review-v1'||raw.call_id!==callId||raw.requested_model!=='gpt-5.6-sol'||raw.reasoning_effort!=='medium'||
  receiptParent!==expected.parentReviewCallId||raw.request_digest!==hash(canonicalJson(expected.privateRequest))||!Array.isArray(raw.packages))throw new Error('私有回执元数据与冻结请求不一致');
 const reviewed=validateNameMappingReview({packages:raw.packages},expected.privateRequest.packages as any);
 if(reviewed.packages.length!==1||reviewed.packages[0].package_id!==expected.item.package_id||reviewed.packages[0].redaction_id!==expected.item.redaction_id)throw new Error('私有回执包身份不一致');
 return raw;
}

await mkdir(responses,{recursive:true,mode:0o700});
const requestFiles=(await readdir(requests)).filter(name=>/^\d{2}\.request\.json$/.test(name)&&(!selected||selected.has(name.slice(0,2)))).sort();
if(!requestFiles.length)throw new Error('没有选中的单包请求');
const reviewDirectories=(await readdir(reviews,{withFileTypes:true})).filter(item=>item.isDirectory()&&!item.isSymbolicLink()&&uuid.test(item.name)).map(item=>item.name);
const recovered=[],reused=[],missing=[];
for(const file of requestFiles){
 const number=file.slice(0,2),expected=expectedRequest(await regularJson(join(requests,file))),target=join(responses,`${number}.response.json`);
 try{const existing=validateReceipt(await regularJson(target),String((await regularJson(target)).call_id),expected);reused.push({batch:number,call_id:existing.call_id});continue;}catch(error){
  try{await lstat(target);throw new Error(`批次${number}已有响应但与冻结请求不一致`);}catch(statError){if((statError as NodeJS.ErrnoException).code!=='ENOENT'&&String(statError).includes('已有响应'))throw statError;}
 }
 const matches=[] as Array<{call_id:string;receipt:Record<string,unknown>}>;
 for(const callId of reviewDirectories){
  const directory=join(reviews,callId),requestPath=join(directory,'request.private.json'),resultPath=join(directory,'result.private.json');
  try{
   const privateRequest=await regularJson(requestPath);
   if(canonicalJson(privateRequest)!==canonicalJson(expected.privateRequest))continue;
   const receipt=validateReceipt(await regularJson(resultPath),callId,expected);
   matches.push({call_id:callId,receipt});
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw new Error(`批次${number}私有回执损坏：${error instanceof Error?error.message:String(error)}`);}
 }
 if(matches.length>1)throw new Error(`批次${number}存在多个完整私有回执，拒绝任选其一`);
 if(!matches.length){missing.push(number);continue;}
 const {receipt,call_id}=matches[0],temporary=join(responses,`.${basename(target)}.${randomUUID()}.tmp`);
 try{await writeFile(temporary,JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,target);await chmod(target,0o600);}finally{await rm(temporary,{force:true});}
 recovered.push({batch:number,call_id});
}
console.log(JSON.stringify({selected:requestFiles.length,recovered,reused,missing}));
