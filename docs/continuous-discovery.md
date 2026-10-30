# Continuous metadata frontier

`scripts/douyin_discovery.py` is a Python standard-library single-process coordinator for existing Studio search/resolve readers. It stores candidate anchors, revisions, task receipts and work paths in a private SQLite frontier. It does not write the central family ledger, call models or request media/subtitles/OCR. Bilibili remains the discovery source. This increment is implemented and verified offline; real access is still blocked.

## Reproduce offline acceptance

```sh
python -X utf8 tests/test_douyin_frontier.py
python -X utf8 tests/frontier_acceptance.py --output /private/new-acceptance-directory
```

The second command creates synthetic Bilibili metadata, fixed Studio job replies, configuration and a run directory. It executes six bounded CLI invocations and preserves ten round receipts: initial intake, separate search/detail stages, head/history work, a new BVID sharing cached works, updated description intake, manual STOP across process restarts and a rejected second-instance lock. It verifies two unique details, one unavailable detail excluded, overlapping derivative/usage candidates and zero real requests. These are fixtures, not live collection counts. Unit regressions additionally cover lost acknowledgements, missing inflight receipts, waiting jobs, account refusals and multiple explicit family contexts sharing one work.

## Configuration and execution

Copy [continuous-discovery.example.json](continuous-discovery.example.json) into a private directory and set paths relative to that file. `acceptance_state` reads the existing Bilibili 72-hour deadline without extending it. Alternatively specify a numeric Unix `deadline`. `intake_batch` is bounded to 1..1000 rows per source stream; `reader_jobs_per_round` is 1..20 (default four). Each submitted Studio job is polled to terminal before another is submitted.

```sh
# Offline replay; finite rounds for local acceptance.
python -X utf8 scripts/douyin_discovery.py --config /private/config.json --rounds 4

# Continuous loop: drains the frontier, then waits locally for new saved Bilibili metadata.
python -X utf8 scripts/douyin_discovery.py --config /private/config.json

# Coordinator's read-only half-hour inspection; creates no automation or worker.
python -X utf8 scripts/douyin_discovery.py --config /private/config.json --inspect
```

Replay files contain `jobs`, keyed by `search:<literal query>` or `resolve:<canonical URL>`, with saved/fixed Studio Job objects. Replay wraps them in synthetic keyed receipts explicitly; those keys are not claimed as real historical Studio submission receipts. Missing frames stop as unresolved input, never generate example successes. Credentials, original private data and runtime databases must not be committed.

Future real execution requires **both** `transport=live` in the configuration and explicit `--live`. It uses only the existing local `/api/search` (also handles canonical resolve URLs), `/api/receipts/:key` and `/api/jobs/:id`. No direct native platform endpoint is invented. This work did not run that mode. Existing account recovery must be handled explicitly later; changing transport or passing `--live` cannot override an access pause.

## Incremental intake and identity

Bilibili SQLite is opened with `mode=ro` and `query_only`; no Store, migrations or evaluations are loaded. Catalog and observation rowids have separate durable high waters. Initial rowid ceilings separate history from subsequently arriving head material. Bounded catalog intake supplies initial candidates; appended observations supply metadata updates to existing BVIDs. Receipts distinguish new anchors, revised anchors and scanned rows. Replaying an already-seen revision does not create another task.

A new or updated head cue gives its search a stable identity scoped to that saved cue revision, allowing an already-completed literal query to discover fresh cards. Earlier cached candidates remain bound while the refresh waits. This is cue-driven head refresh, not native pagination or periodic retry. Details remain cached by work ID, and earlier search snapshots remain in their completed task records.

In-place catalog classification edits without an appended observation are not an available update stream; the coordinator must provide an explicit dirty/update feed if those edits need reprocessing. This adapter does not repeatedly scan the whole source database to guess such changes. The source schema and classification-v6 explicit-candidate field are verified against saved metadata; they are not a generic Bilibili API contract.

Literal title subjects are extracted after stripping `em` highlight tags, HTML entity decoding and a small known explainer prefix. The evidence object retains the original title, description, source SHA/locators and all transformation rule names. Named works/source phrases and canonical Douyin links come only from explicit saved wording. Unknown names remain candidates; the program does not infer a source or define a meme.

