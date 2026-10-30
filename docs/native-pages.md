# Native search pages and work-related recommendations

The request builders, strict parsers, local keyed API routes and durable frontier page state are implemented and verified offline. **Neither endpoint is live-verified.** The saved account pause remains authoritative, and this increment made no Douyin requests. Positive fixtures are synthetic examples of the pinned public-client contracts, not captured successful platform responses.

## Contract evidence

[native-page-contracts.json](native-page-contracts.json) records exact revisions and unresolved fields. Request paths and related filtering come from [F2's endpoint definitions](https://github.com/Johnserf-Seed/f2/blob/7dab3e2ffffaa2535834d28fca99dbc2e89fa9d3/f2/apps/douyin/api.py) and [request models](https://github.com/Johnserf-Seed/f2/blob/7dab3e2ffffaa2535834d28fca99dbc2e89fa9d3/f2/apps/douyin/model.py). General search's data item and search-session binding follow [the public client call site](https://github.com/NanmiCoder/MediaCrawler/blob/68d9ef1c1da22eab75940dfd7cec259907006538/media_platform/douyin/core.py): `data[].aweme_info` and `extra.logid`. Only protocol facts are used; those clients, token generators, signers, downloaders and retry policies are not imported.

The committed verify-check fixture is a minimal redacted projection of [a reported 2024 response](https://github.com/NanmiCoder/MediaCrawler/issues/358), not our capture. Its normal HTTP/application status and false `has_more` must not become exhaustion: the explicit verification marker stops the reader. That old failure report does not prove current successful access or page shapes. Other mixed result rows remain `unparsedRows` and stop continuation rather than silently losing items.

## Requests and transport

`POST /api/search/page` takes `{query,cursor,searchId,count}`. The builder forwards cursor as native `offset`, plus `keyword/count/search_id`, to `/aweme/v1/web/general/search/single/`. First input uses cursor 0 and an empty search ID. Continuation uses the actual response cursor and `extra.logid`, never offset-plus-count arithmetic. Missing fields stop as a contract gap.

`POST /api/related` takes `{videoId,excludedIds,count}`. The native target is `/aweme/v1/web/aweme/related/`, with the exact parent `aweme_id` and a deduplicated `filterGids` list. Related continuation accumulates returned IDs; it does not invent a numeric related cursor or increment an undocumented refresh counter. Parent and child identities, response/body hash and observation context are checked independently. A recommendation records `recommended_after`, not a semantic or derivative relation.

Both local endpoints retain JSON/`X-Studio-Client:1`/Idempotency-Key and existing serial queue semantics. The browser uses an ordinary same-origin credentialed fetch after normal navigation. It does not fabricate signatures, tokens, fingerprints or headers and does not retry denials. The existing Douyin 20-second additional-page wait is reused; no web-reader timing rule was copied. Native pages abort player media/subtitle requests and save only response metadata, never media files.

**Ordinary fetch may still lack fresh website SDK/session/signature parameters.** Public clients disagree on optional related fields. No working session was available to confirm those details, and they are not claimed solved. A future explicit access-recovery phase must capture successful normal-site requests/responses and validate this bridge. A refusal stops and persists a pause; nothing falls back to another account, proxy or signer.

Raw metadata response bodies (including failed bodies) and safe typed/wire request sidecars are private under Studio's `native-pages/`. Jobs expose only normalized cards and native page metadata: request, raw cursor/has_more values, source body SHA, IDs and observation time. Private raw bodies can contain signed URLs and must not be publicly committed.

## Persistent frontier

Set `reader_protocol=native_pages`, `max_pages_per_stream=3`, and `related_depth=1` in the private [configuration example](continuous-discovery.example.json). Omitting the protocol retains the old bounded-UI mode for existing callers. The standalone family-action adapter also retains its existing contract. New mode uses the native local routes; metadata-only detail reads remain the existing resolve path.

`native_streams`, `native_inputs`, `native_pages`, `native_seen`, `native_depth` and `recommendation_edges` retain exact inputs, next input, page fingerprints, seen work IDs, parent paths, depth and stop reasons. Search cards and related cards still require a separate successful same-ID detail read. Cached works retain multiple BVID/parent/family paths without another detail request. Source/derivative/usage purposes are retained; recommendation or same-word matches do not confirm any of them.

Repeated pages, stationary/decreasing cursors, no new IDs, unknown fields and unparsed rows stop partial streams with explicit reasons. Only an explicit false native `has_more` with understood rows marks exhaustion. Page-budget stops retain `next_input`; an explicit larger budget can enqueue that exact continuation after restart. They are not marked exhausted. STOP, account pauses and the inherited deadline prevent submissions or automatic budget recovery. Unknown inflight tasks still recover only the original keyed receipt/known job.

Head/history lanes remain fair. Within a lane, direct explicit source links have priority; other work uses FIFO so detail arrivals cannot permanently starve queued page/related work. Related depth limits expansion without discarding observed edges. Per-round reader-job budgets and global deadline remain unchanged. Native progress is recorded in `native_page_changes`; detailed response/request evidence stays in the frontier and private raw archive. No upstream throughput claim is made.

## Offline acceptance

```sh
python -X utf8 tests/test_native_frontier.py
python -X utf8 tests/native_acceptance.py --output /private/new-native-acceptance
node --import tsx --test tests/native-pages.test.ts tests/native-api.test.ts
```

The CLI fixture produces 14 receipts across four processes, nine simulated reader submissions, three unique synthetic details and a common child bound to two parent works and two BVIDs. Two explicit STOP restarts submit nothing; continuation later uses the saved cursor. A repeated related page stops, while three streams explicitly exhaust. Unit cases additionally cover page-budget extension, cursor stagnation, missing search IDs, zero-request account pause, detail ID mismatch and local request parameter forwarding.

The local API test uses actual Store/JobQueue/routes with a synthetic browser. The parser tests include synthetic successful bodies and the reported verify-check projection. These prove code behavior and evidence handling; current native endpoint acceptance, session freshness and real response shape remain **live_blocked/unverified**. Author/topic readers remain unsupported.
