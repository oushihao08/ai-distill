/**
 * 职责：持续全容量派发高经第九期剩余材料包
 * 1. 优先使用 Agent 槽位派发已脱敏待整理材料包 (gpt-6.1-sol / medium)
 * 2. 若 Agent 仍有空槽，派发待脱敏材料包 (gpt-5.6-sol / medium)
 * 3. 使用 API 槽位派发待提取入库材料包 (MinerU API)
 * 4. 派发后自动调用 reconcile-phase9-ledger-with-db.ts 刷新 Ledger 对账台
 * 
 * 入口：`bun scripts/runtime/phase9-full-dispatch.ts`
 */
import { readdir, stat, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../server/db';

const REPO_ROOT = resolve(process.cwd());
const QUESTIONS_DIR = resolve(REPO_ROOT, 'projects/豆包高经济价值/第九期/questions');
const PREPARED_DIR = resolve(REPO_ROOT, '.storage/runtime/prepared-manifests');
const PROJECT_ID = '68619f74-c864-49a0-bbe6-495202e62556'; // 豆包高经济价值 - 第九期

async function main() {
  console.log(`[Dispatch] 开始检查队列容量与候选包...`);
  await mkdir(PREPARED_DIR, { recursive: true });

  // 1. 获取当前实时队列容量
  let agentAvailable = 0;
  let apiAvailable = 0;
  try {
    const res = await fetch('http://127.0.0.1:3700/api/system/execution-queue');
    if (res.ok) {
      const q = await res.json();
      agentAvailable = q.capacity?.agent?.available ?? 0;
      apiAvailable = q.capacity?.api?.available ?? 0;
      console.log(`[Queue] 实时容量: Agent可用=${agentAvailable}, API可用=${apiAvailable}`);
    } else {
      console.warn(`[Queue] 获取队列容量失败: HTTP ${res.status}`);
    }
  } catch (err: any) {
    console.warn(`[Queue] 获取队列容量异常: ${err.message}`);
  }

  // 2. 查询 PostgreSQL 获取详细候选状态
  const pool = createPool();

  // 获取全部第九期 packages 及当前 revision
  const pkgRes = await pool.query(`
    SELECT p.id as package_id, p.name, p.current_revision_id, r.manifest_sha256
    FROM ai_distill.library_packages p
    JOIN ai_distill.library_revisions r ON r.id = p.current_revision_id
    WHERE p.deleted_at IS NULL AND (p.name LIKE '豆包高经济第九期-%' OR p.name LIKE '高经九期-%');
  `);

  // 获取成功的脱敏记录
  const redRes = await pool.query(`
    SELECT DISTINCT ON (revision_id) id as redaction_id, package_id, revision_id, extraction_job_id, created_at
    FROM ai_distill.library_redactions
    ORDER BY revision_id, created_at DESC;
  `);

  // 获取成功的整理记录
  const prepRes = await pool.query(`
    SELECT DISTINCT ON (revision_id) id as preparation_id, package_id, revision_id, redaction_id, created_at
    FROM ai_distill.library_preparations
    ORDER BY revision_id, created_at DESC;
  `);

  // 获取正在运行或排队的 library jobs
  const activeJobsRes = await pool.query(`
    SELECT id, package_id, revision_id, kind, status
    FROM ai_distill.library_jobs
    WHERE status IN ('queued', 'running');
  `);

  // 获取最新成功的 extract job
  const extractJobsRes = await pool.query(`
    SELECT DISTINCT ON (revision_id) id as extraction_job_id, revision_id, status
    FROM ai_distill.library_jobs
    WHERE kind = 'extract' AND status = 'succeeded'
    ORDER BY revision_id, created_at DESC;
  `);

  await pool.end();

  const redactionsByRev = new Map<string, any>();
  for (const r of redRes.rows) redactionsByRev.set(r.revision_id, r);

  const prepsByRev = new Map<string, any>();
  for (const p of prepRes.rows) prepsByRev.set(p.revision_id, p);

  const activeJobsByRev = new Map<string, any[]>();
  for (const j of activeJobsRes.rows) {
    if (!activeJobsByRev.has(j.revision_id)) activeJobsByRev.set(j.revision_id, []);
    activeJobsByRev.get(j.revision_id)!.push(j);
  }

  const extractionsByRev = new Map<string, any>();
  for (const e of extractJobsRes.rows) extractionsByRev.set(e.revision_id, e);

  // 整理候选人分类
  const prepareCandidates: any[] = [];
  const redactCandidates: any[] = [];

  for (const pkg of pkgRes.rows) {
    const revId = pkg.current_revision_id;
    const redaction = redactionsByRev.get(revId);
    const preparation = prepsByRev.get(revId);
    const active = activeJobsByRev.get(revId) || [];

    const hasActivePrepare = active.some((j) => j.kind === 'prepare');
    const hasActiveRedact = active.some((j) => j.kind === 'redact');

    if (redaction && !preparation && !hasActivePrepare) {
      prepareCandidates.push({
        package_id: pkg.package_id,
        revision_id: revId,
        redaction_id: redaction.redaction_id,
        name: pkg.name
      });
    } else if (!redaction && !hasActiveRedact) {
      const extJob = extractionsByRev.get(revId);
      if (extJob) {
        redactCandidates.push({
          package_id: pkg.package_id,
          revision_id: revId,
          extraction_job_id: extJob.extraction_job_id,
          name: pkg.name
        });
      }
    }
  }

  console.log(`[Candidates] 待整理(Prepare)候选: ${prepareCandidates.length} 个`);
  console.log(`[Candidates] 待脱敏(Redact)候选: ${redactCandidates.length} 个`);

  // 3. 扫描提取候选 (待入库新包)
  const existingPkgNames = new Set(pkgRes.rows.map((p: any) => p.name));
  const entries = await readdir(QUESTIONS_DIR, { withFileTypes: true });
  const extractCandidates: any[] = [];

  const BLOCKED_NAMES = new Set([
    '002刘志', '012郑仁虎', '71-4', '98-2', '98-3', '098李国强',
    '122曾福纲', '152-2', '184张昭奎', '201-2', '202-2'
  ]);

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dirName = e.name;
    const expectedPkgName = `豆包高经济第九期-${dirName}`;
    const altPkgName = `高经九期-${dirName}`;

    if (existingPkgNames.has(expectedPkgName) || existingPkgNames.has(altPkgName)) continue;
    if (BLOCKED_NAMES.has(dirName)) continue;

    const pkgPath = join(QUESTIONS_DIR, dirName);
    const subFiles = await readdir(pkgPath);
    let totalSize = 0;
    let maxFileSize = 0;
    const files: { path: string; ext: string; size: number }[] = [];

    for (const f of subFiles) {
      if (f.startsWith('.')) continue;
      const fPath = join(pkgPath, f);
      const st = await stat(fPath);
      if (!st.isFile()) continue;
      const ext = extname(f).toLowerCase();
      files.push({ path: fPath, ext, size: st.size });
      totalSize += st.size;
      if (st.size > maxFileSize) maxFileSize = st.size;
    }

    if (files.length === 0) continue;

    extractCandidates.push({
      dirName,
      packageName: expectedPkgName,
      files,
      totalSize,
      maxFileSize,
      needsSharding: maxFileSize > 45 * 1024 * 1024
    });
  }

  console.log(`[Candidates] 待提取(Extract)候选: ${extractCandidates.length} 个`);

  // 4. 派发 Prepare (优先占用 Agent 槽位，最多 agentAvailable)
  let dispatchedPrepare = 0;
  for (const cand of prepareCandidates) {
    if (agentAvailable <= 0) break;
    const reqKey = randomUUID();
    console.log(`[Agent-Prepare] 派发整理: ${cand.name} (rev: ${cand.revision_id})`);
    try {
      const resp = await fetch(`http://127.0.0.1:3700/api/material-library/revisions/${cand.revision_id}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_key: reqKey,
          redaction_id: cand.redaction_id,
          project_id: PROJECT_ID,
          force: true,
          agent_settings: {
            model: 'gpt-6.1-sol',
            reasoning_effort: 'medium'
          }
        })
      });
      if (resp.status === 200 || resp.status === 202) {
        const body = await resp.json();
        console.log(`  -> 成功入队! Job ID: ${body.id}`);
        dispatchedPrepare++;
        agentAvailable--;
      } else {
        const errText = await resp.text();
        console.warn(`  -> 提交失败 (${resp.status}): ${errText}`);
      }
    } catch (err: any) {
      console.warn(`  -> 请求异常: ${err.message}`);
    }
  }

  // 5. 派发 Redact (若 Agent 仍有空位)
  let dispatchedRedact = 0;
  for (const cand of redactCandidates) {
    if (agentAvailable <= 0) break;
    const reqKey = randomUUID();
    console.log(`[Agent-Redact] 派发脱敏: ${cand.name} (rev: ${cand.revision_id})`);
    try {
      const resp = await fetch(`http://127.0.0.1:3700/api/material-library/revisions/${cand.revision_id}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'redact',
          execution_target: 'local',
          request_key: reqKey,
          project_id: PROJECT_ID,
          extraction_job_id: cand.extraction_job_id,
          agent_settings: {
            model: 'gpt-5.6-sol',
            reasoning_effort: 'medium'
          }
        })
      });
      if (resp.status === 200 || resp.status === 202) {
        const body = await resp.json();
        console.log(`  -> 成功入队! Job ID: ${body.id}`);
        dispatchedRedact++;
        agentAvailable--;
      } else {
        const errText = await resp.text();
        console.warn(`  -> 提交失败 (${resp.status}): ${errText}`);
      }
    } catch (err: any) {
      console.warn(`  -> 请求异常: ${err.message}`);
    }
  }

  // 6. 派发 Extract (使用 API 槽位，最多 apiAvailable)
  let dispatchedExtract = 0;
  for (const cand of extractCandidates) {
    if (apiAvailable <= 0) break;
    const reqKey = randomUUID();
    console.log(`[API-Extract] 派发提取入库: ${cand.packageName} (${cand.files.length} 个文件, 需分片: ${cand.needsSharding})`);

    let manifestPath = '';
    if (cand.needsSharding) {
      const tempManifest = join(PREPARED_DIR, `temp-${cand.dirName}-raw.json`);
      const rawManifestData = {
        files: cand.files.map((f: any) => ({
          path: f.path,
          redaction_mode: 'model'
        }))
      };
      await writeFile(tempManifest, JSON.stringify(rawManifestData, null, 2), 'utf8');
      const preparedOutDir = join(PREPARED_DIR, `temp-${cand.dirName}-out`);
      await rm(preparedOutDir, { recursive: true, force: true });

      const prepRes = spawnSync('bun', [
        'run',
        'ai-distill',
        'library',
        'files',
        'prepare',
        '--manifest',
        tempManifest,
        '--out',
        preparedOutDir
      ], { encoding: 'utf8' });

      if (prepRes.status !== 0) {
        console.error(`  -> 分片预处理失败: ${cand.packageName}`, prepRes.stderr);
        continue;
      }
      manifestPath = join(preparedOutDir, 'manifest.json');
    } else {
      manifestPath = join(PREPARED_DIR, `manifest-${cand.dirName}.json`);
      const rawManifestData = {
        files: cand.files.map((f: any) => ({
          path: f.path,
          redaction_mode: 'model'
        }))
      };
      await writeFile(manifestPath, JSON.stringify(rawManifestData, null, 2), 'utf8');
    }

    const cmdArgs = [
      'run',
      'ai-distill',
      'library',
      'import',
      '--name',
      cand.packageName,
      '--request-key',
      reqKey,
      '--manifest',
      manifestPath
    ];

    const importRes = spawnSync('bun', cmdArgs, { encoding: 'utf8' });
    let parsedOut: any = null;
    try {
      parsedOut = JSON.parse(importRes.stdout);
    } catch {
      const match = importRes.stdout.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsedOut = JSON.parse(match[0]); } catch {}
      }
    }

    if (importRes.status === 0 && parsedOut?.outcome === 'complete') {
      const jobId = parsedOut.data?.id;
      console.log(`  -> 成功入队! Job ID: ${jobId}`);
      dispatchedExtract++;
      apiAvailable--;
    } else {
      console.error(`  -> 提取导入失败: ${cand.packageName}`, importRes.stderr || importRes.stdout);
    }
  }

  console.log(`\n=== 本轮派发汇总 ===`);
  console.log(`- 整理 (Prepare, gpt-6.1-sol): ${dispatchedPrepare} 个`);
  console.log(`- 脱敏 (Redact, gpt-5.6-sol): ${dispatchedRedact} 个`);
  console.log(`- 提取 (Extract, MinerU): ${dispatchedExtract} 个`);

  // 7. 刷新 Ledger 对账台
  console.log(`\n[Ledger] 自动触发对账刷新...`);
  const reconcileRes = spawnSync('bun', ['scripts/runtime/reconcile-phase9-ledger-with-db.ts'], {
    encoding: 'utf8',
    stdio: 'inherit'
  });
  console.log(`[Ledger] 对账刷新退出码: ${reconcileRes.status}`);
}

main().catch((err) => {
  console.error('Fatal dispatch error:', err);
  process.exit(1);
});
