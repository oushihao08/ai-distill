/**
 * 职责：本机 CLI 经 SSH 隧道提交、等待和查询服务器作答任务。
 * 关键入口：runRemoteAnswerCommand；请求 ID 保证响应丢失后可找回同一组作答 attempt。
 */
import {setTimeout as delay} from 'node:timers/promises';
import {ApiClient,CliError} from './client';

const uuid=(value:string|undefined,label:string)=>{
 if(!value||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new CliError(`${label} 须为 UUID`);
 return value;
};
function flagsFrom(args:string[]){
 const flags=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!key?.startsWith('--')||!value||value.startsWith('--')||flags.has(key.slice(2)))throw new CliError('远程作答命令参数无效');flags.set(key.slice(2),value);}
 return flags;
}
function clientFromEnv(){
 const base=process.env.REMOTE_MATERIAL_API_URL,token=process.env.REMOTE_MATERIAL_TOKEN;
 if(!base||!token)throw new CliError('须在本机 .env 配置 REMOTE_MATERIAL_API_URL 和 REMOTE_MATERIAL_TOKEN');
 return new ApiClient(base,fetch,token);
}
const lookupPath=(workflowId:string,requestKey:string)=>`/api/remote-answer-operations/by-request?workflow_id=${workflowId}&request_key=${requestKey}`;

export async function runRemoteAnswerCommand(args:string[],signal?:AbortSignal){
 if(args[0]!=='remote'||args[1]!=='answer')throw new CliError('远程作答命令无效');
 const action=args[2],flags=flagsFrom(args.slice(3).filter(value=>value!=='--json'));
 if(!['start','status','run'].includes(action??''))throw new CliError('可用命令：remote answer start|status|run');
 if([...flags.keys()].some(key=>!['workflow','request-key'].includes(key)))throw new CliError('远程作答命令含未知参数');
 const workflowId=uuid(flags.get('workflow'),'workflow'),requestKey=uuid(flags.get('request-key'),'request-key'),client=clientFromEnv();
 const path=lookupPath(workflowId,requestKey);
 if(action==='status'){
  const data=await client.json(path,'GET',undefined,signal);
  return{outcome:['succeeded'].includes(data.status)?'complete':['failed','skipped'].includes(data.status)?'partial':'waiting',data};
 }
 let accepted:any;
 try{accepted=await client.json('/api/remote-answer-operations','POST',{workflow_id:workflowId,request_key:requestKey},signal);}
 catch(error){if(error instanceof CliError&&error.detail.outcome_unknown){error.detail.workflow_id=workflowId;error.detail.request_key=requestKey;}throw error;}
 if(action==='start')return{outcome:'complete',data:accepted};
 while(!signal?.aborted){
  const data=await client.json(path,'GET',undefined,signal);
  if(['succeeded','failed','skipped'].includes(data.status))return{outcome:data.status==='succeeded'?'complete':'partial',data};
  try{await delay(3000,undefined,{signal});}catch{throw new CliError('等待已中断，服务器作答继续执行',{kind:'interrupted',workflow_id:workflowId,request_key:requestKey});}
 }
 throw new CliError('等待已中断，服务器作答继续执行',{kind:'interrupted',workflow_id:workflowId,request_key:requestKey});
}
