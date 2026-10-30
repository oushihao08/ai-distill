/**
 * 职责：独立评分队列：逐答案冻结匿名评分上下文、执行评分并聚合当前模型集合的结果。
 * 关键方法与用途：`enqueueScore()` 按答案冻结上下文；`runNextScore()` 执行单个模型评分并聚合当前集合；摘要函数去重输入。
 * 使用场景：`app.ts` 派发，`worker.ts` 消费持久化评分队列。
 * 项目差异：评分协议选择由生命周期项目策略提供，通用队列只冻结和执行所选协议。
 */
import {runScoringEnhancements as automaticallyJudgeAfterScoring} from '../lifecycle/scoring';
import {projectStepPolicies,resolveStepProjectKey} from '../lifecycle/steps';
import {emitProjectLifecycle as emitLifecycle} from '../lifecycle';
import {startAttemptHeartbeat} from '../attempt-heartbeat';
import {assertWorkflowNotArchived} from '../workflow-archive-guard';
import {assertRepairStepAllowed} from '../revision-advice/jobs';
import {supersedeForeignPending,releaseRolledBackRegistrations,forgetLocalRegistrations,registerLocalJobs,localClaimSql,localWaitingSql,deferLocalPublication,resumeStepFailure,readStepFailure,saveStepFailure,RecordedStepFailure} from '../execution-queue/runtime';
import {watchTaskCancellation} from '../task-signal';
import type {Pool,PoolClient} from 'pg';
import {runExternalCall} from '../external-call';
import {runAcceptance} from '../decisions/jobs';
import {classifyLogError,enterLogContext,logEvent,withLogContext} from '../logging';
import type {AnswerStepModelSummary,ScoreStepModelSummary} from '../../shared/workflow-results';
import {HTTPException} from 'hono/http-exception';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {readScoreContext} from './context';
import {freezeStageHooks,recoverInterruptedStageHooks,executeWithStageHooks,prepareCommittedStageHooks,runCommittedStageHooks,StageHookError,stageHookAffinitySql,type StageWorkerMode} from '../lifecycle/scripts';
import {buildAnonymousInput,buildScoreFiles,runIndependentScore,runIndependentApiScore,scoreExecutionInstructions,scoreExecutionDigest} from './executor';
import {extractTextScore,extractModelReport,validateScore,type ScoreContext} from './validate';
import {validateStepConfigForExecution} from '../project-folders';
import {mergeCodexDefaults,readProjectAgentDefaults} from '../agent/config';
import {canonicalJson} from '../../shared/workflow-config';
import {DEFAULT_STEP_PROMPTS,resolveScoreStepPrompt} from '@shared/step-prompts';
import {resolveEffectiveProjectSkill} from '../rule-files';
export function scoreContextDigest(context:ScoreContext){
 const b=context.binding;
 const frozen={binding:{question_version:b.question_version,input_digest:b.input_digest,rubric_version:b.rubric_version,rubric_digest:b.rubric_digest,answer_attempt_id:b.answer_attempt_id,answer_sha256:b.answer_sha256},input:buildAnonymousInput(context)};
 return createHash('sha256').update(context.scoring_policy?.contract==='model_report_v1'?canonicalJson(frozen):JSON.stringify(frozen)).digest('hex');
}
const workflowSql="SELECT w.project_id,p.local_skill_path,p.workspace_path,p.parent_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w";
/**
 * 从当前作答结果中选取成功答案，为每份答案读取并冻结匿名评分上下文后分别入队。
 * 上下文摘要防止跨题面、rubric、附件、答案或评分提示词混用；活动评分拒绝重复，已完成评分不复用。
 */
