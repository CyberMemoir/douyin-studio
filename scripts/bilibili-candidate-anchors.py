"""Read-only Bilibili metadata handoff; no network, model, family creation or auto-resume."""
import argparse
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path


def digest(body):
    return hashlib.sha256(body).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")


def candidates(database, limit):
    # Never instantiate the central Store, run migrations, or open its DB read-write.
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    connection.execute("PRAGMA query_only=ON")
    try:
        rows = connection.execute(
            "SELECT bvid,record_json,classification_json FROM explainer_catalog_works "
            "WHERE json_extract(classification_json,'$.explanation.level')='explicit_candidate' "
            "ORDER BY bvid"
        )
        emitted = 0
        for bvid, raw, _classification in rows:
            record = json.loads(raw)
            if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
                raise ValueError("Invalid saved BVID")
            title = next((text for text in record["texts"] if text["kind"] == "title"), None)
            if not title:
                continue
            match = re.match(r"(.{1,80}?)(?:是什么梗|是啥梗|什么梗)", title["text"])
            if not match:
                continue
            term = match[1].strip()
            if not term:
                continue
            start = title["text"].index(term)
            descriptions = [text for text in record["texts"] if text["kind"] in {"desc", "description"}]
            view = {"bvid": bvid, "url": record["url"], "title": title["text"],
                    "descriptions": [text["text"] for text in descriptions],
                    "observed_at": record["observed_at"], "published_at_raw": record.get("published_at_raw"),
                    "provenance": {"basis": "saved_catalog_record_view", "source_evidence_sha": record["evidence_sha"],
                                   "title_locator": title["locator"],
                                   "description_locators": [text["locator"] for text in descriptions]}}
            body = encode(view)
            sha = digest(body)
            proof = {"evidence_sha": sha, "locator": "/title", "span": [start, start + len(term)], "original_text": term}
            anchor_id = "bilibili-candidate:" + bvid
            plans = [{"reader": "search", "query": term, "purpose": purpose, "evidence_refs": [proof]}
                     for purpose in ("derivative", "usage")]
            for index, text in enumerate(view["descriptions"]):
                for link in re.finditer(r"https://www\.douyin\.com/video/[0-9]{8,30}(?![0-9])", text):
                    ref = {"evidence_sha": sha, "locator": f"/descriptions/{index}",
                           "span": list(link.span()), "original_text": link[0]}
                    plans.append({"reader": "resolve", "url": link[0], "purpose": "source",
                                  "claim_status": "explicit_link_unverified_role", "evidence_refs": [ref]})
            anchor = {"candidate_anchor_id": anchor_id, "bvid": bvid, "family_id": None,
                      "submission_authorized": False,
                      "family_assignment": "unassigned", "label_candidate": term,
                      "relation_status": "candidate", "evidence_refs": [proof], "plans": plans,
                      "source_status": "explicit_link_candidate" if len(plans) > 2 else "missing_douyin_source_hint"}
            yield anchor, sha, body
            emitted += 1
            if emitted >= limit:
                break
    finally:
        connection.close()


def inspect(output, pause_file, acceptance_state):
    saved = json.loads((output / "state.json").read_text(encoding="utf-8"))
    acceptance = json.loads(acceptance_state.read_text(encoding="utf-8"))
    deadline = acceptance["deadline"]
    pause_body = pause_file.read_bytes() if pause_file.exists() else None
    saved.update(checked_at=time.time(), deadline=deadline, pause_present=pause_body is not None,
                 current_pause_sha256=digest(pause_body) if pause_body is not None else None,
                 current_pause=json.loads(pause_body) if pause_body is not None else None)
    saved["status"] = ("deadline_reached" if time.time() >= deadline else
                       "blocked_access" if pause_file.exists() else "stopped_requires_explicit_start")
    # Read-only inspection cannot start collection, clear a pause or rewrite saved run state.
    return saved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--pause-file", required=True, type=Path)
    parser.add_argument("--acceptance-state", required=True, type=Path)
    parser.add_argument("--studio-state", type=Path)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    if args.inspect:
        print(json.dumps(inspect(args.output, args.pause_file, args.acceptance_state), ensure_ascii=False))
        return
    if args.database is None or not 1 <= args.limit <= 100:
        parser.error("--database and --limit 1..100 required")
    acceptance = json.loads(args.acceptance_state.read_text(encoding="utf-8"))
    pause_body = args.pause_file.read_bytes() if args.pause_file.exists() else None
    records = list(candidates(args.database, args.limit))
    args.output.mkdir()  # Refuse overwrite/reinitialization of another run.
    (args.output / "objects").mkdir()
    db = sqlite3.connect(args.output / "candidate-anchors.sqlite3")
    try:
        db.execute("CREATE TABLE candidates (id TEXT PRIMARY KEY,bvid TEXT NOT NULL,record_json TEXT NOT NULL)")
        for anchor, sha, body in records:
            (args.output / "objects" / (sha + ".bin")).write_bytes(body)
            db.execute("INSERT INTO candidates VALUES(?,?,?)", (anchor["candidate_anchor_id"], anchor["bvid"], encode(anchor).decode()))
        db.commit()
    finally:
        db.close()
    (args.output / "candidate-anchors.jsonl").write_bytes(b"".join(encode(row[0]) + b"\n" for row in records))
    login = None
    if args.studio_state:
        login = json.loads(args.studio_state.read_text(encoding="utf-8")).get("connection")
    state = {"schema": "douyin-candidate-metadata-trial-v1", "created_at": time.time(),
             "deadline": acceptance["deadline"], "status": "deadline_reached" if time.time() >= acceptance["deadline"] else "blocked_access" if pause_body is not None else "stopped_requires_explicit_start",
             "pause_file": str(args.pause_file.resolve()), "pause_sha256": digest(pause_body) if pause_body is not None else None,
             "pause": json.loads(pause_body) if pause_body is not None else None,
             "login": {"basis": "saved_state_only", "value": login, "currently_verified": False},
             "pid": None, "runner_started": False, "auto_resume": False,
             "candidates": len(records), "prepared_plans": sum(len(row[0]["plans"]) for row in records),
             "real_platform_requests": 0, "new_platform_items": 0, "downloads": 0,
             "cursor": {"last_bvid": records[-1][0]["bvid"] if records else None,
                        "basis": "offline_snapshot_only", "native_cursor": None},
             "candidate_database": str((args.output / "candidate-anchors.sqlite3").resolve()),
             "central_import_authorized": False, "family_actions_created": 0}
    (args.output / "state.json").write_bytes(encode(state))
    (args.output / "checks.jsonl").write_bytes(encode({"at": time.time(), "status": state["status"], "requests": 0}) + b"\n")
    print(json.dumps(state, ensure_ascii=False))


if __name__ == "__main__":
    main()
