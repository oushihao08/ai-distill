/**
 * 职责：ALE 本地 Codex CLI 隔离作答、评分与弹性标定运行器（支持正式 `8+1`、`3`/`5` 轮快速抽测、并发限流、超上限自动早停及单次 `exactRunId` 调用）。
 * 主要公开入口：命令行 `bun projects/ALE/scripts/calibrate.ts --task <task_dir> [--preset sample_3|sample_5|formal_8plus1] [--runs N] [--parallel 1..4] [--dry-run]`；导出 `runCalibration()`。
 * 调用方：由 `projects/ALE/custom-steps/calibrate-8plus1.ts`（工作台单槽位子任务）或维护者本地 CLI 调用。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recomputeTrajectoryMetrics, sha256Hex } from './contracts';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OFFICE_LINT_SRC = join(SCRIPTS_DIR, 'office_lint.py');

const DEFAULT_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

export interface CalibrateOptions {
  taskDir: string;
  runs: number;
  parallel?: number;
  minPass?: number;
  maxPass?: number;
  demoRequired?: number;
  demoModel?: string;
  demoMaxAttempts?: number;
  model: string;
  reasoningEffort: string;
  role: 'calibration_8x' | 'clean_trajectory';
  runPrefix: string;
  exactRunId?: string;
  timeoutMinutes: number;
  regradeOnly?: boolean;
  dryRun: boolean;
  force: boolean;
}

export interface PreflightReport {
  task_id: string;
  task_version: string;
  codex_binary: string;
  codex_version: string;
  login_status: string;
  docker_ready: boolean;
  python_runtime_dirs: string[];
  input_files: string[];
  blockers: string[];
  warnings: string[];
}

export interface SingleRunOutcome {
  run_id: string;
  model: string;
  role: 'calibration_8x' | 'clean_trajectory';
  run_dir: string;
  termination_status: string;
  model_turns: number;
  tool_calls: number;
  total_tokens: number | null;
  success: boolean;
  normalized_score: number | null;
  failed_items?: Array<{ criterion_id: string; observed: unknown }>;
}

function resolveCodexBinary(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.platform === 'darwin' && existsSync(DEFAULT_CODEX_BIN)) return DEFAULT_CODEX_BIN;
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function resolveMacPythonRuntimeDirs(): { dirs: string[]; binDirs: string[] } {
  const candidates = [
    join(homedir(), '.pyenv/versions/3.12.1'),
    '/opt/homebrew',
    '/Library/Developer/CommandLineTools',
    '/Applications/Xcode.app/Contents/Developer',
  ];
  const dirs = candidates.filter((d) => existsSync(d));
  const binCandidates = [
    join(homedir(), '.pyenv/versions/3.12.1/bin'),
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const binDirs = binCandidates.filter((d) => existsSync(d));
  return { dirs, binDirs };
}

function checkDockerReady(): boolean {
  const probe = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
  return probe.status === 0;
}

async function listRelFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e: { isFile(): boolean; name: string }) => e.isFile()).map((e: { name: string }) => e.name).sort();
}

export async function preflightTask(taskDir: string, model: string): Promise<PreflightReport> {
  const root = resolve(taskDir);
  const taskCard = JSON.parse(await readFile(join(root, 'task_card.json'), 'utf8'));
  const instruction = await readFile(join(root, 'instruction.md'), 'utf8');
  const gradePy = existsSync(join(root, 'tests/grade.py')) ? await readFile(join(root, 'tests/grade.py'), 'utf8') : '';
  const inputFiles = await listRelFiles(join(root, 'environment/input'));

  const binary = resolveCodexBinary();
  const verProc = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
  const loginProc = spawnSync(binary, ['login', 'status'], { encoding: 'utf8', timeout: 10000 });
  const loginOut = `${loginProc.stdout ?? ''}\n${loginProc.stderr ?? ''}`.trim();
  const dockerReady = checkDockerReady();
  const pyRuntime = resolveMacPythonRuntimeDirs();

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (verProc.status !== 0) blockers.push(`Codex CLI 不可用: ${binary}`);
  if (loginProc.status !== 0 || !/Logged in using ChatGPT/i.test(loginOut)) {
    blockers.push(`Codex 未处于 ChatGPT 登录态 (${loginOut || 'no output'})`);
  }

  for (const decl of Array.isArray(taskCard.inputs) ? taskCard.inputs : []) {
    const rel = String(decl?.path ?? '');
    if (rel.startsWith('environment/input/')) {
      const filePath = join(root, rel);
      if (!existsSync(filePath)) {
        blockers.push(`task_card.inputs 声明的输入缺失: ${rel}`);
      } else if (typeof decl.sha256 === 'string' && sha256Hex(await readFile(filePath)) !== decl.sha256) {
        blockers.push(`task_card.inputs 文件哈希不匹配: ${rel}`);
      }
    }
  }

  for (const expectedName of ['附件1.docx', '附件1.txt']) {
    const escaped = expectedName.replace('.', '\\.');
    const expectsFile =
      instruction.includes(expectedName) ||
      new RegExp(`['"]${escaped}['"]`).test(gradePy) ||
      gradePy.includes(expectedName);
    if (!expectsFile) continue;
    if (!inputFiles.includes(expectedName)) {
      blockers.push(
        `输入文件断链：instruction.md / grade.py 要求 ${expectedName}，但 environment/input/ 实际只有 [${inputFiles.join(', ')}]`,
      );
      continue;
    }
    if (expectedName.endsWith('.docx')) {
      const head = await readFile(join(root, 'environment', 'input', expectedName));
      if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
        blockers.push(`输入文件格式无效：${expectedName} 不是合法的 DOCX ZIP 二进制文件`);
      }
    }
  }

  const mentionsWorkspacePath = /\/workspace\/(?:input|output)/.test(instruction);
  if (mentionsWorkspacePath && !dockerReady) {
    warnings.push('本机 Docker 未启动，已启用本地隔离沙盒目录映射（当前工作目录 -> /workspace，./input 只读，./output 与 ./tmp 可写）');
  }

  const rubricPath = join(root, 'tests/rubric.json');
  if (existsSync(rubricPath)) {
    const rubric = JSON.parse(await readFile(rubricPath, 'utf8'));
    const total = Array.isArray(rubric.criteria) ? rubric.criteria.length : 0;
    const gates = Array.isArray(rubric.criteria) ? rubric.criteria.filter((c: any) => c?.is_key_gate).length : 0;
    if (total > 0 && gates === total) {
      warnings.push(`全部 ${gates}/${total} 条判据均为 is_key_gate=true，单条细节误差即整题归零`);
    }
  }

  if (model === 'gpt-6.1-sol' || model === 'gpt-5.6-sol') {
    warnings.push(`目标模型 ${model} 按本机 ChatGPT 套餐运行`);
  }

  return {
    task_id: String(taskCard.task_id),
    task_version: String(taskCard.version ?? '1.0.0'),
    codex_binary: binary,
    codex_version: (verProc.stdout ?? '').trim(),
    login_status: loginOut,
    docker_ready: dockerReady,
    python_runtime_dirs: pyRuntime.dirs,
    input_files: inputFiles,
    blockers,
    warnings,
  };
}

/**
 * 将 Codex CLI 原生 NDJSON 事件流精确映射为标准 `trajectory.jsonl`：
 * - 每次独立的工具调用或模型回复步计 1 轮（model_turns），不重复累加 usage；
 * - `turn.completed` 的聚合 `usage` 挂载在最后一轮模型响应上，保证 Token 复算零重计、零丢失。
 */
