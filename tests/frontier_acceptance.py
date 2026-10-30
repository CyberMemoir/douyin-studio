"""Reproducible, bounded CLI acceptance; all inputs and reader replies are synthetic."""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from test_douyin_frontier import frames, make_source, source_record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir()
    repo = Path(__file__).parents[1]
    source = root / "synthetic-bili.sqlite3"
    make_source(source, [source_record()])
    (root / "replay.json").write_text(
        json.dumps(
            {"material": "synthetic_fixture", "jobs": frames()}, ensure_ascii=False
        ),
        encoding="utf-8",
    )
    config = {
        "output": "run",
        "bilibili_database": "synthetic-bili.sqlite3",
        "pause_file": "synthetic-pause.json",
        "deadline": time.time() + 300,
        "transport": "replay",
        "replay_file": "replay.json",
        "intake_batch": 1,
        "reader_jobs_per_round": 1,
        "idle_wait_seconds": 1,
    }
    config_path = root / "config.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    command = [
        sys.executable,
        "-X",
        "utf8",
        str(repo / "scripts/douyin_discovery.py"),
        "--config",
        str(config_path),
    ]
    calls = []

    def run(rounds, expected=0):
        result = subprocess.run(
            command + ["--rounds", str(rounds)],
            capture_output=True,
            check=False,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            timeout=30,
        )
        calls.append(
            {
                "rounds": rounds,
                "exit": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
        )
        if result.returncode != expected:
            raise AssertionError(result.stderr)

    run(2)
    make_source(source, [source_record("BV2234567890", "乙", "无出处")])
    run(
        4
    )  # New head discovery plus existing history; actual detail lookup is separate.
    db = sqlite3.connect(source)
    db.execute(
        "INSERT INTO observations VALUES(?)",
        (
            json.dumps(
                source_record(desc="原作：更新线索", observed="2026-10-29T01:00:00Z")
            ),
        ),
    )
    db.commit()
    db.close()
    run(2)  # Update watermark, then an exhausted local queue.
    stop = root / "run/STOP"
    stop.write_text("manual_stop", encoding="utf-8")
    run(1)
    run(1)  # Persistent manual stop across separate CLI processes.
    lock = root / "run/run.lock"
    lock.write_text(json.dumps({"pid": os.getpid()}))
    run(1, expected=1)  # A second instance cannot own this frontier.
    lock.unlink()  # This acceptance process created this synthetic lock.
    db = sqlite3.connect(root / "run/frontier.sqlite3")
    dump = "\n".join(db.iterdump())
    assert "token=excluded" not in dump and "private.invalid/media" not in dump
    rows = [
        json.loads(row[0])
        for row in db.execute("SELECT record FROM receipts ORDER BY id")
    ]
    detail_count = db.execute("SELECT count(*) FROM details").fetchone()[0]
    anchor_count = db.execute("SELECT count(*) FROM anchors").fetchone()[0]
    overlap = db.execute(
        "SELECT count(DISTINCT work) FROM role_assertions WHERE derivative=1 AND usage=1"
    ).fetchone()[0]
    db.close()
    assert detail_count == 2 and anchor_count == 2 and overlap == 1
    assert rows[-1]["status"] == rows[-2]["status"] == "stopped"
    assert all(row["real_network_requests"] == 0 for row in rows)
    assert sum(row["unavailable"] for row in rows) == 1
    report = {
        "material": "synthetic_fixture",
        "cli_invocations": len(calls),
        "receipts": len(rows),
        "anchors": anchor_count,
        "unique_details": detail_count,
        "derivative_usage_overlap": overlap,
        "real_network_requests": 0,
        "native_cursor": "unsupported",
        "calls": calls,
    }
    (root / "acceptance-results.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({key: value for key, value in report.items() if key != "calls"}))


if __name__ == "__main__":
    main()
