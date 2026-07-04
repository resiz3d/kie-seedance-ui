import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.kie.ai/api/v1/jobs";
const UPLOAD_URL = "https://kieai.redpandaai.co/api/file-base64-upload";
const CREDITS_URL = "https://api.kie.ai/api/v1/chat/credit";
const API_KEY = process.env.KIE_API_KEY;
const PORT = process.env.PORT || 3000;

const VIDEO_DIR = path.join(__dirname, "video");
const IMAGES_DIR = path.join(__dirname, "images");
const HISTORY_FILE = path.join(__dirname, "history.json");
const IMAGES_FILE = path.join(__dirname, "images.json");
const PROJECTS_FILE = path.join(__dirname, "projects.json");

if (!API_KEY) {
  console.error(
    "\n  Missing KIE_API_KEY. Copy .env.example to .env and add your key.\n" +
      "  Get one at https://kie.ai/api-key\n"
  );
  process.exit(1);
}

fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// --- json file helpers ----------------------------------------------------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- projects ---------------------------------------------------------------
function ensureDefaultProject() {
  const projects = readJson(PROJECTS_FILE);
  if (!projects.some((p) => p.id === "default")) {
    projects.unshift({ id: "default", name: "Default", slug: "default", createdAt: new Date().toISOString() });
    writeJson(PROJECTS_FILE, projects);
  }
  return projects;
}

// Resolve a projectId to a project, falling back to Default.
function resolveProject(projectId) {
  const projects = ensureDefaultProject();
  return projects.find((p) => p.id === projectId) || projects.find((p) => p.id === "default");
}

function slugify(name, projects) {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  let slug = base;
  let n = 2;
  while (projects.some((p) => p.slug === slug)) slug = `${base}-${n++}`;
  return slug;
}

// Move a gallery entry's file into another project's subfolder and fix its paths.
function moveGalleryEntry(entry, targetSlug) {
  const fileName = path.basename(entry.storedName);
  const from = path.join(IMAGES_DIR, entry.storedName);
  const newStored = `${targetSlug}/${fileName}`;
  const to = path.join(IMAGES_DIR, newStored);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(from)) fs.renameSync(from, to);
  entry.storedName = newStored;
  entry.localUrl = `/images/${newStored}`;
}

// Move a history entry's saved video into another project's subfolder.
function moveHistoryVideo(entry, targetSlug) {
  if (!entry.localVideo?.startsWith("/video/")) return;
  const rel = entry.localVideo.slice("/video/".length);
  const fileName = path.basename(rel);
  const from = path.join(VIDEO_DIR, rel);
  const to = path.join(VIDEO_DIR, targetSlug, fileName);
  if (from === to) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(from)) fs.renameSync(from, to);
  entry.localVideo = `/video/${targetSlug}/${fileName}`;
}

// One-time migration: stamp pre-project data with the Default project and move
// flat files into default/ subfolders. Idempotent — skips already-stamped entries.
function migrateToProjects() {
  ensureDefaultProject();
  fs.mkdirSync(path.join(IMAGES_DIR, "default"), { recursive: true });
  fs.mkdirSync(path.join(VIDEO_DIR, "default"), { recursive: true });

  const images = readJson(IMAGES_FILE);
  let changed = false;
  for (const entry of images) {
    if (entry.projectId) continue;
    try {
      moveGalleryEntry(entry, "default");
    } catch (err) {
      console.error(`Migration: failed to move ${entry.storedName}:`, err.message);
      continue;
    }
    entry.projectId = "default";
    changed = true;
  }
  if (changed) writeJson(IMAGES_FILE, images);

  const history = readJson(HISTORY_FILE);
  changed = false;
  for (const entry of history) {
    if (entry.projectId) continue;
    entry.projectId = "default";
    try {
      moveHistoryVideo(entry, "default");
    } catch (err) {
      console.error(`Migration: failed to move ${entry.localVideo}:`, err.message);
    }
    changed = true;
  }
  if (changed) writeJson(HISTORY_FILE, history);
}

