/**
 * 职责：任务状态读取与有限等待：请求等待结束不取消后台执行，终态完成与成功分开表达。
 * 关键方法与用途：`waitDuration()` 限制 HTTP 等待时长；`waitForAttempt()` 每秒观察持久化尝试，支持不读取结果正文的状态视图，不取消后台任务。
 * 使用场景：由 `app.ts` 的等待接口调用，区分终态完成与业务成功。
 */
import type { Pool } from 'pg';
import { HTTPException } from 'hono/http-exception';

export function waitDuration(value: string | undefined) {
 if (value === undefined) return 0;
 if (!/^\d{1,5}$/.test(value) || Number(value)>30000) throw new HTTPException(400,{message:'wait_ms须为0至30000的整数'});
 return Number(value);
}

export async function waitForAttempt(pool: Pool, id: string, waitMs: number, signal: AbortSignal, view:'full'|'status'='full') {
 const deadline=performance.now()+waitMs;
 try {
  while (true) {
   if (signal.aborted) throw new HTTPException(408,{message:'等待请求已中断，后台任务继续执行'});
   // Waiting clients only need metadata; avoid fetching/serializing large JSONB results.
   const row=(await pool.query(`SELECT a.id,a.workflow_id,a.ordinal,a.status,${view==='full'?'a.result,':''}a.error,a.started_at,a.finished_at
    FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.projects p ON p.id=w.project_id
    WHERE a.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL`,[id])).rows[0];
   if (signal.aborted) throw new HTTPException(408,{message:'等待请求已中断，后台任务继续执行'});
   if (!row) throw new HTTPException(404,{message:'执行任务不存在'});
   const completed=['succeeded','failed','skipped'].includes(row.status);
   if (completed || performance.now()>=deadline) return {...row,completed};
   await new Promise<void>(resolve=>{
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,Math.min(1000,Math.max(0,deadline-performance.now())));
    signal.addEventListener('abort',finish,{once:true});
    if(signal.aborted)finish();
   });
  }
 } catch(error) { throw error; }
}
