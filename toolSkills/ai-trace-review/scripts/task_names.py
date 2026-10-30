#!/usr/bin/env python3
"""生成飞书任务名称修改计划并按旧值核验后执行；入口见父目录README。

仅通过现有飞书CLI读取/修改指定记录的任务名称；写私有计划/回执，不访问数据库。
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'toolSkills/feishu-operations/scripts/cli.ts'


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def cli(action, target, record_id, body=None):
    args = ['bun', str(CLI), 'record', action, '--base', target['base_token'],
            '--table', target['table_id'], '--id', record_id]
    try:
        result = subprocess.run(args, input=None if body is None else json.dumps(body),
                                capture_output=True, text=True, timeout=100, cwd=ROOT)
        if result.returncode:
            raise RuntimeError('feishu_command_failed')
        envelope = json.loads(result.stdout)
        if envelope.get('ok') is not True:
            raise RuntimeError('feishu_command_failed')
        return envelope['data']
    except (subprocess.TimeoutExpired, ValueError, KeyError, OSError) as error:
        raise RuntimeError('feishu_response_unknown') from error


def read(target, record_id):
    data = cli('get', target, record_id)
    record = data.get('record', data)
    if record.get('record_id') != record_id or not isinstance(record.get('fields'), dict):
        raise RuntimeError('record_identity_invalid')
    return record['fields']


def identity(fields, workflow_id):
    values = [fields.get(key) for key in ['题目ID', '系统同步ID'] if fields.get(key)]
    if not values or any(value != workflow_id for value in values):
        raise RuntimeError('workflow_identity_conflict')


def without_name(fields):
    return {key: value for key, value in fields.items() if key != '任务名称'}


def plan(args):
    destination = Path(args.out).resolve()
    if destination.exists():
        raise RuntimeError('plan_already_exists')
    source = json.loads(Path(args.input).read_text())
    items = source.get('items')
    if set(source) != {'items'} or not isinstance(items, list) or not items:
        raise RuntimeError('items_required')
    target = {'base_token': args.base, 'table_id': args.table}
    records, workflows, prepared = set(), set(), []
    for item in items:
        if not isinstance(item, dict) or set(item) != {'record_id', 'workflow_id', 'before', 'after'}:
            raise RuntimeError('item_invalid')
        if not all(isinstance(value, str) for value in item.values()):
            raise RuntimeError('item_invalid')
        uuid.UUID(item['workflow_id'])
        if not item['after'].strip() or any(ord(c) < 32 for c in item['after']):
            raise RuntimeError('task_name_invalid')
        if item['record_id'] in records or item['workflow_id'] in workflows:
            raise RuntimeError('duplicate_identity')
        records.add(item['record_id'])
        workflows.add(item['workflow_id'])
        current = read(target, item['record_id'])
        identity(current, item['workflow_id'])
        if current.get('任务名称', '') != item['before']:
            raise RuntimeError('old_name_conflict')
        prepared.append({**item, 'snapshot': current})
    save(destination, {'format': 'feishu-task-names-v1', 'target': target, 'items': prepared})
    print(json.dumps({'status': 'planned', 'count': len(prepared), 'writes': 0, 'plan': str(destination)}))


def apply(args):
    path = Path(args.plan).resolve()
    value = json.loads(path.read_text())
    if value.get('format') != 'feishu-task-names-v1' or not value.get('items'):
        raise RuntimeError('plan_invalid')
    digest = hashlib.sha256(canonical(value).encode()).hexdigest()
    progress_path = path.with_name(path.name + '.progress.json')
    with path.with_name(path.name + '.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock.seek(0)
        lock.truncate()
        lock.write(canonical({'pid': os.getpid(), 'run_id': str(uuid.uuid4()),
                              'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        lock.flush()
        progress = json.loads(progress_path.read_text()) if progress_path.exists() else {'plan_sha256': digest, 'items': {}}
        if progress.get('plan_sha256') != digest:
            raise RuntimeError('plan_changed')
        for item in value['items']:
            record_id = item['record_id']
            current = read(value['target'], record_id)
            identity(current, item['workflow_id'])
            if without_name(current) != without_name(item['snapshot']):
                raise RuntimeError('unrelated_fields_changed')
            previous = progress['items'].get(record_id)
            if previous:
                if current.get('任务名称', '') != item['after']:
                    raise RuntimeError('prior_write_unknown_or_changed')
                previous['status'] = 'reconciled'
                save(progress_path, progress)
                continue
            if current.get('任务名称', '') != item['before']:
                raise RuntimeError('old_name_conflict')
            state = {'status': 'intent', 'before': item['before'], 'after': item['after']}
            progress['items'][record_id] = state
            save(progress_path, progress)
            if item['before'] == item['after']:
                state['status'] = 'unchanged'
                save(progress_path, progress)
                continue
            try:
                state['receipt'] = cli('update', value['target'], record_id, {'fields': {'任务名称': item['after']}})
                state['status'] = 'received'
                save(progress_path, progress)
                actual = read(value['target'], record_id)
                state['readback'] = actual
                expected = {**current, '任务名称': item['after']}
                if actual != expected:
                    state['status'] = 'readback_conflict'
                    save(progress_path, progress)
                    raise RuntimeError('readback_conflict')
                state['status'] = 'verified'
                save(progress_path, progress)
            except Exception:
                if state['status'] in ['intent', 'received']:
                    state['status'] = 'unknown'
                save(progress_path, progress)
                raise
        print(json.dumps({'status': 'complete', 'scope': 'feishu-only',
                          'database_modified': False, 'count': len(value['items']),
                          'progress': str(progress_path)}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    draft = commands.add_parser('plan', help='只读核验并生成旧名→新名计划')
    for name in ['base', 'table', 'input', 'out']:
        draft.add_argument('--' + name, required=True)
    execute = commands.add_parser('apply', help='按私有计划仅修改飞书任务名称；不修改数据库')
    execute.add_argument('--plan', required=True)
    execute.add_argument('--scope', choices=['feishu-only'], required=True)
    args = parser.parse_args()
    try:
        plan(args) if args.command == 'plan' else apply(args)
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({'status': 'stopped', 'reason': code, 'retry_performed': False}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