// Startup sweep: ensure each history entry's saved video lives in its project's
// folder. Entries reassigned under the old restamp-only behavior can have their
// video left in another project's folder. Idempotent, best-effort.
function reconcileVideoLocations() {
  const projects = ensureDefaultProject();
  const history = readJson(HISTORY_FILE);
  let changed = false;
  for (const entry of history) {
    if (!entry.localVideo?.startsWith("/video/")) continue;
    const proj =
      projects.find((p) => p.id === (entry.projectId || "default")) ||
      projects.find((p) => p.id === "default");
    if (entry.localVideo.startsWith(`/video/${proj.slug}/`)) continue;
    const before = entry.localVideo;
    try {
      moveHistoryVideo(entry, proj.slug);
      changed = true;
      console.log(`Reconciled video into ${proj.slug}/: ${before}`);
    } catch (err) {
      console.error(`Failed to reconcile ${before}:`, err.message);
    }
  }
  if (changed) writeJson(HISTORY_FILE, history);
}

// Same sweep for gallery media (images/videos/audio): move any file whose
// on-disk location doesn't match its entry's project into images/<slug>/.
// Entries stamped with a no-longer-existing project fall back to Default.
function reconcileGalleryLocations() {
  const projects = ensureDefaultProject();
  const images = readJson(IMAGES_FILE);
  let changed = false;
  for (const entry of images) {
    const proj =
      projects.find((p) => p.id === (entry.projectId || "default")) ||
      projects.find((p) => p.id === "default");
    if (entry.storedName?.startsWith(`${proj.slug}/`)) continue;
    const before = entry.storedName;
    try {
      moveGalleryEntry(entry, proj.slug);
      entry.projectId = proj.id; // re-stamp in case the old project no longer exists
      changed = true;
      console.log(`Reconciled media into ${proj.slug}/: ${before}`);
    } catch (err) {
      console.error(`Failed to reconcile ${before}:`, err.message);
    }
  }
  if (changed) writeJson(IMAGES_FILE, images);
}

migrateToProjects();
reconcileVideoLocations();
reconcileGalleryLocations();

const app = express();
app.use(express.json({ limit: "120mb" })); // base64 video can approach ~67MB for a 50MB file
app.use(express.static(path.join(__dirname, "public")));
app.use("/video", express.static(VIDEO_DIR)); // saved videos (per-project subfolders)
app.use("/images", express.static(IMAGES_DIR)); // saved reference media (per-project subfolders)

// Upload a data-URL / base64 string to kie.ai's file host. Returns downloadUrl.
async function uploadToKie(base64Data, fileName) {
  const up = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      base64Data,
      uploadPath: "seedance-app/references",
      fileName,
    }),
  });
  const body = await up.json().catch(() => ({}));
  return { ok: up.ok, downloadUrl: body?.data?.downloadUrl, body };
}

// Shared helper to call the upstream API and forward the result/status.
async function forward(res, upstreamPromise) {
  try {
    const upstream = await upstreamPromise;
    const body = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(body);
  } catch (err) {
    console.error("Upstream error:", err);
    res.status(502).json({ code: 502, msg: "Failed to reach Seedance API" });
  }
}

// --- create generation task ---------------------------------------------
const ALLOWED_MODELS = new Set([
  "bytedance/seedance-2",
  "bytedance/seedance-2-fast",
  "seedream/5-lite-image-to-image",
  "seedream/5-lite-text-to-image",
]);