export async function enqueueScore(pool:Pool,id:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await assertWorkflowNotArchived(db,id);await assertRepairStepAllowed(db,id,6);const w=(await db.query(workflowSql,[id])).rows[0];if(!w)throw new HTTPException(404,{message:'工作流不存在'});
  const answerStep=(await db.query("SELECT status,result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=5",[id])).rows[0];
  const bundle=Array.isArray(answerStep?.result?.models)?answerStep.result.models as any[]:null;
  const terminalAnswerStatuses=['succeeded','failed','skipped'];
  const bundleSettled=!!bundle&&bundle.length>0&&bundle.every(item=>terminalAnswerStatuses.includes(item?.status));
  const hasScorableAnswer=!!bundle&&bundle.some(item=>item?.status==='succeeded'&&typeof item.attempt_id==='string');
  if(answerStep?.status!=='succeeded'&&!(bundleSettled&&hasScorableAnswer))throw new HTTPException(409,{message:'请先完成当前题目作答，且至少有一个成功答案'});
  let answerIds:string[];
  if(bundle){
   const requested=bundle.filter(item=>item?.status==='succeeded'&&typeof item.attempt_id==='string').map(item=>item.attempt_id as string);
   const available=await db.query("SELECT a.id FROM ai_distill.step_attempts a WHERE a.workflow_id=$1 AND a.ordinal=5 AND a.status='succeeded' AND a.id=ANY($2::uuid[])",[id,requested]);
   answerIds=available.rows.map(row=>row.id);
  }else{
   const answer=(await db.query("SELECT a.id FROM ai_distill.step_attempts a JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=5 WHERE a.workflow_id=$1 AND a.ordinal=5 AND a.status='succeeded' AND s.status='succeeded' AND s.result->>'answer_sha256'=a.result->>'answer_sha256' AND s.result->>'input_digest'=a.result->>'input_digest' ORDER BY a.attempt DESC LIMIT 1",[id])).rows[0];
   answerIds=answer?[answer.id]:[];
  }
  if(!answerIds.length)throw new HTTPException(409,{message:'当前模型集合没有成功答案可评分'});
  const raw=(await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=6',[w.project_id])).rows[0]?.config;
  const mergedConfig=raw?.provider==='api'?raw:mergeCodexDefaults(raw,await readProjectAgentDefaults(db,w.project_id));
  const config=validateStepConfigForExecution(6,mergedConfig),loggingConfig=config.provider==='api'?{model:config.api.model,provider:'api'}:{model:config.model,reasoning_effort:config.reasoning_effort,provider:'codex'},queued:string[]=[];
  config.prompt=resolveScoreStepPrompt(config.prompt);
  const needsHooks=!!(config.workflow?.hooks.before.length||config.workflow?.hooks.after.length);
  const skill=needsHooks?await resolveEffectiveProjectSkill(w):undefined;
  const hooks=skill?await freezeStageHooks(dirname(skill.path),config.workflow):undefined;
  await supersedeForeignPending(db,{kind:'step',id,ordinal:6});
  const materialCache=new Map();
  for(const answerId of answerIds){
   // 工作流已加锁：先拒绝活动评分，避免重复点击仍读取完整材料并延长事务。
   if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND input->'context'->'binding'->>'answer_attempt_id'=$2 AND status IN ('waiting','running') LIMIT 1",[id,answerId])).rowCount)throw new HTTPException(409,{message:'此答案已有评分任务'});
   const context=await readScoreContext(db,id,answerId,false,false,materialCache);context.step_prompt=config.prompt||DEFAULT_STEP_PROMPTS[6];projectStepPolicies.scoreProtocol.execute(resolveStepProjectKey({project_name:context.project_name,content_contract:context.content_contract}),{context});buildAnonymousInput(context);
   const input={context,digest:scoreContextDigest(context),execution_instructions:scoreExecutionInstructions(config.provider,context.scoring_policy?.contract,context.candidate_quote_check),...(hooks?{hooks,hook_digest:createHash('sha256').update(canonicalJson(hooks)).digest('hex')}:{})};
   const attempt=crypto.randomUUID();
   await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config) SELECT $2,$1::uuid,6,COALESCE(max(attempt),0)+1,'waiting',$3,$4 FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=6",[id,attempt,JSON.stringify(input),JSON.stringify(config)]);
   queued.push(attempt);
  }
  await registerLocalJobs(db,queued.map(id=>({id,kind:'step' as const,lane:config.provider==='api'?'api' as const:'agent' as const,route:'score'})));
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=6",[id]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal>6 AND ordinal<=8",[id]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='评分更新，后续任务失效',finished_at=now() WHERE workflow_id=$1 AND ordinal>6 AND ordinal<=8 AND status IN ('waiting','running')",[id]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[id]);
  await db.query('COMMIT');forgetLocalRegistrations(db);for(const attemptId of queued)withLogContext({component:'scoring',workflow_id:id,project_id:w.project_id,ordinal:6,attempt_id:attemptId,operation:'score_enqueue',provider:loggingConfig.provider,model:loggingConfig.model,...('reasoning_effort'in loggingConfig?{reasoning_effort:loggingConfig.reasoning_effort}:{})},()=>logEvent('attempt.enqueued',{level:'info',state:'waiting'}));return bundle?{id:queued[0]!,ids:queued,reused:false}:{id:queued[0]!,reused:false};
 }catch(error){await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);throw error;}finally{db.release();}
}
interface ScoreRun {report:unknown;session_id:string;usage:unknown;duration_ms:number;execution_request?:unknown;raw_text?:string}
type Grader=(context:ScoreContext,options:any)=>Promise<ScoreRun>;
async function stillCurrent(db:PoolClient,job:any){
 const w=(await db.query(workflowSql,[job.workflow_id])).rows[0];if(!w)return false;
 try{const current=await readScoreContext(db,job.workflow_id,job.input.context.binding.answer_attempt_id,!!job.input.context.project_rules,!!job.input.context.project_prompt);if(job.input.context.candidate_quote_check!==undefined){if(!projectStepPolicies.scoreProtocol.execute(resolveStepProjectKey({project_name:current.project_name,content_contract:current.content_contract}),{context:current,frozen:job.input.context}))return false;}if(job.input.context.step_prompt!==undefined)current.step_prompt=job.input.context.step_prompt;if(job.input.context.project_name===undefined){delete current.project_name;delete current.question_id;}return current.binding.answer_attempt_id===job.input.context.binding.answer_attempt_id&&scoreContextDigest(current)===job.input.digest;}
 catch(error){if(error instanceof HTTPException&&[404,409].includes(error.status))return false;throw error;}
}
/** 聚合查询投影；逐项完整报告仍由独立评分记录保存。 */
type ScoreAggregationRow={
 id:string;status:import('../../shared/types').StepStatus;
 input:{context?:{binding?:{answer_attempt_id?:string|null}}}|null;
 result:{report?:{contract?:string;total?:unknown;max_score?:unknown;summary?:{raw_score?:number|null;full_score?:number|null;evaluation_percent?:number|null;veto_triggered?:boolean|null};disputes?:unknown[]};validation?:{valid?:boolean};score_extraction?:unknown;binding?:unknown}|null;
};
/** 只汇总当前成功答案绑定的最新评分；执行成功与validation.valid分开，达标由decisions判断。 */
export async function refreshScoreStep(db: PoolClient, job: {workflow_id:string;status:import('../../shared/types').StepStatus;result?:unknown}) {
    const answerStep = (await db.query("SELECT result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=5", [job.workflow_id])).rows[0];
    const answers = Array.isArray(answerStep?.result?.models) ? answerStep.result.models as AnswerStepModelSummary[] : null;
    if (!answers) {
        await db.query('UPDATE ai_distill.steps SET status=$2,result=$3,error=$4,finished_at=now() WHERE workflow_id=$1 AND ordinal=6', [job.workflow_id, job.status, JSON.stringify(job.result), job.status === 'failed' ? '评分存在争议或执行失败' : null]);
        return job.status;
    }
    // 只汇总当前答案的最新评分；历史上下文和逐项报告仍保存在原记录。
    const rows = await db.query<ScoreAggregationRow>("SELECT id,input,result,status FROM (SELECT DISTINCT ON (input #>> '{context,binding,answer_attempt_id}') id,jsonb_build_object('context',jsonb_build_object('binding',jsonb_build_object('answer_attempt_id',input #> '{context,binding,answer_attempt_id}'))) AS input,jsonb_build_object('report',jsonb_build_object('total',result #> '{report,total}','max_score',result #> '{report,max_score}','contract',result #> '{report,contract}','summary',result #> '{report,summary}','disputes',result #> '{report,disputes}'),'validation',jsonb_build_object('valid',result #> '{validation,valid}'),'score_extraction',result->'score_extraction','binding',result->'binding') AS result,status FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND input #>> '{context,binding,answer_attempt_id}'=ANY($2::text[]) ORDER BY input #>> '{context,binding,answer_attempt_id}',attempt DESC) latest", [job.workflow_id, answers.filter((answer) => answer.status === 'succeeded' && typeof answer.attempt_id === 'string').map((answer) => answer.attempt_id)]);
    const latest = new Map<string, ScoreAggregationRow>();
    for (const row of rows.rows) {
        const answerId = row.input?.context?.binding?.answer_attempt_id;
        if (typeof answerId === 'string' && !latest.has(answerId))
            latest.set(answerId, row);
    }
    const models: ScoreStepModelSummary[] = answers.map((answer) => {
        if (answer.status !== 'succeeded' || typeof answer.attempt_id !== 'string')
            return { model_id: answer.model_id, name: answer.name, answer_attempt_id: answer.attempt_id ?? null, answer_status: answer.status, score_attempt_id: null, score_status: 'skipped' };
        const score = latest.get(answer.attempt_id);
        const report = score?.result?.report;
        const validation = score?.result?.validation;
        return {
            model_id: answer.model_id,
            name: answer.name,
            answer_attempt_id: answer.attempt_id,
            answer_status: answer.status,
            score_attempt_id: score?.id ?? null,
            score_status: score?.status ?? 'waiting',
            ...(report?.contract === 'model_report_v1' ? { score_contract: 'model_report_v1' as const, raw_score: report.summary?.raw_score ?? null, full_score: report.summary?.full_score ?? null, evaluation_percent: report.summary?.evaluation_percent ?? null, veto_triggered: report.summary?.veto_triggered ?? null } : {}),
            score: typeof report?.total === 'number' ? report.total : null,
            max_score: typeof report?.max_score === 'number' ? report.max_score : null,
            extraction_status: score?.result?.score_extraction ? (validation?.valid ? 'parsed' : 'unparsed') : undefined,
            valid: typeof validation?.valid === 'boolean' ? validation.valid : null,
            binding: score?.result?.binding ?? null,
            disputes: Array.isArray(report?.disputes) ? report.disputes : []
        };
    });
    const expected = models.filter((model) => model.answer_status === 'succeeded');
    const settled = expected.length > 0 && expected.every((model) => ['succeeded', 'failed', 'skipped'].includes(model.score_status));
    const succeeded = settled && expected.every((model) => model.score_status === 'succeeded');
    const running = expected.some((model) => model.score_status === 'running');
    const status = succeeded ? 'succeeded' : settled ? 'failed' : running ? 'running' : 'waiting';
    await db.query("UPDATE ai_distill.steps SET status=$2,result=$3,error=$4,finished_at=CASE WHEN $2 IN ('succeeded','failed') THEN now() ELSE NULL END WHERE workflow_id=$1 AND ordinal=6 AND EXISTS(SELECT 1 FROM ai_distill.workflows WHERE id=$1)", [job.workflow_id, status, JSON.stringify({ models }), status === 'failed' ? '部分模型评分未通过或执行失败' : null]);
    return status;
}
/**
 * 领取一份答案的评分任务，通过冻结的Codex/API配置评分并校验上下文摘要和报告结构。
 * 结果写入前再次确认版本绑定；legacy必须返回可用最终总分才记成功；model_report保留独立的执行与结构状态。
 */
