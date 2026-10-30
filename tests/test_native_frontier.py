"""Synthetic, pinned-public-contract page replay. Never a real platform acceptance."""

import hashlib
import json
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from douyin_discovery import Studio
from douyin_frontier import Frontier, anchor, encoded
from test_douyin_frontier import CLASSIFICATION, Reader, source_record, url, video


def page_job(request, indices, cursor=None, more=False, search_id=None, unparsed=0):
    related = request["kind"] == "related"
    path = "https://www.douyin.com/aweme/v1/web/" + (
        "aweme/related/" if related else "general/search/single/"
    )
    body_sha = hashlib.sha256(encoded([request, indices, cursor, more])).hexdigest()
    rows = []
    for index in indices:
        row = video(index, request.get("query"))
        if related:
            row.pop("detailContext", None)
            row["relatedContext"] = {
                "parentVideoId": request["videoId"],
                "responsePath": path,
                "bodySha256": body_sha,
                "observedAt": "2026-10-29T00:00:02Z",
            }
        rows.append(row)
    observed = "2026-10-29T00:00:02Z" if related else "2026-10-29T00:00:01Z"
    return {
        "id": "synthetic-native-" + body_sha[:12],
        "type": request["kind"],
        "status": "completed",
        "result": {
            "videos": rows,
            "nativePage": {
                "request": request,
                "responsePath": path,
                "observedAt": observed,
                "bodySha256": body_sha,
                "ids": [row["id"] for row in rows],
                "cursor": cursor,
                "cursorRaw": cursor,
                "hasMore": more,
                "hasMoreRaw": int(more),
                "searchId": search_id,
                "unparsedRows": unparsed,
                "contractBasis": "pinned_public_client_not_live_verified",
            },
        },
    }


class NativeReader(Reader):
    def __init__(self, responder):
        super().__init__()
        self.responder = responder

    def submit(self, task):
        if "native_input" not in task:
            return super().submit(task)
        self.calls.append(dict(task["native_input"]))
        result = {**self.responder(task["native_input"]), "idempotencyKey": task["id"]}
        self.receipts[task["id"]] = result
        return result


