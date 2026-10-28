# Associated discovery bridge (`platform-collection-v1`)

The Studio reader remains bounded. This change adds a deterministic **offline converter**, not a second crawler, scheduler, database, or OCR worker. Shared CyberMemoir discovery owns seed rotation, budgets, native reader tasks, receipt recovery, media download, and resource leases.

## Inputs and CLI

Use public normalized `GET /api/jobs/:id` or existing `collect.ts` archives. Keep real archives and outputs private.

```sh
node --import tsx scripts/discovery-export.ts \
  --job /private/search-job.json --seed 'actual requested keyword' \
  --output /private/new-export-01 --checkpoint /private/discovery-checkpoint.json \
  --pause-file /private/studio-data/comments-access-pause.json
```

Output directory must be new; its parent must exist. Checkpoint has one writer. Re-run in a fresh process with the same checkpoint: exact evidence is not emitted again; a second real search path to the same video is retained. Replacing the temporary checkpoint after an interruption is safe; the final checkpoint is replaced only after all output files and their manifest have been written. Partial output directories remain for diagnosis and are not overwritten.

`--pause-file` is required when the account has a persisted pause. This converter makes **zero network requests** even when unpaused. Existing unresolved verification must not be cleared to run this command or live acceptance. Live scheduling must always enforce the actual Studio and central platform pauses, regardless of a recipe's saved status.

## Exports

- `nodes.jsonl`: video, exact returned author UID and native `cha_list.cid` topic identities, caption hashtag tags, and explicitly synthetic seed topics. Missing public URL/UID remains null. Numeric author/topic IDs are not converted through JavaScript floating-point.
- `edges.jsonl`: `search_result`, `author_post`, `topic_member`, `tag_member`, each bound to an archived JSON locator/hash. Multiple seeds and new observations retain distinct evidence edges; they are not derivation or causal claims.
- `queries.jsonl`: full original titles/comments as **unreviewed real expressions**, observed trend words as platform clues. These are not actual search logs or material-naming answers. Caption-tag expansion requests are `rule_seed`, not platform suggestions. No generated AI queries or semantic family binding.
- `frontier.json`: additive request recipes for shared scheduling. Search/tag seeds use the existing `/api/search`; discovered videos stage a canonical detail request. Author/topic identity does not pretend an author-feed/topic-feed reader exists.
- `media_manifest.jsonl`: only explicit explainer-title rule matches (`是什么梗`, `梗的由来`, `梗来源`, `梗科普`, `梗解释`, `meme explained`) stage media-descriptor candidates. This is a rule flag, not semantic confirmation. Ordinary videos never get a media recipe. Resolve the exact video first, bind its completed job ID, then use the existing private `source-media` receipt. Null media path/hash means **not downloaded**. Shared collector owns actual download/validation/OCR.
- `capabilities.json`, `trial_summary.json`: reader capabilities remain `unverified` without live acceptance, or `blocked` for the current pause. Author-feed, topic-feed, related-video readers and native search pagination remain `unsupported`. No `recommended_after` edge is manufactured.
- `job.json` and `manifest.json` bind normalized job evidence. Comment response pages are additionally written by SHA with exact native text pointers. A comment's text/video ID/body hash must match before output.

Seed nodes use the allowed `topic` entity type but carry `seed:` identity and `identity_basis=seed_text_not_native_topic`; they are **not native Douyin topics**. Caption tags similarly use `text:` identities, not native challenge IDs. Public author UID alone does not supply a verified `/user/` URL; canonical URL stays null.

## Continuation and limitations

`cursor.kind=local_evidence_checkpoint` counts processed evidence and saved frontier identities. It is **not** a native site cursor. Current search reader offers bounded scrolls only. Native comments pages/cursors remain in the original reader archive; truncated pages must not be advanced as if all comments were exported. Shared scheduling must consume these gaps explicitly, not claim all-platform enumeration or complete pagination.

Capabilities are not upgraded to available by offline fixtures or historical replay. Current verification blocker is tracked in [issue #3](https://github.com/CyberMemoir/douyin-studio/issues/3). A browser slot released by another platform does not remove this account's pause. After manual verification and explicit authorization, first run one minimal normal request before a 2–3 seed window. Do not restart or close another platform's browser.

## Shared-core integration handoff

This PR touches no central queue, runtime, transport, worker, database, or OCR files. Coordinator should import node/edge deltas, retain all path evidence, deduplicate recipes by request ID, enforce existing resource/platform budgets, and map descriptor recipes to completed resolve receipts. Keep queued frontier continuation distinct from successful access. 72-hour server acceptance remains separate.

Validation covers Unicode original text, exact identity, two-path dedup, process checkpoint replay, verification-blocked recipes, and ordinary-vs-explainer media gating. Synthetic tests and private historical replay are reported separately from live requests. No models or media decoding are run here.
