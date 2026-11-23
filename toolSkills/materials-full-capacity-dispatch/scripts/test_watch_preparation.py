"""运行 python3 -m unittest discover -s 本目录；以临时台账和分段检查点验证补位与续作。"""
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from watch_preparation import load, reconcile, store, watch


class BatchWatchTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.batch = Path(tmp.name)
        self.jobs = self.batch / "jobs"
        self.job = str(uuid4())
        self.req = dict(redaction_id="red", project_id="target", agent_settings={"model": "m"})
        self.attempt = self.batch / "attempts" / "p.json"
        self.attempt.parent.mkdir()
        store(self.attempt, dict(id="p", item_id="rev", stage_id="prepare", status="failed",
                                 request=self.req, inputs=[], configuration=self.req["agent_settings"],
                                 external_ids={"job_id": self.job}, error={"code": "deadline_exceeded"}))
        self.task = self.batch / "task.json"
        store(self.batch / "sources.json", {"target_project": "target"})
        store(self.task, {"items": [dict(id="rev", external_ids=dict(new_redaction="red", revision_id="rev"),
                                         stages=[dict(id="redact", state="succeeded"),
                                                 dict(id="prepare", state="failed", attempt_id="p")])]})

    def chunk(self, job, index):
        path = self.jobs / job / "preparation" / f"chunk-{index:03d}" / "checkpoint.json"
        path.parent.mkdir(parents=True)
        store(path, {"response": {"result": {"documents": [{"id": "d"}]}}})

    def test_resume_one_per_parent_with_progress(self):
        self.chunk(self.job, 1)
        original = load(self.task)
        self.assertEqual(reconcile(self.batch, self.jobs), "pending")
        stage = load(self.task)["items"][0]["stages"][1]
        child_path = self.attempt.with_name(stage["attempt_id"] + ".json")
        child = load(child_path)
        self.assertEqual(child["request"]["previous_job_id"], self.job)
        self.assertEqual(child["request"]["redaction_id"], "red")
        store(self.task, original)  # interruption between child receipt and stage update
        reconcile(self.batch, self.jobs)
        self.assertEqual(len(list(self.attempt.parent.iterdir())), 2)
        task = load(self.task)
        task["items"][0]["stages"][1]["state"] = "failed"
        store(self.task, task)
        next_job = str(uuid4())
        child.update(status="failed", error={"code": "codex_timeout"}, external_ids={"job_id": next_job})
        store(child_path, child)
        self.chunk(next_job, 1)
        self.assertEqual(reconcile(self.batch, self.jobs), "blocked")
        self.chunk(next_job, 2)
        self.assertEqual(reconcile(self.batch, self.jobs), "pending")

    def test_isolate_no_checkpoint_source_mismatch_and_other_failure(self):
        self.assertEqual(reconcile(self.batch, self.jobs), "blocked")
        self.chunk(self.job, 1)
        parent = load(self.attempt)
        parent["error"]["code"] = "invalid_output"
        store(self.attempt, parent)
        self.assertEqual(reconcile(self.batch, self.jobs), "blocked")
        parent["request"]["project_id"] = "elsewhere"
        parent["error"]["code"] = "codex_timeout"
        store(self.attempt, parent)
        self.assertEqual(reconcile(self.batch, self.jobs), "blocked")
        self.assertEqual(len(list(self.attempt.parent.iterdir())), 1)

    def test_fast_refill_and_stop(self):
        self.chunk(self.job, 1)
        waits, visits = [], []
        def visit():
            visits.append(True)
            if len(visits) == 2:
                task = load(self.task)
                task["items"][0]["stages"][1]["state"] = "succeeded"
                task["items"][0]["acceptance"] = {"state": "accepted"}
                store(self.task, task)
        self.assertEqual(watch(self.batch, self.jobs, visit, waits.append), "done")
        self.assertEqual(waits, [60])
        self.assertEqual(watch(self.batch, self.jobs, visit, waits.append), "done")
        self.assertEqual(len(visits), 2)
