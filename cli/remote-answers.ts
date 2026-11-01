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
const terminalStatuses=new Set(['succeeded','failed','skipped']);
/** 远程回执必须仍属于原 workflow/request key；只核对业务身份和状态，不增加机器或网络环境门槛。 */
function answerState(value:any,workflowId:string,requestKey:string){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.workflow_id!==workflowId||value.request_key!==requestKey||!['waiting','running','succeeded','failed','skipped'].includes(value.status)||!Array.isArray(value.attempts)||value.attempts.some((attempt:any)=>!attempt||typeof attempt!=='object'||Array.isArray(attempt)||typeof attempt.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attempt.id)||!['waiting','running','succeeded','failed','skipped','cancelled'].includes(attempt.status)))throw new CliError('远程作答回执与请求身份不一致',{kind:'invalid_response'});
 return value;
}

export async function runRemoteAnswerCommand(args:string[],signal?:AbortSignal){
 if(args[0]!=='remote'||args[1]!=='answer')throw new CliError('远程作答命令无效');
 const action=args[2],flags=flagsFrom(args.slice(3).filter(value=>value!=='--json'));
 if(!['start','status','run'].includes(action??''))throw new CliError('可用命令：remote answer start|status|run');
 if([...flags.keys()].some(key=>!['workflow','request-key'].includes(key)))throw new CliError('远程作答命令含未知参数');
 const workflowId=uuid(flags.get('workflow'),'workflow'),requestKey=uuid(flags.get('request-key'),'request-key'),client=clientFromEnv();
 const path=lookupPath(workflowId,requestKey);
 if(action==='status'){
  const data=answerState(await client.json(path,'GET',undefined,signal),workflowId,requestKey);
  return{outcome:data.status==='succeeded'?'complete':terminalStatuses.has(data.status)?'partial':'waiting',data};
 }
 let accepted:any;
 try{accepted=answerState(await client.json('/api/remote-answer-operations','POST',{workflow_id:workflowId,request_key:requestKey},signal),workflowId,requestKey);}
 catch(error){if(error instanceof CliError&&error.detail.outcome_unknown){error.detail.workflow_id=workflowId;error.detail.request_key=requestKey;}throw error;}
 if(action==='start')return{outcome:'complete',data:accepted};
 while(!signal?.aborted){
  const data=answerState(await client.json(path,'GET',undefined,signal),workflowId,requestKey);
  if(terminalStatuses.has(data.status))return{outcome:data.status==='succeeded'?'complete':'partial',data};
  try{await delay(3000,undefined,{signal});}catch{throw new CliError('等待已中断，服务器作答继续执行',{kind:'interrupted',workflow_id:workflowId,request_key:requestKey});}
 }
 throw new CliError('等待已中断，服务器作答继续执行',{kind:'interrupted',workflow_id:workflowId,request_key:requestKey});
}
