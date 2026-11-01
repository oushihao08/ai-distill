/** 职责：让指定Agent逐包复核全源坐标差异候选，输出唯一主体映射与歧义清单；不应用替换或写业务表。 */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import type {AgentResult,AgentTask} from '../agent';
import {validateNameReplacements,type NameReplacement} from '../authoring/name-replacements';
import {canonicalJson} from '../../shared/workflow-config';

interface CandidateSample{file_id:string;original_name:string;page:number;path:string;context:string}
export interface NameMappingCandidate{original:string;before:string;count:number;question_hits:number;samples:CandidateSample[]}
export interface NameMappingPackage{package_id:string;redaction_id:string;workflow_id:string;candidates:NameMappingCandidate[]}
interface MappingDecision extends NameReplacement{reason:string}
interface NonMappingDecision{original:string;before:string;reason:string}
export interface NameMappingReviewPackage{package_id:string;redaction_id:string;mappings:MappingDecision[];unresolved:NonMappingDecision[];ignored:NonMappingDecision[]}
interface ReviewResult{packages:NameMappingReviewPackage[]}
interface ReviewBundle{call_id:string;request_digest:string;parent_review_call_id?:string;packages:NameMappingPackage[];reviewed:ReviewResult}
interface ResolvedReview{source:NameMappingPackage;result:NameMappingReviewPackage;request_digest:string}
export interface ReviewedNameRevisionPackage{
 review_call_id:string;
 request_digest:string;
 package_id:string;
 redaction_id:string;
 workflow_id:string;
 mappings:NameReplacement[];
 evidence:Array<{original:string;before:string;count:number;question_hits:number;samples:CandidateSample[]}>;
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const compoundSurnames=['欧阳','太史','端木','上官','司马','东方','独孤','南宫','万俟','闻人','夏侯','诸葛','尉迟','公羊','赫连','澹台','皇甫','宗政','濮阳','公冶','太叔','申屠','公孙','慕容','仲孙','钟离','长孙','宇文','司徒','鲜于','司空','闾丘','子车','亓官','司寇','巫马','公西','颛孙','壤驷','公良','漆雕','乐正','宰父','谷梁','拓跋','夹谷','轩辕','令狐','段干','百里','呼延','东郭','南门','羊舌','微生','梁丘','左丘','东门','西门'] as const;
const surname=(name:string)=>compoundSurnames.find(value=>name.startsWith(value))??name[0]??'';
const organizationForms=['有限责任公司','股份有限公司','有限公司','律师事务所','会计师事务所','委员会','合作社','工作室','经营部','集团','学校','医院','商行','中心','厂','店'] as const;
const organizationIndustries=['房地产开发','机械制造','建筑工程','装饰工程','支付科技','网络技术','信息技术','物业管理','餐饮管理','电子商务','科技','物流','建材','建设','商贸','贸易','咨询','运输','广告','传媒','医药','教育'] as const;
function organizationBoundary(name:string){
 const form=organizationForms.find(value=>name.endsWith(value))??'';
 const withoutForm=form?name.slice(0,-form.length):name;
 const administration=/^(北京|上海|天津|重庆|(?:内蒙古|广西|西藏|宁夏|新疆)(?:自治区)?|[\p{Script=Han}]{2,8}(?:省|自治区|自治州|市|县|区))/u.exec(withoutForm)?.[0]??'';
 const industry=organizationIndustries.find(value=>withoutForm.endsWith(value))??'';
 return{form,administration,industry};
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function text(value:unknown,max:number){return typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\r\n\t]/.test(value);}
function parsePackages(value:unknown):NameMappingPackage[]{
 if(!Array.isArray(value)||!value.length||value.length>8)throw new HTTPException(400,{message:'每次须复核1至8个材料包'});
 const ids=new Set<string>();
 return value.map(raw=>{
  if(!object(raw)||Object.keys(raw).some(key=>!['package_id','redaction_id','workflow_id','candidates'].includes(key))||
   !uuid.test(String(raw.package_id))||!uuid.test(String(raw.redaction_id))||!uuid.test(String(raw.workflow_id))||ids.has(String(raw.redaction_id))||!Array.isArray(raw.candidates)||!raw.candidates.length||raw.candidates.length>800)throw new HTTPException(400,{message:'主体映射候选批次无效'});
  ids.add(String(raw.redaction_id));const keys=new Set<string>();
  const candidates=raw.candidates.map(candidate=>{
   if(!object(candidate)||Object.keys(candidate).some(key=>!['original','before','count','question_hits','samples'].includes(key))||!text(candidate.original,300)||!text(candidate.before,300)||
    !Number.isSafeInteger(candidate.count)||Number(candidate.count)<1||!Number.isSafeInteger(candidate.question_hits)||Number(candidate.question_hits)<0||!Array.isArray(candidate.samples)||candidate.samples.length>5)throw new HTTPException(400,{message:'主体映射候选字段无效'});
   const key=canonicalJson([candidate.original,candidate.before]);if(keys.has(key))throw new HTTPException(400,{message:'主体映射候选重复'});keys.add(key);
   const samples=candidate.samples.map(sample=>{if(!object(sample)||Object.keys(sample).some(key=>!['file_id','original_name','page','path','context'].includes(key))||!uuid.test(String(sample.file_id))||!text(sample.original_name,500)||!Number.isSafeInteger(sample.page)||Number(sample.page)<1||!text(sample.path,500)||typeof sample.context!=='string'||sample.context.length>500)throw new HTTPException(400,{message:'主体映射候选证据无效'});return sample as unknown as CandidateSample;});
   return{original:String(candidate.original),before:String(candidate.before),count:Number(candidate.count),question_hits:Number(candidate.question_hits),samples};
  });
  return{package_id:String(raw.package_id),redaction_id:String(raw.redaction_id),workflow_id:String(raw.workflow_id),candidates};
 });
}

export function validateNameMappingReview(value:unknown,packages:NameMappingPackage[]):ReviewResult{
 if(!object(value)||Object.keys(value).some(key=>key!=='packages')||!Array.isArray(value.packages)||value.packages.length!==packages.length)throw new Error('主体映射复核结果结构无效');
 const byId=new Map(packages.map(item=>[item.redaction_id,item])),seen=new Set<string>();
 const reviewed=value.packages.map(raw=>{
  if(!object(raw)||Object.keys(raw).some(key=>!['package_id','redaction_id','mappings','unresolved','ignored'].includes(key))||!Array.isArray(raw.mappings)||!Array.isArray(raw.unresolved)||!Array.isArray(raw.ignored))throw new Error('主体映射包结果结构无效');
  const source=byId.get(String(raw.redaction_id));if(!source||source.package_id!==raw.package_id||seen.has(source.redaction_id))throw new Error('主体映射包身份无效');seen.add(source.redaction_id);
  const candidateKeys=new Set(source.candidates.map(item=>canonicalJson([item.original,item.before]))),decisions=new Set<string>();
  const decision=(item:unknown)=>{if(!object(item)||Object.keys(item).some(key=>!['original','before','reason'].includes(key))||!text(item.original,300)||!text(item.before,300)||!text(item.reason,500))throw new Error('主体映射分流说明无效');const key=canonicalJson([item.original,item.before]);if(!candidateKeys.has(key)||decisions.has(key))throw new Error('主体映射分流未绑定唯一候选');decisions.add(key);return{original:String(item.original),before:String(item.before),reason:String(item.reason)};};
  const mappings=(raw.mappings as unknown[]).map(item=>{if(!object(item)||Object.keys(item).some(key=>!['original','before','after','kind','reason'].includes(key))||!text(item.reason,500))throw new Error('主体映射决定无效');const base=validateNameReplacements([{original:item.original,before:item.before,after:item.after,kind:item.kind}])[0],key=canonicalJson([base.original,base.before]);if(!candidateKeys.has(key)||decisions.has(key)||base.after===base.original)throw new Error('主体映射决定未绑定唯一候选或仍暴露原名');if(base.kind==='person'&&surname(base.original)!==surname(base.after))throw new Error('人名映射改变了姓氏');
   if(base.kind==='organization'){const source=organizationBoundary(base.original),target=organizationBoundary(base.after);if(!source.form||source.form!==target.form||source.administration!==target.administration||source.industry!==target.industry)throw new Error('单位映射改变了行政区划、行业或组织形式');}
   decisions.add(key);return{...base,reason:String(item.reason)};});
  const unresolved=(raw.unresolved as unknown[]).map(decision),ignored=(raw.ignored as unknown[]).map(decision);
  if(decisions.size!==candidateKeys.size)throw new Error('主体映射候选未全部分流');
  if(mappings.length)validateNameReplacements(mappings.map(({original,before,after,kind})=>({original,before,after,kind})));
  return{package_id:source.package_id,redaction_id:source.redaction_id,mappings,unresolved,ignored};
 });
 if(seen.size!==packages.length)throw new Error('主体映射材料包未完整返回');
 return{packages:reviewed};
}

export function preserveMissingDecisionsAsUnresolved(value:unknown,packages:NameMappingPackage[]){
 if(!object(value)||!Array.isArray(value.packages))return value;
 const copy=structuredClone(value) as Record<string,unknown>;
 const reviewed=copy.packages as unknown[];
 for(const raw of reviewed){
  if(!object(raw)||!Array.isArray(raw.mappings)||!Array.isArray(raw.unresolved)||!Array.isArray(raw.ignored))continue;
  const mappings=raw.mappings as unknown[],unresolved=raw.unresolved as unknown[],ignored=raw.ignored as unknown[];
  const source=packages.find(item=>item.redaction_id===raw.redaction_id&&item.package_id===raw.package_id);
  if(!source)continue;
  const safeMappings:unknown[]=[];
  for(const item of mappings){
   if(!object(item)){safeMappings.push(item);continue;}
   try{
    const base=validateNameReplacements([{original:item.original,before:item.before,after:item.after,kind:item.kind}])[0];
    if(base.after===base.original)throw new Error('after exposes original');
    if(base.kind==='person'&&surname(base.original)!==surname(base.after))throw new Error('surname changed');
    if(base.kind==='organization'){
     const originalBoundary=organizationBoundary(base.original),afterBoundary=organizationBoundary(base.after);
     if(!originalBoundary.form||originalBoundary.form!==afterBoundary.form||originalBoundary.administration!==afterBoundary.administration||originalBoundary.industry!==afterBoundary.industry)throw new Error('organization boundary changed');
    }
    safeMappings.push(item);
   }catch{
    if(typeof item.original==='string'&&typeof item.before==='string')unresolved.push({original:item.original,before:item.before,reason:'模型给出的化名违反姓氏或单位保留边界，降级为未决并阻断自动应用'});
    else safeMappings.push(item);
   }
  }
  const beforeCounts=new Map<string,number>();
  for(const item of safeMappings)if(object(item)&&typeof item.before==='string')beforeCounts.set(item.before,(beforeCounts.get(item.before)??0)+1);
  const uniqueBefore=safeMappings.filter(item=>{
   if(!object(item)||typeof item.before!=='string'||(beforeCounts.get(item.before)??0)===1)return true;
   if(typeof item.original==='string')unresolved.push({original:item.original,before:item.before,reason:'同一旧名称对应多个主体候选，降级为未决并阻断自动应用'});
   return false;
  });
  const afterCounts=new Map<string,number>();
  for(const item of uniqueBefore)if(object(item)&&typeof item.after==='string')afterCounts.set(item.after,(afterCounts.get(item.after)??0)+1);
  const uniqueMappings=uniqueBefore.filter(item=>{
   if(!object(item)||typeof item.after!=='string'||(afterCounts.get(item.after)??0)===1)return true;
   if(typeof item.original==='string'&&typeof item.before==='string')unresolved.push({original:item.original,before:item.before,reason:'多个主体使用相同新化名，降级为未决并阻断自动应用'});
   return false;
  });
  raw.mappings=uniqueMappings;
  const decided=new Set([...uniqueMappings,...unresolved,...ignored].filter(object).map(item=>canonicalJson([item.original,item.before])));
  for(const candidate of source.candidates)if(!decided.has(canonicalJson([candidate.original,candidate.before])))unresolved.push({original:candidate.original,before:candidate.before,reason:'模型未返回该候选的唯一分流，保留为未决并阻断自动应用'});
 }
 return copy;
}

const decisionSchema={type:'object',additionalProperties:false,required:['original','before','reason'],properties:{original:{type:'string'},before:{type:'string'},reason:{type:'string'}}};
const mappingSchema={type:'object',additionalProperties:false,required:['original','before','after','kind','reason'],properties:{original:{type:'string'},before:{type:'string'},after:{type:'string'},kind:{type:'string',enum:['person','organization']},reason:{type:'string'}}};
const schema={type:'object',additionalProperties:false,required:['packages'],properties:{packages:{type:'array',items:{type:'object',additionalProperties:false,
 required:['package_id','redaction_id','mappings','unresolved','ignored'],properties:{package_id:{type:'string'},redaction_id:{type:'string'},mappings:{type:'array',items:mappingSchema},unresolved:{type:'array',items:decisionSchema},ignored:{type:'array',items:decisionSchema}}}}}};
export async function reviewNameMappings(storageRoot:string,raw:unknown,execute:<T>(task:AgentTask<T>)=>Promise<AgentResult<T>>){
 if(!object(raw)||Object.keys(raw).some(key=>!['model','reasoning_effort','packages','parent_review_call_id'].includes(key))||!text(raw.model,100)||!text(raw.reasoning_effort,30)||
  (raw.parent_review_call_id!==undefined&&!uuid.test(String(raw.parent_review_call_id))))throw new HTTPException(400,{message:'主体映射复核参数无效'});
 const packages=parsePackages(raw.packages),parentReviewCallId=raw.parent_review_call_id===undefined?undefined:String(raw.parent_review_call_id);
 if(parentReviewCallId){
  if(raw.model!=='gpt-5.6-sol'||raw.reasoning_effort!=='medium')throw new HTTPException(409,{message:'未决项续审模型或推理强度与父回执不一致'});
  if(packages.length!==1)throw new HTTPException(400,{message:'未决项续审每次只能处理一个材料包'});
  const parent=await resolveReviewChain(storageRoot,parentReviewCallId,packages[0].redaction_id,new Set());
  const followup=packages[0];
  if(parent.source.package_id!==followup.package_id||parent.source.redaction_id!==followup.redaction_id||parent.source.workflow_id!==followup.workflow_id)throw new HTTPException(409,{message:'未决项续审与父回执材料包身份不一致'});
  if(!parent.result.unresolved.length)throw new HTTPException(409,{message:'父回执没有可继续复核的未决项'});
  const rootCandidates=new Map(parent.source.candidates.map(candidate=>[canonicalJson([candidate.original,candidate.before]),candidate]));
  const expected=parent.result.unresolved.map(item=>rootCandidates.get(canonicalJson([item.original,item.before])));
  if(expected.some(candidate=>!candidate)||canonicalJson(expected)!==canonicalJson(followup.candidates))throw new HTTPException(409,{message:'未决项续审候选与父回执未决集合不一致'});
 }
 const callId=randomUUID(),directory=join(storageRoot,'name-revision-reviews',callId),request={format:'name-mapping-candidates-v1',...(parentReviewCallId?{parent_review_call_id:parentReviewCallId}:{}),packages};
 await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'request.private.json'),JSON.stringify(request,null,2),{mode:0o600});
 const prompt=`读取mapping-candidates.json，对每个候选逐项分流。候选来自原件与现有脱敏文本的同文件、同页、同块、同字段差异，但候选不等于主体。\n
规则：\n1. mappings只放可确认的人名或企业/单位/律所名称，且同一before在本包唯一对应一个主体；人名保留真实姓氏，只改名字中至少一个字为同音或近音字，例如杨政→杨正；杨政→林志远是错误。企业仅替换可确认字号，行政区划、行业/业务表述和组织形式逐字保留。after不得等于原名、旧名或其他主体的新名。\n2. 同一before对应多个真实主体、原名存在无法归并的OCR异写、主体边界不清或无法可靠生成同音化名时放unresolved，不猜。\n3. before与original相同且确为人名或企业/单位/律所名称，表示原样遗漏，必须进入mappings，不能因读音相同放ignored。非主体、法院/银行/邮政名称、号码地址遮盖差异、扫描垃圾、普通词语，以及before已经是不同汉字且符合全部同音化名规则的候选放ignored。\n4. 每个输入候选必须且只能出现在mappings、unresolved、ignored之一；按包隔离，不能跨包归并。reason简述证据和判断，不复述敏感正文。`;
 const result=await execute({task_type:'material_name_mapping_review',directory,model:String(raw.model),reasoning_effort:String(raw.reasoning_effort),prompt,schema,input_files:[{name:'mapping-candidates.json',text:JSON.stringify(request)}],timeout_ms:60*60*1000,validate:value=>validateNameMappingReview(preserveMissingDecisionsAsUnresolved(value,packages),packages)});
 const receipt={format:'name-mapping-review-v1',call_id:callId,request_digest:hash(canonicalJson(request)),...(parentReviewCallId?{parent_review_call_id:parentReviewCallId}:{}),requested_model:String(raw.model),reasoning_effort:String(raw.reasoning_effort),returned_model:result.returned_model??null,session_id:result.session_id,usage:result.usage,duration_ms:result.duration_ms,...result.result};
 await writeFile(join(directory,'result.private.json'),JSON.stringify(receipt,null,2),{mode:0o600});return receipt;
}

