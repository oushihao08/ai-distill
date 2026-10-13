/**
 * 职责：启动并管理本次启动的 API、worker 和 Vite 子进程，任一退出时收尾其他进程。
 * 入口：由 start.sh 在仓库根目录执行，使用 Bun 加载的根 .env；不迁移、不重启已有服务。
 */
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {repositoryRoot} from '../server/paths';
const children:ChildProcess[]=[];
let stopping=false;
function stop(code:number){
 if(stopping)return;stopping=true;process.exitCode=code;
 for(const child of children){
  if(!child.pid)continue;
  try{if(process.platform==='win32')child.kill('SIGTERM');else process.kill(-child.pid,'SIGTERM');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH'){console.error('子进程停止失败，请检查启动终端。');process.exitCode=1;}}
 }
}
async function requireFreePort(port:number){
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('端口配置无效');
 try{
  await new Promise<void>((resolve,reject)=>{
   const probe=createServer();
   probe.once('error',()=>reject(new Error(`端口 ${port} 已占用或无法监听，请使用原启动入口管理已有服务。`)));
   probe.listen(port,'127.0.0.1',()=>probe.close(error=>error?reject(error):resolve()));
  });
 }catch(error){throw error;}
}
try{
 if(!process.env.DATABASE_URL)throw new Error('请先配置根 .env 中的 DATABASE_URL');
 // 启动任何子进程前检查两个端口，避免已有 API 占用时仍先启动第二个 worker。
 await requireFreePort(Number(process.env.PORT??3700));await requireFreePort(3800);
 for(const args of [['server/index.ts'],['server/worker.ts'],['run','--cwd','web','dev']]){
  const child=spawn(process.execPath,args,{cwd:repositoryRoot,env:process.env,stdio:'inherit',detached:process.platform!=='win32'});
  children.push(child);
  child.on('error',()=>{console.error('服务启动失败，请检查依赖和配置。');stop(1);});
  child.on('exit',(code)=>{if(!stopping){console.error('一个服务已退出，正在停止本次启动的其他服务。');stop(code===0?0:1);}});
 }
 process.on('SIGINT',()=>stop(130));process.on('SIGTERM',()=>stop(143));
}catch(error){console.error(error instanceof Error?error.message:'启动失败，请检查运行环境。');stop(1);}
