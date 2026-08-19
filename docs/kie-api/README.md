# kie.ai API reference (Seedance / Seedream)

Local copies of the kie.ai model API docs this tool talks to, so we don't have to
re-check the web. One file per model family:

- [seedance-2-5.md](seedance-2-5.md) — `bytedance/seedance-2-5`
- [seedance-2-0.md](seedance-2-0.md) — `bytedance/seedance-2` and `bytedance/seedance-2-fast`
- [seedance-2-0-mini.md](seedance-2-0-mini.md) — `bytedance/seedance-2-mini`

Seedream (image) models are used by the tool too but aren't documented here yet.

## Sources & confidence

| Model | Source | Confidence |
| --- | --- | --- |
| Seedance 2.5 | Official kie.ai API docs (pasted in full into the project) | High — authoritative param table with types/defaults |
| Seedance 2.0 / Fast | Playground **Form** view at <https://kie.ai/seedance-2-0> | Good — param names + option lists read off the live form |
| Seedance 2.0 Mini | Playground **Form** view at <https://kie.ai/seedance-2-0-mini> | Good — same |

Retrieved **2026-08-18**. The 2.0/Mini entries come from the rendered playground
form (which reliably shows a field only when the model supports it), not a formal
schema doc — so treat option lists as authoritative but re-verify if kie.ai
revises the pages.

## Shared request/response mechanics (all models)

kie.ai uses one unified Jobs API; only the `model` string and the `input` object
differ per model.

**Auth:** `Authorization: Bearer YOUR_API_KEY` on every request. Key from
<https://kie.ai/api-key>.

**Create a task**

```
POST https://api.kie.ai/api/v1/jobs/createTask
Content-Type: application/json

{ "model": "<model-id>", "input": { ... }, "callBackUrl": "<optional>" }
```

Response: `{ "code": 200, "msg": "success", "data": { "taskId": "..." } }`

**Query a task**

```
GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<taskId>
```

`data.state` is `waiting` | `success` | `fail`. On success, `data.resultJson` is a
JSON **string** like `{"resultUrls":["https://.../out.mp4"]}`. Other fields:
`failCode`, `failMsg`, `costTime` (ms), `completeTime`, `createTime`.

**Callback:** if `callBackUrl` is set, kie.ai POSTs the same body as the query
response on completion (success or fail); its `param` field holds the full create
request. Otherwise poll `recordInfo`.

**Error codes:** 200 ok · 400 bad params · 401 auth · 402 insufficient balance ·
404 not found · 422 validation failed · 429 rate limit · 500 server error.
Rate limit is ~20 new requests / 10s; rejected requests are **not** queued.

## Parameter matrix (video models)

| Parameter | 2.5 | 2.0 | Fast | Mini |
| --- | :---: | :---: | :---: | :---: |
| `prompt` | ✓ | ✓ | ✓ | ✓ |
| `first_frame_url` / `last_frame_url` | ✓ | ✓ | ✓ | ✓ |
| `reference_image_urls` | ✓ | ✓ (≤9) | ✓ (≤9) | ✓ (≤9) |
| `reference_video_urls` | ✓ | ✓ | ✓ | ✓ |
| `reference_audio_urls` | ✓ | ✓ | ✓ | ✓ |
| `generate_audio` | ✓ | ✓ | ✓ | ✓ |
| `web_search` | ✓ | ✓ | ✓ | ✓ |
| `nsfw_checker` | ✓ | ✓ | ✓ | ✓ |
| `resolution` (480p/720p) | ✓ | ✓ | ✓ | ✓ |
| `aspect_ratio` | ✓ +`adaptive` | ✓ | ✓ | ✓ +`adaptive` |
| `duration` | −1..30 | 4..15 | 4..15 | 4..15 |
| `output_format` (mp4/mov) | ✓ | ✗ | ✗ | ✗ |
| `return_last_frame` | ✓ | ✗ | ✗ | ✗ |

**Mutual exclusivity:** `reference_image_urls` and the first/last frames cannot be
combined (the API rejects it; the playground shows them as separate tabs). The tool
enforces this with an "Image source" toggle. Reference **video** and **audio** stay
available alongside either choice.

## Known discrepancies with the tool (as of 2026-08-18)

Worth a look but **not yet changed** — recorded here so we don't lose track:

1. **Resolution 1080p/4K.** Every documented Seedance video model (including 2.5)
   lists only `480p` and `720p`. The tool's resolution dropdown also offers
   `1080p`/`4K`, enabled for standard `bytedance/seedance-2`. That option set isn't
   backed by any of these docs — verify whether standard 2.0 actually accepts it
   before relying on it.
2. **2.5 reference-media limits.** 2.5 allows larger/longer references than
   2.0/Fast/Mini (video ≤200MB & total ≤30s; audio total ≤30s) but the tool's
   dropzone hints show the 2.0 numbers (≤50MB, total ≤15s) for all models. Hints
   understate 2.5's real limits.
