"""Single-instance continuous metadata frontier. Default transport is OFFLINE replay."""

import argparse
import json
import os
import signal
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from douyin_frontier import METADATA_FIELDS, AccessRefused, Frontier, encoded, publish


class Replay:
    mode = "replay"

    def __init__(self, frontier, file):
        self.frontier = frontier
        self.frames = json.loads(Path(file).read_text(encoding="utf-8"))["jobs"]

    def submit(self, task):
        frame = self.frames[task["kind"] + ":" + task["target"]]
        job = {
            **{key: frame.get(key) for key in ("id", "type", "status", "error")},
            "idempotencyKey": task["id"],
            "replay_source_job_id": frame["id"],
            "result": {
                "videos": [
                    {key: video.get(key) for key in METADATA_FIELDS}
                    for video in frame.get("result", {}).get("videos", [])
                ]
            },
        }
        with self.frontier.db:
            self.frontier.set("replay_receipt:" + task["id"], job)
        return job

    def recover(self, task):
        return self.frontier.get("replay_receipt:" + task["id"])


class Studio:
    mode = "live"

    def __init__(self, origin):
        url = urllib.parse.urlsplit(origin)
        if (
            url.scheme != "http"
            or url.hostname not in ("localhost", "127.0.0.1", "::1")
            or url.username
            or url.password
            or url.path not in ("", "/")
            or url.query
            or url.fragment
        ):
            raise ValueError("Only a local Studio origin is accepted")
        self.origin = origin.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, route, body=None, key=None):
        headers = {"Content-Type": "application/json", "X-Studio-Client": "1"}
        if key:
            headers["Idempotency-Key"] = key
        request = urllib.request.Request(
            self.origin + "/api/" + route,
            data=encoded(body) if body is not None else None,
            headers=headers,
        )
        try:
            with self.opener.open(request, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404 and route.startswith("receipts/"):
                return None
            if error.code in (401, 403, 412, 429, 461, 471, 567):
                raise AccessRefused("Studio HTTP " + str(error.code)) from error
            raise RuntimeError(
                "Studio HTTP " + str(error.code) + "; preserve original key"
            ) from error

    def submit(self, task):
        # Same real Studio API handles canonical URLs as resolve; no guessed upstream endpoint.
        return self.request(
            "search", {"query": task["target"], "limit": 8, "maxScrolls": 2}, task["id"]
        )

    def recover(self, task):
        return self.request(
            "jobs/" + task["job_id"] if task["job_id"] else "receipts/" + task["id"]
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument(
        "--rounds",
        type=int,
        help="Bounded acceptance rounds; omit to keep consuming/waiting locally",
    )
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument(
        "--live",
        action="store_true",
        help="Explicit future live opt-in; existing access pauses remain authoritative",
    )
    args = parser.parse_args()
    if args.rounds is not None and args.rounds < 1:
        parser.error("--rounds must be positive")
    config = json.loads(args.config.read_text(encoding="utf-8"))
    base = args.config.resolve().parent

    def local(key):
        return (base / config[key]).resolve()

    root = local("output")
    pause = local("pause_file")
    stop = root / "STOP"
    if args.inspect:
        state = json.loads((root / "state.json").read_text(encoding="utf-8"))
        state.update(
            inspected_at=time.time(),
            pause_present=pause.exists(),
            stop_present=stop.exists(),
            lock=json.loads((root / "run.lock").read_text())
            if (root / "run.lock").exists()
            else None,
        )
        print(json.dumps(state, ensure_ascii=False))
        return
    deadline = config.get("deadline")
    if "acceptance_state" in config:
        deadline = json.loads(local("acceptance_state").read_text(encoding="utf-8"))[
            "deadline"
        ]
    if (
        not isinstance(deadline, (float, int))
        or not 1 <= config.get("reader_jobs_per_round", 4) <= 20
    ):
        raise ValueError(
            "An explicit deadline and 1..20 reader jobs per round are required"
        )
    if not 1 <= config.get("intake_batch", 200) <= 1000:
        raise ValueError("intake_batch must be 1..1000")
    mode = config.get("transport", "replay")
    if (
        mode not in ("replay", "live")
        or (mode == "live" and not args.live)
        or (args.live and mode != "live")
    ):
        raise ValueError(
            "Live needs both transport=live and explicit --live; replay cannot become live"
        )
    root.mkdir(parents=True, exist_ok=True)
    if (root / "FAULT").exists():
        raise RuntimeError("Saved code fault requires explicit review before restart")
    # A crash intentionally leaves this lock. No stale-lock guessing or automatic takeover.
    lock = os.open(root / "run.lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(lock, encoded({"pid": os.getpid(), "at": time.time(), "mode": mode}))

    def request_stop(_signal, _frame):
        stop.write_text("operator_stop\n", encoding="utf-8")

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    frontier = None
    try:
        frontier = Frontier(root)
        saved_mode = frontier.get("transport_mode")
        if saved_mode is None:
            previous = frontier.db.execute(
                "SELECT json_extract(record,'$.mode') FROM receipts ORDER BY id LIMIT 1"
            ).fetchone()
            saved_mode = previous[0] if previous else None
        if saved_mode is not None and saved_mode != mode:
            raise ValueError("Replay and live require separate frontier directories")
        with frontier.db:
            frontier.set("transport_mode", mode)
        transport = (
            Replay(frontier, local("replay_file"))
            if mode == "replay"
            else Studio(config["studio_origin"])
        )
        count = 0
        while True:
            intake = {}
            if not stop.exists() and time.time() < deadline:
                intake = frontier.ingest(
                    local("bilibili_database"), config.get("intake_batch", 200)
                )
            receipt = frontier.step(
                transport, pause, stop, deadline, config.get("reader_jobs_per_round", 4)
            )
            receipt["intake"] = intake
            state = {
                "pid": os.getpid(),
                "running": True,
                "mode": mode,
                "deadline": deadline,
                "receipt": receipt,
                "last_round": frontier.db.execute(
                    "SELECT max(id) FROM receipts"
                ).fetchone()[0],
            }
            # Store intake in the same audit receipt used by the coordinator.
            with frontier.db:
                frontier.db.execute(
                    "UPDATE receipts SET record=? WHERE id=?",
                    (encoded(receipt).decode(), state["last_round"]),
                )
            publish(root / "receipts" / f"{state['last_round']:08d}.json", receipt)
            publish(root / "state.json", state)
            print(
                json.dumps(
                    {
                        "round": state["last_round"],
                        "status": receipt["status"],
                        "intake": intake,
                        "submitted_reader_jobs": receipt["submitted_reader_jobs"],
                        "new_unique_details": receipt["new_unique_details"],
                    }
                ),
                flush=True,
            )
            count += 1
            if receipt["status"] in (
                "stopped",
                "deadline_reached",
                "blocked_access",
                "submission_unknown",
            ) or (args.rounds and count >= args.rounds):
                break
            if receipt["status"] in ("idle", "waiting_for_job"):
                for _ in range(max(1, int(config.get("idle_wait_seconds", 5)))):
                    if stop.exists() or pause.exists() or time.time() >= deadline:
                        break
                    time.sleep(1)
        state["running"] = False
        state["pid"] = None
        publish(root / "state.json", state)
    except Exception as error:
        (root / "FAULT").write_bytes(encoded({"at": time.time(), "error": str(error)}))
        publish(
            root / "state.json",
            {
                "pid": None,
                "running": False,
                "status": "code_fault",
                "error": str(error),
            },
        )
        raise
    finally:
        if frontier:
            frontier.db.close()
        os.close(lock)
        (root / "run.lock").unlink()


if __name__ == "__main__":
    main()