app.post("/api/create", (req, res) => {
  const { model: requestedModel, ...input } = req.body || {};
  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : "bytedance/seedance-2";
  const clean = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === "" || v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  forward(
    res,
    fetch(`${API_BASE}/createTask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model, input: clean }),
    })
  );
});

// --- poll task status / result ------------------------------------------
app.get("/api/status", (req, res) => {
  const taskId = req.query.taskId;
  if (!taskId) return res.status(400).json({ code: 400, msg: "taskId is required" });
  forward(
    res,
    fetch(`${API_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
  );
});

// --- open the output folder in the OS file explorer -----------------------
// Only ever opens VIDEO_DIR or one of its project subfolders — no arbitrary paths.
app.post("/api/open-folder", (req, res) => {
  const { projectId } = req.body || {};
  let dir = VIDEO_DIR;
  if (projectId && projectId !== "all") {
    dir = path.join(VIDEO_DIR, resolveProject(projectId).slug);
  }
  fs.mkdirSync(dir, { recursive: true });
  const cmd =
    process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref();
    res.json({ code: 200, msg: "opened" });
  } catch (err) {
    console.error("Failed to open folder:", err);
    res.status(500).json({ code: 500, msg: "Failed to open folder" });
  }
});

// --- health check (used by the client's server-down banner) ---------------
app.get("/api/ping", (req, res) => {
  res.json({ ok: true });
});

// --- account credit balance ---------------------------------------------
app.get("/api/credits", (req, res) => {
  forward(res, fetch(CREDITS_URL, { headers: { Authorization: `Bearer ${API_KEY}` } }));
});

// --- projects CRUD --------------------------------------------------------
app.get("/api/projects", (req, res) => {
  res.json({ code: 200, msg: "success", data: ensureDefaultProject() });
});

app.post("/api/projects", (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ code: 400, msg: "name is required" });
  const projects = ensureDefaultProject();
  const proj = { id: randomUUID(), name, slug: slugify(name, projects), createdAt: new Date().toISOString() };
  projects.push(proj);
  writeJson(PROJECTS_FILE, projects);
  fs.mkdirSync(path.join(IMAGES_DIR, proj.slug), { recursive: true });
  fs.mkdirSync(path.join(VIDEO_DIR, proj.slug), { recursive: true });
  res.json({ code: 200, msg: "created", data: proj });
});

app.put("/api/projects/:id", (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ code: 400, msg: "name is required" });
  const projects = ensureDefaultProject();
  const proj = projects.find((p) => p.id === req.params.id);
  if (!proj) return res.status(404).json({ code: 404, msg: "project not found" });
  proj.name = name; // slug (and folders) intentionally stay put on rename
  writeJson(PROJECTS_FILE, projects);
  res.json({ code: 200, msg: "renamed", data: proj });
});

// Delete a project: its gallery media and history move to Default.
app.delete("/api/projects/:id", (req, res) => {
  if (req.params.id === "default") {
    return res.status(403).json({ code: 403, msg: "The Default project cannot be deleted" });
  }
  const projects = ensureDefaultProject();
  const proj = projects.find((p) => p.id === req.params.id);
  if (!proj) return res.status(404).json({ code: 404, msg: "project not found" });

  const images = readJson(IMAGES_FILE);
  for (const entry of images) {
    if (entry.projectId !== proj.id) continue;
    try {
      moveGalleryEntry(entry, "default");
    } catch (err) {
      console.error(`Failed to move ${entry.storedName} to default:`, err.message);
    }
    entry.projectId = "default";
  }
  writeJson(IMAGES_FILE, images);

  const history = readJson(HISTORY_FILE);
  for (const entry of history) {
    if (entry.projectId !== proj.id) continue;
    entry.projectId = "default";
    try {
      moveHistoryVideo(entry, "default");
    } catch (err) {
      console.error(`Failed to move ${entry.localVideo} to default:`, err.message);
    }
  }
  writeJson(HISTORY_FILE, history);

  writeJson(PROJECTS_FILE, projects.filter((p) => p.id !== proj.id));
  // remove the now-empty project folders (best-effort)
  for (const dir of [path.join(IMAGES_DIR, proj.slug), path.join(VIDEO_DIR, proj.slug)]) {
    try {
      fs.rmdirSync(dir);
    } catch {}
  }
  res.json({ code: 200, msg: "deleted; contents moved to Default" });
});