export async function runNextScore(pool: Pool, root: string, grade: Grader = runIndependentScore, signal?: AbortSignal, judgeAcceptance: (workflowId: string) => Promise<unknown> = (workflowId) => runAcceptance(pool, workflowId), provider: 'codex' | 'api' = 'codex', workerMode: StageWorkerMode = 'all', workflowIds?: string[]) {
    if (signal?.aborted)
        return false;
    const affinity = stageHookAffinitySql(workerMode);
    const db = await pool.connect();
    let job: any, staleRows: any[] = [];
    const staleScoreStatuses = new Map<string, string>();
    try {
        await db.query('BEGIN');
        await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))");
        const stale = await db.query(`SELECT a.id,a.workflow_id,a.heartbeat_at,a.input,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE a.ordinal=6 AND COALESCE(a.config->>'provider','codex')=$1 AND ($2::uuid[] IS NULL OR a.workflow_id=ANY($2)) AND ${affinity} AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ${localClaimSql('a', true)}  ORDER BY w.id,a.id FOR UPDATE OF w,a SKIP LOCKED`, [provider, workflowIds?.length ? workflowIds : null]);
        for (const row of stale.rows) {
            await recoverInterruptedStageHooks(db, row);
            const updated = await db.query("UPDATE ai_distill.step_attempts SET status='failed',error='评分进程中断，可重试',finished_at=now() WHERE id=$1 AND status='running' RETURNING id", [row.id]);
            await db.query("UPDATE ai_distill.steps SET status='failed',error='评分进程中断，可重试',finished_at=now() WHERE workflow_id=$1 AND ordinal=6 AND status='running' AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1)", [row.workflow_id]);
            if (updated.rowCount)
                staleRows.push(row);
        }
        for (const workflowId of new Set(staleRows.map(row => row.workflow_id))) {
            staleScoreStatuses.set(workflowId, await refreshScoreStep(db, { workflow_id: workflowId, status: 'failed', result: null }));
        }
        job = (await db.query(`SELECT a.*,w.project_id FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id WHERE w.deleted_at IS NULL AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=w.project_id AND p.deleted_at IS NULL) AND a.ordinal=6 AND COALESCE(a.config->>'provider','codex')=$1 AND ($2::uuid[] IS NULL OR a.workflow_id=ANY($2)) AND ${affinity} AND ${localWaitingSql('a')} ${localClaimSql('a', false)}  ORDER BY a.started_at,a.id FOR UPDATE OF w,a SKIP LOCKED LIMIT 1`, [provider, workflowIds?.length ? workflowIds : null])).rows[0];
        if (!job) {
            await db.query('COMMIT');forgetLocalRegistrations(db);
        }
        else {
            await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=COALESCE(started_at,now()),heartbeat_at=now() WHERE id=$1", [job.id]);
            if (!readStepFailure())
                await db.query("UPDATE ai_distill.steps SET status='running',error=NULL,started_at=now() WHERE workflow_id=$1 AND ordinal=6", [job.workflow_id]);
            await db.query('COMMIT');forgetLocalRegistrations(db);
        }
    }
    catch (error) {
        await db.query('ROLLBACK');await releaseRolledBackRegistrations(db);
        throw error;
    }
    finally {
        db.release();
    }
    for (const row of staleRows)
        withLogContext({ component: 'scoring', project_id: row.project_id, workflow_id: row.workflow_id, ordinal: 6, attempt_id: row.id, operation: 'score' }, () => logEvent('attempt.recovered_interrupted', { level: 'error', state: 'failed', threshold_ms: 300000, ...(row.heartbeat_at ? { last_heartbeat_at: new Date(row.heartbeat_at).toISOString() } : {}) }));
    for (const [workflowId, status] of staleScoreStatuses)
        await automaticallyJudgeAfterScoring({ workflow_id: workflowId }, status, judgeAcceptance);
    if (!job)
        return false;
    const restoreLogContext = enterLogContext({ component: 'scoring', workflow_id: job.workflow_id, project_id: job.project_id, ordinal: 6, attempt_id: job.id, operation: 'score', provider: job.config?.provider ?? 'codex', model: job.config?.provider === 'api' ? job.config?.api?.model : job.config?.model, ...(job.config?.reasoning_effort ? { reasoning_effort: job.config.reasoning_effort } : {}) });
    logEvent('attempt.claimed', { level: 'info', state: 'running' });
    logEvent('attempt.started', { level: 'info', state: 'running' });
    const cancellation = watchTaskCancellation(pool, job.id, signal, false);
    signal = cancellation.signal;
    const stopHeartbeat = startAttemptHeartbeat(pool, { component: 'scoring', project_id: job.project_id, workflow_id: job.workflow_id, ordinal: 6, attempt_id: job.id }, '评分心跳写入失败');
    let wrote = false, failurePhase = 'input_validation';
    const directory = join(resolve(root), job.workflow_id, job.id);
    try {
        resumeStepFailure();
        buildAnonymousInput(job.input.context);
        const before = await pool.connect();
        try {
            await before.query('BEGIN');
            if (!await stillCurrent(before, job))
                throw new Error('obsolete');
            await before.query('COMMIT');
        }
        catch (error) {
            await before.query('ROLLBACK');
            throw error;
        }
        finally {
            before.release();
        }
        const config = job.config;
        const executionProvider = config?.provider === 'api' ? 'api' : 'codex';
        // 旧无核对正文的队列继续原协议；新任务校验冻结正文，不在执行时给旧任务补新指令。
        const frozenReading = job.input.execution_instructions?.model_report_reading_instructions;
        const legacyPreflight = job.input.execution_instructions?.legacy_text_preflight === 'text_v1';
        const currentInstructions = scoreExecutionInstructions(executionProvider, frozenReading !== undefined ? job.input.context.scoring_policy?.contract : undefined, job.input.context.candidate_quote_check, legacyPreflight);
        if (job.input.execution_instructions && scoreExecutionDigest(executionProvider, job.input.execution_instructions) !== scoreExecutionDigest(executionProvider, currentInstructions))
            throw new Error('评分执行指令已变化，请重新派发评分');
        if (executionProvider === 'codex' && (typeof config.model !== 'string' || !config.model.trim() || typeof config.reasoning_effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(config.reasoning_effort)))
            throw new Error('invalid frozen config');
        if (executionProvider === 'api' && (!config.api || typeof config.api.model !== 'string'))
            throw new Error('invalid frozen config');
        failurePhase = 'agent_execution';
        await emitLifecycle(pool,'before', {stage:'scoring',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal});
        const hookContext = { pool, attempt_id: job.id, workflow_id: job.workflow_id, stage: 'scoring' as const, binding_digest: createHash('sha256').update(canonicalJson({ input: job.input.digest, config: job.config })).digest('hex'), input: { files: buildScoreFiles(buildAnonymousInput({ ...job.input.context, project_name: undefined, question_id: undefined, project_prompt: undefined, project_rules: undefined }), false) }, hooks: job.input.hooks, signal };
        const invocation = await executeWithStageHooks({
            ...hookContext,
            runMain: additions => runExternalCall({
                attempt_id: job.id, operation: 'score'
            }, call_id => {
                const scoreOptions = executionProvider === 'api' ? {
                    hook_additions: additions,
                    config: config.api,
                    step_prompt: job.input.context.step_prompt ?? config.prompt ?? DEFAULT_STEP_PROMPTS[6],
                    model_report_reading_instructions: frozenReading ?? '',
                    signal,
                    call_id,
                    timeout_ms: 1800000
                } : {
                    hook_additions: additions,
                    legacy_text_preflight: false,
                    root: join(directory, 'private'),
                    model: config.model,
                    reasoning_effort: config.reasoning_effort,
                    step_prompt: job.input.context.step_prompt ?? config.prompt ?? DEFAULT_STEP_PROMPTS[6],
                    model_report_reading_instructions: frozenReading ?? '',
                    signal,
                    call_id,
                    timeout_ms: 1800000
                };
                return grade(job.input.context, scoreOptions);
            }),
            outputForHooks: value => ({
                raw_text: value.raw_text ?? '', report: value.report
            })
        });
        if (signal?.aborted)
            throw new Error('cancelled');
        failurePhase = 'result_validation';
        const isModelReport = job.input.context.scoring_policy?.contract === 'model_report_v1';
        const validation = isModelReport ? { ...extractModelReport(invocation.raw_text ?? '', job.input.context.rubric, job.input.context.candidate_quote_check ? job.input.context.answer : undefined), total: null, max_score: null } : typeof invocation.raw_text === 'string' ? extractTextScore(invocation.raw_text, job.input.context.rubric) : validateScore(invocation.report, job.input.context);
        const report = isModelReport ? { binding: job.input.context.binding, total: null, max_score: null, ...('report' in validation && validation.report ? validation.report : { contract: 'model_report_v1' }) } : invocation.report;
        const textReturned = typeof invocation.raw_text === 'string' && !!invocation.raw_text.trim();
        const context = job.input.context;
        const projectBinding = context.project_prompt ? { project_prompt_digest: context.project_prompt.source_digest, project_prompt_files: context.project_prompt.files.map((file: {
                path: string;
                sha256: string;
                size_bytes: number;
            }) => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes })) } : context.project_rules ? { project_rule_version_id: context.project_rules.version_id, project_rule_source_digest: context.project_rules.source_digest, project_rule_files: context.project_rules.files.map((file: {
                path: string;
                sha256: string;
                size_bytes: number;
            }) => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes })) } : {};
        const publication = { question_version: context.binding.question_version, rubric_version: context.binding.rubric_version, ...projectBinding, provider: executionProvider, ...(invocation.execution_request ? { execution_request: invocation.execution_request } : {}), ...(textReturned ? { raw_text: invocation.raw_text, score_extraction: validation } : {}), report, validation, binding: context.binding, session_id: invocation.session_id, usage: invocation.usage, duration_ms: invocation.duration_ms, model: executionProvider === 'api' ? config.api.model : config.model, ...(executionProvider === 'codex' ? { reasoning_effort: config.reasoning_effort } : {}) };
        failurePhase = 'result_persistence';
        const bytes = Buffer.from(JSON.stringify(publication, null, 2) + '\n'), path = join(directory, 'score.json');
        await mkdir(directory, { recursive: true });
        wrote = true;
        logEvent('file.write.started', { level: 'info', file_kind: 'score_report', output_bytes: bytes.length });
        await writeFile(path, bytes, { mode: 0o600 });
        logEvent('file.write.completed', { level: 'info', file_kind: 'score_report', output_bytes: bytes.length });
        const tx = await pool.connect();
        let scoreStepStatus = '';
        try {
            await tx.query('BEGIN');
            if (!await stillCurrent(tx, job) || !(await tx.query("SELECT id FROM ai_distill.step_attempts WHERE id=$1 AND status='running' FOR UPDATE", [job.id])).rowCount)
                throw new Error('obsolete');
            await tx.query('INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)', [crypto.randomUUID(), job.workflow_id, job.id, 'score_report', relative(resolve(root), path), createHash('sha256').update(bytes).digest('hex'), bytes.length]);
            const succeeded = isModelReport ? textReturned || validation.valid : validation.valid;
            const status = succeeded ? 'succeeded' : 'failed', error = succeeded ? null : isModelReport ? '评分结果缺失，详见报告记录' : '评分未返回可用最终总分，请重新评分；原文已保留';
            await tx.query('UPDATE ai_distill.step_attempts SET status=$2,result=$3,session_id=$4,error=$5,finished_at=now() WHERE id=$1', [job.id, status, JSON.stringify(publication), invocation.session_id, error]);
            job.status = status;
            job.result = publication;
            scoreStepStatus = await refreshScoreStep(tx, job);
            await prepareCommittedStageHooks({...hookContext,pool:tx}, { raw_text: invocation.raw_text ?? '', report: invocation.report });
            await tx.query('COMMIT');forgetLocalRegistrations(tx);
            logEvent('attempt.completed', { level: validation.valid ? 'info' : 'error', state: status, output_bytes: bytes.length, token_usage: invocation.usage, ...(!validation.valid ? { failure_phase: 'result_validation' } : {}) });
        }
        catch (error) {
            await tx.query('ROLLBACK');await releaseRolledBackRegistrations(tx);
            throw error;
        }
        finally {
            tx.release();
        }
        await runCommittedStageHooks(hookContext, { raw_text: invocation.raw_text ?? '', report: invocation.report });
        await emitLifecycle(pool,job.status==='succeeded'?'committed':'failed', {stage:'scoring',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal,data:{result:publication}});
        await automaticallyJudgeAfterScoring(job, scoreStepStatus, judgeAcceptance);
    }
    catch (error) {
        deferLocalPublication(error);
        await emitLifecycle(pool,signal?.aborted?'cancelled':'failed', {stage:'scoring',execution_id:job.id,workflow_id:job.workflow_id,project_id:job.project_id,signal});
        logEvent('attempt.failed', { level: 'error', state: 'failed', ...classifyLogError(error), failure_phase: failurePhase });
        const failure = saveStepFailure(error instanceof RecordedStepFailure ? error.failure : { status: 'failed', message: '评分或钩子执行失败，或版本已失效，可检查记录后重试', result: error instanceof StageHookError ? { error_code: 'project_hook_failed' } : { failure_phase: failurePhase, ...classifyLogError(error) } });
        if (wrote)
            try {
                if (!(await pool.query('SELECT id FROM ai_distill.artifacts WHERE attempt_id=$1 LIMIT 1', [job.id])).rowCount)
                    await rm(join(directory, 'score.json'), { force: true });
            }
            catch (cleanupError) {
                logEvent('file.cleanup_or_commit_check_failed', { level: 'error', file_kind: 'score_report', ...classifyLogError(cleanupError) });
                console.error('评分发布状态未知，保留文件等待核对');
            }
        const tx = await pool.connect();
        let scoreStepStatus = '', shouldJudge = false;
        try {
            await tx.query('BEGIN');
            const current = await stillCurrent(tx, job);
            const failed = await tx.query("UPDATE ai_distill.step_attempts SET status='failed',result=$2,error=$3,finished_at=now() WHERE id=$1 AND status='running'", [job.id, JSON.stringify(failure.result), failure.message]);
            if (current && failed.rowCount) {
                job.status = 'failed';
                job.result = null;
                scoreStepStatus = await refreshScoreStep(tx, job);
                shouldJudge = true;
            }
            await tx.query('COMMIT');forgetLocalRegistrations(tx);
        }
        catch (error) {
            await tx.query('ROLLBACK');await releaseRolledBackRegistrations(tx);
            throw error;
        }
        finally {
            tx.release();
        }
        if (shouldJudge)
            await automaticallyJudgeAfterScoring(job, scoreStepStatus, judgeAcceptance);
    }
    finally {
        cancellation.dispose();
        stopHeartbeat();
        restoreLogContext();
    }
    return true;
}