Source intake always assigns `family_id=null` and `candidate_anchor_id` via the BVID. `Frontier.add_anchor` can preserve an explicitly supplied trusted formal context under a distinct anchor ID; it does not discover or mint that family ID. The generic ledger preserves multiple anchors/families and all proof paths to the same numeric aweme ID. Central formal-anchor dispatch remains separate; the CLI's Bilibili intake does not join families or guess membership.

Canonical URL/work ID is the dedup identity. Private profile, access credentials and signed media mappings stay with Studio; only allowlisted metadata enters the frontier. Search cards are stored separately from successful same-ID details. One work may have many BVIDs and discovery paths without another detail request. Cached details can acquire new proof paths; unavailable/private/deleted detail results do not become successful details.

## Reader boundaries, scheduling and roles

Direct explicit links are prioritized within each lane, then literal queries; head/history lanes alternate when both have work. Stable keyed tasks survive restart. Search jobs inherit the existing Studio limit of eight results and at most two UI scrolls, including the browser's existing pacing. The coordinator adds no new cross-platform 20-second policy.

**Native cursor continuation is unsupported.** Current Studio search output lacks a restartable native cursor contract; bounded UI scrolling is not native pagination or historical exhaustion. Receipts state `native_cursor=null` and `entry_exhaustion=native_unknown_bounded_ui_only`. Related-video, author and topic readers are also unsupported. Replay never unlocks those capabilities.

Actual detail text with explicit canonical references can enqueue further detail reads. Role assertions retain exact text spans and paths. Source-reference candidates require an explicit target URL bound to that work, not merely a source-purpose search. Source material is not verified origin. A derivative candidate requires both action wording and an explicit different target; usage wording may overlap with it. All roles remain unverified candidates; same-word search/title matches alone leave roles unknown. Requested purposes and weak paths are retained even when roles are unknown.

`frontier.sqlite3#role_assertions` stores detailed proof records once. Per-round receipts contain summary counts (both paths and unique works), overlap, duplicates, unmatched/unavailable results, reader-job submissions/recoveries, watermarks, stagnation and stop state. They do not copy all prior evidence every round. `real_network_requests=0` in replay; live upstream HTTP counts are unknown because Studio does not expose navigation/subrequest totals. Submitted reader jobs must not be reported as measured upstream request counts or throughput.

## Stops and recovery

The private run directory contains `frontier.sqlite3`, `objects/`, `receipts/<round>.json`, `state.json` and an exclusive `run.lock` while owned. STOP or SIGINT/SIGTERM persists a local STOP and prevents further submissions. A manual STOP is never removed automatically. A previously submitted bounded Studio job may still finish; this runner does not claim it has cancelled that remote work. Its job ID and original key remain recorded.

A saved account pause is checked before any transport access. New access refusals also persist a local frontier pause; neither pause is auto-cleared. On a lost acknowledgement, recovery only looks up the original keyed receipt or known job. A missing receipt remains `submission_unknown`: no blind POST replay, new key or alternative account is attempted. Unexpected code faults save `FAULT` plus diagnostics and require explicit review before restart.

A hard crash may leave `run.lock`. Inspect the recorded PID and process command before explicit operator removal; the program never guesses that a lock is stale. Clearing a lock, STOP or FAULT does not clear account restrictions. At the inherited deadline, intake and new submissions end. Inspection is read-only, and no separate scheduled automation is created.

| Capability                                                                          | Implemented         | Offline verified                                         | Real acceptance               |
| ----------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------- | ----------------------------- |
| Incremental SQLite intake/revisions, single-owner frontier, identity/path retention | yes                 | multi-round + separate CLI processes                     | saved Bilibili metadata only  |
| Existing Studio search → same-ID detail → explicit-link expansion                   | yes                 | fixed job replay                                         | blocked by saved access pause |
| Keyed inflight recovery, STOP, refusal pause, deadline                              | yes                 | focused regressions                                      | blocked, no live requests     |
| UI scroll search batch                                                              | existing browser    | existing parser tests; frontier preserves bounded result | blocked                       |
| Native search cursor/related/author/topic                                           | no                  | unsupported state verified                               | unsupported                   |
| Family registration, semantic relations, downloads/models                           | outside this reader | not performed                                            | not performed                 |
