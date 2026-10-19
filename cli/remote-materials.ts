/**
 * 职责：本机 CLI 经 SSH 隧道处理旧材料工作流的远程组合操作并取回管理副本；全局库package/revision/job不使用此接口。
 * 关键入口：runRemoteMaterialCommand；供 cli/index.ts 的 remote material 命令使用。
 */
import {createHash,randomUUID} from 'node:crypto';
import {link,lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,resolve,relative,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {storageDirectory} from '../server/paths';
import {ApiClient,CliError} from './client';

const uuid=(value:string|undefined,label:string)=>{
 if(!value||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new CliError(`${label} 须为 UUID`);
 return value;
};
function argsToFlags(args:string[]){
 const flags=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){
  const key=args[i],value=args[i+1];
  if(!key?.startsWith('--')||!value||value.startsWith('--')||flags.has(key.slice(2)))throw new CliError('远程材料命令参数无效');
  flags.set(key.slice(2),value);
 }
 return flags;
}
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');

async function syncFile(client:ApiClient,operationId:string,item:any,kind:'materials'|'artifacts',root:string,signal?:AbortSignal){
 if(typeof item?.id!=='string'||typeof item?.storage_path!=='string'||typeof item?.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(item.sha256))throw new CliError('远程文件清单无效',{kind:'invalid_response'});
 const base=resolve(root),path=resolve(base,item.storage_path),rel=relative(base,path);
 if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||rel.startsWith(sep))throw new CliError('远程文件路径越界',{kind:'invalid_response'});
 await mkdir(base,{recursive:true});
 const actualBase=await realpath(base);
 let actualParent=actualBase;
 for(const segment of relative(base,dirname(path)).split(sep).filter(Boolean)){
  actualParent=resolve(actualParent,segment);
  try{
   const info=await lstat(actualParent);
   if(!info.isDirectory()||info.isSymbolicLink())throw new CliError('本机管理目录路径越界',{kind:'file_error'});
  }catch(error){
   if(error instanceof CliError)throw error;
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new CliError('本机管理目录无法读取',{kind:'file_error'});
   try{await mkdir(actualParent);}catch{
    const info=await lstat(actualParent).catch(()=>null);
    if(!info?.isDirectory()||info.isSymbolicLink())throw new CliError('本机管理目录路径越界',{kind:'file_error'});
   }
  }
 }
 try{
  const existingPath=await realpath(path);
  if(!existingPath.startsWith(`${actualBase}${sep}`))throw new CliError('本机文件路径越界',{kind:'file_error'});
  const current=await readFile(existingPath);
  if(hash(current)===item.sha256)return{kind,id:item.id,status:'present'};
  throw new CliError('本机已有同路径但指纹不同的文件',{kind:'file_conflict'});
 }catch(error){if(error instanceof CliError)throw error;if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new CliError('本机文件无法读取',{kind:'file_error'});}
 const bytes=await client.download(`/api/remote-material-operations/${operationId}/${kind}/${item.id}/download`,signal);
 if(hash(bytes)!==item.sha256)throw new CliError('下载文件指纹不符',{kind:'invalid_response'});
 const temporary=`${path}.${randomUUID()}.tmp`;
 try{await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await link(temporary,path);}catch{throw new CliError('本机文件写入失败或目标已存在',{kind:'file_error'});}finally{await rm(temporary,{force:true});}
 return{kind,id:item.id,status:'downloaded'};
}

export async function runRemoteMaterialCommand(args:string[],signal?:AbortSignal){
 if(args[0]!=='remote'||args[1]!=='material')throw new CliError('远程材料命令无效');
 const action=args[2],flags=argsToFlags(args.slice(3).filter(value=>value!=='--json'));
 if(!['start','status','sync','run'].includes(action??''))throw new CliError('可用命令：remote material start|status|sync|run');
 const allowed=action==='status'||action==='sync'?['operation','workflow','request-key']:['workflow','mode','request-key'];
 if([...flags.keys()].some(key=>!allowed.includes(key)))throw new CliError('远程材料命令含未知参数');
 const base=process.env.REMOTE_MATERIAL_API_URL,token=process.env.REMOTE_MATERIAL_TOKEN;
 if(!base||!token)throw new CliError('须在本机 .env 配置 REMOTE_MATERIAL_API_URL 和 REMOTE_MATERIAL_TOKEN');
 const client=new ApiClient(base,fetch,token);
 const lookupOperation=async()=>{
  if(flags.has('operation')){
   if(flags.has('workflow')||flags.has('request-key'))throw new CliError('operation 与 workflow/request-key 不能同时使用');
   return client.json(`/api/remote-material-operations/${uuid(flags.get('operation'),'operation')}`,'GET',undefined,signal);
  }
  const workflow=uuid(flags.get('workflow'),'workflow'),requestKey=uuid(flags.get('request-key'),'request-key');
  if(flags.has('mode'))throw new CliError('status/sync 查询不接受 mode');
  return client.json(`/api/remote-material-operations/by-request?workflow_id=${workflow}&request_key=${requestKey}`,'GET',undefined,signal);
 };
 if(action==='status'){
  const op=await lookupOperation();
  return{outcome:op.status==='succeeded'?'complete':op.status==='failed'?'partial':'waiting',data:op};
 }
 if(action==='sync'){
  const op=await lookupOperation(),operationId=uuid(op.id,'operation');
  if(op.status!=='succeeded')return{outcome:op.status==='failed'?'partial':'waiting',data:op};
  const files=await client.json(`/api/remote-material-operations/${operationId}/files`,'GET',undefined,signal);
  if(files.operation_id!==operationId||files.workflow_id!==op.workflow_id||!Array.isArray(files.materials)||!Array.isArray(files.artifacts))throw new CliError('远程文件清单与操作不一致',{kind:'invalid_response'});
  const root=storageDirectory(),results=[];
  for(const item of files.materials)results.push(await syncFile(client,operationId,item,'materials',root,signal));
  for(const item of files.artifacts)results.push(await syncFile(client,operationId,item,'artifacts',root,signal));
  return{outcome:'complete',ready_for_local_authoring:op.mode!=='intake',operation_id:operationId,files:results};
 }
 const workflowId=uuid(flags.get('workflow'),'workflow'),requestKey=uuid(flags.get('request-key'),'request-key');
 const mode=flags.get('mode');if(!['intake','redact','intake-redact'].includes(mode??''))throw new CliError('mode 须为 intake、redact 或 intake-redact');
 let op:any;
 try{op=await client.json('/api/remote-material-operations','POST',{workflow_id:workflowId,mode,request_key:requestKey},signal);}
 catch(error){if(error instanceof CliError&&error.detail.outcome_unknown){error.detail.request_key=requestKey;error.detail.workflow_id=workflowId;}throw error;}
 if(action==='start')return{outcome:'complete',data:op};
 const operationId=uuid(op.id,'operation');
 while(!signal?.aborted){
  const current=await client.json(`/api/remote-material-operations/${operationId}`,'GET',undefined,signal);
  if(current.status==='failed')return{outcome:'partial',data:current};
  if(current.status==='succeeded')return runRemoteMaterialCommand(['remote','material','sync','--operation',operationId],signal);
  try{await delay(3000,undefined,{signal});}catch{throw new CliError('等待已中断，服务器任务继续执行',{kind:'interrupted',operation_id:operationId});}
 }
 throw new CliError('等待已中断，服务器任务继续执行',{kind:'interrupted',operation_id:operationId});
}
