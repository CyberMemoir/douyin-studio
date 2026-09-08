# Local API

Base URL: `http://127.0.0.1:4321/api`.

Mutation requests require `Content-Type: application/json` and `X-Studio-Client: 1`. Only loopback Host and same-origin browser requests are accepted. No wildcard CORS.

| Method | Path                           | Purpose                                                                            |
| ------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| GET    | `/health`                      | Liveness/version                                                                   |
| GET    | `/state`                       | Jobs, trends and connection state; no session Cookie values or private media URLs  |
| GET    | `/events`                      | Server-Sent Events; full snapshot after changes, heartbeat every 20 seconds        |
| POST   | `/browser/check`               | Enqueue browser/session check                                                      |
| POST   | `/browser/login`               | Open dedicated Douyin login window                                                 |
| POST   | `/search`                      | `{ "query": "AI工具", "limit": 20 }`; accepts share text/URL/ID too                |
| POST   | `/trends`                      | Enqueue actual Douyin hot-list refresh                                             |
| POST   | `/downloads`                   | `{ "ids": ["video-id"] }`; only previously discovered videos, up to 30 per request |
| POST   | `/jobs/:id/cancel`             | Cancel queued/running job                                                          |
| GET    | `/jobs/:id/export`             | Export a search's public video metadata as JSON                                    |
| GET    | `/downloads/:id/file`          | Download completed MP4                                                             |
| GET    | `/downloads/:id/file?inline=1` | Inline MP4 with HTTP Range support for playback                                    |

Queued operations return HTTP 202 with a job (downloads return `{ jobs: [...] }`). Follow `/events` or `/state` until status becomes `completed`, `failed` or `cancelled`. `progress: null` means the byte total is unknown, not an invented percentage. Jobs share one serial worker to avoid conflicting browser actions.

Connection `login: "likely"` means a non-expired session credential is present, not a guarantee of platform acceptance. No API reports the contents of a credential.

Errors return `{ "error": "human-readable description" }`. API output and logs must not be committed as public fixtures without review.
