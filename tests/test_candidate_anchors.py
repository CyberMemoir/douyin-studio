"""Regression: metadata candidates must not become fabricated family actions."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("candidate_anchors", Path(__file__).parents[1] / "scripts/bilibili-candidate-anchors.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CandidateTests(unittest.TestCase):
    def test_readonly_metadata_proof_and_candidate_identity(self):
        with tempfile.TemporaryDirectory() as root:
            db_path = Path(root) / "fixture.sqlite3"
            db = sqlite3.connect(db_path)
            db.execute("CREATE TABLE explainer_catalog_works(bvid TEXT,record_json TEXT,classification_json TEXT)")
            record = {"url": "https://www.bilibili.com/video/BV1234567890", "observed_at": "2026-10-29T00:00:00Z",
                      "published_at_raw": 1234567890, "evidence_sha": "a" * 64,
                      "texts": [{"kind": "title", "text": "🙂原话是什么梗", "locator": "/data/title"},
                                {"kind": "desc", "text": "引用 https://www.douyin.com/video/1234567890123456789", "locator": "/data/desc"}]}
            db.execute("INSERT INTO explainer_catalog_works VALUES(?,?,?)", ("BV1234567890", json.dumps(record), json.dumps({"explanation": {"level": "explicit_candidate"}})))
            db.commit(); db.close()
            before = db_path.read_bytes()
            rows = list(module.candidates(db_path, 1))
            self.assertEqual(before, db_path.read_bytes())
            anchor, sha, body = rows[0]
            self.assertIsNone(anchor["family_id"])
            self.assertFalse(anchor["submission_authorized"])
            self.assertEqual(anchor["candidate_anchor_id"], "bilibili-candidate:BV1234567890")
            self.assertEqual(sha, module.digest(body))
            proof = anchor["evidence_refs"][0]
            title = json.loads(body)["title"]
            self.assertEqual(title[slice(*proof["span"])], proof["original_text"])
            self.assertEqual({p["purpose"] for p in anchor["plans"]}, {"source", "derivative", "usage"})
            self.assertEqual(anchor["plans"][-1]["claim_status"], "explicit_link_unverified_role")

    def test_readonly_inspection_never_restarts_after_pause_disappears(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            state = b'{"pid":null,"runner_started":false,"real_platform_requests":0}'
            (root / "state.json").write_bytes(state)
            (root / "acceptance.json").write_text('{"deadline":9999999999}')
            result = module.inspect(root, root / "absent-pause.json", root / "acceptance.json")
            self.assertEqual(result["status"], "stopped_requires_explicit_start")
            self.assertFalse(result["runner_started"])
            self.assertEqual((root / "state.json").read_bytes(), state)
            (root / "pause.json").write_text('{"reason":"access_restriction"}')
            self.assertEqual(module.inspect(root, root / "pause.json", root / "acceptance.json")["status"], "blocked_access")


if __name__ == "__main__":
    unittest.main()