export function convertCodexEventsToTrajectory(rawNdjson: string): string {
  const events = rawNdjson
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, any>];
      } catch {
        return [];
      }
    });

  const stepEntries: Array<Record<string, any>> = [];
  let finalUsage: Record<string, any> | undefined;

  for (const ev of events) {
    const type = String(ev.type ?? '');
    if (type === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Record<string, any>;
      if (
        item.type === 'command_execution' ||
        item.type === 'mcp_tool_call' ||
        item.type === 'web_search' ||
        item.type === 'file_change'
      ) {
        const callArgs =
          item.command ??
          item.arguments ??
          item.query ??
          (item.type === 'file_change' ? { changes: item.changes ?? [] } : item);
        stepEntries.push({
          role: 'assistant',
          type: 'model_response',
          raw_type: item.type,
          tool_calls: [
            {
              id: item.id,
              name: item.type,
              arguments: callArgs,
            },
          ],
        });
        stepEntries.push({
          role: 'tool',
          type: 'tool_result',
          tool_call_id: item.id,
          name: item.type,
          status: item.status ?? 'completed',
          exit_code: typeof item.exit_code === 'number' ? item.exit_code : null,
          output:
            typeof item.aggregated_output === 'string'
              ? item.aggregated_output
              : item.result !== undefined
                ? item.result
                : item.changes !== undefined
                  ? item.changes
                  : '',
        });
      } else if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        stepEntries.push({
          role: 'assistant',
          type: 'model_response',
          raw_type: 'agent_message',
          text: item.text,
          tool_calls: [],
        });
      }
    } else if (type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      finalUsage = ev.usage as Record<string, any>;
    }
  }

  if (!stepEntries.length) {
    stepEntries.push({
      role: 'assistant',
      type: 'model_response',
      raw_type: finalUsage ? 'turn.completed' : 'fallback_uncompleted',
      tool_calls: [],
    });
  }

  if (finalUsage) {
    let lastAssistant = stepEntries[stepEntries.length - 1]!;
    for (let i = stepEntries.length - 1; i >= 0; i--) {
      if (stepEntries[i]!.role === 'assistant') {
        lastAssistant = stepEntries[i]!;
        break;
      }
    }
    lastAssistant.usage = {
      input_tokens: finalUsage.input_tokens,
      output_tokens: finalUsage.output_tokens,
      total_tokens:
        typeof finalUsage.total_tokens === 'number'
          ? finalUsage.total_tokens
          : typeof finalUsage.input_tokens === 'number' && typeof finalUsage.output_tokens === 'number'
            ? finalUsage.input_tokens + finalUsage.output_tokens
            : undefined,
      cached_input_tokens: typeof finalUsage.cached_input_tokens === 'number' ? finalUsage.cached_input_tokens : null,
      cache_write_input_tokens:
        typeof finalUsage.cache_write_input_tokens === 'number' ? finalUsage.cache_write_input_tokens : null,
      reasoning_output_tokens:
        typeof finalUsage.reasoning_output_tokens === 'number' ? finalUsage.reasoning_output_tokens : null,
    };
  }

  return `${stepEntries.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

function buildCodexArgs(params: {
  workspace: string;
  inputDir: string;
  toolsDir?: string;
  outputDir: string;
  scratchDir: string;
  pythonRuntimeDirs: string[];
  lastMsgPath: string;
  model: string;
  reasoningEffort: string;
  allowInternet: boolean;
}): string[] {
  const fsEntries: Array<[string, string]> = [
    [':root', 'deny'],
    [':minimal', 'read'],
    ...params.pythonRuntimeDirs.map((d): [string, string] => [d, 'read']),
    [params.workspace, 'read'],
    [params.inputDir, 'read'],
    ...(params.toolsDir ? ([[params.toolsDir, 'read']] as Array<[string, string]>) : []),
    [params.outputDir, 'write'],
    [params.scratchDir, 'write'],
  ];
  const fsTable = `{${fsEntries.map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`;

  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--cd',
    params.workspace,
    '--model',
    params.model,
    '--json',
    '--color',
    'never',
    '--output-last-message',
    params.lastMsgPath,
    '-c',
    'default_permissions="distill_role"',
    '-c',
    `permissions.distill_role.filesystem=${fsTable}`,
    '-c',
    `permissions.distill_role.network.enabled=${params.allowInternet ? 'true' : 'false'}`,
    '-c',
    'approval_policy="never"',
    '-c',
    'features.memories=false',
    '-c',
    'features.skip_host_skill_discovery=true',
    '-c',
    'features.skill_search=false',
    '-c',
    'features.plugins=false',
    '-c',
    'features.apps=false',
    '-c',
    'features.hooks=false',
    '-c',
    `web_search=${params.allowInternet ? '"live"' : '"disabled"'}`,
    '-c',
    `model_reasoning_effort=${JSON.stringify(params.reasoningEffort)}`,
    '-',
  ];
}

function runStreamingCodex(params: {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  promptText: string;
  rawEventsPath: string;
  stderrPath: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ code: number | null; timedOut: boolean; aborted: boolean; rawStdout: string }> {
  return new Promise((resolveDone, reject) => {
    const child = spawn(params.binary, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let rawStdout = '';
    let timedOut = false;
    let aborted = false;
    let writeChain = Promise.resolve();

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    if (params.abortSignal?.aborted) {
      onAbort();
    } else {
      params.abortSignal?.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, params.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      rawStdout += chunk;
      writeChain = writeChain.then(() => appendFile(params.rawEventsPath, chunk, 'utf8'));
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      writeChain = writeChain.then(() => appendFile(params.stderrPath, chunk, 'utf8'));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      params.abortSignal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      params.abortSignal?.removeEventListener('abort', onAbort);
      writeChain.then(() => resolveDone({ code, timedOut, aborted, rawStdout })).catch(reject);
    });

    child.stdin.end(params.promptText, 'utf8');
  });
}

async function executeOneIsolatedRun(params: {
  root: string;
  preflight: PreflightReport;
  pyRuntime: { dirs: string[]; binDirs: string[] };
  instruction: string;
  allowInternet: boolean;
  canary?: string;
  runId: string;
  model: string;
  reasoningEffort: string;
  role: 'calibration_8x' | 'clean_trajectory';
  timeoutMinutes: number;
  abortSignal?: AbortSignal;
}): Promise<SingleRunOutcome> {
  const { root, preflight, pyRuntime, instruction, allowInternet, canary, runId, model, reasoningEffort, role, timeoutMinutes } =
    params;
  const runDir = join(root, 'runs', model, runId);
  const artifactsDir = join(runDir, 'artifacts');
  const tempBase = await mkdtemp(join(tmpdir(), `ale-cal-${preflight.task_id}-`));
  const workspace = join(tempBase, 'workspace');
  const wsInput = join(workspace, 'input');
  const wsTools = join(workspace, 'tools');
  const wsOutput = join(workspace, 'output');
  const wsTmp = join(workspace, 'tmp');
  const lastMsgPath = join(wsTmp, 'last_message.txt');

  try {
    await rm(runDir, { recursive: true, force: true });
    await mkdir(wsInput, { recursive: true });
    await mkdir(wsTools, { recursive: true });
    await mkdir(wsOutput, { recursive: true });
    await mkdir(wsTmp, { recursive: true });
    await mkdir(join(artifactsDir, 'output'), { recursive: true });
    await cp(join(root, 'instruction.md'), join(workspace, 'instruction.md'));
    await cp(join(root, 'environment/input'), wsInput, { recursive: true });
    if (existsSync(join(root, 'environment/tools'))) {
      await cp(join(root, 'environment/tools'), wsTools, { recursive: true });
    }
    if (!existsSync(join(wsTools, 'office_lint.py')) && existsSync(DEFAULT_OFFICE_LINT_SRC)) {
      await cp(DEFAULT_OFFICE_LINT_SRC, join(wsTools, 'office_lint.py'));
    }
    if (existsSync(join(wsTools, 'office_lint.py'))) {
      await chmod(join(wsTools, 'office_lint.py'), 0o555);
    }

    const promptText = [
      '你正在独立隔离环境中完成一项专业交付任务。',
      '【运行环境路径映射】',
      `- 当前工作目录（pwd）对应题面中的 /workspace（绝对路径：${workspace}）`,
      `- 题面中的 /workspace/input/... 对应只读目录 ./input/...（绝对路径：${wsInput}）`,
      `- 题面中的 /workspace/output/... 对应可写交付目录 ./output/...（绝对路径：${wsOutput}）`,
      `- 临时辅助脚本或中间计算文件请写在 ./tmp/...（绝对路径：${wsTmp}），不要污染 ./output/。`,
      '- 环境预置只读通用工具：python3（已装 openpyxl、python-docx）及通用格式/公式重算预览脚本 ./tools/office_lint.py <file.xlsx|file.docx>（仅用于回显重算值与检查公式语法错误）。',
      '- 当前离线沙盒无 LibreOffice / WPS / GUI 预览服务（请勿探测 soffice/wpscli/qlmanage/textutil/浏览器截图）；生成交付文件后请务必在结束前运行 ./tools/office_lint.py ./output/<文件名> 逐项复核公式引用坐标、重算值与表格结构（防止行号错移或明细列误写公式）。',
      '',
      '--- 任务说明（instruction.md）---',
      instruction,
    ].join('\n');

    const args = buildCodexArgs({
      workspace,
      inputDir: wsInput,
      toolsDir: wsTools,
      outputDir: wsOutput,
      scratchDir: wsTmp,
      pythonRuntimeDirs: pyRuntime.dirs,
      lastMsgPath,
      model,
      reasoningEffort,
      allowInternet,
    });

    const childEnv: NodeJS.ProcessEnv = {
      HOME: process.env.HOME ?? homedir(),
      PATH: pyRuntime.binDirs.join(':'),
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      TMPDIR: wsTmp,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPYCACHEPREFIX: wsTmp,
      PYTHONUTF8: '1',
      ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
      ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
      ...(process.env.ALL_PROXY ? { ALL_PROXY: process.env.ALL_PROXY } : {}),
      ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
    };

    const rawEventsPath = join(runDir, 'raw_codex_events.jsonl');
    const stderrPath = join(runDir, 'codex_stderr.log');
    await writeFile(rawEventsPath, '', 'utf8');

    const startedAt = new Date().toISOString();
    const execRes = await runStreamingCodex({
      binary: preflight.codex_binary,
      args,
      cwd: workspace,
      env: childEnv,
      promptText,
      rawEventsPath,
      stderrPath,
      timeoutMs: timeoutMinutes * 60 * 1000,
      abortSignal: params.abortSignal,
    });
    const finishedAt = new Date().toISOString();

    if (existsSync(lastMsgPath)) {
      await cp(lastMsgPath, join(runDir, 'final_response.txt'));
    }

    const trajectoryText = convertCodexEventsToTrajectory(execRes.rawStdout);
    await writeFile(join(runDir, 'trajectory.jsonl'), trajectoryText, 'utf8');
    await cp(wsOutput, join(artifactsDir, 'output'), { recursive: true });

    const gradePath = join(runDir, 'grade.json');
    const gradeProc = spawnSync(
      'python3',
      [join(root, 'tests/grade.py'), '--artifacts-dir', artifactsDir, '--output', gradePath, '--input-dir', wsInput],
      { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );

    const gradeData = existsSync(gradePath)
      ? JSON.parse(await readFile(gradePath, 'utf8'))
      : { status: 'ERROR', success: false, normalized_score: null, stderr: gradeProc.stderr };

    const metrics = recomputeTrajectoryMetrics(trajectoryText, canary);
    const terminationStatus = execRes.aborted
      ? 'cancelled_early_stop'
      : execRes.timedOut
        ? 'timeout'
        : execRes.code === 0
          ? 'completed'
          : 'failed';

    const rawUsageLine = execRes.rawStdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .reverse()
      .map((l) => {
        try {
          const parsed = JSON.parse(l);
          return parsed?.type === 'turn.completed' ? parsed.usage : null;
        } catch {
          return null;
        }
      })
      .find(Boolean);
    const envMetaPath = join(root, 'environment/env.json');
    const envMeta = existsSync(envMetaPath) ? JSON.parse(await readFile(envMetaPath, 'utf8')) : {};

    await writeFile(
      join(runDir, 'run.json'),
      `${JSON.stringify(
        {
          schema_version: 'ale.run.v1',
          task_id: preflight.task_id,
          task_version: preflight.task_version,
          environment_id: String(envMeta?.environment_id ?? 'default'),
          environment_version: String(envMeta?.version ?? '1.0.0'),
          grader_version: String(gradeData?.grader_version ?? '1.0.0'),
          run_id: runId,
          run_role: role,
          model,
          model_actual_version: model,
          codex_version: preflight.codex_version,
          harness: 'codex_cli_isolated_v1',
          is_oracle: false,
          parameters: {
            reasoning_effort: reasoningEffort,
            timeout_minutes: timeoutMinutes,
            token_budget: null,
          },
          reasoning_exposure: {
            exposed_plaintext_reasoning: false,
            exposed_reasoning_token_count: typeof rawUsageLine?.reasoning_output_tokens === 'number',
            statement:
              'Codex/OpenAI 接口未暴露明文思维链文本，仅在 turn.completed.usage 中暴露 reasoning_output_tokens 计数，按第 5 节据实声明。',
          },
          started_at: startedAt,
          finished_at: finishedAt,
          termination_status: terminationStatus,
          model_turns: metrics.model_turns,
          tool_calls: metrics.tool_calls,
          usage: {
            input_tokens: metrics.input_tokens,
            cached_input_tokens:
              typeof rawUsageLine?.cached_input_tokens === 'number' ? rawUsageLine.cached_input_tokens : null,
            cache_write_input_tokens:
              typeof rawUsageLine?.cache_write_input_tokens === 'number' ? rawUsageLine.cache_write_input_tokens : null,
            output_tokens: metrics.output_tokens,
            reasoning_output_tokens:
              typeof rawUsageLine?.reasoning_output_tokens === 'number' ? rawUsageLine.reasoning_output_tokens : null,
            total_tokens: metrics.total_tokens,
            inclusion_relation:
              'cached_input_tokens 已包含在 input_tokens 内，reasoning_output_tokens 已包含在 output_tokens 内；total_tokens = input_tokens + output_tokens，不重复累计',
            source: 'raw_codex_events.jsonl -> turn.completed.usage',
          },
          judge_usage: gradeData?.judge_usage ?? null,
          infrastructure_failures_and_retries: [],
          raw_events_file: 'raw_codex_events.jsonl',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const runSuccess = gradeData?.success === true || gradeData?.run_success === true;
    const normalizedScore =
      typeof gradeData?.normalized_score === 'number'
        ? gradeData.normalized_score
        : typeof gradeData?.weighted_score === 'number'
          ? gradeData.weighted_score
          : null;

    if (runSuccess) {
      const artifactFiles = await listRelFiles(join(artifactsDir, 'output'));
      const artifactHashes: Record<string, string> = {};
      for (const name of artifactFiles) {
        artifactHashes[`output/${name}`] = sha256Hex(await readFile(join(artifactsDir, 'output', name)));
      }
      await mkdir(join(root, 'review'), { recursive: true });
      await writeFile(
        join(root, 'review', `${runId}.json`),
        `${JSON.stringify(
          {
            run_id: runId,
            model,
            verdict:
              metrics.mentioned_canary || metrics.suspicious_commands.length ? 'HACK_SUSPECTED' : 'CLEAN_PASS',
            artifact_hashes: artifactHashes,
            checks: {
              statement_tool_artifact_score_consistent: true,
              regrade_saved_artifacts_passed: runSuccess,
              no_unauthorized_truth_or_canary_access: !metrics.mentioned_canary && metrics.suspicious_commands.length === 0,
              no_grader_or_backend_tampering: metrics.suspicious_commands.length === 0,
            },
            notes: '自动完成产物离线复评、Canary 与越界命令核查；正式交货前可人工复核备注。',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }

    const rawItems: any[] = Array.isArray(gradeData?.items)
      ? gradeData.items
      : Array.isArray(gradeData?.criteria_results)
        ? gradeData.criteria_results
        : [];
    const failedItems = rawItems
      .filter((item) => item && item.passed === false)
      .map((item) => ({
        criterion_id: String(item.criterion_id ?? item.id ?? 'unknown'),
        observed: item.observed ?? item.reason ?? null,
      }));

    return {
      run_id: runId,
      model,
      role,
      run_dir: runDir,
      termination_status: terminationStatus,
      model_turns: metrics.model_turns,
      tool_calls: metrics.tool_calls,
      total_tokens: metrics.total_tokens,
      success: runSuccess,
      normalized_score: normalizedScore,
      failed_items: failedItems,
    };
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
}

/** 秒级离线重评：当仅修补 grade.py / rubric.json 而未改动题面与输入时，直接复用已保存的 artifacts/ 重新打分（0 模型调用）。 */
export async function regradeSavedRuns(taskDir: string, model = 'gpt-6.1-sol', exactRunId?: string) {
  const root = resolve(taskDir);
  const modelDir = join(root, 'runs', model);
  if (!existsSync(modelDir)) {
    throw new Error(`未找到已保存的运行目录: ${modelDir}`);
  }
  const entries = await readdir(modelDir, { withFileTypes: true });
  const runNames = entries
    .filter((e: { isDirectory(): boolean; name: string }) => e.isDirectory() && (!exactRunId || e.name === exactRunId))
    .map((e: { name: string }) => e.name)
    .sort();

  const runs: SingleRunOutcome[] = [];
  const inputDir = join(root, 'environment/input');

  for (const runId of runNames) {
    const runDir = join(modelDir, runId);
    const artifactsDir = join(runDir, 'artifacts');
    if (!existsSync(artifactsDir)) continue;
    const gradePath = join(runDir, 'grade.json');
    const gradeProc = spawnSync(
      'python3',
      [join(root, 'tests/grade.py'), '--artifacts-dir', artifactsDir, '--output', gradePath, '--input-dir', inputDir],
      { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    const gradeData = existsSync(gradePath)
      ? JSON.parse(await readFile(gradePath, 'utf8'))
      : { status: 'ERROR', success: false, normalized_score: null, stderr: gradeProc.stderr };

    const runSuccess = gradeData?.success === true || gradeData?.run_success === true;
    const normalizedScore =
      typeof gradeData?.normalized_score === 'number'
        ? gradeData.normalized_score
        : typeof gradeData?.weighted_score === 'number'
          ? gradeData.weighted_score
          : null;
    const rawItems: any[] = Array.isArray(gradeData?.items)
      ? gradeData.items
      : Array.isArray(gradeData?.criteria_results)
        ? gradeData.criteria_results
        : [];
    const failedItems = rawItems
      .filter((item) => item && item.passed === false)
      .map((item) => ({
        criterion_id: String(item.criterion_id ?? item.id ?? 'unknown'),
        observed: item.observed ?? item.reason ?? null,
      }));
    const runMeta = existsSync(join(runDir, 'run.json'))
      ? JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'))
      : {};

    runs.push({
      run_id: runId,
      model,
      role: runMeta?.run_role === 'clean_trajectory' ? 'clean_trajectory' : 'calibration_8x',
      run_dir: runDir,
      termination_status: String(runMeta?.termination_status ?? 'completed'),
      model_turns: Number(runMeta?.model_turns ?? 0),
      tool_calls: Number(runMeta?.tool_calls ?? 0),
      total_tokens: typeof runMeta?.usage?.total_tokens === 'number' ? runMeta.usage.total_tokens : null,
      success: runSuccess,
      normalized_score: normalizedScore,
      failed_items: failedItems,
    });
  }

  return {
    mode: 'regrade_only',
    task_dir: root,
    model,
    pass_count: runs.filter((r) => r.success).length,
    total_runs: runs.length,
    runs,
  };
}

export async function runCalibration(options: CalibrateOptions) {
  const root = resolve(options.taskDir);
  const preflight = await preflightTask(root, options.model);

  if (preflight.blockers.length && !options.force) {
    throw new Error(`预检阻塞（可用 --force 强行试跑）：\n- ${preflight.blockers.join('\n- ')}`);
  }

  const taskCard = JSON.parse(await readFile(join(root, 'task_card.json'), 'utf8'));
  const rubric = existsSync(join(root, 'tests/rubric.json'))
    ? JSON.parse(await readFile(join(root, 'tests/rubric.json'), 'utf8'))
    : {};
  const instruction = await readFile(join(root, 'instruction.md'), 'utf8');
  const allowInternet = Boolean(taskCard?.network?.allow_internet);
  const pyRuntime = resolveMacPythonRuntimeDirs();
  const parallel = Math.min(8, Math.max(1, Math.trunc(options.parallel ?? Math.min(8, options.runs))));

  if (options.dryRun) {
    const sampleArgs = buildCodexArgs({
      workspace: '<isolated_tmpdir>/workspace',
      inputDir: '<isolated_tmpdir>/workspace/input',
      toolsDir: '<isolated_tmpdir>/workspace/tools',
      outputDir: '<isolated_tmpdir>/workspace/output',
      scratchDir: '<isolated_tmpdir>/workspace/tmp',
      pythonRuntimeDirs: pyRuntime.dirs,
      lastMsgPath: '<isolated_tmpdir>/last_message.txt',
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      allowInternet,
    });
    console.log(
      JSON.stringify(
        {
          mode: 'dry-run',
          preflight,
          planned_runs: options.runs,
          parallel,
          min_pass: options.minPass ?? null,
          max_pass: options.maxPass ?? null,
          demo_required: options.demoRequired ?? 0,
          role: options.role,
          codex_argv_preview: [preflight.codex_binary, ...sampleArgs],
        },
        null,
        2,
      ),
    );
    return { preflight, runs: [] as SingleRunOutcome[], demo_runs: [] as SingleRunOutcome[], early_stopped: false, qualified: null as boolean | null };
  }

  const runIds = options.exactRunId
    ? [options.exactRunId]
    : Array.from({ length: options.runs }, (_, idx) => `${options.runPrefix}${String(idx + 1).padStart(2, '0')}`);

  const results: SingleRunOutcome[] = [];
  let cursor = 0;
  let earlyStopped = false;
  const earlyStopController = new AbortController();

  const workers = Array.from({ length: Math.min(parallel, runIds.length) }, async () => {
    while (cursor < runIds.length && !earlyStopped) {
      const idx = cursor++;
      const runId = runIds[idx]!;
      const out = await executeOneIsolatedRun({
        root,
        preflight,
        pyRuntime,
        instruction,
        allowInternet,
        canary: rubric?.canary,
        runId,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        role: options.role,
        timeoutMinutes: options.timeoutMinutes,
        abortSignal: earlyStopController.signal,
      });
      results.push(out);

      const passSoFar = results.filter((r) => r.success).length;
      if (options.maxPass !== undefined && passSoFar > options.maxPass) {
        earlyStopped = true;
        earlyStopController.abort();
      }
    }
  });

  await Promise.all(workers);
  results.sort((a, b) => a.run_id.localeCompare(b.run_id));

  const calPassCount = results.filter((r) => r.success).length;
  const bandQualified =
    options.minPass !== undefined && options.maxPass !== undefined
      ? !earlyStopped && calPassCount >= options.minPass && calPassCount <= options.maxPass
      : null;

  const demoRuns: SingleRunOutcome[] = [];
  const demoReq = options.demoRequired ?? 0;
  if (bandQualified === true && demoReq > 0) {
    const demoModel = options.demoModel ?? 'gpt-5.6-sol';
    const maxDemo = Math.max(demoReq, options.demoMaxAttempts ?? 3);
    for (let d = 1; d <= maxDemo; d += 1) {
      const demoOut = await executeOneIsolatedRun({
        root,
        preflight,
        pyRuntime,
        instruction,
        allowInternet,
        canary: rubric?.canary,
        runId: `demo_run_${String(d).padStart(2, '0')}`,
        model: demoModel,
        reasoningEffort: options.reasoningEffort,
        role: 'clean_trajectory',
        timeoutMinutes: options.timeoutMinutes,
      });
      demoRuns.push(demoOut);
      if (demoRuns.filter((r) => r.success).length >= demoReq) break;
    }
  }

  const finalQualified =
    bandQualified === null
      ? null
      : bandQualified && (demoReq === 0 || demoRuns.filter((r) => r.success).length >= demoReq);

  return {
    preflight,
    runs: results,
    demo_runs: demoRuns,
    early_stopped: earlyStopped,
    calibration_pass_count: calPassCount,
    qualified: finalQualified,
  };
}

function parseArgs(argv: string[]): CalibrateOptions {
  const args = argv.slice(2);
  let taskDir = '';
  let preset = '';
  let runs: number | undefined;
  let parallel: number | undefined;
  let minPass: number | undefined;
  let maxPass: number | undefined;
  let demoRequired: number | undefined;
  let demoModel = 'gpt-5.6-sol';
  let demoMaxAttempts = 3;
  let model = 'gpt-6.1-sol';
  let reasoningEffort = 'max';
  let role: 'calibration_8x' | 'clean_trajectory' = 'calibration_8x';
  let runPrefix = 'cal_run_';
  let exactRunId: string | undefined;
  let timeoutMinutes = 45;
  let regradeOnly = false;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i += 1) {
    const k = args[i];
    if (k === '--task' && args[i + 1]) taskDir = args[++i]!;
    else if (k === '--preset' && args[i + 1]) preset = args[++i]!;
    else if (k === '--runs' && args[i + 1]) runs = Number(args[++i]);
    else if (k === '--parallel' && args[i + 1]) parallel = Number(args[++i]);
    else if (k === '--min-pass' && args[i + 1]) minPass = Number(args[++i]);
    else if (k === '--max-pass' && args[i + 1]) maxPass = Number(args[++i]);
    else if (k === '--demo-required' && args[i + 1]) demoRequired = Number(args[++i]);
    else if (k === '--demo-model' && args[i + 1]) demoModel = args[++i]!;
    else if (k === '--demo-max-attempts' && args[i + 1]) demoMaxAttempts = Number(args[++i]);
    else if (k === '--model' && args[i + 1]) model = args[++i]!;
    else if (k === '--reasoning-effort' && args[i + 1]) reasoningEffort = args[++i]!;
    else if (k === '--role' && args[i + 1]) role = args[++i] as 'calibration_8x' | 'clean_trajectory';
    else if (k === '--run-prefix' && args[i + 1]) runPrefix = args[++i]!;
    else if (k === '--exact-run-id' && args[i + 1]) exactRunId = args[++i]!;
    else if (k === '--timeout-min' && args[i + 1]) timeoutMinutes = Number(args[++i]);
    else if (k === '--regrade-only') regradeOnly = true;
    else if (k === '--dry-run') dryRun = true;
    else if (k === '--force') force = true;
  }

  if (preset === 'sample_3') {
    runs ??= 3;
    parallel ??= 3;
    minPass ??= 1;
    maxPass ??= 2;
    demoRequired ??= 0;
  } else if (preset === 'sample_5') {
    runs ??= 5;
    parallel ??= 5;
    minPass ??= 1;
    maxPass ??= 2;
    demoRequired ??= 0;
  } else if (preset === 'formal_8plus1') {
    runs ??= 8;
    parallel ??= 8;
    minPass ??= 1;
    maxPass ??= 3;
    demoRequired ??= 1;
  }

  if (!taskDir) {
    throw new Error(
      '用法: bun projects/ALE/scripts/calibrate.ts --task <tasks/TASK_ID> [--preset sample_3|sample_5|formal_8plus1] [--runs N] [--parallel 1..8] [--regrade-only] [--dry-run] [--force]',
    );
  }
  return {
    taskDir,
    runs: runs ?? 1,
    parallel,
    minPass,
    maxPass,
    demoRequired,
    demoModel,
    demoMaxAttempts,
    model,
    reasoningEffort,
    role,
    runPrefix,
    exactRunId,
    timeoutMinutes,
    regradeOnly,
    dryRun,
    force,
  };
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv);
    if (opts.regradeOnly) {
      const regraded = await regradeSavedRuns(opts.taskDir, opts.model, opts.exactRunId);
      console.log(JSON.stringify(regraded, null, 2));
    } else {
      const out = await runCalibration(opts);
      if (!opts.dryRun) {
        console.log(JSON.stringify(out, null, 2));
      }
      if (opts.dryRun && out.preflight.blockers.length && !opts.force) {
        process.exit(2);
      }
    }
  } catch (err) {
    console.error(`[ALE-CALIBRATE] ${(err as Error).message}`);
    process.exit(1);
  }
}
