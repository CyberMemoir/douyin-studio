# Candidate metadata handoff while access is paused

`scripts/bilibili-candidate-anchors.py` reads only saved Bilibili catalog title/description metadata through a SQLite `mode=ro` connection and `query_only`. It does not open the central Store or change its database, runners, families or evaluations. Use Python 3.11+ standard library; this is an optional offline handoff tool, not a background collector.

```sh
python scripts/bilibili-candidate-anchors.py \
  --database /private/bilibili/data/collection.sqlite3 \
  --acceptance-state /private/bilibili/acceptance/state.json \
  --pause-file /private/studio-data/comments-access-pause.json \
  --studio-state /private/studio-data/state.json \
  --output /private/new-douyin-trial --limit 20
```

Select only already-classified explicit explainer candidates whose saved title contains a literal `X是什么梗`/`X是啥梗`/`X什么梗` prefix. The prefix is a search label candidate, not confirmed semantic analysis. Keep exact Unicode spans, BVID, source hashes and raw source locators. The self-contained allowlisted evidence view copies title and description text; it is identified as `saved_catalog_record_view`, not a native API body. Signed media URLs, cookies and profiles are not copied from upstream objects.

Output is an independent candidate database, JSONL, evidence objects and state. Each candidate has `family_id=null`, `submission_authorized=false`, a BVID-based candidate identity and derivative/usage query plans. Explicit canonical Douyin links in descriptions may become source detail plans with unverified roles. Missing links remain `missing_douyin_source_hint`; no original source is guessed. This candidate package cannot be submitted through the formal family-action runner or imported as a family-source bundle. A later candidate reader lane must bind results to `candidate_anchor_id` separately before any live candidate execution; that lane is not implemented here.

The process exits after preparation. `pid=null`, `runner_started=false`, and zero platform requests are intentional. Existing pauses remain unchanged; saved login state is historical and cannot establish a currently usable account. No check/login/search requests are issued. No account changes, media/subtitle downloads, OCR or models are involved.

For the coordinator's half-hour **read-only** check:

```sh
python scripts/bilibili-candidate-anchors.py --inspect \
  --output /private/douyin-trial \
  --pause-file /private/studio-data/comments-access-pause.json \
  --acceptance-state /private/bilibili/acceptance/state.json
```

Inspection reports `blocked_access` while the pause exists, `deadline_reached` when Bilibili's deadline passes, and otherwise `stopped_requires_explicit_start`. Removing a pause never starts execution. It does not rewrite state or append checks; the coordinator may save its output in its own inspection log. No extra automation is created. The deadline is inherited without extension from Bilibili's 72-hour acceptance state.

Validation: `python tests/test_candidate_anchors.py` checks source database bytes stay unchanged, BVID/proof spans/role plans survive, family identity remains unassigned, and inspection cannot restart a stopped run. These tests and an offline real-metadata snapshot do not verify Douyin access or online candidate collection.
