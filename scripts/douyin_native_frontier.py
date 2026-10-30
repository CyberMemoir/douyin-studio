"""Native page bookkeeping. Public-client contracts, not a live acceptance claim."""

import json
import re


class NativePages:
    def setup_native(self):
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS native_streams(id TEXT PRIMARY KEY,kind TEXT,target TEXT,status TEXT,pages INTEGER,next_input TEXT,reason TEXT);
        CREATE TABLE IF NOT EXISTS native_inputs(task TEXT PRIMARY KEY,stream TEXT,request TEXT);
        CREATE TABLE IF NOT EXISTS native_pages(task TEXT PRIMARY KEY,stream TEXT,fingerprint TEXT,record TEXT);
        CREATE TABLE IF NOT EXISTS native_seen(stream TEXT,work TEXT,PRIMARY KEY(stream,work));
        CREATE TABLE IF NOT EXISTS recommendation_edges(parent TEXT,child TEXT,page_sha TEXT,PRIMARY KEY(parent,child,page_sha));
        CREATE TABLE IF NOT EXISTS native_depth(work TEXT PRIMARY KEY,depth INTEGER);
        """)

    def native_open(self, kind, target, lane, scope=None):
        stream = self.object({"kind": kind, "target": target, "scope": scope})
        request = (
            {"kind": kind, "query": target, "cursor": 0, "searchId": "", "count": 8}
            if kind == "search_page"
            else {
                "kind": kind,
                "videoId": target.rsplit("/", 1)[1],
                "excludedIds": [],
                "count": 8,
            }
        )
        self.db.execute(
            "INSERT OR IGNORE INTO native_streams VALUES(?,?,?,'pending',0,NULL,NULL)",
            (stream, kind, target),
        )
        return self.native_enqueue(stream, request, lane)

    def native_enqueue(self, stream, request, lane="history"):
        row = self.db.execute(
            "SELECT kind,target FROM native_streams WHERE id=?", (stream,)
        ).fetchone()
        task = self.task(
            row["kind"], row["target"], lane, {"stream": stream, "request": request}
        )
        self.db.execute(
            "INSERT OR IGNORE INTO native_inputs VALUES(?,?,?)",
            (task, stream, json.dumps(request, sort_keys=True)),
        )
        return task

    def native_input(self, task):
        row = self.db.execute(
            "SELECT request FROM native_inputs WHERE task=?", (task["id"],)
        ).fetchone()
        if row:
            task["native_input"] = json.loads(row[0])
        return task

    def native_rebind(self, task_id, anchor_id, purpose, proof, parent):
        stream = self.db.execute(
            "SELECT stream FROM native_inputs WHERE task=?", (task_id,)
        ).fetchone()[0]
        path = {
            "anchor": anchor_id,
            "purpose": purpose,
            "proof": proof,
            "parent": parent,
        }
        for row in self.db.execute(
            "SELECT i.task,t.result,p.record FROM native_inputs i JOIN tasks t ON t.id=i.task LEFT JOIN native_pages p ON p.task=i.task WHERE i.stream=?",
            (stream,),
        ).fetchall():
            self.db.execute(
                "INSERT OR IGNORE INTO paths VALUES(?,?,?,?,?)",
                (anchor_id, row["task"], purpose, proof, parent),
            )
            if row["record"] is not None:
                self.native_rows(
                    row["task"],
                    json.loads(row["record"]),
                    json.loads(row["result"]),
                    [path],
                )

    def native_rows(self, task_id, page, videos, paths=None):
        paths = (
            paths
            if paths is not None
            else self.db.execute(
                "SELECT * FROM paths WHERE task=?", (task_id,)
            ).fetchall()
        )
        sha = self.object(page)
        related = page["request"]["kind"] == "related"
        parent_id = page["request"].get("videoId")
        parent_depth = (
            self.db.execute(
                "SELECT depth FROM native_depth WHERE work=?", (parent_id,)
            ).fetchone()
            if related
            else None
        )
        depth = (parent_depth[0] if parent_depth else 0) + 1 if related else 0
        for index, video in enumerate(videos):
            self.db.execute(
                "INSERT INTO native_depth VALUES(?,?) ON CONFLICT(work) DO UPDATE SET depth=min(depth,excluded.depth)",
                (video["id"], depth),
            )
            proof = json.dumps(
                {
                    "evidence_sha": sha,
                    "locator": f"/ids/{index}",
                    "span": [0, len(video["id"])],
                    "original_text": video["id"],
                    "discovery_relation": "recommended_after"
                    if related
                    else "search_card",
                },
                sort_keys=True,
            )
            if related:
                self.db.execute(
                    "INSERT OR IGNORE INTO recommendation_edges VALUES(?,?,?)",
                    (parent_id, video["id"], sha),
                )
            for path in paths:
                parent = "recommended_after:" + parent_id if related else task_id
                self.db.execute(
                    "INSERT OR IGNORE INTO work_paths VALUES(?,?,?,?,?,?)",
                    (
                        video["id"],
                        path["anchor"],
                        path["purpose"],
                        task_id,
                        proof,
                        parent,
                    ),
                )
                detail = self.task("resolve", video["url"], "history")
                self.bind(path["anchor"], detail, path["purpose"], proof, parent)

    def native_after_detail(self, video, task_id):
        depth = self.db.execute(
            "SELECT depth FROM native_depth WHERE work=?", (video["id"],)
        ).fetchone()
        if (depth[0] if depth else 0) >= self.related_depth:
            return
        root = self.native_open("related", video["url"], "history")
        for path in self.db.execute(
            "SELECT * FROM paths WHERE task=?", (task_id,)
        ).fetchall():
            self.bind(
                path["anchor"],
                root,
                path["purpose"],
                path["proof"],
                "native_parent:" + video["id"],
            )

    def native_apply(self, task, job, stats):
        if job["type"] != task["kind"]:
            raise ValueError("Native job kind mismatch")
        page = job.get("result", {}).get("nativePage")
        request = task["native_input"]
        if (
            not page
            or page.get("request") != request
            or not re.fullmatch(r"[a-f0-9]{64}", page.get("bodySha256", ""))
        ):
            raise ValueError("Native page request/hash binding mismatch")
        expected_path = "https://www.douyin.com" + (
            "/aweme/v1/web/general/search/single/"
            if task["kind"] == "search_page"
            else "/aweme/v1/web/aweme/related/"
        )
        if page.get("responsePath") != expected_path:
            raise ValueError("Native response path mismatch")
        videos = job.get("result", {}).get("videos", [])
        clean = []
        for video in videos:
            if task["kind"] == "related":
                context = video.get("relatedContext", {})
                if (
                    context.get("parentVideoId") != request["videoId"]
                    or context.get("bodySha256") != page["bodySha256"]
                    or context.get("responsePath") != expected_path
                    or context.get("observedAt") != page.get("observedAt")
                ):
                    raise ValueError("Related parent/response observation mismatch")
                if video["url"] != "https://www.douyin.com/video/" + video[
                    "id"
                ] or not re.fullmatch(r"[0-9]{8,30}", video["id"]):
                    raise ValueError("Related card identity mismatch")
                item = {
                    key: video.get(key)
                    for key in (
                        "id",
                        "url",
                        "title",
                        "authorId",
                        "createdAt",
                        "likes",
                        "comments",
                        "relatedContext",
                    )
                }
            else:
                item = self.metadata(video, False, task["target"])
                if item["searchContext"]["observedAt"] != page.get("observedAt"):
                    raise ValueError("Search page observation mismatch")
            clean.append(item)
        ids = [row["id"] for row in clean]
        if page.get("ids") != ids or len(ids) != len(set(ids)):
            raise ValueError("Native IDs/card binding mismatch")
        for item in clean:
            known = self.db.execute(
                "SELECT 1 FROM cards WHERE id=?", (item["id"],)
            ).fetchone()
            self.db.execute(
                "INSERT OR REPLACE INTO cards VALUES(?,?)",
                (item["id"], json.dumps(item)),
            )
            stats["duplicate_cards" if known else "new_unique_cards"] += 1
        stats["search_cards" if task["kind"] == "search_page" else "related_cards"] += (
            len(clean)
        )
        stats["no_match"] += int(not clean)
        stream_id = self.db.execute(
            "SELECT stream FROM native_inputs WHERE task=?", (task["id"],)
        ).fetchone()[0]
        stream = self.db.execute(
            "SELECT * FROM native_streams WHERE id=?", (stream_id,)
        ).fetchone()
        fingerprint = self.object({"ids": sorted(ids)})
        repeated = self.db.execute(
            "SELECT 1 FROM native_pages WHERE stream=? AND fingerprint=?",
            (stream_id, fingerprint),
        ).fetchone()
        fresh = [
            item
            for item in ids
            if not self.db.execute(
                "SELECT 1 FROM native_seen WHERE stream=? AND work=?", (stream_id, item)
            ).fetchone()
        ]
        self.db.execute(
            "INSERT INTO native_pages VALUES(?,?,?,?)",
            (task["id"], stream_id, fingerprint, json.dumps(page)),
        )
        for item in ids:
            self.db.execute(
                "INSERT OR IGNORE INTO native_seen VALUES(?,?)", (stream_id, item)
            )
        self.native_rows(task["id"], page, clean)
        self.db.execute(
            "UPDATE tasks SET status='completed',result=?,reason='native_page_saved' WHERE id=?",
            (json.dumps(clean), task["id"]),
        )
        reason, next_input = None, None
        has_more = page.get("hasMore")
        if has_more is not True and has_more is not False:
            reason = "missing_has_more_contract"
        elif page.get("unparsedRows"):
            reason = "unparsed_native_rows"
        elif repeated:
            reason = "repeated_page"
        elif not has_more:
            reason = "entry_exhausted"
        elif not fresh:
            reason = "no_new_ids"
        elif task["kind"] == "search_page":
            cursor = page.get("cursor")
            if type(cursor) is not int:
                reason = "missing_search_cursor_contract"
            elif cursor <= request["cursor"]:
                reason = "cursor_not_advanced"
            elif not isinstance(page.get("searchId"), str) or not page["searchId"]:
                reason = "missing_search_id_contract"
            elif len(page["searchId"]) > 200:
                reason = "search_id_input_budget"
            else:
                next_input = {**request, "cursor": cursor, "searchId": page["searchId"]}
        else:
            excluded = [
                row[0]
                for row in self.db.execute(
                    "SELECT work FROM native_seen WHERE stream=? ORDER BY work",
                    (stream_id,),
                )
            ]
            next_input = {
                **request,
                "excludedIds": sorted(
                    {request["videoId"], *request["excludedIds"], *excluded}
                ),
            }
            if len(next_input["excludedIds"]) > 1000:
                reason = "filter_ids_input_budget"
        pages = stream["pages"] + 1
        if next_input and not reason and pages >= self.page_budget:
            reason = "page_budget"
        state = (
            "exhausted"
            if reason == "entry_exhausted"
            else "stopped"
            if reason
            else "pending"
        )
        self.db.execute(
            "UPDATE native_streams SET status=?,pages=?,next_input=?,reason=? WHERE id=?",
            (
                state,
                pages,
                json.dumps(next_input) if next_input else None,
                reason,
                stream_id,
            ),
        )
        if next_input and not reason:
            following = self.native_enqueue(stream_id, next_input)
            for path in self.db.execute(
                "SELECT * FROM paths WHERE task=?", (task["id"],)
            ).fetchall():
                self.bind(
                    path["anchor"],
                    following,
                    path["purpose"],
                    path["proof"],
                    path["parent"],
                )
        self.native_changes.append(
            {
                "stream": stream_id,
                "pages": pages,
                "request": request,
                "next_input": next_input,
                "reason": reason,
                "state": state,
                "body_sha256": page["bodySha256"],
            }
        )

    def native_resume_budgets(self):
        for row in self.db.execute(
            "SELECT * FROM native_streams WHERE reason='page_budget' AND pages<?",
            (self.page_budget,),
        ).fetchall():
            following = self.native_enqueue(row["id"], json.loads(row["next_input"]))
            for path in self.db.execute(
                "SELECT DISTINCT p.anchor,p.purpose,p.proof,p.parent FROM paths p JOIN native_inputs i ON i.task=p.task WHERE i.stream=?",
                (row["id"],),
            ).fetchall():
                self.bind(
                    path["anchor"],
                    following,
                    path["purpose"],
                    path["proof"],
                    path["parent"],
                )
            self.db.execute(
                "UPDATE native_streams SET status='pending',reason=NULL WHERE id=?",
                (row["id"],),
            )
