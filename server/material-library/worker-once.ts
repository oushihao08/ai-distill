/** 职责：只消费指定UUID的本机Agent材料任务，供隔离服务验收；入口bun server/material-library/worker-once.ts <job-id>。复用正式队列、租约、并发槽及发布事务，不领取其他任务。任务须先经HTTP入队。 */
import {createPool} from '../db';
import {storageDirectory} from '../paths';
import {configureAgentCredentialHome,readAgentCredentialHome} from '../agent';
import {getAgentConcurrencyGate,readConcurrencySettings} from '../concurrency';
import {configureLogger} from '../logging';
import {runNextLibraryJob} from './runner';
import {readLibraryJob} from './jobs';

const id=process.argv[2];
if(!id||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))throw new Error('请提供经HTTP创建的材料任务UUID');
const root=storageDirectory(),logger=configureLogger({root,service:'worker'}),pool=createPool(),controller=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>controller.abort());
configureAgentCredentialHome(()=>readAgentCredentialHome(pool));
const gate=getAgentConcurrencyGate(root,readConcurrencySettings(process.env,root).agent);
try{
 const job=await readLibraryJob(pool,id);
 if(job.executor_kind!=='agent'||job.execution_target!=='local'||job.kind!=='redact')throw new Error('本入口仅执行本机Agent材料脱敏任务');
 const result=await gate.run(()=>runNextLibraryJob(pool,root,'agent','local',controller.signal,id),{signal:controller.signal});
 const current=await readLibraryJob(pool,id);
 console.log(JSON.stringify({job_id:id,slot_acquired:result.acquired,status:current.status,error_code:current.error_code??null,duration_ms:current.result_summary?.duration_ms??null}));
 if(!result.acquired||current.status!=='succeeded')process.exitCode=2;
}catch(error){console.error('指定材料任务未完成；请按job_id查询安全状态和私有诊断。');process.exitCode=1;}
finally{gate.close();await pool.end();await logger.close();}
