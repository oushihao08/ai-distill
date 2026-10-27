/** 将当前活动尝试投影为本机/他机/未归属执行状态；供步骤列表和详情读取，不修改队列或共享业务状态。 */
import type {StepExecution} from '../../shared/execution-state';
import type {LocalQueue} from './store';
import {localQueueEnabled,localExecutionQueue} from './runtime';
export interface ExecutionAttempt {id:string;status:string;executor_id:string|null;generation:number|null}
/** 复用原步骤SQL的当前活动尝试元信息，不读取输入、结果、原文；legacy不要求归属表存在。 */
export function executionAttemptProjection(alias:string){
 if(!/^[a-z_]+$/.test(alias))throw new Error('步骤SQL别名无效');
 if(!localQueueEnabled())return 'NULL';
 return `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'status',a.status,'executor_id',d.executor_id,'generation',d.generation) ORDER BY a.started_at DESC,a.id DESC),'[]'::jsonb) FROM ai_distill.step_attempts a LEFT JOIN ai_distill.execution_dispatches d ON d.job_id=a.id WHERE a.workflow_id=${alias}.workflow_id AND (a.ordinal=${alias}.ordinal OR (${alias}.ordinal=1 AND a.ordinal=2)) AND a.status IN ('waiting','running'))`;
}
export function projectStepExecution(attempt:ExecutionAttempt|null|undefined,queue?:LocalQueue|null):StepExecution|undefined{
 if(!attempt)return;
 const q=queue??(localQueueEnabled()?localExecutionQueue():null);if(!q)return;
 const base={source:'local_queue' as const,attempt_id:attempt.id,executor_id:attempt.executor_id??null,generation:attempt.generation??null};
 if(!attempt.executor_id)return{...base,source:'shared_attempt',scope:'unowned',state:attempt.status,active:false,label:'旧任务未归属，待核实'};
 if(attempt.executor_id!==q.executorId)return{...base,source:'shared_attempt',scope:'other_executor',state:attempt.status,active:false,label:attempt.status==='running'?'其他执行端 · 运行待核实':'其他执行端 · 未执行意图（非本机队列）'};
 const job=q.get(attempt.id);
 if(!job)return{...base,scope:'local',state:'missing',active:false,label:'本机任务记录缺失，待核实'};
 if(job.generation!==attempt.generation)return{...base,scope:'local',state:'generation_mismatch',active:false,label:'执行代次不一致，待核实'};
 if(job.state==='running'&&job.pid){try{process.kill(job.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return{...base,scope:'local',state:'orphaned',active:false,label:'本机执行已中断，待恢复'};}}
 const labels:Record<string,string>={pending_registration:'本机待登记',queued:'本机排队中',running:'本机执行中',result_pending_commit:'结果已保存，待同步',needs_review:'本机待核实',committed:'本机已完成，待同步',cancelled:'本机已取消，待同步',failed:'本机已失败，待同步',stale:'本机任务已失效'};
 return{...base,scope:'local',state:job.state,active:job.state==='running'||job.state==='queued'&&!job.cancel_requested,label:job.cancel_requested?'本机取消处理中':labels[job.state]??'本机状态待核实'};
}

export function projectStepExecutions(attempts:ExecutionAttempt[]|null|undefined,queue?:LocalQueue|null):StepExecution[]|undefined{
 if(!attempts)return;
 return attempts.map(attempt=>projectStepExecution(attempt,queue)).filter((value):value is StepExecution=>Boolean(value));
}
