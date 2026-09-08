# Verification — 2026-09-08

## Local checks

- `npm test`: **16 passing** offline unit/API tests.
- `npm run check` / `npm run build`: passed.
- `npm run format:check`: passed.
- `npm audit --omit=dev`: zero reported vulnerabilities at verification time.
- Tested on macOS, Node.js 22.23.0, Chrome 152, Playwright 1.63.0. Other platforms have not received a live account test.

## Live functional verification

Using a dedicated, already logged-in local automation Chrome, not bundled credentials:

1. Browser connection check and reusable login state.
2. Keyword search returned 10 actual video records, including titles, authors and platform media metadata.
3. The platform's hot list returned 50 actual items with a fetch timestamp.
4. One selected video downloaded completely: 10,621,145 bytes. ffprobe confirmed H.264 video / AAC audio, duration about 80.643 seconds.
5. Inline MP4 playback and HTTP Range requests worked (206); the browser reported a finite duration and advancing playback time with no media error.
6. Browser workflow exercised navigation, connection dialog, Escape close, search/count selector, selection, download center, preview, logs and hot-list refresh.
7. Desktop 1536 × 1024 and mobile 390 × 844 checked. No horizontal overflow at 390 px and no JavaScript page errors in the live smoke test.

These are observations from this run, not a guarantee about future website changes or every video. Test inputs and downloaded content remain local and are not committed.

## Visual verification / fidelity ledger

The built-in Browser/IAB runtime reported no available browsers. After its documented discovery check, verification used an independent Playwright Chrome instance against the local app. The authenticated Douyin browser remained separate.

The initial reference [`design/concept.png`](design/concept.png) was produced with built-in Image Gen before implementation; the brief and extracted tokens are in [`design/spec.md`](design/spec.md). The production build was captured at the reference's native **1536 × 1024**. Both the reference and the final browser captures were explicitly inspected with `view_image` in the same QA pass.

| Comparison    | Concept → implementation                                                                        | Resolution                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| App structure | Left navigation, white header, main search panel and right hot-list rail                        | Preserved; not replaced by a generic card dashboard                                            |
| Copy          | Heading, subtitle, navigation, search placeholder, empty-state title and three-step row         | Preserved; no marketing eyebrow or invented metrics added                                      |
| Palette       | True-white panels, cool near-white workspace, coral action/selection treatment, gray borders    | Matched the extracted tokens; no gradients or warm background substitutions                    |
| Typography    | Chinese/system sans-serif with clear heading, panel, body and control hierarchy                 | Explicit sizes/weights defined, including buttons, selectors, navigation and captions          |
| Geometry      | Sidebar/header proportions, search-row alignment, panel split, padding and bottom workflow band | Compared at native size and adjusted through responsive styles                                 |
| Icons         | Play brand; outlined search, flame, download, book and refresh; film-search empty icon          | Code-native, consistent stroke treatment; no raster screenshot used as interactive UI          |
| Responsive    | Full app surface kept on a small screen                                                         | Horizontal navigation, one-column panels, usable search/select controls, no overflow at 390 px |

### Intentional state differences

- The real connection label reflects actual state; an untouched fresh install must not claim it is already connected.
- An empty search disables and lightens the submit button.
- Actual hot-list rows, video rows and download controls replace empty states after successful operations. Their content and timestamps are dynamic, not pixel copies of the empty reference.
- Platform/system font rendering varies; the project does not make a remote font request.
- Guide, modal, download, progress and error states extend the same design system as functional requirements, rather than adding unrelated features.

The above-the-fold copy check found no unaccounted-for static additions. The main surface was faithfully checked against the design; no material layout mismatch remains within the documented state/platform differences.

### Fixes found by testing

- CDP attachment now preserves browser defaults and materializes a page before checking the default context on macOS.
- A late connection check cannot incorrectly fail a successfully collected search.
- In-site navigation replacement (`ERR_ABORTED`) is handled without hiding genuine timeouts or closed pages.
- The private `.data` directory is not exposed as a static mount; only indexed MP4s are explicitly served with dot-directory support. This fixed inline playback and file saving.
- Rank zero is preserved for pinned hot-list entries.
- Modal focus is contained, Escape closes it, and focus is restored.

## Production screenshots

These are real browser renders of a clean local state, not simulated search results. They intentionally contain no account information, downloaded content or live signed URLs.

![Desktop production render](screenshot.png)

<details><summary>Mobile production render</summary>

![Mobile production render](mobile.png)

</details>
