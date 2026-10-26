/** 职责：将本机队列与监控快照转换为只读阻塞诊断；入口diagnoseQueue由CLI queue diagnose调用，不取消或重派任务。 */
type QueueItem={id:string;lane:string;state:string;route?:string;created_at?:number;updated_at?:number};
type QueueView={capacity?:Record<string,{running:number;queued:number}>;items?:QueueItem[]};
type MonitorView={status?:string;heartbeat_at?:string|null;worker_pid?:number|null};
export function diagnoseQueue(queue:QueueView,monitor:MonitorView,now=Date.now()){
 const findings:{code:string;lane?:string;job_id?:string;state?:string;elapsed_ms?:number;reason:string}[]=[];
 for(const [lane,c] of Object.entries(queue.capacity??{})){
  if(c.queued>0&&c.running===0)findings.push({code:'queued_without_running',lane,reason:'有排队任务但无运行任务；立即核对消费者模式、范围、资源暂停和领取日志，不能视为正常执行中'});
 }
 for(const item of queue.items??[]){
  if(!['authoring','author','score'].includes(item.route??'')||!['queued','running'].includes(item.state))continue;
  // running的updated_at可能只是心跳，不能作为开始时间。保守报告入队总时长，不冒充模型执行时长。
  const created=item.created_at;
  if(typeof created==='number'&&Number.isFinite(created)&&created<=now&&now-created>=15*60_000)findings.push({code:'author_score_elapsed_15m',lane:item.lane,job_id:item.id,state:item.state,elapsed_ms:now-created,reason:'出题/评分自入队已超过15分钟；立即查询同一attempt时间线，区分排队、模型执行及结果提交，不自动重试'});
 }
 if(monitor.status&&['stale','stopped','unavailable'].includes(monitor.status))findings.push({code:'worker_snapshot_unhealthy',reason:'worker监控快照不可用、陈旧或已停止；单实例快照不能证明所有消费者的存活状态'});
 return{checked_at:new Date(now).toISOString(),status:findings.length?'needs_attention':'no_observed_issue',findings,worker_snapshot:{status:monitor.status??'unknown',heartbeat_at:monitor.heartbeat_at??null,worker_pid:monitor.worker_pid??null},note:'只读诊断；无告警不证明任务或多worker健康。15分钟是排查线，不是自动取消线。'};
}
