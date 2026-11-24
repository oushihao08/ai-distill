/** 本地批次清单：保存固定题目范围、批次大小和本轮跳过原因；不保存或推断数据库执行状态。由 commands.ts 的 batch 命令调用。 */
import {readFile} from 'node:fs/promises';
import {CliError} from './client';
import {atomicWriteJson,isUuid,withExclusiveFileLock,writeExclusiveJson} from './shared';

export interface BatchManifest {
  version:1; project_id:string; workflow_ids:string[]; batch_size:number; target_step:string;
  created_at:string; skipped:Record<string,{reason:string;recorded_at:string}>;
}
export function batchSize(value:string):number {
  if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value)))throw new CliError('批次大小须为正整数');
  return Number(value);
}
export async function readBatch(path:string):Promise<BatchManifest> {
  try {
    const value=JSON.parse(await readFile(path,'utf8'));
    if(value.version!==1||!isUuid(value.project_id)||!Array.isArray(value.workflow_ids)||!value.workflow_ids.length
      ||value.workflow_ids.some((id:unknown)=>!isUuid(id))
      ||new Set(value.workflow_ids).size!==value.workflow_ids.length
      ||!Number.isSafeInteger(value.batch_size)||value.batch_size<1||typeof value.target_step!=='string'
      ||typeof value.created_at!=='string'||!value.skipped||typeof value.skipped!=='object'||Array.isArray(value.skipped)
      ||Object.entries(value.skipped).some(([id,entry]:[string,any])=>!value.workflow_ids.includes(id)||!entry||typeof entry.reason!=='string'||!entry.reason.trim()||typeof entry.recorded_at!=='string')) {
      throw new Error('invalid manifest');
    }
    return value;
  } catch {throw new CliError('无法读取有效批次清单',{kind:'file_error'});}
}
export function batchView(value:BatchManifest) {
  const groups:string[][]=[];
  for(let i=0;i<value.workflow_ids.length;i+=value.batch_size)groups.push(value.workflow_ids.slice(i,i+value.batch_size));
  return {...value,batches:groups.map((ids,index)=>({index:index+1,workflow_ids:ids,remaining_workflow_ids:ids.filter(id=>!Object.hasOwn(value.skipped,id))})),
    note:'清单只固定本轮范围；当前状态、活动任务及成功结果必须重新查询服务端。'};
}
export async function createBatch(path:string,value:BatchManifest) {
  await writeExclusiveJson(path,value,'无法创建批次清单；文件须不存在且父目录已创建');
  return batchView(value);
}
export async function skipBatch(path:string,ids:string[],reason:string) {
  // 短时本地锁防止两个调用覆盖跳过名单；失败不删除其他进程的锁，不自动重试。
  return withExclusiveFileLock(`${path}.lock`,async()=>{
    const value=await readBatch(path);
    if(ids.some(id=>!value.workflow_ids.includes(id)))throw new CliError('跳过题目必须属于本轮固定范围');
    for(const id of ids)value.skipped[id]={reason,recorded_at:new Date().toISOString()};
    try{await atomicWriteJson(path,value);}
    catch{throw new CliError('无法更新批次清单；检查文件权限或是否有其他调用正在更新',{kind:'file_error'});}
    return batchView(value);
  },{busyMessage:'无法更新批次清单；检查文件权限或是否有其他调用正在更新',cleanupErrorMessage:'批次临时文件清理失败'});
}
