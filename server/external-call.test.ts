/**
 * 职责：验证外部调用封装可关联并返回不携带用量字段的结构化提取结果。
 * 主要边界：提取调用也使用同一 call_id/日志包装，但结果类型不必伪装成模型响应。
 */
import {expect,test} from 'bun:test';
import {runExternalCall} from './external-call';

test('external calls preserve structured results without model usage fields',async()=>{
 const result=await runExternalCall({library_job_id:'job-1',operation:'library_document_extract'},async call_id=>({
  call_id,format:'txt' as const,provider:'local' as const,sha256:'a'.repeat(64),pages:[{page:1,text:'正文'}],
 }));

 expect(result.call_id).toBeString();
 expect(result.pages[0]?.text).toBe('正文');
});

test('external call contexts require exactly one workflow or library job identity',async()=>{
 const execute=async()=>({usage:0});
 await expect(runExternalCall({operation:'invalid'} as any,execute)).rejects.toThrow('外部调用必须且只能关联 attempt_id 或 library_job_id');
 await expect(runExternalCall({attempt_id:'attempt-1',library_job_id:'job-1',operation:'invalid'} as any,execute)).rejects.toThrow('外部调用必须且只能关联 attempt_id 或 library_job_id');
});
