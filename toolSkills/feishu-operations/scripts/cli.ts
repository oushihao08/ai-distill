#!/usr/bin/env bun
/** 通用飞书CLI入口：一次命令或持久NDJSON会话；凭证只由进程环境提供，正文走stdin。 */
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createAppClient,FeishuError,type FeishuClient} from './client';
import {HELP,parseCommand,executeOperation,type Operation} from './commands';
const safeError=(error:unknown)=>({code:error instanceof FeishuError?error.code:'feishu_operation_failed'});
async function main(){
 const args=process.argv.slice(2);
 if(!args.length||args.includes('--help')){if(args[0]!=='official'){process.stdout.write(HELP);return;}}
 if(args[0]==='project'){
  if(!['show','sync'].includes(args[1]??'')||args.length!==4||args[2]!=='--project')throw new FeishuError('feishu_arguments_invalid');
  const registry=await import('./project-registry');
  const data=args[1]==='show'?await registry.showProjectRegistry(args[3]!):await registry.syncProjectRegistry(args[3]!,await createAppClient());
  process.stdout.write(JSON.stringify({ok:true,data})+'\n');return;
 }
 if(args[0]==='official'){
  const argv=args.slice(args[1]==='--'?2:1);
  // 不替用户选择身份，也不把原始官方错误/凭证写进项目日志；交互输出直接留在用户终端。
  const identity=argv.indexOf('--as');
  if(!['auth','config','whoami'].includes(argv[0]??'')&&!argv.includes('--help')&&(identity<0||!['user','bot'].includes(argv[identity+1]??'')))throw new FeishuError('feishu_official_identity_required');
  const child=spawn(process.env.LARK_CLI_BIN??'lark-cli',argv,{stdio:'inherit',shell:false,env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
  process.exitCode=await new Promise<number>((resolve,reject)=>{child.once('error',()=>reject(new FeishuError('feishu_official_cli_unavailable')));child.once('close',code=>resolve(code??1));});return;
 }
 let api:FeishuClient|undefined;
 const execute=async(operation:Operation)=>{api??=await createAppClient();return executeOperation(api,operation);};
 if(args[0]==='--rpc'){
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
   let id:unknown=null;
   try{const request=JSON.parse(line);id=request.id;if(!Number.isSafeInteger(id))throw new FeishuError('feishu_rpc_invalid');
    const data=await execute(request.operation);process.stdout.write(JSON.stringify({id,ok:true,data})+'\n');
   }catch(error){process.stdout.write(JSON.stringify({id,ok:false,error:safeError(error)})+'\n');}
  }
  return;
 }
 const dry=args.includes('--dry-run');if(dry)args.splice(args.indexOf('--dry-run'),1);
 const identity=args.indexOf('--as');if(identity>=0){if(args[identity+1]!=='bot')throw new FeishuError('feishu_use_official_for_user');args.splice(identity,2);}
 let text='';const input=args.indexOf('--input');
 if(input>=0){if(!args[input+1])throw new FeishuError('feishu_input_missing');text=await readFile(args[input+1]!,'utf8');args.splice(input,2);}
 else if(!process.stdin.isTTY&&args[0]!=='auth')text=await Bun.stdin.text();
 let body:unknown;try{body=text.trim()?JSON.parse(text):undefined;}catch{throw new FeishuError('feishu_json_invalid');}
 const operation=args[0]==='api'?{kind:'call' as const,method:args[1],path:args[2],body}:parseCommand(args,body);
 if(args[0]==='api'&&(!['GET','POST','PUT','PATCH','DELETE'].includes(args[1]??'')||!args[2]||args.length!==3))throw new FeishuError('feishu_arguments_invalid');
 const data=dry?{identity:'bot',request:operation,dispatched:false}:await execute(operation);
 process.stdout.write(JSON.stringify({ok:true,data})+'\n');
}
try{await main();}catch(error){process.stderr.write(JSON.stringify({ok:false,error:safeError(error)})+'\n');process.exitCode=1;}
