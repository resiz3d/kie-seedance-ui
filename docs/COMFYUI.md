# Local ComfyUI workflows

Run local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) workflows from the
same UI you use for the kie.ai models. Nothing is hard-coded: drop workflow files
in a folder, mark the values you want to control with `{{tokens}}`, and the UI
builds a form for them automatically.

## Setup

1. Have ComfyUI running. By default the app looks for it at
   `http://127.0.0.1:8188`. Point elsewhere with `COMFYUI_URL` in `.env`:

   ```
   COMFYUI_URL=http://127.0.0.1:8188
   ```

2. Put **API-format** workflow exports (`.json`) in the `workflows/` folder (change
   the location with `WORKFLOWS_DIR` in `.env`). In ComfyUI, enable
   *Settings → Enable Dev mode Options* and use **Save (API Format)** — this is the
   flat `{ "<nodeId>": { "inputs": …, "class_type": … } }` shape, not the editor's
   graph export.

3. Reload the app. Each workflow appears in the **Model** dropdown under
   **Local · ComfyUI**.

## Tokens

Replace any value in the workflow JSON with a token to expose it as a control:

```jsonc
"129": { "inputs": { "noise_seed": "{{seed=14}}" } },      // number, default 14
"132": { "inputs": { "value": "{{duration=25}}" } },       // number, default 25
"138": { "inputs": { "value": "{{prompt}}" } },            // big text box
"137": { "inputs": { "image": "{{first_frame}}" } }        // image upload
```

Grammar: `{{ name }}`, `{{ name=default }}`, or `{{ name=default|opt1|opt2 }}`.

Dropdown options can be plain values, or **`Label=value`** to show a friendly label
while writing a different value — handy for on/off toggles:

```jsonc
// strength 1 = on, 0 = off; the dropdown shows "Enabled" / "Disabled"
"142": { "inputs": { "strength_model": "{{turbo_lora=1|Enabled=1|Disabled=0}}" } },
"124": { "inputs": { "steps": "{{steps=8}}" } }
```

If every option value is a number, the dropdown sends a number (so a `strength_model`
of `0` stays numeric, not `"0"`).

- The **same token name** can appear in multiple nodes — it renders one control and
  fills every occurrence.
- If a token is the **entire** value, its type is preserved (a number stays a
  number in the JSON). Tokens embedded in a longer string interpolate as text.

### Control inference

The control is chosen from the token, in this order:

| Rule | Control |
| --- | --- |
| Has inline options `\|a\|b` | dropdown |
| Name contains `prompt` | multi-line text box |
| Name contains `audio` | audio upload (checked before video, so `ref_video_audio` reads as audio) |
| Name contains `video` | video upload |
| Name contains `image` / `img` / `frame` / `photo` / `picture` | image upload |
| Name contains a numeric hint (`seed`, `steps`, `cfg`, `width`, `height`, `length`, `duration`, `fps`, `frames`, `count`, `denoise`, `strength`, `scale`, `megapixel`, `batch`) **or** the default is a number | number box (a `seed` box also gets a 🎲 and a **control-after-generate** dropdown) |
| otherwise | single-line text box |

Image / video / audio controls all save dropped files to the project gallery and
offer **Pick from gallery**; the chosen file is uploaded to ComfyUI at generate
time and included in exports.

