"""运行已授权的脱敏、整理批次。使用既有 visit.py 派发，复用同一把台账锁及请求回执。"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import UUID, uuid5


def load(path):
    return json.loads(path.read_text())


def store(path, data):
    tmp = path.with_suffix(".watch.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.replace(path)


@contextmanager
def locked(path):
    with path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def checkpoints(jobs, job_id):
    directory = jobs / str(UUID(job_id)) / "preparation"
    # 只采信引擎已原子提交的完整分段。单段文件的实际字段仍由整理引擎复验。
    done = set()
    for file in directory.glob("chunk-*/checkpoint.json"):
        try:
            documents = load(file)["response"]["result"]["documents"]
            if isinstance(documents, list) and documents:
                done.add(file.parent.name)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return done


def plan_resume(batch, jobs, target, item, stage):
    path = batch / "attempts" / (stage["attempt_id"] + ".json")
    parent = load(path)
    req = parent["request"]
    ids = item["external_ids"]
    if (parent["status"] != "failed" or parent.get("stage_id") != "prepare"
            or parent["item_id"] != item["id"] or ids["revision_id"] != item["id"]
            or req.get("redaction_id") != ids.get("new_redaction") or not ids.get("new_redaction")
            or req.get("project_id") != target or not req.get("agent_settings")
            or parent.get("error", {}).get("code") not in {"codex_timeout", "deadline_exceeded"}):
        return False
    job = parent["external_ids"]["job_id"]
    done = checkpoints(jobs, job)
    # Require strictly more completed chunks than at the previous handoff.
    prior = set(parent.get("resume_checkpoints", []))
    if req.get("previous_job_id") and "resume_checkpoints" not in parent:
        prior = checkpoints(jobs, req["previous_job_id"])
    if not prior < done:
        return False
    key = str(uuid5(UUID(job), "prepare-checkpoint-resume"))
    attempt_id = "prepare-" + key
    child_path = path.with_name(attempt_id + ".json")
    request = dict(req, previous_job_id=job, request_key=key)
    if child_path.exists():
        child = load(child_path)
        if child["request"] != request or child["previous_attempt_id"] != parent["id"]:
            raise ValueError("已有续作回执与当前来源不符")
    else:
        child = dict(id=attempt_id, item_id=item["id"], stage_id="prepare",
                     started_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), status="planned",
                     inputs=parent["inputs"], configuration=parent["configuration"],
                     previous_attempt_id=parent["id"], resume_checkpoints=sorted(done),
                     changes_from_previous=[f"已确认整理超时，继承 {len(done)} 个完整分段"],
                     external_ids={"request_key": key}, request=request)
        store(child_path, child)
    stage.update(state=child["status"], attempt_id=attempt_id, outcome="有新完成分段，待同源续作")
    return True


def reconcile(batch, jobs):
    with locked(batch / "visit.lock"):
        task = load(batch / "task.json")
        target = load(batch / "sources.json")["target_project"]
        changed = False
        pending = False
        accepted = 0
        for item in task["items"]:
            redact, prepare = item["stages"]
            if (redact["id"], prepare["id"]) != ("redact", "prepare"):
                raise ValueError("巡查仅支持脱敏后整理")
            if item.get("acceptance", {}).get("state") == "accepted" and prepare["state"] == "succeeded":
                accepted += 1
                continue
            if redact["state"] == "succeeded" and prepare["state"] == "failed":
                changed |= plan_resume(batch, jobs, target, item, prepare)
            active = prepare if redact["state"] == "succeeded" else redact
            pending |= active["state"] in {"queued", "running", "unknown", "planned"}
        if changed:
            store(batch / "task.json", task)
        if not task["items"]:
            raise ValueError("先由本批台账确认输入范围")
        return "done" if accepted == len(task["items"]) else "pending" if pending else "blocked"


def watch(batch, jobs, visit, sleep=time.sleep, interval=60):
    while True:
        status = reconcile(batch, jobs)
        if status != "pending":
            return status
        visit()
        status = reconcile(batch, jobs)
        if status != "pending":
            return status
        sleep(interval)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch", type=Path, help="已核实且获授权的批次台账目录")
    parser.add_argument("--storage", type=Path, default=os.environ.get("STORAGE_DIR") or Path(__file__).resolve().parents[3] / ".storage")
    parser.add_argument("--interval", type=int, default=60, help="两次单轮巡查间隔秒数")
    args = parser.parse_args()
    if args.interval < 1:
        parser.error("巡查间隔须为正数")
    batch = args.batch.resolve()
    def visit():
        subprocess.run([sys.executable, str(batch / "visit.py")], check=True)
    # A second watcher exits without dispatching; independent single visits use visit.lock.
    with (batch / "watch.lock").open("a") as owner:
        try:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit("此批次已在巡查")
        result = watch(batch, args.storage / "material-library" / "jobs", visit, interval=args.interval)
        print(result)
        sys.exit(0 if result == "done" else 2)