/** 仅从本机私有回执恢复可应用映射；请求、结果或分流不完整时硬阻断。 */
export async function readReviewedNameRevision(storageRoot:string,callId:string,redactionId:string):Promise<ReviewedNameRevisionPackage>{
 if(!uuid.test(callId))throw new HTTPException(400,{message:'主体映射复核回执标识无效'});
 try{
  const resolved=await resolveReviewChain(storageRoot,callId,redactionId,new Set()),source=resolved.source,result=resolved.result,requestDigest=resolved.request_digest;
  if(result.unresolved.length)throw new HTTPException(409,{message:'本包仍有未决主体映射，不能应用名称修订'});
  if(!result.mappings.length)throw new HTTPException(409,{message:'本包复核回执没有可应用的主体映射'});
  const candidates=new Map(source.candidates.map(item=>[canonicalJson([item.original,item.before]),item]));
  const evidence=result.mappings.map(mapping=>{
   const candidate=candidates.get(canonicalJson([mapping.original,mapping.before]));
   if(!candidate)throw new Error('reviewed mapping lost candidate evidence');
   if(source.candidates.filter(item=>item.before===mapping.before).length!==1)throw new HTTPException(409,{message:'同一旧名称对应多个候选主体，不能执行全局名称修订'});
   if(source.candidates.some(item=>item!==candidate&&(item.original===mapping.after||item.before===mapping.after)))throw new HTTPException(409,{message:'新化名与本包其他主体候选名称冲突'});
   return{original:candidate.original,before:candidate.before,count:candidate.count,question_hits:candidate.question_hits,samples:candidate.samples};
  });
  return{review_call_id:callId,request_digest:requestDigest,package_id:source.package_id,redaction_id:source.redaction_id,workflow_id:source.workflow_id,
   mappings:result.mappings.map(({original,before,after,kind})=>({original,before,after,kind})),evidence};
 }catch(error){
  if(error instanceof HTTPException)throw error;
  throw conflictReview('主体映射复核回执缺失、损坏或与请求不一致');
 }
}

