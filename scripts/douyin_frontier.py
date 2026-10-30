"""Durable, metadata-only Douyin candidate frontier. No family ledger writes."""

import hashlib
import html
import json
import os
import re
import sqlite3
import time
from pathlib import Path

METADATA_FIELDS = (
    "id",
    "url",
    "title",
    "authorId",
    "createdAt",
    "likes",
    "comments",
    "searchContext",
    "detailContext",
)


class AccessRefused(RuntimeError):
    pass


def encoded(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()


def identity(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def publish(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(encoded(value))
    os.replace(temporary, path)


def canonical(value):
    match = re.fullmatch(r"https://www\.douyin\.com/video/([0-9]{8,30})", value)
    if not match:
        raise ValueError("Canonical Douyin work identity required")
    return match[1]


def anchor(record, classification):
    if classification.get("explanation", {}).get("level") != "explicit_candidate":
        return None
    bvid = record["item_id"]
    if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
        raise ValueError("Invalid BVID")
    texts = {row["kind"]: row["text"] for row in record["texts"]}
    original = texts.get("title", "")
    cleaned = html.unescape(
        re.sub(r"</?em(?:\s[^>]*)?>", "", original, flags=re.IGNORECASE)
    )
    cleaned = re.sub(r"^【(?:梗指南|梗百科|梗科普)】\s*", "", cleaned)
    match = re.match(r"(.{1,80}?)(?:是什么梗|是啥梗|什么梗)", cleaned)
    if not match or not match[1].strip():
        return None
    view = {
        "bvid": bvid,
        "texts": texts,
        "observed_at": record["observed_at"],
        "published_at_raw": record.get("published_at_raw"),
        "provenance": {
            "basis": "saved_record_view",
            "evidence_sha": record["evidence_sha"],
            "locators": {row["kind"]: row["locator"] for row in record["texts"]},
        },
    }
    sha = identity(view)
    proof = {
        "evidence_sha": sha,
        "locator": "/texts/title",
        "span": [0, len(original)],
        "original_text": original,
    }
    plans = [
        {"kind": "search", "target": match[1].strip(), "purpose": role, "proof": proof}
        for role in ("derivative", "usage")
    ]
    for kind in ("desc", "description"):
        text = texts.get(kind, "")
        for link in re.finditer(
            r"https://www\.douyin\.com/video/[0-9]{8,30}(?![0-9])", text
        ):
            plans.append(
                {
                    "kind": "resolve",
                    "target": link[0],
                    "purpose": "source",
                    "proof": {
                        "evidence_sha": sha,
                        "locator": "/texts/" + kind,
                        "span": list(link.span()),
                        "original_text": link[0],
                    },
                }
            )
        for named in re.finditer(
            r"(?:原作|原曲|原视频|出处|来源)[：:]\s*([^\n]{1,100})", text
        ):
            query = named[1].strip()
            if re.search(r"https?://|BV[0-9A-Za-z]{10}", query):
                continue  # Other-platform references remain evidence, not invented Douyin targets.
            plans.append(
                {
                    "kind": "search",
                    "target": html.unescape(query),
                    "purpose": "source",
                    "proof": {
                        "evidence_sha": sha,
                        "locator": "/texts/" + kind,
                        "span": list(named.span(1)),
                        "original_text": named[1],
                    },
                }
            )
    return {
        "id": "bilibili-candidate:" + bvid,
        "bvid": bvid,
        "family_id": None,
        "label": match[1].strip(),
        "proof": proof,
        "plans": plans,
        "transform_rules": [
            "strip_em_highlight",
            "html_unescape",
            "strip_known_explainer_prefix",
            "literal_title_subject",
        ],
        "view": view,
        "evidence_sha": sha,
    }


class Frontier:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "objects").mkdir(exist_ok=True)
        (self.root / "receipts").mkdir(exist_ok=True)
        self.db = sqlite3.connect(self.root / "frontier.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS anchors(id TEXT PRIMARY KEY,revision TEXT NOT NULL,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS anchor_versions(id TEXT,revision TEXT,record TEXT,PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,kind TEXT,target TEXT,lane TEXT,status TEXT,
          job_id TEXT,result TEXT,reason TEXT,created REAL);
        CREATE TABLE IF NOT EXISTS paths(anchor TEXT,task TEXT,purpose TEXT,proof TEXT,parent TEXT,
          PRIMARY KEY(anchor,task,purpose,proof,parent));
        CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS details(id TEXT PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS work_paths(work TEXT,anchor TEXT,purpose TEXT,via_task TEXT,proof TEXT,parent TEXT,
          PRIMARY KEY(work,anchor,purpose,via_task,proof,parent));
        CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY,record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS role_assertions(id TEXT PRIMARY KEY,work TEXT,anchor TEXT,
          source INTEGER,derivative INTEGER,usage INTEGER,unknown INTEGER,record TEXT);
        """)

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        self.db.execute(
            "INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value))
        )

    def object(self, value):
        sha = identity(value)
        target = self.root / "objects" / (sha + ".bin")
        if not target.exists():
            publish(target, value)
        return sha

    def task(self, kind, target, lane):
        key = identity([kind, target])
        self.db.execute(
            "INSERT OR IGNORE INTO tasks VALUES(?,?,?,?, 'pending',NULL,NULL,NULL,?)",
            (key, kind, target, lane, time.time()),
        )
        return key

    def bind(self, anchor_id, task_id, purpose, proof, parent):
        inserted = self.db.execute(
            "INSERT OR IGNORE INTO paths VALUES(?,?,?,?,?)",
            (anchor_id, task_id, purpose, proof, parent),
        ).rowcount
        done = self.db.execute(
            "SELECT result,kind FROM tasks WHERE id=? AND status='completed'",
            (task_id,),
        ).fetchone()
        if inserted and done:
            for video in json.loads(done["result"]):
                self.link(video, task_id)
                if done["kind"] == "resolve":
                    self.expand(video, task_id)

    def add_anchor(self, value, lane="head"):
        revision = identity(value)
        previous = self.db.execute(
            "SELECT 1 FROM anchor_versions WHERE id=? AND revision=?",
            (value["id"], revision),
        ).fetchone()
        if previous:
            return 0
        self.object(value["view"])
        self.db.execute(
            "INSERT OR REPLACE INTO anchors VALUES(?,?,?)",
            (value["id"], revision, encoded(value).decode()),
        )
        self.db.execute(
            "INSERT INTO anchor_versions VALUES(?,?,?)",
            (value["id"], revision, encoded(value).decode()),
        )
        for plan in value["plans"]:
            key = self.task(plan["kind"], plan["target"], lane)
            self.bind(
                value["id"],
                key,
                plan["purpose"],
                encoded(plan["proof"]).decode(),
                "bilibili_explicit_metadata",
            )
        return 1

    def ingest(self, source, batch=200):
        source = Path(source)
        db = sqlite3.connect(
            source.resolve().as_uri() + "?mode=ro", uri=True, timeout=5
        )
        db.execute("PRAGMA query_only=ON")
        changed = scanned = 0
        old_count = self.db.execute("SELECT count(*) FROM anchors").fetchone()[0]
        try:
            db.execute("BEGIN")
            if self.get("catalog_bootstrap_end") is None:
                with self.db:
                    self.set(
                        "catalog_bootstrap_end",
                        db.execute(
                            "SELECT coalesce(max(rowid),0) FROM explainer_catalog_works"
                        ).fetchone()[0],
                    )
                    self.set(
                        "observation_bootstrap_end",
                        db.execute(
                            "SELECT coalesce(max(rowid),0) FROM observations"
                        ).fetchone()[0],
                    )
            # Bootstrap catalog by stable SQLite rowid; subsequent observations are the update stream.
            catalog = db.execute(
                "SELECT rowid,record_json,classification_json FROM explainer_catalog_works "
                "WHERE rowid>? ORDER BY rowid LIMIT ?",
                (self.get("catalog_highwater", 0), batch),
            ).fetchall()
            observations = db.execute(
                "SELECT rowid,record_json FROM observations WHERE rowid>? ORDER BY rowid LIMIT ?",
                (self.get("observation_highwater", 0), batch),
            ).fetchall()
            with self.db:
                for rowid, raw, classification in catalog:
                    record = json.loads(raw)
                    value = anchor(record, json.loads(classification or "{}"))
                    changed += (
                        self.add_anchor(
                            value,
                            "history"
                            if rowid <= self.get("catalog_bootstrap_end")
                            else "head",
                        )
                        if value
                        else 0
                    )
                    scanned += 1
                    self.set("catalog_highwater", rowid)
                for rowid, raw in observations:
                    record = json.loads(raw)
                    if (
                        record.get("platform") == "bilibili"
                        and record.get("kind") == "video"
                    ):
                        entry = db.execute(
                            "SELECT classification_json FROM explainer_catalog_works WHERE bvid=?",
                            (record["item_id"],),
                        ).fetchone()
                        value = (
                            anchor(record, json.loads(entry[0] or "{}"))
                            if entry
                            else None
                        )
                        changed += (
                            self.add_anchor(
                                value,
                                "history"
                                if rowid <= self.get("observation_bootstrap_end")
                                else "head",
                            )
                            if value
                            else 0
                        )
                    scanned += 1
                    self.set("observation_highwater", rowid)
        finally:
            db.close()
        new_count = (
            self.db.execute("SELECT count(*) FROM anchors").fetchone()[0] - old_count
        )
        return {
            "anchor_revisions": changed,
            "new_anchors": new_count,
            "updated_anchors": changed - new_count,
            "bilibili_rows_scanned": scanned,
            "catalog_highwater": self.get("catalog_highwater", 0),
            "observation_highwater": self.get("observation_highwater", 0),
        }

    def link(self, video, task_id):
        for path in self.db.execute(
            "SELECT * FROM paths WHERE task=?", (task_id,)
        ).fetchall():
            self.db.execute(
                "INSERT OR IGNORE INTO work_paths VALUES(?,?,?,?,?,?)",
                (
                    video["id"],
                    path["anchor"],
                    path["purpose"],
                    task_id,
                    path["proof"],
                    path["parent"],
                ),
            )
            detail = self.task("resolve", video["url"], "history")
            if detail != task_id:
                self.bind(
                    path["anchor"], detail, path["purpose"], path["proof"], task_id
                )
        saved = self.db.execute(
            "SELECT record FROM details WHERE id=?", (video["id"],)
        ).fetchone()
        if saved:
            self.refresh_roles(json.loads(saved[0]))

    def expand(self, video, task_id):
        # Only explicit canonical references in the actual detail text can extend this reader.
        for link in re.finditer(
            r"https://www\.douyin\.com/video/[0-9]{8,30}(?![0-9])", video["title"] or ""
        ):
            if link[0] == video["url"]:
                continue
            key = self.task("resolve", link[0], "history")
            sha = self.object(video)
            proof = encoded(
                {
                    "evidence_sha": sha,
                    "locator": "/title",
                    "span": list(link.span()),
                    "original_text": link[0],
                }
            ).decode()
            for path in self.db.execute(
                "SELECT * FROM paths WHERE task=?", (task_id,)
            ).fetchall():
                self.bind(path["anchor"], key, "source", proof, video["id"])

    def choose(self):
        inflight = self.db.execute(
            "SELECT * FROM tasks WHERE status IN ('inflight','submission_unknown') ORDER BY created,id LIMIT 1"
        ).fetchone()
        if inflight:
            return dict(
                inflight
            )  # Poll/recover the sole outstanding task before another submission.
        lane = self.get("next_lane", "head")
        for current in (lane, "history" if lane == "head" else "head"):
            row = self.db.execute(
                "SELECT * FROM tasks WHERE lane=? AND status IN ('pending','inflight','submission_unknown') "
                "ORDER BY CASE kind WHEN 'resolve' THEN 0 ELSE 1 END,created,id LIMIT 1",
                (current,),
            ).fetchone()
            if row:
                self.set("next_lane", "history" if current == "head" else "head")
                return dict(row)
        return None

    def metadata(self, video, detail=False, target=None):
        if canonical(video["url"]) != video["id"]:
            raise ValueError("Work ID/URL mismatch")
        context = video.get("detailContext" if detail else "searchContext")
        if not context or not context.get("observedAt"):
            raise ValueError("Missing actual reader observation context")
        if detail and (
            context.get("resolvedUrl") != video["url"]
            or target != video["url"]
            or context.get("requestedUrl") != target
        ):
            raise ValueError("Detail requested/resolved identity mismatch")
        if not detail and context.get("requestedQuery") != target:
            raise ValueError("Search query evidence mismatch")
        return {key: video.get(key) for key in METADATA_FIELDS}

    def apply(self, task, job, stats):
        if job["status"] != "completed":
            error = job.get("error") or ""
            blocked = bool(
                re.search(
                    r"人工验证|暂时限制|访问限制|HTTP (401|403|412|429|461|471|567)|AccessBlocked|扫码|重新登录",
                    error,
                )
            )
            unavailable = not blocked and bool(
                re.search(r"作品不存在|已删除|不可用|私密", error)
            )
            state = (
                "blocked"
                if blocked
                else "unavailable"
                if unavailable
                else "cancelled"
                if job["status"] == "cancelled"
                else "failed"
            )
            self.db.execute(
                "UPDATE tasks SET status=?,reason=? WHERE id=?",
                (state, error or job["status"], task["id"]),
            )
            if blocked:
                self.set(
                    "access_pause",
                    {"reason": error, "task": task["id"], "at": time.time()},
                )
            stats[
                "blocked" if blocked else "unavailable" if unavailable else "failed"
            ] += 1
            return
        detail = task["kind"] == "resolve"
        if job["type"] != ("resolve" if detail else "search"):
            raise ValueError("Reader job kind mismatch")
        videos = job.get("result", {}).get("videos", [])
        if detail and len(videos) != 1:
            raise ValueError("A detail request must return exactly its work")
        clean = [self.metadata(video, detail, task["target"]) for video in videos]
        for video in clean:
            table = "details" if detail else "cards"
            exists = self.db.execute(
                "SELECT 1 FROM " + table + " WHERE id=?", (video["id"],)
            ).fetchone()
            self.db.execute(
                "INSERT OR REPLACE INTO " + table + " VALUES(?,?)",
                (video["id"], encoded(video).decode()),
            )
            stats["new_unique_details" if detail else "new_unique_cards"] += int(
                exists is None
            )
            stats["duplicate_details" if detail else "duplicate_cards"] += int(
                exists is not None
            )
            self.link(video, task["id"])
            if detail:
                self.expand(video, task["id"])
        stats["detail_results" if detail else "search_cards"] += len(clean)
        stats["no_match"] += int(not clean)
        self.db.execute(
            "UPDATE tasks SET status='completed',result=?,reason=? WHERE id=?",
            (
                encoded(clean).decode(),
                "detail_verified"
                if detail
                else "bounded_ui_batch_native_cursor_unsupported",
                task["id"],
            ),
        )

    def refresh_roles(self, video):
        for row in self.db.execute(
            "SELECT w.*,json_extract(a.record,'$.family_id') AS family_id FROM work_paths w JOIN anchors a ON a.id=w.anchor WHERE work=?",
            (video["id"],),
        ).fetchall():
            title = video["title"] or ""
            action = re.search(r"二创|改编|翻唱|填词|配音|混剪|剪辑", title)
            target = re.search(
                r"https://www\.douyin\.com/video/[0-9]{8,30}(?![0-9])", title
            )
            usage = re.search(r"模板|用.{1,30}表达|当.{1,30}时", title)
            roles = []
            proof = json.loads(row["proof"])
            if row["purpose"] == "source" and proof["original_text"] == video["url"]:
                roles.append("source_reference_candidates")
            if action and target and target[0] != video["url"]:
                roles.append("derivative_candidates")
            if usage:
                roles.append("usage_candidates")
            if not roles:
                roles.append("unknown")
            evidence = {
                "work": row["work"],
                "anchor": row["anchor"],
                "family_id": row["family_id"],
                "roles": roles,
                "role_status": "unverified_candidates",
                "requested_purpose": row["purpose"],
                "path_proof": proof,
                "detail": video,
                "action_span": list(action.span()) if action else None,
                "target_span": list(target.span()) if target else None,
                "usage_span": list(usage.span()) if usage else None,
            }
            key = identity(
                {
                    key: row[key]
                    for key in (
                        "work",
                        "anchor",
                        "purpose",
                        "via_task",
                        "proof",
                        "parent",
                    )
                }
            )
            self.db.execute(
                "INSERT OR REPLACE INTO role_assertions VALUES(?,?,?,?,?,?,?,?)",
                (
                    key,
                    row["work"],
                    row["anchor"],
                    int("source_reference_candidates" in roles),
                    int("derivative_candidates" in roles),
                    int("usage_candidates" in roles),
                    int("unknown" in roles),
                    encoded(evidence).decode(),
                ),
            )

    def roles(self, include_evidence=True):
        columns = {
            "source_reference_candidates": "source",
            "derivative_candidates": "derivative",
            "usage_candidates": "usage",
            "unknown": "unknown",
        }
        counts, unique = {}, {}
        for role, column in columns.items():
            counts[role], unique[role] = self.db.execute(
                "SELECT coalesce(sum("
                + column
                + "),0),count(DISTINCT CASE WHEN "
                + column
                + "=1 THEN work END) FROM role_assertions"
            ).fetchone()
        overlap = self.db.execute(
            "SELECT count(DISTINCT work) FROM role_assertions WHERE derivative=1 AND usage=1"
        ).fetchone()[0]
        result = {
            "path_counts": counts,
            "unique_work_counts": unique,
            "derivative_usage_overlap": overlap,
            "evidence_store": "frontier.sqlite3#role_assertions",
        }
        if include_evidence:
            result["evidence"] = [
                json.loads(row[0])
                for row in self.db.execute("SELECT record FROM role_assertions")
            ]
        return result

    def step(self, transport, pause_file, stop_file, deadline, budget=4):
        stats = {
            key: 0
            for key in (
                "submitted_reader_jobs",
                "recovered_jobs",
                "search_cards",
                "detail_results",
                "new_unique_cards",
                "new_unique_details",
                "duplicate_cards",
                "duplicate_details",
                "no_match",
                "blocked",
                "unavailable",
                "failed",
            )
        }
        status = "budget"
        for _ in range(budget):
            if Path(stop_file).exists():
                status = "stopped"
                break
            if time.time() >= deadline:
                status = "deadline_reached"
                break
            if Path(pause_file).exists() or self.get("access_pause"):
                status = "blocked_access"
                break
            with self.db:
                task = self.choose()
            if not task:
                status = "idle"
                break
            try:
                if task["status"] in ("inflight", "submission_unknown"):
                    job = transport.recover(task)
                    if job is None:
                        status = "submission_unknown"
                        break  # Never resubmit an ambiguous inflight key.
                    stats["recovered_jobs"] += 1
                else:
                    with self.db:
                        self.db.execute(
                            "UPDATE tasks SET status='inflight' WHERE id=?",
                            (task["id"],),
                        )
                    if Path(stop_file).exists() or Path(pause_file).exists():
                        with self.db:
                            self.db.execute(
                                "UPDATE tasks SET status='pending' WHERE id=?",
                                (task["id"],),
                            )
                        status = (
                            "stopped" if Path(stop_file).exists() else "blocked_access"
                        )
                        break
                    stats["submitted_reader_jobs"] += 1
                    job = transport.submit(task)
                if job.get("idempotencyKey") != task["id"]:
                    raise ValueError("Keyed Studio receipt mismatch")
                with self.db:
                    self.db.execute(
                        "UPDATE tasks SET job_id=? WHERE id=?", (job["id"], task["id"])
                    )
                if job["status"] not in ("completed", "failed", "cancelled"):
                    status = "waiting_for_job"
                    break
                with self.db:
                    self.apply(task, job, stats)
                if job["status"] == "cancelled":
                    Path(stop_file).write_text(
                        "upstream_job_cancelled\n", encoding="utf-8"
                    )
                    status = "stopped"
                    break
                if self.get("access_pause"):
                    status = "blocked_access"
                    break
            except (
                OSError,
                RuntimeError,
                ValueError,
                KeyError,
                sqlite3.Error,
            ) as error:
                with self.db:
                    access = isinstance(error, AccessRefused)
                    self.db.execute(
                        "UPDATE tasks SET status=?,reason=? WHERE id=?",
                        (
                            "blocked" if access else "submission_unknown",
                            str(error),
                            task["id"],
                        ),
                    )
                    if access:
                        self.set(
                            "access_pause",
                            {
                                "reason": str(error),
                                "task": task["id"],
                                "at": time.time(),
                            },
                        )
                        stats["blocked"] += 1
                status = "blocked_access" if access else "submission_unknown"
                break
        with self.db:
            stagnant = (
                self.get("rounds_without_new_details", 0) + 1
                if not stats["new_unique_details"]
                else 0
            )
            self.set("rounds_without_new_details", stagnant)
            record = {
                "at": time.time(),
                "status": status,
                **stats,
                "mode": transport.mode,
                "real_network_requests": 0 if transport.mode == "replay" else None,
                "reader_job_budget": budget,
                "native_cursor": None,
                "native_search_cursor": "unsupported",
                "related_reader": "unsupported",
                "rounds_without_new_details": stagnant,
                "entry_exhaustion": "native_unknown_bounded_ui_only",
                "frontier": dict(
                    self.db.execute(
                        "SELECT status,count(*) FROM tasks GROUP BY status"
                    ).fetchall()
                ),
                "roles": self.roles(False),
            }
            if Path(pause_file).exists():
                pause_body = Path(pause_file).read_bytes()
                record["access_pause"] = {
                    "basis": "existing_studio_pause",
                    "sha256": hashlib.sha256(pause_body).hexdigest(),
                    "record": json.loads(pause_body),
                }
            elif self.get("access_pause"):
                record["access_pause"] = self.get("access_pause")
            self.db.execute(
                "INSERT INTO receipts(record) VALUES(?)", (encoded(record).decode(),)
            )
            receipt_id = self.db.execute("SELECT last_insert_rowid()").fetchone()[0]
        publish(self.root / "receipts" / f"{receipt_id:08d}.json", record)
        return record
