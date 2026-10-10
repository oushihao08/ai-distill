/**
 * 职责：登记当前 worker 中运行的 Agent 子进程 PID，供本地资源监控采样。
 * 关键方法：`registerAgentProcess()` 返回幂等注销函数；`listAgentProcessIds()` 返回去重快照。
 */
const processes=new Map<number,number>();
export function registerAgentProcess(pid:number){
 if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Agent子进程PID无效');
 processes.set(pid,(processes.get(pid)??0)+1);let active=true;
 return()=>{if(!active)return;active=false;const count=processes.get(pid)??0;if(count<=1)processes.delete(pid);else processes.set(pid,count-1);};
}
export function listAgentProcessIds(){return[...processes.keys()];}
