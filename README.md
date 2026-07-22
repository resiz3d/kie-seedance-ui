# Seedance 2 App

A tiny web app for generating with [kie.ai](https://kie.ai) models, switchable per
generation: **Seedance 2** / **Seedance 2 Fast** / **Seedance 2 Mini** (video; Fast
and Mini are 480p/720p only)
and **Seedream 5.0 Lite** image-to-image / text-to-image (the form adapts: quality
tier instead of resolution/duration, image references only — or none at all for
text-to-image — and results display as images).
A small Express server keeps your API key on the server side (never exposed to the
browser) and proxies requests to the kie.ai API. A single-page UI lets you submit a
prompt + reference media, then polls until the video is ready.

![Screenshot of the Seedance app](screenshot.png)

## Features

- **Drag-and-drop reference media** — images, videos, and audio each have a
  dropzone: drop local files (or click to browse, or drag a URL in). Files are
  saved locally on drop and only uploaded to kie.ai's file host when you click
  Generate. Each shows a thumbnail with an **×** to remove and a **Clear all**
  button.
- **Media gallery** — every dropped file is kept in a gallery (video/audio get a
  kind badge); expand it to click any past item back into the matching reference
  list. Hosting happens fresh at generate time, so kie.ai's ~3-day URL expiry
  never matters.
- **Labeled, reorderable references** — thumbnails are labeled `Image1`/`Video1`/
  `Audio1`, … matching the `@Image1`-style tokens you use in the prompt. Drag
  thumbnails to reorder within a list; the labels (and the order sent to the API)
  update accordingly.
- **Generation history** — every successful generation is saved to `history.json`
  with its prompt, settings, reference URLs, and measured credit cost. Each entry
  has **Re-import** (load the settings back into the form) and **Re-run** (load +
  generate again). Re-runs re-host the saved reference images automatically.
- **Saved videos** — finished videos are downloaded into the `video/` folder, and
  the history record links to both the local copy and the original URL.
- **Reload-safe** — the in-flight task id is saved to `localStorage`, so closing or
  reloading the tab mid-generation resumes polling automatically on the next load
  (generations can take 5+ minutes; nothing is held on an open connection).
- **Projects** — divide generations into projects via the header switcher (＋ new,
  ✎ rename, 🗑 delete). Each project gets its own `images/<slug>/` and
  `video/<slug>/` subfolders; the gallery is strictly per-project and history can
  be filtered by project (or All). Re-running another project's generation warns
  before saving the result to the active project. Deleting a project moves its
  media and history to Default. Pre-project data is auto-migrated to Default on
  first start.
- **Live credit balance** — shown in the header (`GET /api/v1/chat/credit`), with a
  refresh button.
- **Cost estimate** — kie.ai has no price-preview API, so cost is *measured*: the
  exact `creditsConsumed` reported by the task-detail API (falling back to the
  credit-balance delta around the run) is stored in history. The estimate next to
  the Generate button is seeded from known per-second rates (480p ≈ 19 credits/s,
  720p ≈ 41 credits/s, audio on) and refines itself from your measured runs per
  resolution + audio setting. Reference videos appear to bill by the combined
  input + output duration, so their measured lengths are added to the estimate
  (with a warning if they exceed the 15s total input limit).

## Setup

> **New to git, Node, or the terminal?** Follow the step-by-step
> [beginner's install guide](INSTALL.md) instead — no prior knowledge needed.

You'll need [Node.js](https://nodejs.org) 18+ (uses the built-in `fetch`).

```bash
# 1. Install dependencies
npm install

# 2. Add your API key
cp .env.example .env        # on Windows: copy .env.example .env
#   then edit .env and paste your key from https://kie.ai/api-key

# 3. Run it
npm start
```

Open <http://localhost:3000> in your browser.

For auto-restart while developing: `npm run dev`.

## Getting an API key

1. Go to <https://kie.ai/api-key>
2. Create a key and copy it into `.env` as `KIE_API_KEY=...`

**Each person running the app needs their own key.** Generations are billed to the
key's account.

## Updating to a newer version (complete beginner)

New features and fixes land over time. How you update depends on how you first
**got** the app. Not sure which you did? If your app folder contains a hidden
`.git` folder, you cloned it — use the git steps. If you downloaded and unzipped
a file, use the ZIP steps.

Whichever method you use, your personal stuff is always kept:

- **`.env`** — your API key, password, and any settings
- **`history.json`, `images.json`, `projects.json`** — your generation history,
  gallery, and projects
- **the `video` and `images` folders** — your saved videos and reference media

> 💡 Five-second safety net: before updating, make a copy of your whole app
> folder (right-click → Copy, then Paste) so you can fall back to it if anything
> goes wrong.

### If you downloaded the ZIP

You're not using git, so you re-download and carry your personal files across:

1. On the project's GitHub page, click the green **`<> Code`** button →
   **Download ZIP**, and unzip it into a **new** folder (don't overwrite the old
   one yet).
2. From your **old** app folder, copy these into the **new** folder, replacing
   what's there when asked:
   - the file `.env`
   - any of `history.json`, `images.json`, `projects.json` that exist
   - the `video` folder and the `images` folder

   *(These files are hidden from GitHub on purpose, so the new download won't
   contain them — that's why you copy your own across.)*
3. Open a terminal in the **new** folder (see the
   [install guide](INSTALL.md#step-3--open-a-terminal-in-the-project-folder) if
   you're unsure how) and run:

   ```
   npm install
   ```

4. Start it as usual with `npm start`. Once you've confirmed the new folder
   works, you can delete the old one.

### If you cloned with git

Your personal files are ignored by git, so they're left untouched — updating is
two commands. Open a terminal in the app folder and run:

```
git pull
npm install
```

Then start it again with `npm start`.

- `git pull` downloads the latest code. `npm install` picks up any new libraries
  (safe to run even when there are none).
- If `git pull` prints something about **"local changes"** that would be
  overwritten, it means you edited a tracked file. If you didn't change anything
  on purpose, run `git stash` first, then `git pull` again. If you're stuck,
  the ZIP method above always works as a fallback.

## Security / sharing notes

- **Never commit `.env`.** It holds your secret API key and is listed in
  `.gitignore`. Only `.env.example` (a key-less template) is tracked.
- If you deploy this somewhere public, anyone who can reach the URL can spend your
  API credits, since the key lives on the server. Keep it local or behind auth.

## Accessing from other devices on your home network

By default the server listens on `127.0.0.1`, so only the PC it runs on can reach
it. To open it to your phone/laptop on the same Wi-Fi:

1. Set `HOST=0.0.0.0` in `.env` and restart (`npm start`).
2. The startup message prints the URL(s) to use, e.g. `http://192.168.1.50:3000`.
   Enter that on the other device's browser.
3. On Windows you may get a one-time "Allow Node.js through the firewall" prompt —
   allow it for **Private** networks only.

By default there is **no login**, so anyone on your network who opens that URL can
use the app and spend your kie.ai credits. Set a password (below) if you enable
LAN access. Either way, only enable it on a network you trust, and **never**
port-forward it or otherwise expose it to the public internet.

## Password protection (optional)

Set `APP_PASSWORD` in `.env` and restart to require a password before the app can
be used:

```
APP_PASSWORD=your-shared-password
```

When set, every page, API call, and saved media file requires signing in first —
a simple password page appears until you enter it. The sign-in is remembered in a
cookie for 30 days per browser. Leave `APP_PASSWORD` blank/unset for no login
(the default). Recommended whenever you turn on LAN access. Note this is a single
shared password meant for a trusted home network, not per-user accounts.

## How it works

| Endpoint | What it does |
| --- | --- |
| `POST /api/create` | Builds the `bytedance/seedance-2` payload and calls `createTask`. |
| `GET /api/status?taskId=...` | Proxies `recordInfo` so the UI can poll for the result. |
| `GET /api/credits` | Proxies the account credit balance. |
| `GET/POST /api/projects`, `PUT/DELETE /api/projects/:id` | Project CRUD; delete moves contents to Default. |
| `POST /api/upload` | Saves dropped media (image/video/audio) to `images/` locally — no API call. |
| `POST /api/reupload` | Hosts a saved local file (by id) on kie.ai at generate time; returns a fresh URL. |
| `GET /api/images` | Lists the saved media gallery. |
| `DELETE /api/images/:id` | Removes an item from the gallery. |
| `POST /api/save` | Downloads the finished video into `video/` and appends the record (incl. measured cost) to `history.json`. |
| `GET /api/history` | Returns the saved generation history. |

The browser never sees `KIE_API_KEY` — it only talks to this local server.

## Project layout

```
server.js          Express proxy (holds the API key)
public/index.html  UI
public/style.css   styling
public/app.js      form handling, image upload, polling, history
.env.example       template — copy to .env and add your key
video/<project>/   downloaded result videos (git-ignored, created at runtime)
images/<project>/  saved reference media — images/video/audio (git-ignored, created at runtime)
history.json       generation history (git-ignored, created at runtime)
images.json        saved-media gallery manifest (git-ignored, created at runtime)
projects.json      project list (git-ignored, created at runtime)
```

The `video/` and `images/` locations can be moved off the app folder by setting
`VIDEO_DIR` and/or `IMAGES_DIR` in `.env` (absolute path, or relative to the app
folder). The per-project subfolders are still created inside whatever you choose.

## License & Disclaimer

This project is licensed under the [MIT License](LICENSE). In plain English:

**This software is provided "as is", without warranty of any kind, and you use
it entirely at your own risk.** By downloading or running it you accept that
the author is **not responsible or liable** for:

- any damage to your computer, files, or data;
- any charges, credit consumption, or costs incurred on your kie.ai account
  (every generation spends real credits — the cost estimates shown in the app
  are approximations, not guarantees);
- anything you create, generate, publish, or otherwise do with this software
  or its outputs — that's on you, including complying with kie.ai's and
  ByteDance's terms of service and the laws that apply to you;
- the safekeeping of your API key. Your key is stored in a local `.env` file
  and sent only to kie.ai. If you commit it, share it, screenshot it, paste it
  somewhere public, or otherwise leak it, anyone who has it can spend your
  credits. Guard it accordingly.

This is an unofficial hobby tool. It is **not affiliated with, endorsed by, or
supported by kie.ai or ByteDance**. Their APIs, models, pricing, and terms can
change at any time and break this app without notice.
