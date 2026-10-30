"""Synthetic native-contract CLI replay; saves audit artifacts and never contacts Douyin."""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from douyin_frontier import encoded
from test_douyin_frontier import make_source, source_record, url, video
from test_native_frontier import page_job


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    root = parser.parse_args().output.resolve()
    root.mkdir()
    repo = Path(__file__).parents[1]
    make_source(
        root / "bili.sqlite3",
        [source_record(desc="无出处"), source_record("BV2234567890", "乙", "无出处")],
    )
    frames = {}

    def add(request, indices, cursor=None, more=False, search_id=None):
        frames[request["kind"] + ":" + encoded(request).decode()] = page_job(
            request, indices, cursor, more, search_id
        )

    search = {
        "kind": "search_page",
        "query": "甲",
        "cursor": 0,
        "searchId": "",
        "count": 8,
    }
    add(search, [0, 1], 10, True, "log10")
    add({**search, "cursor": 10, "searchId": "log10"}, [1], 20, False, "log20")
    add({**search, "query": "乙"}, [1], 10, False, "log-b")
    a = {"kind": "related", "videoId": "123456789", "excludedIds": [], "count": 8}
    add(a, [2], more=True)
    add({**a, "excludedIds": ["123456789", "323456789"]}, [2], more=True)
    add({**a, "videoId": "223456789"}, [2])
    for index in range(3):
        frames["resolve:" + url(index)] = {
            "id": "synthetic-detail-" + str(index),
            "type": "resolve",
            "status": "completed",
            "result": {"videos": [video(index)]},
        }
    (root / "replay.json").write_bytes(
        encoded(
            {
                "material": "synthetic_public_contract_fixtures_not_real_responses",
                "jobs": frames,
            }
        )
    )
    config = {
        "output": "run",
        "bilibili_database": "bili.sqlite3",
        "pause_file": "synthetic-pause.json",
        "transport": "replay",
        "reader_protocol": "native_pages",
        "max_pages_per_stream": 3,
        "related_depth": 1,
        "replay_file": "replay.json",
        "deadline": time.time() + 300,
        "reader_jobs_per_round": 1,
        "idle_wait_seconds": 1,
    }
    file = root / "config.json"
    file.write_bytes(encoded(config))
    calls = []

    def run(rounds):
        result = subprocess.run(
            [
                sys.executable,
                "-X",
                "utf8",
                str(repo / "scripts/douyin_discovery.py"),
                "--config",
                str(file),
                "--rounds",
                str(rounds),
            ],
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
            timeout=40,
        )
        calls.append(
            {
                "exit": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
        )
        if result.returncode:
            raise AssertionError(result.stderr)

    run(3)
    stop = root / "run/STOP"
    stop.write_text("synthetic_operator_stop")
    run(1)
    run(1)
    stop.unlink()  # Deliberate synthetic operator restart only.
    run(9)
    db = sqlite3.connect(root / "run/frontier.sqlite3")
    receipts = [
        json.loads(row[0])
        for row in db.execute("SELECT record FROM receipts ORDER BY id")
    ]
    rows = list(
        db.execute(
            "SELECT kind,status,pages,reason FROM native_streams ORDER BY kind,target"
        )
    )
    stats = {
        "details": db.execute("SELECT count(*) FROM details").fetchone()[0],
        "related_parents": db.execute(
            "SELECT count(DISTINCT parent) FROM recommendation_edges WHERE child='323456789'"
        ).fetchone()[0],
        "child_anchors": db.execute(
            "SELECT count(DISTINCT anchor) FROM work_paths WHERE work='323456789'"
        ).fetchone()[0],
    }
    assert stats == {"details": 3, "related_parents": 2, "child_anchors": 2}, stats
    assert len(receipts) == 14
    assert receipts[3]["status"] == receipts[4]["status"] == "stopped"
    assert all(row["real_network_requests"] == 0 for row in receipts)
    assert sum(row["submitted_reader_jobs"] for row in receipts) == 9
    assert any(row[3] == "repeated_page" for row in rows)
    assert len([row for row in rows if row[1] == "exhausted"]) == 3
    assert "token=excluded" not in "\n".join(db.iterdump())
    db.close()
    report = {
        "material": "synthetic_public_contract_fixtures",
        "cli_invocations": len(calls),
        "receipts": len(receipts),
        "submitted_reader_jobs": 9,
        "real_douyin_requests": 0,
        "streams": rows,
        **stats,
        "calls": calls,
    }
    (root / "native-results.json").write_bytes(encoded(report))
    print(json.dumps({key: value for key, value in report.items() if key != "calls"}))


if __name__ == "__main__":
    main()
