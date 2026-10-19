/** 验证外部调用包装的 call_id、结构化返回及 workflow/library_job 身份互斥；执行函数由测试回调提供，不请求真实外部服务。 */
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