async function loadReviewBundle(storageRoot:string,callId:string):Promise<ReviewBundle>{
 if(!uuid.test(callId))throw new Error('review call id is invalid');
 const directory=join(storageRoot,'name-revision-reviews',callId),requestPath=join(directory,'request.private.json'),resultPath=join(directory,'result.private.json');
 const [requestStat,resultStat]=await Promise.all([lstat(requestPath),lstat(resultPath)]);
 if(!requestStat.isFile()||requestStat.isSymbolicLink()||!resultStat.isFile()||resultStat.isSymbolicLink())throw new Error('review receipt is not a regular file');
 const [requestRaw,resultRaw]=await Promise.all([readFile(requestPath,'utf8'),readFile(resultPath,'utf8')]);
 const request=JSON.parse(requestRaw),receipt=JSON.parse(resultRaw);
 if(!object(request)||request.format!=='name-mapping-candidates-v1'||Object.keys(request).some(key=>!['format','parent_review_call_id','packages'].includes(key))||
  (request.parent_review_call_id!==undefined&&!uuid.test(String(request.parent_review_call_id))))throw new Error('review request format mismatch');
 const packages=parsePackages(request.packages),parentReviewCallId=request.parent_review_call_id===undefined?undefined:String(request.parent_review_call_id),requestDigest=hash(canonicalJson({format:'name-mapping-candidates-v1',...(parentReviewCallId?{parent_review_call_id:parentReviewCallId}:{}),packages}));
 if(!object(receipt)||receipt.format!=='name-mapping-review-v1'||receipt.call_id!==callId||receipt.request_digest!==requestDigest||
  receipt.requested_model!=='gpt-5.6-sol'||receipt.reasoning_effort!=='medium'||(receipt.parent_review_call_id===undefined?undefined:String(receipt.parent_review_call_id))!==parentReviewCallId)throw new Error('review receipt binding mismatch');
 const reviewed=validateNameMappingReview({packages:receipt.packages},packages);
 return{call_id:callId,request_digest:requestDigest,...(parentReviewCallId?{parent_review_call_id:parentReviewCallId}:{}),packages,reviewed};
}