class NativeTests(unittest.TestCase):
    def test_cursor_budget_stop_restart_and_exhaustion(self):
        with ExitStack() as cleanup:
            root = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
            frontier = Frontier(
                root / "run", native_pages=True, page_budget=2, related_depth=0
            )
            cleanup.callback(frontier.db.close)
            value = anchor(source_record(desc="无出处"), CLASSIFICATION)
            with frontier.db:
                frontier.add_anchor(value)

            def response(request):
                offset = request["cursor"]
                self.assertEqual(
                    request["searchId"], "" if offset == 0 else "log" + str(offset)
                )
                return page_job(
                    request,
                    [offset // 10],
                    offset + 10,
                    offset < 20,
                    "log" + str(offset + 10),
                )

            reader = NativeReader(response)
            # Successful details do not expand related when related_depth=0.
            reader.records["resolve:" + url(0)] = {
                "id": "detail-a",
                "type": "resolve",
                "status": "completed",
                "result": {"videos": [video(0)]},
            }
            reader.records["resolve:" + url(1)] = {
                "id": "detail-b",
                "type": "resolve",
                "status": "completed",
                "result": {"videos": [video(1)]},
            }
            receipts = []
            for _ in range(4):
                receipts.append(
                    frontier.step(
                        reader, root / "pause", root / "STOP", time.time() + 100, 1
                    )
                )
            state = frontier.db.execute("SELECT * FROM native_streams").fetchone()
            self.assertEqual(state["reason"], "page_budget")
            self.assertEqual(json.loads(state["next_input"])["cursor"], 20)
            (root / "STOP").write_text("manual_stop")
            frontier.db.close()
            frontier = Frontier(
                root / "run", native_pages=True, page_budget=3, related_depth=0
            )
            cleanup.callback(frontier.db.close)
            self.assertEqual(
                frontier.step(reader, root / "pause", root / "STOP", time.time() + 100)[
                    "status"
                ],
                "stopped",
            )
            self.assertEqual(
                len([call for call in reader.calls if isinstance(call, dict)]), 2
            )
            (
                root / "STOP"
            ).unlink()  # Explicit synthetic operator restart, never a real pause.
            for _ in range(4):
                receipts.append(
                    frontier.step(
                        reader, root / "pause", root / "STOP", time.time() + 100, 1
                    )
                )
            self.assertEqual(
                frontier.db.execute("SELECT status FROM native_streams").fetchone()[0],
                "exhausted",
            )
            self.assertEqual(
                [call["cursor"] for call in reader.calls if isinstance(call, dict)],
                [0, 10, 20],
            )
            self.assertEqual(
                frontier.db.execute("SELECT count(*) FROM native_pages").fetchone()[0],
                3,
            )
            self.assertTrue(all(row["real_network_requests"] == 0 for row in receipts))

    def test_related_multi_parent_paths_and_repeated_page(self):
        with ExitStack() as cleanup:
            root = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
            frontier = Frontier(
                root / "run", native_pages=True, page_budget=3, related_depth=1
            )
            cleanup.callback(frontier.db.close)
            with frontier.db:
                for index, bvid in enumerate(("BV1234567890", "BV2234567890")):
                    value = anchor(
                        source_record(bvid=bvid, desc="引用 " + url(index)),
                        CLASSIFICATION,
                    )
                    value["plans"] = [
                        plan for plan in value["plans"] if plan["kind"] == "resolve"
                    ]
                    frontier.add_anchor(value)
            reader = NativeReader(
                lambda request: page_job(
                    request, [2], more=request["videoId"] == "123456789"
                )
            )
            for index in range(3):
                reader.records["resolve:" + url(index)] = {
                    "id": "detail" + str(index),
                    "type": "resolve",
                    "status": "completed",
                    "result": {"videos": [video(index)]},
                }
            for _ in range(12):
                frontier.step(
                    reader, root / "pause", root / "STOP", time.time() + 100, 1
                )
            self.assertEqual(
                frontier.db.execute(
                    "SELECT count(DISTINCT parent) FROM recommendation_edges WHERE child='323456789'"
                ).fetchone()[0],
                2,
            )
            self.assertEqual(
                frontier.db.execute(
                    "SELECT count(DISTINCT anchor) FROM work_paths WHERE work='323456789'"
                ).fetchone()[0],
                2,
            )
            self.assertEqual(reader.calls.count("resolve:" + url(2)), 1)
            self.assertEqual(
                frontier.db.execute(
                    "SELECT reason FROM native_streams WHERE target=?", (url(0),)
                ).fetchone()[0],
                "repeated_page",
            )
            self.assertTrue(
                all(row["family_id"] is None for row in frontier.roles()["evidence"])
            )
            self.assertFalse(
                any(
                    row["roles"] == ["source_reference_candidates"]
                    for row in frontier.roles()["evidence"]
                    if row["work"] == "323456789"
                )
            )

    def test_nonprogress_contract_gap_pause_and_detail_mismatch(self):
        for expected, cursor, more, unparsed, indices in (
            ("cursor_not_advanced", 0, True, 0, [0]),
            ("no_new_ids", 10, True, 0, []),
            ("unparsed_native_rows", 10, True, 1, [0]),
            ("missing_search_id_contract", 10, True, 0, [0]),
        ):
            with self.subTest(expected=expected), ExitStack() as cleanup:
                root = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
                frontier = Frontier(root / "run", native_pages=True, related_depth=0)
                cleanup.callback(frontier.db.close)
                with frontier.db:
                    frontier.add_anchor(
                        anchor(source_record(desc="无出处"), CLASSIFICATION)
                    )
                reader = NativeReader(
                    lambda request, indices=indices, cursor=cursor, more=more, unparsed=unparsed: (
                        page_job(request, indices, cursor, more, unparsed=unparsed)
                    )
                )
                pause = root / "pause"
                pause.write_text('{"reason":"access_restriction"}')
                before = pause.read_bytes()
                self.assertEqual(
                    frontier.step(reader, pause, root / "STOP", time.time() + 100)[
                        "submitted_reader_jobs"
                    ],
                    0,
                )
                self.assertEqual(pause.read_bytes(), before)
                pause.unlink()
                frontier.step(reader, pause, root / "STOP", time.time() + 100, 1)
                self.assertEqual(
                    frontier.db.execute("SELECT reason FROM native_streams").fetchone()[
                        0
                    ],
                    expected,
                )
                if indices:
                    wrong = video(0)
                    wrong["detailContext"]["resolvedUrl"] = url(1)
                    reader.records["resolve:" + url(0)] = {
                        "id": "wrong-detail",
                        "type": "resolve",
                        "status": "completed",
                        "result": {"videos": [wrong]},
                    }
                    self.assertEqual(
                        frontier.step(
                            reader, pause, root / "STOP", time.time() + 100, 1
                        )["status"],
                        "submission_unknown",
                    )
                    self.assertEqual(
                        frontier.db.execute("SELECT count(*) FROM details").fetchone()[
                            0
                        ],
                        0,
                    )

    def test_studio_routes_pass_native_request_parameters_without_guessing(self):
        studio = Studio("http://127.0.0.1:4321")
        calls = []
        studio.request = lambda *args: calls.append(args)
        request = {
            "kind": "search_page",
            "query": "测试",
            "cursor": 15,
            "searchId": "log",
            "count": 8,
        }
        studio.submit(
            {
                "id": "a" * 64,
                "kind": "search_page",
                "target": "测试",
                "native_input": request,
            }
        )
        self.assertEqual(
            calls[0],
            (
                "search/page",
                {key: value for key, value in request.items() if key != "kind"},
                "a" * 64,
            ),
        )


if __name__ == "__main__":
    unittest.main()
