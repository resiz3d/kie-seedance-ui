# Seedance 2.0 & 2.0 Fast — `bytedance/seedance-2`, `bytedance/seedance-2-fast`

Video models. Source: playground **Form** view at <https://kie.ai/seedance-2-0>,
retrieved 2026-08-18. See [README.md](README.md) for shared endpoints, auth,
polling, and error codes.

**Model ids** (as used by this tool, confirmed working against real generations):

- Standard: `bytedance/seedance-2`
- Fast: `bytedance/seedance-2-fast`

> Note: the `kie.ai/seedance-2-0` page's README header reads *"Complete guide to
> using bytedance/seedance-2-fast"*, and 2.0 and Fast appear to share the same
> documentation and identical parameters. Fast trades quality for speed/cost; the
> input schema is the same. Both cap resolution at 720p.

## `input` parameters

| Parameter | Type | Options / limits |
| --- | --- | --- |
| `prompt` | string | Text description of the video. |
| `first_frame_url` | string | Start keyframe. ≤30MB. jpeg/jpg/png/webp/gif/bmp. Mutually exclusive with `reference_image_urls`. |
| `last_frame_url` | string | End keyframe. Same limits. |
| `reference_image_urls` | string[] | Up to 9 images. ≤30MB each. jpeg/png/webp/jpg/gif. Mutually exclusive with first/last frame. |
| `reference_video_urls` | string[] | Up to 3. ≤50MB each; **total ≤ 15s**. mp4/quicktime/x-matroska. |
| `reference_audio_urls` | string[] | Up to 3. ≤15MB each; **total ≤ 15s**. mpeg/wav. |
| `generate_audio` | boolean | Generate AI audio synced to the video. |
| `resolution` | string | `480p` \| `720p`. |
| `aspect_ratio` | string | `16:9` \| `4:3` \| `1:1` \| `3:4` \| `9:16` \| `21:9`. **No `adaptive`** (that's Mini/2.5 only). |
| `duration` | number | Seconds. Marketing copy states 4–15s ("Flexible 4–15s Duration Control"); the tool uses min 4 / max 15. |
| `web_search` | boolean | Enable online search. |
| `nsfw_checker` | boolean | Playground default true. |

## Not supported (present on 2.5 only)

- `output_format` (mp4/mov) — not offered.
- `return_last_frame` — not offered.
- `aspect_ratio: adaptive` — not offered (Mini adds it; 2.0/Fast do not).

## Notes

- Multimodal: mixes text + image + video + audio references; strong at replicating
  camera motion/pacing from a reference video.
- Mutual exclusivity between `reference_image_urls` and first/last frames applies
  here too (rendered as separate "Frames" vs form tabs on the page).
