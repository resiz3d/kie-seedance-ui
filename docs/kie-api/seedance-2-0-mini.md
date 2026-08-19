# Seedance 2.0 Mini — `bytedance/seedance-2-mini`

Video model. Source: playground **Form** view at
<https://kie.ai/seedance-2-0-mini>, retrieved 2026-08-18. See [README.md](README.md)
for shared endpoints, auth, polling, and error codes.

**Model id:** `bytedance/seedance-2-mini`

Faster/cheaper than 2.0 and 2.0 Fast, with output quality kie.ai describes as
comparable to 2.0 Fast. Caps resolution at 720p.

## `input` parameters

| Parameter | Type | Options / limits |
| --- | --- | --- |
| `prompt` | string | Text description of the video. |
| `first_frame_url` | string | Start keyframe. ≤30MB. jpeg/jpg/png/webp/gif. Mutually exclusive with `reference_image_urls`. |
| `last_frame_url` | string | End keyframe. Same limits. |
| `reference_image_urls` | string[] | Up to 9 images. ≤30MB each. jpeg/png/webp/jpg/gif. Mutually exclusive with first/last frame. |
| `reference_video_urls` | string[] | Up to 3. ≤50MB each; **total ≤ 15s**. mp4/quicktime/x-matroska. |
| `reference_audio_urls` | string[] | Up to 3. ≤15MB each; **total ≤ 15s**. mpeg/wav. |
| `generate_audio` | boolean | Generate AI audio synced to the video. |
| `resolution` | string | `480p` \| `720p`. |
| `aspect_ratio` | string | `16:9` \| `4:3` \| `1:1` \| `3:4` \| `9:16` \| `21:9` \| **`adaptive`**. |
| `duration` | number | Seconds. Same short-form range as 2.0 (tool uses min 4 / max 15). |
| `web_search` | boolean | Enable online search. |
| `nsfw_checker` | boolean | Playground default true. |

## Difference from 2.0 / Fast

- **Adds `adaptive` to `aspect_ratio`** — the one input difference vs 2.0/Fast.
  (2.5 also has `adaptive`; 2.0 and Fast do not.)

## Not supported (present on 2.5 only)

- `output_format` (mp4/mov) — not offered.
- `return_last_frame` — not offered.
