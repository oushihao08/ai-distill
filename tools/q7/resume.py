#!/usr/bin/env python3
"""第七期 9 包续跑：材料整理 -> 出题。

用法（在仓库根目录）：
    python3 tools/q7/resume.py              # 全量：整理 + 出题
    python3 tools/q7/resume.py --skip-prepare   # 跳过整理，直接出题
    python3 tools/q7/resume.py --only-author     # 同上
    python3 tools/q7/resume.py --dry-run        # 只打印计划，不派发

设计要点：
- 复用 .storage/q7-run-20261101/ledger.json 台账，不重做入库/脱敏/建题。
- Codex 额度未恢复时，第一次 agent 调用会在十几秒内 process_exit_nonzero，
  脚本检测到 usage limit 后立即中止，避免白跑。
- prepare 并发默认 3（8 并发曾把服务压垮）。
"""
import argparse
import json
import os
import subprocess
import sys
import time
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROJECT = 'd1cb65a1-7b73-4380-99ed-c7caa9fa481b'
LEDGER = os.path.join(REPO, '.storage/q7-run-20261101/ledger.json')
API = 'http://127.0.0.1:3700'
MAX_PREPARE_INFLIGHT = 3


def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)


def cli(*args):
    p = subprocess.run(['bun', 'cli/index.ts', *args, '--json'],
                       capture_output=True, text=True, cwd=REPO)
    out = (p.stdout + p.stderr).strip()
    try:
        return json.loads(out[out.index('{'):])
    except Exception:
        return {'outcome': 'parse_fail', 'raw': out[:300]}


def health():
    p = subprocess.run(['curl', '-s', '-m', '4', '-o', '/dev/null',
                        '-w', '%{http_code}', API + '/api/health'],
                       capture_output=True, text=True)
    return p.stdout.strip() == '200'


def job_status(job_id):
    d = cli('library', 'job', 'show', '--job', job_id)
    if d.get('outcome') != 'complete':
        return None, None
    return d['data'].get('status'), d['data'].get('error_code')


def quota_blocked(job_id):
    """检查失败任务的 agent 输出里是否有 usage limit。"""
    root = os.path.join(REPO, '.storage/material-library/jobs', job_id)
    for dirpath, _, files in os.walk(root):
        if 'events.jsonl' in files:
            try:
                txt = open(os.path.join(dirpath, 'events.jsonl'), errors='ignore').read()
            except OSError:
                continue
            if 'usage limit' in txt:
                return True
    return False


def load_ledger():
    with open(LEDGER) as f:
        return json.load(f)


def save_ledger(led):
    with open(LEDGER, 'w') as f:
        json.dump(led, f, ensure_ascii=False, indent=2)


def run_prepares(led, dry):
    pending = [k for k, v in led.items()
               if v.get('redaction_id') and not v.get('prepared')]
    if not pending:
        log('整理：无待处理包')
        return True
    log('整理待跑：' + ', '.join(pending))
    if dry:
        return True

    inflight = {}
    while pending or inflight:
        while pending and len(inflight) < MAX_PREPARE_INFLIGHT:
            k = pending.pop(0)
            v = led[k]
            rk = str(uuid.uuid4())
            d = cli('library', 'prepare', 'start', '--revision', v['revision_id'],
                    '--redaction', v['redaction_id'], '--request-key', rk,
                    '--project', PROJECT)
            if d.get('outcome') == 'complete':
                v['prepare_request_key'] = rk
                v['prepare_job'] = d['data']['id']
                inflight[k] = v['prepare_job']
                log(f"  启动 {k} job={v['prepare_job'][:8]}")
            else:
                log(f"  启动失败 {k}: {json.dumps(d, ensure_ascii=False)[:180]}")
        save_ledger(led)
        time.sleep(20)
        for k, job in list(inflight.items()):
            st, err = job_status(job)
            if st not in ('succeeded', 'failed', 'cancelled'):
                continue
            led[k]['prepare_status'] = st
            led[k]['prepare_error'] = err
            if st == 'succeeded':
                led[k]['prepared'] = True
                log(f"  {k} 整理成功")
            else:
                log(f"  {k} 整理失败 {err}")
                if err == 'process_exit_nonzero' and quota_blocked(job):
                    log('检测到 Codex 用量上限，中止。额度恢复后重跑本脚本。')
                    save_ledger(led)
                    return False
            inflight.pop(k)
    save_ledger(led)
    ok = sum(1 for v in led.values() if v.get('prepared'))
    log(f'整理完成：{ok}/9 成功')
    return True


def run_authors(led, dry):
    ids = [v['workflow_id'] for v in led.values()]
    d = cli('workflow', 'status', '--project', PROJECT, '--ids', ','.join(ids))
    if d.get('outcome') != 'complete':
        log('读取 workflow 状态失败：' + json.dumps(d, ensure_ascii=False)[:200])
        return False
    st = d['data']
    todo = []
    for k, v in led.items():
        w = st.get(v['workflow_id'], {})
        steps = [x for x in (w.get('steps') or []) if x['ordinal'] == 4]
        if not steps:
            log(f'  {k} 缺少第4步，跳过')
            continue
        s4 = steps[0]
        if s4.get('status') == 'succeeded':
            log(f"  {k} 已出题成功，跳过")
            continue
        todo.append((k, v['workflow_id']))
    if not todo:
        log('出题：全部已完成')
        return True
    log('出题待派发：' + ', '.join(k for k, _ in todo))
    if dry:
        return True

    d = cli('step', 'dispatch', 'author_question', '--project', PROJECT,
            '--ids', ','.join(w for _, w in todo))
    if d.get('outcome') != 'complete':
        log('派发失败：' + json.dumps(d, ensure_ascii=False)[:300])
        return False
    attempts = [x['attempt_id'] for x in d.get('dispatch', []) if x.get('attempt_id')]
    log(f'已派发 {len(attempts)} 个 attempt，等待终态（最长 60 分钟）')
    if attempts:
        cli('attempt', 'wait', '--ids', ','.join(attempts), '--timeout', '60m')
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--skip-prepare', action='store_true')
    ap.add_argument('--only-author', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    if not health():
        log(f'API 未就绪（{API}）。先在另一个终端跑 `bun run server` 与 `bun run worker`。')
        return 1
    led = load_ledger()
    skip_prepare = a.skip_prepare or a.only_author
    if not skip_prepare:
        if not run_prepares(led, a.dry_run):
            return 2
    if not run_authors(led, a.dry_run):
        return 1
    if a.dry_run:
        log('（dry-run：只出计划，未派发任何任务）')
        return 0
    log('全部完成。用 `bun cli/index.ts workflow status --project %s --ids <ids>` 复核。' % PROJECT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
