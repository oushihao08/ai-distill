/**
 * 文件职责：保留旧调用点的停用兼容入口；新任务直接读取步骤设置和当前项目文件。
 * `loadWorkflowRules()` 不再创建编号规则版本或 ordinal 3 执行记录。
 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';

/** 已停用的旧流程；调用方须改用当前项目文件和步骤配置。 */
export async function loadWorkflowRules(_pool:Pool,_workflowId:string):Promise<never>{
 throw new HTTPException(410,{message:'编号规则绑定已停用，新任务直接读取当前项目资料与步骤设置'});
}
