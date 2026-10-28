# Family source bundle and search actions

This producer implements central `family-source-bundle-v1` from CyberMemoir/cyber-memoir PR #35 (collector 0.5.0). It preserves the existing Studio API/CLI and graph exports. Shared dispatch, SQLite, queue, media and OCR remain coordinator-owned.

## Export a self-contained bundle

```sh
node --import tsx scripts/family-bundle.ts export \
  --job tests/fixtures/family-search.json --source-id douyin-fixture-v1 \
  --unit seconds --material fixture --output /private/new-bundle
```

The output contains `manifest.json`, UTF-8/no-BOM `records.jsonl`, and `objects/<sha256>.bin`. Manifest is written last. Output must be new and its parent must exist; preserve incomplete output and use another directory after a write failure.

Use `material=fixture` for synthetic input, `historical_replay` for saved real input, and `real` for current reader results. Evidence objects are allowlisted JSON views of normalized Studio results: exact titles, IDs/URLs, observation basis, counters and raw publication values. Titles bind to exact pointers. Cookie, headers, signed cover/media links, profile, caller paths and error stacks are excluded.

Publication `unit=seconds|milliseconds|unknown` is explicit, never inferred from digit count. Known integer epochs retain raw values, exact central precision and `source_evidence`. Missing dates/unknown units remain undated; publication is not the historical popularity window. Calendar strings/relative dates/fractional numeric seconds lack a verified Douyin field contract here and should remain unknown until their native field and timezone evidence are available. Observation timestamps must include a timezone and come from the saved reader; missing observation time rejects a record.

Search completion is `partial` (bounded results); detail completion is `succeeded`. Valid records already obtained in a blocked result are retained. The central enum has no rate-limit/cancel/interrupted/unsupported outcome: preserve those in `reader_outcome`/`execution`, map rate limits to `blocked_verification`, and other stops to `failed`. Client waiting or submission-unknown is not a reader terminal and emits no bundle.

## Consume a central family search action

Action JSON requires `action_type=search`, `target_platform=douyin`, stable `family_id`, `query`, `purpose` (`find_independent_uses`, `find_original_reference`, `find_explainer`), `evidence_refs`, `query_layer=rule_seed`, and `is_actual_search_log=false`. Evidence refs retain `evidence_sha`, `locator`, Unicode-codepoint `span`, and `original_text`.

```sh
node --import tsx scripts/family-bundle.ts prepare \
  --action /private/action.json --action-objects /private/central-objects \
  --state /private/action-state --mode head --epoch window-001 \
  --pause-file /private/studio-data/comments-access-pause.json --material fixture

# Only after authorized manual access recovery:
node --import tsx scripts/family-bundle.ts run \
  --action /private/action.json --action-objects /private/central-objects \
  --state /private/action-state --mode head --epoch window-001 \
  --pause-file /private/studio-data/comments-access-pause.json --studio-url http://127.0.0.1:4321 \
  --material real --output /private/new-bundle
```

Referenced objects may use `<sha>.bin` or central `<prefix>/<sha>.bin` layout. SHA, pointer and exact original substring are checked before copying them into the bundle. Public action context is retained in the evidence view; it does not approve family membership or change definitions. Central dispatcher currently accepts Bilibili only; coordinator must explicitly register this adapter.

Head execution identity is recipe + explicit epoch. A new epoch refreshes the head; the same epoch reads its saved job/result or original keyed receipt. Lost submission acknowledgement uses `/api/receipts/:key`, known jobs use `/api/jobs/:id`. Requests retain JSON, `X-Studio-Client:1` and `Idempotency-Key`. Conflicts, evictions or missing known jobs stop rather than changing keys. Supply the actual Studio pause path; both the local action gate and Studio enforce account pauses.

## Persistent stop and restart

```sh
node --import tsx scripts/family-bundle.ts cancel --action /private/action.json \
  --state /private/action-state --reason 'operator ended recipe' --material real
```

Cancellation survives new processes and future head epochs. Changing evidence refs while replanning the same family/query/purpose cannot clear it. A running action checks cancellation and cancels the known local Studio task. SIGINT/SIGTERM retain an interrupted execution and attempt that cancellation; failed acknowledgement does not prove the remote job ended. Stopped epochs do not restart automatically.

Each execution has a single-writer lock. After a hard exit, `recover-lock` with the same action/state/mode/epoch/material checks that the recorded PID is gone and archives the lock without platform access. A live/ambiguous owner is refused. This recovery never clears a platform pause.

## Current capabilities

| Capability                                                                            | Validation                                                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Self-contained video bundle, second/ms precision, undated input                       | Actual central import/sync/timeline/verify exercised offline               |
| Family action, keyed receipts, fresh head epochs, persistent stop/cancel              | Local API fixture with separate Studio/client process restarts             |
| Native historical cursor/date filters, historical enumeration, author/series backfill | Unsupported (#5/#6); `mode=history` persists unsupported without a request |
| Comments in this family bundle                                                        | Not implemented; existing comment evidence export unchanged                |
| Real account access                                                                   | Blocked by unresolved verification (#3)                                    |

Historical popularity remains first priority; head refresh is only a bounded current search. Ordinary content remains metadata-only. Models, media decoding, old cancelled subscriptions and formal meme publication are outside this producer.

The committed fixture and tests cover explicit date units, Unicode evidence binding, stop outcomes, receipt loss, head refresh, cancellation after replanning and separate-process restart. The API fixture uses real Store/JobQueue/createApp with a synthetic reader: no browser, cookies or upstream requests. Private acceptance additionally runs central import→family-sync→timeline→verify, replay with zero new events, and import recovery after a staged-row interruption. Fixture validation does not clear verification or claim real online acceptance.
