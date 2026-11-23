// 将批次分项接到现有四个业务入口，只有同来源的成功记录才能解锁后继。
import type { Pool } from 'pg';
import { HTTPException } from 'hono/http-exception';
import { fileURLToPath } from 'node:url';
import { withLocalQueueRoot } from '../execution-queue/runtime';
import type { LocalQueue } from '../execution-queue/store';
import { enqueueLibraryJob } from '../material-library/jobs';
import { enqueuePreparation } from '../material-library/preparation';
import { createLibraryQuestion } from '../material-library/questions';
import { loadLibraryPackage, updateLoadedLibraryPackage } from '../material-library/projects';
import { enqueueAuthoring } from '../authoring/jobs';
import { syncAuthoredWorkflowToFeishu, syncArchivedWorkflowToFeishu } from '../publishing/feishu';
import { DeliveryReceiptError, type BatchBackend } from './scheduler';
import type { Entry, Result } from './store';
const assets = fileURLToPath(new URL('../../assets/out/', import.meta.url));
const conflict = (message: string) => new HTTPException(409, { message });
export function businessBackend(pool: Pool, q: LocalQueue, agent: number, delivery: number): BatchBackend {
  async function projectWorkflow(id: string, project: string) {
    if (
      !(
        await pool.query(
          'SELECT 1 FROM ai_distill.workflows WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL',
          [id, project]
        )
      ).rowCount
    )
      throw conflict('目标题与清单期次不匹配');
  }
  async function author(e: Entry, parent?: Result) {
    const i = e.task.input;
    let workflow = i.workflow_id;
    const source =
      parent ??
      (i.redaction_id
        ? { redaction_id: i.redaction_id }
        : i.revision_id
          ? { revision_id: i.revision_id, redaction_id: null }
          : undefined);
    if (!workflow) {
      const origin = source?.redaction_id
        ? { redaction_id: source.redaction_id }
        : { revision_id: source?.revision_id };
      let version = i.link_version!,
        linkId = i.link_id;
      if (i.load_package_id) {
        if (parent && parent.package_id !== i.load_package_id) throw conflict('待加载的材料包与上游不同');
        const loaded = await loadLibraryPackage(
          pool,
          i.project_id,
          i.load_package_id,
          origin.redaction_id,
          origin.revision_id,
          i.original_workflow_id
            ? { source_workflow_id: i.original_workflow_id, direction: i.direction! }
            : undefined
        );
        linkId = loaded.id;
        version = Number(loaded.lock_version);
      } else if (parent) {
        const link = (
          await pool.query(
            'SELECT package_id,selected_revision_id,selected_redaction_id,lock_version FROM ai_distill.project_library_packages WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
            [i.link_id, i.project_id]
          )
        ).rows[0];
        if (!link || link.package_id !== parent.package_id) throw conflict('目标加载关系与上游包不同');
        const matches =
          link.selected_redaction_id === (parent.redaction_id ?? null) &&
          link.selected_revision_id === parent.revision_id;
        if (!matches && i.select_source) {
          const updated = await updateLoadedLibraryPackage(pool, i.project_id, i.link_id!, version, origin);
          version = Number(updated.lock_version);
        } else if (matches && i.select_source && Number(link.lock_version) === version + 1) version++;
      }
      workflow = (
        await createLibraryQuestion(pool, q.root, i.project_id, linkId!, {
          ...origin,
          expected_link_version: version,
          title: i.title,
          request_key: e.token,
          ...(i.target_level ? { target_level: i.target_level } : {}),
          ...(i.direction ? { authoring_direction: i.direction } : {})
        })
      ).id;
    }
    return enqueueAuthoring(
      pool,
      workflow!,
      { model: i.model, provider: i.provider, reasoning_effort: i.reasoning_effort },
      { attempt: e.token, project: i.project_id, source }
    );
  }
  const bind = (e: Entry, parent?: Result) =>
    withLocalQueueRoot(q.root, async () => {
      const i = e.task.input;
      const model = i.model ? { agent_settings: { model: i.model, reasoning_effort: i.reasoning_effort } } : {};
      if (e.task.type === 'author') return author(e, parent);
      if (e.task.type === 'redact')
        return enqueueLibraryJob(
          pool,
          i.package_id!,
          i.revision_id!,
          {
            ...model,
            kind: 'redact',
            execution_target: 'local',
            request_key: e.token,
            project_id: i.project_id,
            extraction_job_id: i.extraction_job_id,
            ...(i.previous_job_id ? { previous_job_id: i.previous_job_id } : {})
          },
          q.root,
          e.token
        );
      const valid = await pool.query('SELECT 1 FROM ai_distill.library_revisions WHERE id=$1 AND package_id=$2', [
        i.revision_id,
        i.package_id
      ]);
      if (!valid.rowCount) throw conflict('整理材料包与版本不匹配');
      return enqueuePreparation(
        pool,
        q.root,
        i.revision_id!,
        {
          ...model,
          project_id: i.project_id,
          request_key: e.token,
          ...(i.force ? { force: true } : {}),
          ...(parent?.redaction_id || i.redaction_id
            ? { redaction_id: parent?.redaction_id ?? i.redaction_id }
            : { extraction_job_id: i.extraction_job_id })
        },
        e.token
      );
    });
  return {
    capacity: () => ({ agent, waiting: q.capacity('agent', agent).available, delivery }),
    queued: (e) => !e.job || ['queued', 'pending_registration'].includes(q.get(e.job)?.state ?? ''),
    async start(e, parent) {
      const r = await bind(e, parent);
      // 业务方法在事务提交后返回；仅确认本机同代、有归属的已提交任务。
      const job = q.get(r.id);
      if (job?.state === 'pending_registration') {
        const owned = await pool.query(
          'SELECT 1 FROM ai_distill.execution_dispatches WHERE job_id=$1 AND executor_id=$2 AND generation=$3',
          [job.id, q.executorId, job.generation]
        );
        if (owned.rowCount) q.confirm(job.id, agent);
      }
      return { id: r.id };
    },
    async check(e) {
      const local = e.job ? q.get(e.job) : null;
      if (
        local &&
        ['queued', 'running', 'pending_registration', 'result_pending_commit'].includes(local.state) &&
        !q.db.query('SELECT 1 FROM dispatch_commits WHERE job=?').get(local.id)
      )
        return { state: 'working' };
      const i = e.task.input;
      const row = (
        await (e.task.type === 'author'
          ? pool.query(
              `SELECT a.status,a.result->>'error_code' AS error_code,a.error AS error_message,a.workflow_id,a.id AS author_attempt_id,a.result->>'question_version' AS question_version
    FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id
    WHERE a.id=$1 AND a.ordinal=4 AND w.project_id=$2 AND w.deleted_at IS NULL`,
              [e.job, i.project_id]
            )
          : pool.query(
              `SELECT j.status,j.error_code,j.error_message,j.package_id,j.revision_id,COALESCE(p.extraction_job_id,r.extraction_job_id) AS extraction_job_id,
     COALESCE(p.redaction_id,r.id) AS redaction_id,p.id AS preparation_id FROM ai_distill.library_jobs j
     LEFT JOIN ai_distill.library_redactions r ON r.redaction_job_id=j.id AND r.validation_report->>'usable_for_question'='true'
      AND (j.result_summary->'latest_program_validation'->>'valid') IS DISTINCT FROM 'false'
     LEFT JOIN ai_distill.library_preparations p ON p.job_id=j.id AND p.project_id=$5
     WHERE j.id=$1 AND j.kind=$2 AND j.package_id=$3 AND j.revision_id=$4`,
              [e.job, e.task.type, i.package_id, i.revision_id, i.project_id]
            ))
      ).rows[0];
      if (row?.status === 'succeeded') {
        if (e.task.type === 'author' && row.question_version)
          return {
            state: 'succeeded',
            result: {
              workflow_id: row.workflow_id,
              author_attempt_id: row.author_attempt_id,
              question_version: row.question_version
            }
          };
        if (e.task.type === 'redact' ? row.redaction_id : e.task.type === 'prepare' && row.preparation_id) {
          const { status, error_code, error_message, ...result } = row;
          return { state: 'succeeded', result };
        }
        return { state: 'failed', error: '成功记录缺少匹配的业务产物' };
      }
      if (row && ['failed', 'cancelled', 'skipped'].includes(row.status))
        return {
          state: 'failed',
          error: [row.error_code, row.error_message].filter(Boolean).join(' · ').slice(0, 1000) || row.status
        };
      return { state: 'unknown', error: '执行结果或本机归属待核实' };
    },
    async deliver(e, parent) {
      const i = e.task.input,
        w = parent?.workflow_id ?? i.workflow_id!,
        attempt = parent?.author_attempt_id ?? i.author_attempt_id!;
      await projectWorkflow(w, i.project_id);
      const target = { base_token: i.base_token!, table_id: i.table_id! };
      const r =
        i.mode === 'draft'
          ? await syncAuthoredWorkflowToFeishu(
              pool,
              w,
              q.root,
              assets,
              target,
              undefined,
              i.attachment_format,
              false,
              i.record_id,
              attempt
            )
          : await syncArchivedWorkflowToFeishu(
              pool,
              w,
              q.root,
              assets,
              target,
              false,
              i.attachment_format,
              false,
              attempt
            );
      if (r.status !== 'succeeded' || !('record_id' in r) || !r.record_id) {
        const code = String('reason_code' in r ? r.reason_code : r.status);
        const message = '飞书交付未取得成功回执：' + code;
        const verification = 'verification' in r ? r.verification?.status : undefined;
        const knownFailure =
          verification === 'failed' ||
          [
            'not_applicable',
            'feishu_authoring_version_changed',
            'feishu_current_authoring_required',
            'feishu_current_archive_required'
          ].includes(code);
        throw new DeliveryReceiptError(message, knownFailure ? 'failed' : 'unknown', {
          workflow_id: w,
          author_attempt_id: attempt,
          receipt: { ...target, status: r.status, reason_code: code, verification_status: verification }
        });
      }
      return { workflow_id: w, author_attempt_id: attempt, receipt: r };
    }
  };
}
