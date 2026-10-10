/**
 * 职责：验证 Agent 子进程登记表能供 worker 资源监控读取并及时清理。
 * 主要边界：去重、安全 PID 和结束后注销。
 */
import {expect,test} from 'bun:test';
import {listAgentProcessIds,registerAgentProcess} from './processes';

test('registered Agent process IDs are unique and removed on exit',()=>{
 const pid=process.pid+100000;
 const unregister=registerAgentProcess(pid);
 const unregisterAgain=registerAgentProcess(pid);
 try{expect(listAgentProcessIds()).toContain(pid);}finally{unregister();unregisterAgain();}
 expect(listAgentProcessIds()).not.toContain(pid);
});
