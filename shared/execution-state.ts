/** 页面和CLI共用的步骤执行投影；共享业务结果与本机队列状态分别表达，不携带租约或私有检查点。 */
export interface StepExecution {
 source:'local_queue'|'shared_attempt';scope:'local'|'other_executor'|'unowned';state:string;
 attempt_id:string;executor_id:string|null;generation:number|null;active:boolean;label:string;
}
