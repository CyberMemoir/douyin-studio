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

| Capability                                                                            | Validation                                                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Self-contained video bundle, second/ms precision, undated input                       | Actual central import/sync/timeline/verify exercised offline                      |
| Family action, keyed receipts, fresh head epochs, persistent stop/cancel              | Local API fixture with separate Studio/client process restarts                    |
| Native historical cursor/date filters, historical enumeration, author/series backfill | Unsupported (#5/#6); `mode=history` persists unsupported without a request        |
| Comments in this family bundle                                                        | Hash/text/video-bound native page views and cursor preservation, offline fixtures |
| Real account access                                                                   | Blocked by unresolved verification (#3)                                           |

Bilibili explainers supply discovery anchors. Douyin supplements their explicit source hints, derivative candidates and actual usage; it does not independently register new families. Content publication time drives the timeline, while counters are snapshots at observation time. Head refresh remains a bounded current search. Ordinary content remains metadata-only. Models, media decoding, old cancelled subscriptions and formal meme publication are outside this producer.

The committed fixture and tests cover explicit date units, Unicode evidence binding, stop outcomes, receipt loss, head refresh, cancellation after replanning and separate-process restart. The API fixture uses real Store/JobQueue/createApp with a synthetic reader: no browser, cookies or upstream requests. Private acceptance additionally runs central import→family-sync→timeline→verify, replay with zero new events, and import recovery after a staged-row interruption. Fixture validation does not clear verification or claim real online acceptance.

## Comment bundles

The same `export` command accepts `type=comments` jobs, including the direct-result archive layout written by `collect.ts`. Pass the saved job path and an explicit publication unit. Each record uses `item_id=video_id:comment_id`, the parent video URL, exact comment text and a JSON pointer into an allowlisted native response view. Comment timestamps describe comments, never their parent videos. Missing dates remain unknown. Response body hashes, raw `cursor` values and raw `has_more` survive in the view; complete private response bodies remain in the private reader archive because they can contain signed avatar URLs.

`comment_cursor` records the final cursor, page body hash, unexported comment versions, repeated cursors and whether page replay is necessary. `native_resume_implemented=false`: preserving a cursor does not implement restartable cursor requests. Completed jobs are `partial` on truncation, missing pages, repeated cursors or a non-exhausted entry; `succeeded` means only that the saved bounded top-level comment entry exhausted. Replies are outside that scope. Blocked jobs retain both their stop and valid partial records.

## Bilibili anchor conversion

```sh
node --import tsx scripts/anchor-requests.ts /private/anchor.json /private/evidence-objects > /private/requests.json
```

This offline converter checks referenced object hashes and exact codepoint spans. Its platform-local input requires `family_id`, `purpose=source|derivative|usage`, `terms` (names/aliases/original phrases) and `evidence_refs` using the existing action reference format. `source_hint`, when explicit, is `{kind: url|named|quote, value: ...}`. Work/segment identity is retained through original evidence objects and their locators; this converter does not invent shared central anchor fields.

`source` without an explicit hint returns `missing_source`. A canonical Douyin video hint returns `detail_url`; short/external links require explicit resolution elsewhere. Named hints and quoted source phrases become search actions. Derivative/usage terms become separate existing `find_independent_uses` actions, while output `context` retains the exact original purpose, family, terms, source hint and evidence refs. Keep `context` beside each action/result until coordinator wiring is ready. No action is submitted by this converter. Central scheduling and context import are not implemented here.

Search hits are relation candidates. Derivative and usage roles can overlap; quoted source claims remain claims, and weak matches remain candidates. Comments do not automatically establish parent-video family membership. Newly encountered names require Bilibili follow-up, not new family registration.

## Reader capability matrix (this increment)

Account access is blocked by #3 across these entries; offline verification does not clear that state.

| Capability                        | Implemented | Offline verified                       | Live verified in this increment | Unsupported capability/gap                  |
| --------------------------------- | ----------- | -------------------------------------- | ------------------------------- | ------------------------------------------- |
| Search/detail video bundle        | yes         | yes (existing tests retained)          | no                              | bounded results only                        |
| Comment reader → source bundle    | yes         | yes (synthetic two-page native bodies) | no                              | replies excluded                            |
| Comment raw cursor preservation   | yes         | yes                                    | no                              | restartable native requests absent          |
| Bilibili anchor input conversion  | yes         | yes (proof/role/missing source)        | no                              | central context/dispatch wiring pending     |
| Native search cursor continuation | no          | no                                     | no                              | missing saved native response contract (#5) |
| Author feed                       | no          | no                                     | no                              | missing saved native response contract (#5) |
| Topic feed                        | no          | no                                     | no                              | missing saved native response contract (#5) |
| Related videos                    | no          | no                                     | no                              | missing saved native response contract (#5) |

The saved pilot JSON audit found normalized/diagnostic jobs, not native responses proving these four contracts. No endpoint, signature or cursor field was guessed. Author/topic/related work is scoped to supplementing anchors, not whole-platform historical popularity enumeration. No historical-popularity proof is required for content admission.