// mime subtype → file extension for stored media
const EXT_MAP = {
  jpeg: "jpg",
  quicktime: "mov",
  "x-matroska": "mkv",
  "x-wav": "wav",
  mpeg: "mp3",
};

// --- save dropped media locally (NO API call — happens at generate time) ---
app.post("/api/upload", (req, res) => {
  const { base64Data, fileName, projectId } = req.body || {};
  if (!base64Data) return res.status(400).json({ code: 400, msg: "base64Data is required" });

  const proj = resolveProject(projectId);
  const m = /^data:([^;]+);base64,(.+)$/s.exec(base64Data);
  const mime = m ? m[1] : "image/png";
  const rawB64 = m ? m[2] : base64Data;
  const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "image";
  const sub = mime.split("/")[1] || "png";
  // audio/mp4 needs to be distinguished from video/mp4
  const ext = kind === "audio" && sub === "mp4" ? "m4a" : EXT_MAP[sub] || sub;
  const id = randomUUID();
  const storedName = `${proj.slug}/${id}.${ext}`;

  try {
    fs.mkdirSync(path.join(IMAGES_DIR, proj.slug), { recursive: true });
    fs.writeFileSync(path.join(IMAGES_DIR, storedName), Buffer.from(rawB64, "base64"));
  } catch (err) {
    console.error("Failed to save file:", err);
    return res.status(500).json({ code: 500, msg: "Failed to save file" });
  }

  const entry = {
    id,
    kind, // image | video | audio (older entries without this field are images)
    projectId: proj.id,
    storedName,
    name: fileName || storedName,
    mime,
    localUrl: `/images/${storedName}`,
    createdAt: new Date().toISOString(),
  };
  const images = readJson(IMAGES_FILE);
  images.unshift(entry);
  writeJson(IMAGES_FILE, images);

  res.json({ code: 200, msg: "ok", image: entry });
});

// --- host a saved local file on kie.ai, return a fresh URL (at generate) ---
app.post("/api/reupload", async (req, res) => {
  const { id } = req.body || {};
  const images = readJson(IMAGES_FILE);
  const entry = images.find((i) => i.id === id);
  if (!entry) return res.status(404).json({ code: 404, msg: "file not found" });

  try {
    const buf = fs.readFileSync(path.join(IMAGES_DIR, entry.storedName));
    const dataUrl = `data:${entry.mime};base64,${buf.toString("base64")}`;
    const up = await uploadToKie(dataUrl, entry.name);
    if (!up.downloadUrl) throw new Error(up.body?.msg || "upload failed");
    res.json({ code: 200, msg: "ok", hostedUrl: up.downloadUrl });
  } catch (err) {
    console.error("Re-upload failed:", err);
    res.status(502).json({ code: 502, msg: "Failed to re-host file" });
  }
});

// --- gallery: list / delete saved media -----------------------------------
app.get("/api/images", (req, res) => {
  res.json({ code: 200, msg: "success", data: readJson(IMAGES_FILE) });
});

// --- move a gallery item to another project (file physically moves) -------
app.put("/api/images/:id", (req, res) => {
  const { projectId } = req.body || {};
  const projects = ensureDefaultProject();
  const proj = projects.find((p) => p.id === projectId);
  if (!proj) return res.status(400).json({ code: 400, msg: "unknown projectId" });

  const images = readJson(IMAGES_FILE);
  const entry = images.find((i) => i.id === req.params.id);
  if (!entry) return res.status(404).json({ code: 404, msg: "file not found" });

  if ((entry.projectId || "default") !== proj.id) {
    try {
      moveGalleryEntry(entry, proj.slug);
    } catch (err) {
      console.error("Failed to move file:", err);
      return res.status(409).json({ code: 409, msg: "Failed to move the file (is it open elsewhere?)" });
    }
    entry.projectId = proj.id;
    writeJson(IMAGES_FILE, images);
  }
  res.json({ code: 200, msg: "moved", data: entry });
});

