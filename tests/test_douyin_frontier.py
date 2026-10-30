import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from douyin_frontier import AccessRefused, Frontier, anchor

IDS = ("123456789", "223456789", "323456789")


def url(index):
    return "https://www.douyin.com/video/" + IDS[index]


def source_record(
    bvid="BV1234567890", label="甲", desc=None, observed="2026-10-29T00:00:00Z"
):
    return {
        "platform": "bilibili",
        "kind": "video",
        "item_id": bvid,
        "observed_at": observed,
        "published_at_raw": 1600000000,
        "evidence_sha": "a" * 64,
        "texts": [
            {
                "kind": "title",
                "text": "【梗指南】<em>" + label + "</em>是什么梗",
                "locator": "/data/title",
            },
            {
                "kind": "desc",
                "text": desc if desc is not None else "引用 " + url(2),
                "locator": "/data/desc",
            },
        ],
    }


CLASSIFICATION = {"explanation": {"level": "explicit_candidate"}}


def make_source(path, records):
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE IF NOT EXISTS explainer_catalog_works(bvid TEXT PRIMARY KEY,record_json TEXT,classification_json TEXT); "
        "CREATE TABLE IF NOT EXISTS observations(record_json TEXT);"
    )
    for record in records:
        db.execute(
            "INSERT INTO explainer_catalog_works VALUES(?,?,?)",
            (record["item_id"], json.dumps(record), json.dumps(CLASSIFICATION)),
        )
    db.commit()
    db.close()


def video(index, query=None, title="卡片标题"):
    row = {
        "id": IDS[index],
        "url": url(index),
        "title": title,
        "createdAt": 1600000000,
        "likes": 3,
        "comments": 1,
        "cover": "https://private.invalid/?token=excluded",
        "mediaUrls": ["https://private.invalid/media"],
    }
    if query is not None:
        row["searchContext"] = {
            "requestedQuery": query,
            "observedAt": "2026-10-29T00:00:01Z",
            "responsePath": "https://www.douyin.com/aweme/v1/web/general/search/single/",
        }
    else:
        row["detailContext"] = {
            "requestedUrl": url(index),
            "resolvedUrl": url(index),
            "observedAt": "2026-10-29T00:00:02Z",
        }
    return row


def job(kind, rows, status="completed", error=None):
    return {
        "id": "fixture-" + kind,
        "type": kind,
        "status": status,
        "result": {"videos": rows},
        "error": error,
    }


def frames():
    return {
        "resolve:" + url(2): job("resolve", [video(2, title="引用素材")]),
        "search:甲": job("search", [video(0, "甲"), video(2, "甲")]),
        "search:乙": job("search", [video(0, "乙"), video(1, "乙")]),
        "search:更新线索": job("search", []),
        "resolve:" + url(0): job(
            "resolve", [video(0, title="当甲时二创模板 " + url(2))]
        ),
        "resolve:" + url(1): job("resolve", [], "failed", "作品已删除，不可用"),
    }


class Reader:
    mode = "replay"

    def __init__(self, records=None):
        self.records = records or frames()
        self.calls = []
        self.receipts = {}

    def submit(self, task):
        self.calls.append(task["kind"] + ":" + task["target"])
        result = {**self.records[self.calls[-1]], "idempotencyKey": task["id"]}
        self.receipts[task["id"]] = result
        return result

    def recover(self, task):
        return self.receipts.get(task["id"])


