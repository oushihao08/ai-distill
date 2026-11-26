/**
 * 职责：期次内“原件包免提取/免脱敏直接建题（可选一键派发出题）”原子服务。
 * 主要公开入口：`createDirectRawQuestion()`，供 `POST /api/projects/:id/direct-raw-questions` 调用。
 * 边界：
 * - 不调用外部云端 OCR（MinerU/GLM）或大模型脱敏，本地秒级生成各文件结构导览并原样保存二进制原件；
 * - 完整遵守主项目永久材料占用账（`project_material_uses`）与 `library_v1` `original` 题目快照契约；
 * - 题目快照显式标记 `origin.raw_passthrough = true`，不影响同期次 `aliases` 脱敏题目的配置与行为。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { HTTPException } from 'hono/http-exception';
import { STEP_REGISTRY } from '../../shared/step-registry';
import { canonicalJson } from '../../shared/workflow-config';
import { enqueueAuthoring } from '../authoring/jobs';
import { projectStepPolicies, resolveStepProjectKey } from '../lifecycle/steps';
import { inspectDirectRawFile, isDirectRawSupportedFilename } from '../materials/raw-package-inspector';
import { MAX_FILE, MAX_FOLDER_BATCH, uuid } from '../validation';
import { LIBRARY_LOAD_ASSESSMENT_VERSION } from './load-eligibility';
import { libraryQuestionStepOrdinals } from './questions';
import { buildDefaultProcessingSettings, buildLibraryManifest } from './service';
import {
  cleanupRolledBackLibraryBlobs,
  installLibraryBlob,
  insertLibraryTextBlob,
  lockLibraryBlobWrites,
  normalizeLibraryFilename,
  type InstalledLibraryBlob,
} from './storage';
import { claimMaterialUse, materialSetSignature } from './uses';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const conflict = (message: string) => new HTTPException(409, { message });

export interface DirectRawUploadFile {
  original_name: string;
  bytes: Uint8Array;
}

export interface DirectRawQuestionInput {
  request_key: string;
  title: string;
  package_name?: string;
  scenario?: string;
  role_perspective?: string;
  authoring_direction?: string;
  target_level?: 'L2' | 'L3' | 'L4' | 'L5';
  question_tags?: string[];
  auto_author?: boolean;
  files: DirectRawUploadFile[];
}

function cleanOptionalText(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new HTTPException(400, { message: `${label}长度无效（最多 ${max} 字）` });
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function createDirectRawQuestion(
  pool: Pool,
  storageRoot: string,
  projectId: string,
  rawInput: DirectRawQuestionInput,
) {
  const requestKey = uuid(String(rawInput.request_key ?? ''));
  const title = typeof rawInput.title === 'string' ? rawInput.title.trim() : '';
  if (!title || title.length > 180) {
    throw new HTTPException(400, { message: '题目标题须为 1 至 180 字' });
  }
  const packageName = cleanOptionalText(rawInput.package_name, 180, '材料包名称') ?? title;
  const scenario = cleanOptionalText(rawInput.scenario, 2000, '出题场景');
  const rolePerspective = cleanOptionalText(rawInput.role_perspective, 1000, '角色视角');
  const authoringDirection = cleanOptionalText(rawInput.authoring_direction, 10000, '出题方向');
  const targetLevel = rawInput.target_level;
  if (targetLevel !== undefined && !['L2', 'L3', 'L4', 'L5'].includes(targetLevel)) {
    throw new HTTPException(400, { message: '题目难度等级无效' });
  }
  const tags = Array.isArray(rawInput.question_tags) ? rawInput.question_tags.map((t) => String(t).trim()).filter(Boolean) : [];
  if (tags.length > 50 || new Set(tags).size !== tags.length) {
    throw new HTTPException(400, { message: '题目标签无效或重复' });
  }
  const autoAuthor = rawInput.auto_author === true;

  const filteredUploads = (rawInput.files ?? []).filter((f) => {
    const norm = f.original_name.replaceAll('\\', '/');
    if (norm.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('.') || seg.startsWith('~$'))) return false;
    return isDirectRawSupportedFilename(norm);
  });
  if (!filteredUploads.length || filteredUploads.length > 100) {
    throw new HTTPException(400, { message: '请选择 1 至 100 份受支持的原件材料' });
  }

  let totalBytes = 0;
  const seenBasenames = new Set<string>();
  const normalizedUploads = filteredUploads.map((f, idx) => {
    const cleanRel = normalizeLibraryFilename(f.original_name);
    const flatName = basename(cleanRel);
    if (!flatName || flatName.length > 180) {
      throw new HTTPException(400, { message: `原件文件名无效：${f.original_name}` });
    }
    if (seenBasenames.has(flatName)) {
      throw new HTTPException(400, { message: `材料包内存在同名原件「${flatName}」，请确保各原件文件名唯一` });
    }
    seenBasenames.add(flatName);
    const bytes = new Uint8Array(f.bytes);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_FILE || totalBytes > MAX_FOLDER_BATCH) {
      throw new HTTPException(413, { message: '原件单文件或整包总大小超过上限' });
    }
    return { position: idx + 1, original_name: flatName, bytes };
  });

  const inspectedFiles = await Promise.all(
    normalizedUploads.map(async (item) => {
      const inspected = await inspectDirectRawFile(item.original_name, item.bytes);
      const docJson = JSON.stringify(inspected.document);
      const docJsonBytes = Buffer.from(docJson, 'utf8');
      const pageTexts = inspected.document.pages.map((p) => p.text);
      const markdown = pageTexts.filter(Boolean).join('\n\n');
      return {
        ...item,
        ...inspected,
        doc_json: docJson,
        doc_json_bytes: docJsonBytes,
        doc_json_sha256: hash(docJsonBytes),
        text_sha256: hash(pageTexts.join('\n')),
        markdown,
      };
    }),
  );

  const signature = materialSetSignature(inspectedFiles.map((f) => ({ sha256: f.sha256, size_bytes: f.size_bytes })));
  const requestDigest = hash(
    canonicalJson({
      version: 'direct-raw-question-v1',
      project_id: projectId,
      material_signature: signature,
      files: inspectedFiles.map((f) => ({ name: f.original_name, sha256: f.sha256, size_bytes: f.size_bytes })),
      title,
      package_name: packageName,
      scenario: scenario ?? null,
      role_perspective: rolePerspective ?? null,
      target_level: targetLevel ?? null,
      authoring_direction: authoringDirection ?? null,
      question_tags: tags,
    }),
  );

  const priorRow = (
    await pool.query(
      'SELECT workflow_id, package_id, revision_id, request_digest, source_digest, snapshot_digest FROM ai_distill.question_library_sources WHERE project_id=$1 AND request_key=$2',
      [projectId, requestKey],
    )
  ).rows[0];
  if (priorRow) {
    if (priorRow.request_digest !== requestDigest) {
      throw conflict('同一建题请求标识对应了不同的材料包或题目参数');
    }
    let authorAttempt: { id: string; reused: boolean } | null = null;
    if (autoAuthor) {
      authorAttempt = await enqueueAuthoring(pool, String(priorRow.workflow_id));
    }
    return {
      id: String(priorRow.workflow_id),
      package_id: String(priorRow.package_id),
      revision_id: String(priorRow.revision_id),
      source_digest: String(priorRow.source_digest),
      snapshot_digest: String(priorRow.snapshot_digest),
      reused: true,
      ...(authorAttempt ? { author_attempt_id: authorAttempt.id } : {}),
    };
  }

  const packageLevel = /(?:^|[-_\s])L([2-5])(?=$|[-_\s])/i.exec(packageName)?.[1];
  const effectiveLevel = targetLevel ?? (packageLevel ? (`L${packageLevel}` as 'L2' | 'L3' | 'L4' | 'L5') : undefined);
  if (packageLevel && effectiveLevel !== `L${packageLevel}`) {
    throw conflict(`材料包名称标注为 L${packageLevel}，题目难度等级须一致`);
  }

  const defaultSettings = await buildDefaultProcessingSettings(pool);
  const installedBlobs: InstalledLibraryBlob[] = [];
  const questionId = randomUUID();
  const questionDir = join(resolve(storageRoot), questionId);
  let commitAttempted = false;

  try {
    for (const f of inspectedFiles) {
      const installed = await installLibraryBlob(storageRoot, f.bytes, f.content_type, 'local');
      installedBlobs.push(installed);
    }

    await mkdir(questionDir, { recursive: true, mode: 0o700 });
    const stagedQuestionFiles: Array<{
      inspected: (typeof inspectedFiles)[number];
      installed: InstalledLibraryBlob;
      materialId: string;
      sourceArtifactId: string;
      pagesArtifactId: string;
      sourcePath: string;
      pagesPath: string;
    }> = [];
    for (const [idx, f] of inspectedFiles.entries()) {
      const materialId = randomUUID();
      const sourceArtifactId = randomUUID();
      const pagesArtifactId = randomUUID();
      const sourcePath = `${questionId}/${materialId}.source`;
      const pagesPath = `${questionId}/${materialId}.extracted.json`;
      await writeFile(join(questionDir, `${materialId}.source`), f.bytes, { mode: 0o600, flag: 'wx' });
      await writeFile(join(questionDir, `${materialId}.extracted.json`), f.doc_json_bytes, { mode: 0o600, flag: 'wx' });
      stagedQuestionFiles.push({
        inspected: f,
        installed: installedBlobs[idx]!,
        materialId,
        sourceArtifactId,
        pagesArtifactId,
        sourcePath,
        pagesPath,
      });
    }

    const fullMarkdown = stagedQuestionFiles
      .map(({ inspected }) => `# ${inspected.original_name}\n\n${inspected.markdown}`)
      .join('\n\n---\n\n');
    const fullMarkdownSha = hash(fullMarkdown);
    const indexObj = {
      format: 'source-index-v1',
      materials: stagedQuestionFiles.map(({ materialId, inspected }) => ({
        material_id: materialId,
        markdown: inspected.markdown,
        document: inspected.document,
      })),
    };
    const indexText = JSON.stringify(indexObj);
    const indexSha = hash(indexText);
    const markdownPath = `${questionId}/source_markdown.md`;
    const indexPath = `${questionId}/source_index.json`;
    await writeFile(join(questionDir, 'source_markdown.md'), fullMarkdown, { mode: 0o600, flag: 'wx' });
    await writeFile(join(questionDir, 'source_index.json'), indexText, { mode: 0o600, flag: 'wx' });

    const db = await pool.connect();
    let txResult: {
      id: string;
      package_id: string;
      revision_id: string;
      source_digest: string;
      snapshot_digest: string;
      reused: boolean;
    };

    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='5s'");

      const project = (
        await db.query(
          'SELECT id, name, parent_name, phase_name, phase_no, project_group_id, question_tags, deleted_at FROM ai_distill.projects WHERE id=$1',
          [projectId],
        )
      ).rows[0];
      if (!project || project.deleted_at) throw new HTTPException(404, { message: '期次不存在或已删除' });
      if (!project.project_group_id) throw conflict('当前期次缺少主项目归属，无法登记原件占用');

      await db.query('SELECT id FROM ai_distill.project_groups WHERE id=$1 FOR UPDATE', [project.project_group_id]);
      await db.query('SELECT id FROM ai_distill.projects WHERE id=$1 FOR UPDATE', [projectId]);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('material-use'), hashtext($1))", [
        `${project.project_group_id}:${signature}`,
      ]);

      const replayInTx = (
        await db.query(
          'SELECT workflow_id, package_id, revision_id, request_digest, source_digest, snapshot_digest FROM ai_distill.question_library_sources WHERE project_id=$1 AND request_key=$2',
          [projectId, requestKey],
        )
      ).rows[0];
      if (replayInTx) {
        if (replayInTx.request_digest !== requestDigest) {
          throw conflict('同一建题请求标识对应了不同的材料包或题目参数');
        }
        await db.query('COMMIT');
        await rm(questionDir, { recursive: true, force: true }).catch(() => {});
        let authorAttempt: { id: string; reused: boolean } | null = null;
        if (autoAuthor) {
          authorAttempt = await enqueueAuthoring(pool, String(replayInTx.workflow_id));
        }
        return {
          id: String(replayInTx.workflow_id),
          package_id: String(replayInTx.package_id),
          revision_id: String(replayInTx.revision_id),
          source_digest: String(replayInTx.source_digest),
          snapshot_digest: String(replayInTx.snapshot_digest),
          reused: true,
          ...(authorAttempt ? { author_attempt_id: authorAttempt.id } : {}),
        };
      }

      const projectTags: string[] = Array.isArray(project.question_tags) ? project.question_tags : [];
      if (tags.some((t) => !projectTags.includes(t))) {
        throw conflict('所选题目标签不属于当前期次');
      }

      const existingUse = (
        await db.query(
          `SELECT u.*, p.phase_name, p.phase_no
           FROM ai_distill.project_material_uses u
           JOIN ai_distill.projects p ON p.id = u.owner_phase_id
           WHERE u.project_group_id = $1 AND u.material_signature = $2
           FOR UPDATE OF u`,
          [project.project_group_id, signature],
        )
      ).rows[0];

      let packageId: string;
      let actualPackageName: string;
      let revisionId: string;
      let extractionJobId: string;
      let libraryFileIds: string[];
      let linkId: string;

      if (existingUse) {
        if (existingUse.owner_phase_id !== projectId) {
          throw conflict(
            `该原件包已在「${existingUse.phase_name || `第${existingUse.phase_no ?? '?'}期`}」使用（${existingUse.status === 'submitted' ? '已提交' : '使用中'}），不能跨期重复建题`,
          );
        }
        if (existingUse.status === 'submitted') {
          throw conflict('该原件包状态为已提交，不能再次新建题目');
        }
        packageId = String(existingUse.package_id);
        const pkgRow = (
          await db.query(
            'SELECT id, name, current_revision_id, deleted_at FROM ai_distill.library_packages WHERE id=$1 FOR UPDATE',
            [packageId],
          )
        ).rows[0];
        if (!pkgRow || pkgRow.deleted_at || !pkgRow.current_revision_id) {
          throw conflict('同签名历史材料包已归档或缺少可用版本');
        }
        actualPackageName = String(pkgRow.name);
        revisionId = String(pkgRow.current_revision_id);

        const activeQ = (
          await db.query(
            `SELECT q.workflow_id FROM ai_distill.question_library_sources q
             JOIN ai_distill.workflows w ON w.id = q.workflow_id
             WHERE q.project_id = $1 AND q.package_id = $2 AND w.deleted_at IS NULL LIMIT 1`,
            [projectId, packageId],
          )
        ).rows[0];
        const policyIssue = projectStepPolicies.materialQuestion.execute(
          resolveStepProjectKey({ parent_name: project.parent_name, name: project.name }),
          { project, active: Boolean(activeQ) },
        );
        if (policyIssue) throw conflict(policyIssue);

        const extJob = (
          await db.query(
            `SELECT id FROM ai_distill.library_jobs
             WHERE package_id=$1 AND revision_id=$2 AND kind='extract' AND status='succeeded'
             ORDER BY finished_at DESC, id DESC LIMIT 1`,
            [packageId, revisionId],
          )
        ).rows[0];
        if (!extJob) throw conflict('已有材料包缺少可用提取记录');
        extractionJobId = String(extJob.id);

        const libFiles = (
          await db.query(
            `SELECT f.id, f.original_name, b.sha256
             FROM ai_distill.library_files f
             JOIN ai_distill.library_blobs b ON b.id = f.blob_id
             WHERE f.revision_id = $1 ORDER BY f.position`,
            [revisionId],
          )
        ).rows;
        if (
          libFiles.length !== stagedQuestionFiles.length ||
          libFiles.some((row: any, i: number) => row.sha256 !== stagedQuestionFiles[i]!.inspected.sha256)
        ) {
          throw conflict('同签名材料包的文件顺序或版本与当前上传不一致，请从本期已加载材料包创建题目');
        }
        libraryFileIds = libFiles.map((r: any) => String(r.id));

        const existingLink = (
          await db.query(
            'SELECT id, removed_at FROM ai_distill.project_library_packages WHERE project_id=$1 AND package_id=$2 FOR UPDATE',
            [projectId, packageId],
          )
        ).rows[0];
        if (existingLink) {
          linkId = String(existingLink.id);
          if (existingLink.removed_at) {
            await db.query(
              'UPDATE ai_distill.project_library_packages SET removed_at=NULL, selected_revision_id=$2, selected_redaction_id=NULL, lock_version=lock_version+1, updated_at=now() WHERE id=$1',
              [linkId, revisionId],
            );
          }
        } else {
          linkId = randomUUID();
          await db.query(
            `INSERT INTO ai_distill.project_library_packages(id, project_id, package_id, selected_revision_id, selected_redaction_id, material_use_id, position)
             VALUES($1, $2, $3, $4, NULL, $5, (SELECT COALESCE(MAX(position), 0) + 1 FROM ai_distill.project_library_packages WHERE project_id = $2))`,
            [linkId, projectId, packageId, revisionId, existingUse.id],
          );
        }
      } else {
        packageId = randomUUID();
        actualPackageName = packageName;
        revisionId = randomUUID();
        extractionJobId = randomUUID();
        libraryFileIds = stagedQuestionFiles.map(() => randomUUID());

        const libManifest = buildLibraryManifest(
          stagedQuestionFiles.map((s) => ({
            original_name: s.inspected.original_name,
            position: s.inspected.position,
            sha256: s.inspected.sha256,
            size_bytes: s.inspected.size_bytes,
            redaction_mode: 'model' as const,
          })),
        );

        await db.query(
          'INSERT INTO ai_distill.library_packages(id, name, description, tags, processing_settings) VALUES($1, $2, $3, $4, $5::jsonb)',
          [packageId, packageName, '原件直通直接建题导入', tags, JSON.stringify(defaultSettings)],
        );
        await db.query(
          `INSERT INTO ai_distill.library_revisions(id, package_id, parent_revision_id, state, manifest_sha256, file_count, source_info, request_key, request_digest)
           VALUES($1, $2, NULL, 'pending', $3, $4, $5::jsonb, $6, $7)`,
          [
            revisionId,
            packageId,
            libManifest.sha256,
            stagedQuestionFiles.length,
            JSON.stringify({ kind: 'atomic_import', mode: 'direct_raw_passthrough', job_id: extractionJobId }),
            randomUUID(),
            requestDigest,
          ],
        );

        await lockLibraryBlobWrites(
          db,
          stagedQuestionFiles.map((s) => s.inspected.sha256),
        );

        for (const [idx, s] of stagedQuestionFiles.entries()) {
          const createdBlob = await db.query(
            `INSERT INTO ai_distill.library_blobs(id, sha256, size_bytes, content_type, storage_kind, storage_target, storage_path)
             VALUES($1, $2, $3, $4, 'file', 'local', $5)
             ON CONFLICT(sha256, storage_target) WHERE storage_kind='file' DO NOTHING RETURNING id`,
            [randomUUID(), s.installed.sha256, s.installed.size_bytes, s.installed.content_type, s.installed.storage_path],
          );
          let blobId: string | undefined = createdBlob.rows[0]?.id;
          if (!blobId) {
            const existingBlob = (
              await db.query(
                "SELECT id, size_bytes, storage_path FROM ai_distill.library_blobs WHERE sha256=$1 AND storage_kind='file' AND storage_target='local' FOR UPDATE",
                [s.installed.sha256],
              )
            ).rows[0];
            if (!existingBlob || Number(existingBlob.size_bytes) !== s.installed.size_bytes) {
              throw conflict(`原件对象大小冲突：${s.inspected.original_name}`);
            }
            if (existingBlob.storage_path !== s.installed.storage_path) {
              await db.query('UPDATE ai_distill.library_blobs SET storage_path=$2 WHERE id=$1', [
                existingBlob.id,
                s.installed.storage_path,
              ]);
            }
            blobId = String(existingBlob.id);
          }

          await db.query(
            'INSERT INTO ai_distill.library_files(id, revision_id, blob_id, original_name, position, redaction_mode, image_review_required) VALUES($1, $2, $3, $4, $5, $6, false)',
            [libraryFileIds[idx]!, revisionId, blobId, s.inspected.original_name, s.inspected.position, 'model'],
          );
        }

        await db.query("UPDATE ai_distill.library_revisions SET state='ready', sealed_at=now() WHERE id=$1", [revisionId]);
        await db.query(
          'UPDATE ai_distill.library_packages SET current_revision_id=$2, lock_version=lock_version+1, updated_at=now() WHERE id=$1',
          [packageId, revisionId],
        );

        const jobSnapshot = {
          version: 1,
          protocol: 'direct-raw-passthrough-v1',
          manifest_sha256: libManifest.sha256,
          atomic_import: {
            package_id: packageId,
            revision_id: revisionId,
            package_input: { name: packageName, description: '原件直通直接建题导入', tags },
            expected_version: null,
          },
          files: stagedQuestionFiles.map((s, idx) => ({
            file_id: libraryFileIds[idx]!,
            original_name: s.inspected.original_name,
            position: s.inspected.position,
            source_sha256: s.inspected.sha256,
            size_bytes: s.inspected.size_bytes,
          })),
        };
        const jobConfig = { protocol: 'direct-raw-passthrough-v1', provider: 'local', model_invoked: false };
        const jobSummary = {
          provider: 'local',
          mode: 'direct_raw_passthrough',
          model_invoked: false,
          file_count: stagedQuestionFiles.length,
          page_count: stagedQuestionFiles.reduce((acc, s) => acc + s.inspected.document.pages.length, 0),
          issue_count: 0,
        };

        await db.query(
          `INSERT INTO ai_distill.library_jobs(id, package_id, revision_id, kind, status, request_key, input_digest, input_snapshot, config_digest, config_snapshot, executor_kind, execution_target, result_summary, started_at, finished_at)
           VALUES($1, $2, $3, 'extract', 'succeeded', $4, $5, $6::jsonb, $7, $8::jsonb, 'internal', 'local', $9::jsonb, now(), now())`,
          [
            extractionJobId,
            packageId,
            revisionId,
            randomUUID(),
            hash(canonicalJson(jobSnapshot)),
            JSON.stringify(jobSnapshot),
            hash(canonicalJson(jobConfig)),
            JSON.stringify(jobConfig),
            JSON.stringify(jobSummary),
          ],
        );

        for (const [idx, s] of stagedQuestionFiles.entries()) {
          const docBlob = await insertLibraryTextBlob(
            db,
            s.inspected.doc_json,
            'application/vnd.ai-distill.extracted-document+json',
          );
          await db.query(
            `INSERT INTO ai_distill.library_documents(id, revision_id, file_id, extraction_job_id, document_blob_id, source_sha256, text_sha256, page_count, issues)
             VALUES($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb)`,
            [
              randomUUID(),
              revisionId,
              libraryFileIds[idx]!,
              extractionJobId,
              docBlob.id,
              s.inspected.sha256,
              s.inspected.text_sha256,
              s.inspected.document.pages.length,
            ],
          );
        }

        const totalEstimatedPages = Math.max(
          11,
          stagedQuestionFiles.reduce((acc, s) => acc + s.inspected.estimated_pages, 0),
        );
        const eligibilityDigest = hash(
          canonicalJson({
            revision_id: revisionId,
            extraction_job_id: extractionJobId,
            files: stagedQuestionFiles.map((s, idx) => ({
              id: libraryFileIds[idx]!,
              source_sha256: s.inspected.sha256,
              document_sha256: s.inspected.text_sha256,
            })),
          }),
        );
        await db.query(
          `INSERT INTO ai_distill.library_load_eligibility(revision_id, extraction_job_id, source_digest, assessment_version, estimated_page_count)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT(revision_id, extraction_job_id, assessment_version) DO NOTHING`,
          [revisionId, extractionJobId, eligibilityDigest, LIBRARY_LOAD_ASSESSMENT_VERSION, totalEstimatedPages],
        );

        const useRow = await claimMaterialUse(
          db,
          {
            id: projectId,
            project_group_id: String(project.project_group_id),
            phase_name: project.phase_name ?? undefined,
            phase_no: project.phase_no ?? null,
          },
          packageId,
          signature,
          { reason: '原件包免提取/免脱敏直接建题导入' },
        );

        linkId = randomUUID();
        await db.query(
          `INSERT INTO ai_distill.project_library_packages(id, project_id, package_id, selected_revision_id, selected_redaction_id, material_use_id, position)
           VALUES($1, $2, $3, $4, NULL, $5, (SELECT COALESCE(MAX(position), 0) + 1 FROM ai_distill.project_library_packages WHERE project_id = $2))`,
          [linkId, projectId, packageId, revisionId, useRow.id],
        );
      }

      const sourceDigest = hash(
        canonicalJson({
          revision_id: revisionId,
          extraction_job_id: extractionJobId,
          files: stagedQuestionFiles.map((s, idx) => ({
            id: libraryFileIds[idx]!,
            source_sha256: s.inspected.sha256,
            document_sha256: s.inspected.text_sha256,
            document_blob_sha256: s.inspected.doc_json_sha256,
          })),
        }),
      );

      const markdownArtifactId = randomUUID();
      const indexArtifactId = randomUUID();
      const manifest = {
        version: 2,
        origin: {
          kind: 'library_v1' as const,
          material_processing_mode: 'original' as const,
          material_mode: 'original' as const,
          raw_passthrough: true,
          package_id: packageId,
          package_name: actualPackageName,
          revision_id: revisionId,
          redaction_id: null,
          source_digest: sourceDigest,
        },
        files: stagedQuestionFiles.map((s, idx) => ({
          library_file_id: libraryFileIds[idx]!,
          material_id: s.materialId,
          source_sha256: s.inspected.sha256,
          document_sha256: s.inspected.text_sha256,
          source_artifact_id: s.sourceArtifactId,
          pages_artifact_id: s.pagesArtifactId,
          position: s.inspected.position,
          original_name: s.inspected.original_name,
        })),
        material_markdown: {
          artifact_id: markdownArtifactId,
          sha256: fullMarkdownSha,
          kind: 'source_markdown' as const,
        },
        material_index: {
          artifact_id: indexArtifactId,
          sha256: indexSha,
          kind: 'source_index' as const,
        },
      };
      const snapshotDigest = hash(canonicalJson(manifest));
      const sourceManifest = stagedQuestionFiles.map((s) => ({
        name: s.inspected.original_name,
        path: s.sourcePath,
        size: s.inspected.size_bytes,
        sha256: s.inspected.sha256,
      }));

      await db.query(
        `INSERT INTO ai_distill.workflows(id, project_id, request_id, title, source_manifest, workflow_kind, scenario, role_perspective, target_level, question_tags, authoring_direction)
         VALUES($1, $2, $3, $4, $5::jsonb, 'question', $6, $7, $8, $9, $10)`,
        [
          questionId,
          projectId,
          randomUUID(),
          title,
          JSON.stringify(sourceManifest),
          scenario ?? null,
          rolePerspective ?? null,
          effectiveLevel ?? null,
          tags,
          authoringDirection ?? null,
        ],
      );

      for (const s of stagedQuestionFiles) {
        await db.query(
          `INSERT INTO ai_distill.materials(id, workflow_id, original_name, storage_path, sha256, size_bytes, content_type, processing_status, redaction_mode)
           VALUES($1, $2, $3, $4, $5, $6, $7, 'text_extracted', 'model')`,
          [
            s.materialId,
            questionId,
            s.inspected.original_name,
            s.sourcePath,
            s.inspected.sha256,
            s.inspected.size_bytes,
            s.inspected.content_type,
          ],
        );
        await db.query(
          `INSERT INTO ai_distill.artifacts(id, workflow_id, material_id, attempt_id, kind, storage_path, sha256, size_bytes, content)
           VALUES($1, $2, $3, NULL, 'private_extracted_pages', $4, $5, $6, $7)`,
          [
            s.pagesArtifactId,
            questionId,
            s.materialId,
            s.pagesPath,
            s.inspected.doc_json_sha256,
            s.inspected.doc_json_bytes.byteLength,
            s.inspected.doc_json,
          ],
        );
        await db.query(
          `INSERT INTO ai_distill.artifacts(id, workflow_id, material_id, attempt_id, kind, storage_path, sha256, size_bytes)
           VALUES($1, $2, $3, NULL, 'source_document', $4, $5, $6)`,
          [s.sourceArtifactId, questionId, s.materialId, s.sourcePath, s.inspected.sha256, s.inspected.size_bytes],
        );
      }

      await db.query(
        `INSERT INTO ai_distill.artifacts(id, workflow_id, material_id, attempt_id, kind, storage_path, sha256, size_bytes, content)
         VALUES($1, $2, NULL, NULL, 'source_markdown', $3, $4, $5, $6)`,
        [markdownArtifactId, questionId, markdownPath, fullMarkdownSha, Buffer.byteLength(fullMarkdown), fullMarkdown],
      );
      await db.query(
        `INSERT INTO ai_distill.artifacts(id, workflow_id, material_id, attempt_id, kind, storage_path, sha256, size_bytes, content)
         VALUES($1, $2, NULL, NULL, 'source_index', $3, $4, $5, $6)`,
        [indexArtifactId, questionId, indexPath, indexSha, Buffer.byteLength(indexText), indexText],
      );

      await db.query(
        `INSERT INTO ai_distill.question_library_sources(workflow_id, project_id, project_material_id, package_id, revision_id, redaction_id, source_digest, snapshot_manifest, snapshot_digest, markdown_artifact_id, index_artifact_id, request_key, request_digest, material_mode)
         VALUES($1, $2, $3, $4, $5, NULL, $6, $7::jsonb, $8, $9, $10, $11, $12, 'original')`,
        [
          questionId,
          projectId,
          linkId,
          packageId,
          revisionId,
          sourceDigest,
          JSON.stringify(manifest),
          snapshotDigest,
          markdownArtifactId,
          indexArtifactId,
          requestKey,
          requestDigest,
        ],
      );

      for (const stage of STEP_REGISTRY.filter((item) => libraryQuestionStepOrdinals().includes(item.ordinal))) {
        await db.query(
          `INSERT INTO ai_distill.steps(workflow_id, ordinal, name, status, implemented, step_key, display_position, enabled)
           VALUES($1, $2, $3, 'waiting', $4, $5, $6, $4)`,
          [questionId, stage.ordinal, stage.name, stage.defaultEnabled, stage.key, stage.position],
        );
      }

      commitAttempted = true;
      await db.query('COMMIT');
      txResult = {
        id: questionId,
        package_id: packageId,
        revision_id: revisionId,
        source_digest: sourceDigest,
        snapshot_digest: snapshotDigest,
        reused: false,
      };
    } catch (txErr) {
      try {
        await db.query('ROLLBACK');
      } catch (rbErr) {
        throw new AggregateError([txErr, rbErr], '原件包直接建题回滚状态未知');
      }
      throw txErr;
    } finally {
      db.release();
    }

    let authorAttempt: { id: string; reused: boolean } | null = null;
    if (autoAuthor) {
      authorAttempt = await enqueueAuthoring(pool, txResult.id);
    }
    return {
      ...txResult,
      ...(authorAttempt ? { author_attempt_id: authorAttempt.id } : {}),
    };
  } catch (err) {
    if (!commitAttempted) {
      await rm(questionDir, { recursive: true, force: true }).catch(() => {});
      await cleanupRolledBackLibraryBlobs(pool, storageRoot, installedBlobs).catch(() => {});
    }
    throw err;
  }
}
