/**
 * 职责：把稳定步骤 ordinal 映射到现有的业务派发函数。
 * 关键方法：dispatchWorkflowStep 供单步和批量入口共用，不处理就绪判断或队列状态。
 * 使用场景：工作流 HTTP 执行路由；入口各自保留参数校验、批量资格和等待语义。
 */
import {HTTPException} from 'hono/http-exception';

export type WorkflowStepOrdinal=1|2|4|5|6|7|8|9;
export interface StepDispatchTask {id:string;ids?:string[];completed?:boolean;reused?:boolean;docx_archive_path?:string;docx_artifact_count?:number;archive_workbook_path?:string}
export interface WorkflowStepHandlers<T>{
 1:()=>Promise<T>;
 2:()=>Promise<T>;
 4:()=>Promise<T>;
 5:()=>Promise<T>;
 6:()=>Promise<T>;
 7:()=>Promise<T>;
 8:()=>Promise<T>;
 9:()=>Promise<T>;
}

export async function dispatchWorkflowStep<T>(ordinal:WorkflowStepOrdinal,handlers:WorkflowStepHandlers<T>):Promise<T>{
 const handler=handlers[ordinal];
 if(!handler)throw new HTTPException(400,{message:'步骤序号无效'});
 return handler();
}
