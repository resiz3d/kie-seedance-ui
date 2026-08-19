# Seedance 2.5 — `bytedance/seedance-2-5`

Video model. Source: official kie.ai API docs (pasted into the project),
retrieved 2026-08-18. See [README.md](README.md) for shared endpoints, auth,
polling, callbacks, and error codes.

Docs page: <https://kie.ai/seedance-2-5>

## `input` parameters

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `prompt` | string | No | (long example) | Text description. Max 30,000 chars. Reference images with `@Image1`, `@Image2`, … |
| `first_frame_url` | string | No | — | Start keyframe. ≤30MB. jpeg/png/webp/gif. Mutually exclusive with `reference_image_urls`. |
| `last_frame_url` | string | No | — | End keyframe. Same limits. |
| `reference_image_urls` | string[] | No | — | Subject/style refs (the `@ImageN` tokens). ≤30MB each. jpeg/png/webp/jpg. Mutually exclusive with first/last frame. |
| `reference_video_urls` | string[] | No | — | ≤200MB each; **total of the 3 videos ≤ 30s**. mp4/quicktime/x-matroska. |
| `reference_audio_urls` | string[] | No | — | ≤15MB each; **total ≤ 30s**. mpeg/wav/aac/mp4/ogg. |
| `generate_audio` | boolean | No | `true` | Generate AI audio synced to the video. |
| `return_last_frame` | boolean | No | — | Return the output's last frame. **Cannot be `true` when `draft=true`.** |
| `resolution` | string | No | `720p` | `480p` \| `720p`. |
| `aspect_ratio` | string | No | `adaptive` | `16:9` \| `4:3` \| `1:1` \| `3:4` \| `9:16` \| `21:9` \| `adaptive`. |
| `duration` | number | No | `5` | Seconds. Range −1..30 (step 1). |
| `output_format` | string | No | `mp4` | `mp4` \| `mov`. |
| `web_search` | boolean | No | `false` | Enable online search. |
| `nsfw_checker` | boolean | No | `true` | Playground default true. |

### `draft` (undocumented in the param table)

The docs mention `draft` only in passing, under `return_last_frame`: *"When
draft=true, this parameter cannot be set to true."* No `draft` field is otherwise
listed — no type, default, or description. Understood intent (per project notes):
generate a cheap low-quality preview, then re-run at full quality if approved.
Not yet exposed by the tool; treat as unconfirmed until kie.ai documents it.

## Example request

```json
{
  "model": "bytedance/seedance-2-5",
  "input": {
    "prompt": "Reference @Image1 for the character. A martial-arts spear sequence, multi-angle tracking shots.",
    "reference_image_urls": ["https://.../char.png"],
    "generate_audio": true,
    "resolution": "720p",
    "aspect_ratio": "adaptive",
    "duration": 5,
    "output_format": "mp4",
    "nsfw_checker": true
  }
}
```

Response: `{ "code": 200, "msg": "success", "data": { "taskId": "..." } }` —
then poll `recordInfo` (see [README.md](README.md)).

## Notes

- Only Seedance model with `output_format`, `return_last_frame`, `adaptive`
  default, and 30s duration.
- No seed parameter is documented.