class FrontierTests(unittest.TestCase):
    def test_replay_frontier_cannot_be_relabelled_live(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            frontier = Frontier(root / "run")
            with frontier.db:
                frontier.set("transport_mode", "replay")
            frontier.db.close()
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {
                        "output": "run",
                        "pause_file": "pause.json",
                        "deadline": time.time() + 60,
                        "transport": "live",
                        "studio_origin": "http://127.0.0.1:9",
                    }
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    sys.executable,
                    "-X",
                    "utf8",
                    str(Path(__file__).parents[1] / "scripts/douyin_discovery.py"),
                    "--config",
                    str(config),
                    "--live",
                    "--rounds",
                    "1",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("separate frontier directories", result.stderr)
            self.assertTrue((root / "run/FAULT").exists())

    def test_waiting_job_is_recovered_before_any_other_submission(self):
        with ExitStack() as cleanup:
            root = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
            frontier = Frontier(root / "run")
            cleanup.callback(frontier.db.close)
            with frontier.db:
                frontier.add_anchor(
                    anchor(source_record(desc="无出处"), CLASSIFICATION)
                )
            reader = Reader({"search:甲": job("search", [], "queued")})
            first = frontier.step(
                reader, root / "pause", root / "STOP", time.time() + 100
            )
            self.assertEqual(first["status"], "waiting_for_job")
            with frontier.db:
                frontier.task("resolve", url(2), "head")
            second = frontier.step(
                reader, root / "pause", root / "STOP", time.time() + 100
            )
            self.assertEqual(second["status"], "waiting_for_job")
            self.assertEqual(second["submitted_reader_jobs"], 0)
            self.assertEqual(second["recovered_jobs"], 1)
            self.assertEqual(len(reader.calls), 1)

    def test_multi_round_incremental_fairness_paths_detail_proof_and_updates(self):
        with ExitStack() as cleanup:
            root = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
            source = root / "bili.sqlite3"
            make_source(source, [source_record()])
            before = source.read_bytes()
            frontier = Frontier(root / "run")
            reader = Reader()
            cleanup.callback(frontier.db.close)
            pause, stop = root / "pause", root / "STOP"
            self.assertEqual(frontier.ingest(source, 1)["anchor_revisions"], 1)
            first = frontier.step(reader, pause, stop, time.time() + 100, 1)
            self.assertEqual(
                first["new_unique_details"], 1
            )  # Explicit link before keyword search.
            self.assertEqual(source.read_bytes(), before)
            make_source(source, [source_record("BV2234567890", "乙", "无明确出处")])
            self.assertEqual(frontier.ingest(source, 1)["anchor_revisions"], 1)
            receipts = [first]
            for _ in range(6):
                receipts.append(
                    frontier.step(reader, pause, stop, time.time() + 100, 1)
                )
            self.assertEqual(reader.calls[0], "resolve:" + url(2))
            self.assertEqual(
                reader.calls[1], "search:乙"
            )  # New head proceeds amid old history.
            self.assertIn(
                "search:甲", reader.calls
            )  # History is not starved by the head.
            self.assertEqual(reader.calls.count("resolve:" + url(0)), 1)
            paths = frontier.db.execute(
                "SELECT DISTINCT anchor FROM work_paths WHERE work=?", (IDS[0],)
            ).fetchall()
            self.assertEqual(len(paths), 2)
            self.assertEqual(
                frontier.db.execute("SELECT count(*) FROM details").fetchone()[0], 2
            )
            self.assertEqual(
                frontier.db.execute(
                    "SELECT status FROM tasks WHERE target=?", (url(1),)
                ).fetchone()[0],
                "unavailable",
            )
            self.assertEqual(sum(row["unavailable"] for row in receipts), 1)
            self.assertEqual(frontier.roles()["derivative_usage_overlap"], 1)
            self.assertTrue(
                all(row["family_id"] is None for row in frontier.roles()["evidence"])
            )
            # Explicit formal contexts supplied by a trusted caller share cached work without losing either family.
            for family in ("formal-family-one", "formal-family-two"):
                formal = anchor(source_record(), CLASSIFICATION)
                formal.update(id="formal:" + family + ":BV1234567890", family_id=family)
                with frontier.db:
                    frontier.add_anchor(formal)
            families = {
                row["family_id"]
                for row in frontier.roles()["evidence"]
                if row["work"] == IDS[0]
            }
            self.assertEqual(families, {None, "formal-family-one", "formal-family-two"})
            self.assertEqual(frontier.ingest(source, 1)["bilibili_rows_scanned"], 0)
            before_update_searches = frontier.db.execute(
                "SELECT count(*) FROM tasks WHERE kind='search' AND target='甲'"
            ).fetchone()[0]
            updated = source_record(
                desc="原作：更新线索", observed="2026-10-29T01:00:00Z"
            )
            db = sqlite3.connect(source)
            db.execute("INSERT INTO observations VALUES(?)", (json.dumps(updated),))
            db.commit()
            db.close()
            self.assertEqual(frontier.ingest(source, 1)["observation_highwater"], 1)
            self.assertEqual(
                frontier.db.execute(
                    "SELECT count(*) FROM tasks WHERE kind='search' AND target='甲'"
                ).fetchone()[0],
                before_update_searches + 1,
            )
            self.assertIsNotNone(
                frontier.db.execute(
                    "SELECT 1 FROM tasks WHERE target='更新线索'"
                ).fetchone()
            )
            self.assertIsNotNone(
                frontier.db.execute(
                    "SELECT 1 FROM tasks WHERE target='甲' AND lane='head' AND status='pending'"
                ).fetchone()
            )
            self.assertEqual(frontier.ingest(source, 1)["bilibili_rows_scanned"], 0)
            for table in ("details", "cards"):
                self.assertNotIn(
                    "token=excluded",
                    str(
                        [
                            row[0]
                            for row in frontier.db.execute(
                                "SELECT record FROM " + table
                            )
                        ]
                    ),
                )
            self.assertEqual(receipts[-1]["native_search_cursor"], "unsupported")
            frontier.db.close()

    def test_stop_restart_unknown_inflight_and_keyed_recovery(self):
        with ExitStack() as cleanup:
            root = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
            frontier = Frontier(root / "run")
            reader = Reader()
            cleanup.callback(frontier.db.close)
            value = anchor(source_record(desc="无出处"), CLASSIFICATION)
            with frontier.db:
                frontier.add_anchor(value)
            pause, stop = root / "pause", root / "STOP"
            stop.write_text("manual_stop")
            self.assertEqual(
                frontier.step(reader, pause, stop, time.time() + 100)["status"],
                "stopped",
            )
            self.assertEqual(reader.calls, [])
            frontier.db.close()
            frontier = Frontier(root / "run")
            cleanup.callback(frontier.db.close)
            self.assertEqual(
                frontier.step(reader, pause, stop, time.time() + 100)["status"],
                "stopped",
            )
            stop.unlink()  # Explicit operator action inside synthetic acceptance only.
            original = reader.submit

            def lost_ack(task):
                original(task)
                raise TimeoutError("lost acknowledgement")

            reader.submit = lost_ack
            self.assertEqual(
                frontier.step(reader, pause, stop, time.time() + 100, 1)["status"],
                "submission_unknown",
            )
            self.assertEqual(len(reader.calls), 1)
            frontier.db.close()
            frontier = Frontier(root / "run")
            cleanup.callback(frontier.db.close)
            row = frontier.step(reader, pause, stop, time.time() + 100, 1)
            self.assertEqual(row["recovered_jobs"], 1)
            self.assertEqual(len(reader.calls), 1)
            with frontier.db:
                key = frontier.task("search", "没有回执", "head")
                frontier.db.execute(
                    "UPDATE tasks SET status='submission_unknown',created=0 WHERE id=?",
                    (key,),
                )
            self.assertEqual(
                frontier.step(reader, pause, stop, time.time() + 100, 1)["status"],
                "submission_unknown",
            )
            self.assertEqual(len(reader.calls), 1)
            frontier.db.close()

    def test_pause_zero_requests_refusal_persists_and_manual_job_cancel_stops(self):
        with ExitStack() as cleanup:
            root = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
            frontier = Frontier(root / "run")
            reader = Reader()
            cleanup.callback(frontier.db.close)
            with frontier.db:
                frontier.add_anchor(
                    anchor(source_record(desc="无出处"), CLASSIFICATION)
                )
            pause, stop = root / "pause", root / "STOP"
            pause.write_text('{"reason":"access_restriction"}')
            before = pause.read_bytes()
            self.assertEqual(
                frontier.step(reader, pause, stop, time.time() + 100)["status"],
                "blocked_access",
            )
            self.assertEqual(reader.calls, [])
            self.assertEqual(pause.read_bytes(), before)
            pause.unlink()  # Synthetic file, never the actual account pause.

            def refusal(_task):
                raise AccessRefused("HTTP 429")

            reader.submit = refusal
            self.assertEqual(
                frontier.step(reader, pause, stop, time.time() + 100)["status"],
                "blocked_access",
            )
            self.assertIsNotNone(frontier.get("access_pause"))
            self.assertEqual(
                frontier.step(Reader(), pause, stop, time.time() + 100)[
                    "submitted_reader_jobs"
                ],
                0,
            )
            frontier.db.close()
            other = Frontier(root / "cancelled")
            cleanup.callback(other.db.close)
            with other.db:
                other.add_anchor(anchor(source_record(desc="无出处"), CLASSIFICATION))
            cancel = Reader({"search:甲": job("search", [], "cancelled")})
            self.assertEqual(
                other.step(cancel, pause, stop, time.time() + 100)["status"], "stopped"
            )
            self.assertTrue(stop.exists())
            other.db.close()


if __name__ == "__main__":
    unittest.main()
