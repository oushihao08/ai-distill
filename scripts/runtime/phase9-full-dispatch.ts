/**
 * 职责：高经第九期纯提取调度 - 只提取入库，不做脱敏与整理
 * 1. 检查 API 槽位可用容量 (MinerU API 提取)
 * 2. 扫描待提取入库新包，自动执行超 45MB 切片预处理与原子导入
 * 3. 持续打满 API 槽位 (最多 20 并发)
 * 4. 自动调用 reconcile-phase9-ledger-with-db.ts 刷新 Ledger 对账台
 * 
 * 入口：`bun scripts/runtime/phase9-full-dispatch.ts`
 */
import { readdir, stat, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../server/db';

const REPO_ROOT = resolve(process.cwd());
const QUESTIONS_DIR = resolve(REPO_ROOT, 'projects/豆包高经济价值/第九期/questions');
const PREPARED_DIR = resolve(REPO_ROOT, '.storage/runtime/prepared-manifests');

async function main() {
  console.log(`[Dispatch] 开始检查队列容量与提取候选包 (纯提取模式)...`);
  await mkdir(PREPARED_DIR, { recursive: true });

  // 1. 获取当前实时队列容量
  let apiAvailable = 0;
  try {
    const res = await fetch('http://127.0.0.1:3700/api/system/execution-queue');
    if (res.ok) {
      const q = await res.json();
      apiAvailable = q.capacity?.api?.available ?? 0;
      console.log(`[Queue] 实时容量: API可用=${apiAvailable} (纯提取模式，不占用Agent槽位)`);
    } else {
      console.warn(`[Queue] 获取队列容量失败: HTTP ${res.status}`);
    }
  } catch (err: any) {
    console.warn(`[Queue] 获取队列容量异常: ${err.message}`);
  }

  // 2. 查询 PostgreSQL 获取已存在与在途包
  const pool = createPool();

  const pkgRes = await pool.query(`
    SELECT p.id as package_id, p.name
    FROM ai_distill.library_packages p
    WHERE p.deleted_at IS NULL AND (p.name LIKE '豆包高经济第九期-%' OR p.name LIKE '高经九期-%');
  `);

  const activeJobsRes = await pool.query(`
    SELECT id, kind, status,
      input_snapshot->'atomic_import'->'package_input'->>'name' as in_flight_pkg_name
    FROM ai_distill.library_jobs
    WHERE status IN ('queued', 'running');
  `);

  await pool.end();

  // 3. 扫描提取候选 (待入库新包)
  const existingPkgNames = new Set(pkgRes.rows.map((p: any) => p.name));
  for (const j of activeJobsRes.rows) {
    if (j.kind === 'extract' && j.in_flight_pkg_name) {
      existingPkgNames.add(j.in_flight_pkg_name);
      existingPkgNames.add(j.in_flight_pkg_name.replace(/^豆包高经济第九期-/, ''));
      existingPkgNames.add(j.in_flight_pkg_name.replace(/^高经九期-/, ''));
    }
  }

  const entries = await readdir(QUESTIONS_DIR, { withFileTypes: true });
  const extractCandidates: any[] = [];

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dirName = e.name;
    const expectedPkgName = `豆包高经济第九期-${dirName}`;
    const altPkgName = `高经九期-${dirName}`;

    if (existingPkgNames.has(expectedPkgName) || existingPkgNames.has(altPkgName)) continue;

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

    if (files.length === 0) continue; // 空目录
    if (files.some(f => ['.doc', '.wps', '.ofd', '.xlsx', '.xls', '.tif', '.tiff'].includes(f.ext))) continue; // 格式受阻
    if (totalSize > 200 * 1024 * 1024) continue; // 超限受阻

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

  // 4. 派发 Extract (使用 API 槽位，最多 apiAvailable)
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

  console.log(`\n=== 本轮派发汇总 (纯提取模式) ===`);
  console.log(`- 提取入库 (Extract, MinerU): ${dispatchedExtract} 个`);

  // 5. 刷新 Ledger 对账台
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
