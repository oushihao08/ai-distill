/** 文件职责：采样本机内存与当前进程，保存资源监控证据；不验证完整 worker 或 Codex 生命周期。
 * 执行入口与用途：`bun scripts/verification/verify-resource-monitor.ts`；调用 sampleResources 读取当前进程资源，写入资源快照证据；不启动 worker。
 */
import {mkdir,writeFile} from 'node:fs/promises';
import {sampleResources,adviseDispatch} from '../../server/monitoring/resources';
try{
 // No worker state or registered child PID is supplied: executor readiness stays unknown.
 const snapshot=await sampleResources({registered_pids:[]});
 const thresholds={min_available_percent:10}; // Explicit sampling example, not a project default.
 const advice=adviseDispatch(snapshot,thresholds);
 const evidence={scope:'real local macOS sampling; current process only; worker/Codex integration not exercised',snapshot,example_thresholds:thresholds,advice};
 const output=new URL('../../docs/evidence/resource-monitor-results.json',import.meta.url);
 await mkdir(new URL('.',output),{recursive:true});await writeFile(output,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence));
 if(snapshot.system.status!=='known'||snapshot.processes.some(process=>process.rss_bytes.status!=='known'))process.exitCode=2;
}catch{console.error('资源采样验证失败；未输出私有事件或原始异常');process.exitCode=1;}