async function resolveReviewChain(storageRoot:string,callId:string,redactionId:string,seen:Set<string>):Promise<ResolvedReview>{
 if(seen.has(callId))throw new Error('review receipt parent cycle');
 if(seen.size>=8)throw new Error('review receipt parent chain is too deep');
 seen.add(callId);
 const bundle=await loadReviewBundle(storageRoot,callId),source=bundle.packages.find(item=>item.redaction_id===redactionId),result=bundle.reviewed.packages.find(item=>item.redaction_id===redactionId);
 if(!source||!result||source.package_id!==result.package_id)throw new Error('redaction is not present in review receipt');
 if(!bundle.parent_review_call_id)return{source,result,request_digest:bundle.request_digest};
 if(bundle.packages.length!==1)throw new Error('follow-up review must contain one package');
 const parent=await resolveReviewChain(storageRoot,bundle.parent_review_call_id,redactionId,seen);
 if(parent.source.package_id!==source.package_id||parent.source.workflow_id!==source.workflow_id)throw new Error('follow-up parent package identity mismatch');
 const rootCandidates=new Map(parent.source.candidates.map(candidate=>[canonicalJson([candidate.original,candidate.before]),candidate]));
 const expected=parent.result.unresolved.map(item=>rootCandidates.get(canonicalJson([item.original,item.before])));
 if(expected.some(candidate=>!candidate)||canonicalJson(expected)!==canonicalJson(source.candidates))throw new Error('follow-up candidates do not match parent unresolved decisions');
 const parentTargets=new Map(parent.result.mappings.map(item=>[item.after,item.original])),followupMappings:MappingDecision[]=[],followupUnresolved=[...result.unresolved];
 for(const item of result.mappings){
  const owner=parentTargets.get(item.after);
  if(owner!==undefined&&owner!==item.original)followupUnresolved.push({original:item.original,before:item.before,reason:'续审新化名与父回执其他主体重名，降级为未决并阻断自动应用'});
  else followupMappings.push(item);
 }
 const merged={package_id:parent.source.package_id,redaction_id:parent.source.redaction_id,
  mappings:[...parent.result.mappings,...followupMappings],unresolved:followupUnresolved,ignored:[...parent.result.ignored,...result.ignored]};
 const validated=validateNameMappingReview({packages:[merged]},[parent.source]).packages[0];
 return{source:parent.source,result:validated,request_digest:bundle.request_digest};
}

function conflictReview(message:string){return new HTTPException(409,{message});}