app.delete("/api/images/:id", (req, res) => {
  const images = readJson(IMAGES_FILE);
  const entry = images.find((i) => i.id === req.params.id);
  if (!entry) return res.status(404).json({ code: 404, msg: "file not found" });
  try {
    fs.rmSync(path.join(IMAGES_DIR, entry.storedName), { force: true });
  } catch (err) {
    console.error("Failed to delete file:", err);
  }
  writeJson(IMAGES_FILE, images.filter((i) => i.id !== req.params.id));
  res.json({ code: 200, msg: "deleted" });
});

// --- save a finished generation to history (+ download the video) -------
app.post("/api/save", async (req, res) => {
  const { input, taskId, resultUrl, costCredits, imageLocalIds, mediaLocalIds, projectId, refVideoSeconds } =
    req.body || {};
  if (!resultUrl) return res.status(400).json({ code: 400, msg: "resultUrl is required" });

  const proj = resolveProject(projectId);
  const id = `${Date.now()}`;
  let localVideo = null;

  try {
    const r = await fetch(resultUrl);
    if (r.ok) {
      const ext = (resultUrl.split("?")[0].match(/\.(\w+)$/)?.[1] || "mp4").toLowerCase();
      const fileName = `${id}.${ext}`;
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.join(VIDEO_DIR, proj.slug), { recursive: true });
      fs.writeFileSync(path.join(VIDEO_DIR, proj.slug, fileName), buf);
      localVideo = `/video/${proj.slug}/${fileName}`;
    }
  } catch (err) {
    console.error("Failed to download video:", err);
  }

  const entry = {
    id,
    createdAt: new Date().toISOString(),
    taskId: taskId || null,
    projectId: proj.id,
    input: input || {},
    resultUrl,
    localVideo,
    costCredits: typeof costCredits === "number" ? costCredits : null,
    // total seconds of reference video inputs (video refs bill by combined duration)
    refVideoSeconds: typeof refVideoSeconds === "number" ? refVideoSeconds : 0,
    imageLocalIds: Array.isArray(imageLocalIds) ? imageLocalIds : [],
    // per-kind local ids: { image: [], video: [], audio: [] }
    mediaLocalIds: mediaLocalIds && typeof mediaLocalIds === "object" ? mediaLocalIds : null,
  };

  const entries = readJson(HISTORY_FILE);
  entries.unshift(entry);
  writeJson(HISTORY_FILE, entries);

  res.json({ code: 200, msg: "saved", data: entry });
});

app.get("/api/history", (req, res) => {
  res.json({ code: 200, msg: "success", data: readJson(HISTORY_FILE) });
});

// --- reassign a history entry to another project (video file moves too) ---
app.put("/api/history/:id", (req, res) => {
  const { projectId } = req.body || {};
  const projects = ensureDefaultProject();
  const proj = projects.find((p) => p.id === projectId);
  if (!proj) return res.status(400).json({ code: 400, msg: "unknown projectId" });

  const entries = readJson(HISTORY_FILE);
  const entry = entries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ code: 404, msg: "history entry not found" });

  if ((entry.projectId || "default") !== proj.id) {
    try {
      moveHistoryVideo(entry, proj.slug);
    } catch (err) {
      console.error("Failed to move video:", err);
      return res.status(409).json({ code: 409, msg: "Failed to move the video file (is it playing?)" });
    }
    entry.projectId = proj.id;
    writeJson(HISTORY_FILE, entries);
  }
  res.json({ code: 200, msg: "updated", data: entry });
});

app.listen(PORT, () => {
  console.log(`\n  Seedance app running:  http://localhost:${PORT}\n`);
});