**Seed — control after generate.** Any number token whose name contains `seed`
gets a `fixed / increment / decrement / randomize` dropdown next to it (like
ComfyUI's seed widget). After you queue a run, the seed advances per that setting
so the next run differs (or stays fixed). The 🎲 randomizes it immediately. The
mode itself is part of last-used settings, so it's remembered per workflow.

**Defaults.** A token's `=default` sets the starting value in the JSON — the way to
bake in a default (e.g. `{{steps=8}}`). On top of that, the form **remembers your
last-used settings per workflow**: after you run one, it reopens prefilled with what
you last used — control values, the media files you picked (by gallery reference),
and the seed's fixed/increment/randomize mode. Last-used settings override the token
defaults; clear your browser storage to reset them.

**Layout hints.** Controls render in a 12-column grid. A token can carry trailing
`;`-separated hints to control its layout — they're ignored when the value is sent:

- **width**: `; 1/2`, `; 1/3`, `; 1/4`, `; 2/3`, `; 3/4`, `; full` — the column span.
  Untagged controls, the prompt, and reference-file dropzones always span full width.
- **order**: `; #N` — sort position (ascending). Tokens without one keep their
  scan order, after any explicitly-ordered ones.

```jsonc
// half-width, shown first
"115": { "inputs": { "aspect_ratio": "{{aspect_ratio=3:4 (Portrait Standard)|... ; 1/2 ; #1}}" } },
// quarter-width, shown eighth
"142": { "inputs": { "strength_model": "{{turbo_lora=1|Enabled=1|Disabled=0 ; 1/4 ; #8}}" } }
```

To force a dropdown for something like an aspect-ratio node, list the exact strings
the node accepts:

```jsonc
"115": { "inputs": { "aspect_ratio":
  "{{aspect_ratio=3:4 (Portrait Standard)|16:9 (Landscape Standard)|1:1 (Square)}}" } }
```

## Image inputs & the gallery

Image controls work like the kie.ai reference dropzones:

- **Drop or browse** a file and it's saved into the current project's gallery
  (`images/<project>/`), the same store the API side uses — so it's reusable and
  shows up in exports.
- **Pick from gallery** to reuse any image already saved in the project.

At generate time the chosen image is pushed into ComfyUI's input folder and its
gallery id is recorded on the History entry, so a **project export** bundles
ComfyUI input images alongside API ones.

### Optional / multiple references

A workflow can wire many reference-loader nodes (e.g. all 9 image / 3 video /
3 audio slots of MiniMax H3) and tokenize each with a **numbered series** —
`{{picture1}}`…`{{picture9}}`, `{{ref_video1}}`…, `{{ref_audio1}}`….

Media tokens that share a base name and end in a number are **grouped into one
multi-upload field** — the *same* component as the kie.ai reference-images dropzone,
so it supports **drag-to-reorder**, **view full size** (⤢), and **Pick from
gallery**. Add several files; they're numbered in order (Picture 1, Picture 2, …),
matching the `<Picture N>` prompt tags, and you can drag them to re-sort. The Nth
file fills the Nth token; the field's width/order come from the first token in the
series (`picture1`). URL drops aren't accepted here — ComfyUI needs a real file, so
drop or browse a file (it's saved to the gallery first).

Media is **optional**: any slot you leave empty has its **loader node pruned** from
the submitted workflow (with its now-dangling connections), so you only fill the
references you have — no "empty input" errors. Files fill from the top, so slots
stay contiguous. (Pruning doesn't renumber, so a hand-built workflow that fills
non-contiguous slots could leave a gap the node may reject — not possible via the
grouped field, which always fills in order.)

## How a run works

1. Image inputs are saved to the gallery, then pushed to ComfyUI (`/upload/image`).
2. Empty optional reference loaders are pruned; remaining tokens are substituted
   into a copy of the workflow (your file is never modified).
3. The workflow is queued (`/prompt`); the app polls `/history/{id}`. While it runs,
   the server also listens on ComfyUI's `/ws` and reports **live progress** (sampler
   step count) — the job card shows a bar and `step N/M (X%)` — plus a **host-stats
   strip** (CPU %, GPU %, VRAM) above the job cards. The strip is shown whenever a
   ComfyUI workflow is selected (refreshing every 5s, or every 2s during a run) so you
   can watch VRAM even between runs. GPU %/VRAM come from `nvidia-smi` when available;
   without it, VRAM falls back to ComfyUI's `/system_stats` and GPU % is shown as `–`.
4. The first video/animation/image output is downloaded into your `video/<project>/`
   folder and added to History — the **same folders and History** as a kie.ai
   generation, so mixed local+API projects export together. No credits are involved.

## Notes & limits

- Local models are labelled **Experimental** in the UI — the token/control layer is
  generic and hasn't been exercised across many node types yet.
- Requires a workflow that **saves an output** (e.g. `VHS_VideoCombine`,
  `SaveImage`) — that's what the app pulls the result from.
- Re-import from History reselects the workflow, refills text/number/dropdown
  values, and re-populates the media fields from the run's saved gallery files
  (any file since deleted from the gallery is skipped).
- Errors from ComfyUI surface on the job card in readable form: a validation
  rejection (e.g. a model that isn't installed) is parsed from `node_errors` into
  lines like `CheckpointLoaderSimple (node 12): Value not in list — ckpt_name: '…'
  not in […]`, and a mid-run failure shows the failing node type + exception message.
  Common runtime failures get a short headline instead of the raw traceback: **out
  of VRAM**, **model mismatch** (state-dict/size mismatch), and **missing file**.
- The bundled `workflows/Minimax H3 (Ref2Video).json` is a tokenized example showing
  every control type: `prompt` (text), up to **9 image / 3 video / 3 audio**
  optional references (`picture1`…`picture9`, `ref_video1`…, `ref_audio1`…),
  `seed`/`duration`/`steps` (numbers), `aspect_ratio`/`megapixels`/`scheduler`/`ref_image_size`
  (dropdowns), and `turbo_lora` (Enabled/Disabled toggle via `Label=value`), plus
  width/order layout hints.
