import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import os from "node:os";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.kie.ai/api/v1/jobs";
const UPLOAD_URL = "https://kieai.redpandaai.co/api/file-stream-upload";
const CREDITS_URL = "https://api.kie.ai/api/v1/chat/credit";
const API_KEY = process.env.KIE_API_KEY;
const PORT = process.env.PORT || 3000;
// Network interface to bind. Default 127.0.0.1 = this PC only. Set HOST=0.0.0.0
// in .env to also accept connections from other devices on your home network
// (see the security warning printed at startup).
const HOST = process.env.HOST || "127.0.0.1";
// Optional password gate. When APP_PASSWORD is set in .env, every page/route
// (UI, API, and saved media) requires signing in first; unset = no auth.
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_ENABLED = APP_PASSWORD.length > 0;

// Media output folders — override via .env (VIDEO_DIR / IMAGES_DIR) to store
// elsewhere. A relative value resolves against the app root; an absolute path is
// used as-is. Per-project subfolders are still created inside these.
const VIDEO_DIR = path.resolve(__dirname, process.env.VIDEO_DIR || "video");
const IMAGES_DIR = path.resolve(__dirname, process.env.IMAGES_DIR || "images");
// Where "Export" writes shareable, self-contained history bundles (one subfolder
// per export). Override via EXPORTS_DIR; created on demand, not at startup.
const EXPORTS_DIR = path.resolve(__dirname, process.env.EXPORTS_DIR || "exports");
const HISTORY_FILE = path.join(__dirname, "history.json");
const IMAGES_FILE = path.join(__dirname, "images.json");
const PROJECTS_FILE = path.join(__dirname, "projects.json");

// --- ComfyUI (optional local backend) -------------------------------------
// Point at a running ComfyUI instance to run local workflows from the UI.
// WORKFLOWS_DIR holds ComfyUI API-format .json exports, optionally tokenized
// with {{name=default|opt|opt}} placeholders. See docs/COMFYUI.md.
const COMFYUI_URL = (process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
const WORKFLOWS_DIR = path.resolve(__dirname, process.env.WORKFLOWS_DIR || "workflows");
// Per-workflow config (chosen model/LoRA/VAE/sampler + the dynamic LoRA list),
// stored server-side so it's shared across devices (incl. the phone over LAN).
const COMFY_SETTINGS_DIR = path.resolve(__dirname, process.env.COMFY_SETTINGS_DIR || "settings/comfy");

if (!API_KEY) {
  console.error(
    "\n  Missing KIE_API_KEY. Copy .env.example to .env and add your key.\n" +
      "  Get one at https://kie.ai/api-key\n"
  );
  process.exit(1);
}

fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });

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

// --- optional password gate (active only when APP_PASSWORD is set) ----------
const AUTH_COOKIE = "seedance_auth";
// A stable, non-reversible token derived from the password: what we store in the
// cookie and re-check on every request (survives restarts, reveals no plaintext).
const AUTH_TOKEN = AUTH_ENABLED
  ? createHash("sha256").update(`seedance-auth:${APP_PASSWORD}`).digest("hex")
  : "";

function tokenFor(password) {
  return createHash("sha256").update(`seedance-auth:${password}`).digest("hex");
}
function tokenValid(token) {
  if (!token || token.length !== AUTH_TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
  } catch {
    return false;
  }
}
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Minimal dark-themed sign-in page (self-contained — served before static, so it
// can't rely on /style.css).
function loginPage(error = false) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Seedance — Sign in</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f1115;color:#e6e8ec;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  form{background:#181b22;border:1px solid #2a2f3a;border-radius:12px;padding:1.75rem;width:min(340px,90vw);
    display:flex;flex-direction:column;gap:0.85rem}
  h1{margin:0;font-size:1.15rem}
  p{margin:0;color:#8a92a3;font-size:0.85rem}
  input{background:#0f1115;border:1px solid #2a2f3a;border-radius:8px;color:#e6e8ec;
    padding:0.6rem 0.7rem;font-size:1rem}
  button{background:#6c8cff;border:none;border-radius:8px;color:#fff;padding:0.6rem;
    font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#5577ff}
  .err{color:#ff6b6b;font-size:0.85rem;${error ? "" : "display:none"}}
</style></head><body>
<form id="f">
  <h1>Seedance</h1>
  <p>Enter the password to continue.</p>
  <input id="pw" type="password" autocomplete="current-password" autofocus placeholder="Password" />
  <div class="err" id="err">Incorrect password.</div>
  <button type="submit">Sign in</button>
</form>
<script>
  const f=document.getElementById("f"),err=document.getElementById("err");
  f.addEventListener("submit",async(e)=>{
    e.preventDefault();err.style.display="none";
    const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:document.getElementById("pw").value})});
    if(r.ok){location.reload();}else{err.style.display="block";document.getElementById("pw").select();}
  });
</script></body></html>`;
}

if (AUTH_ENABLED) {
  // Reachable while signed out so a user can authenticate.
  app.post("/api/login", (req, res) => {
    const password = String(req.body?.password ?? "");
    if (tokenValid(tokenFor(password))) {
      res.cookie(AUTH_COOKIE, AUTH_TOKEN, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: "/",
      });
      return res.json({ code: 200, msg: "ok" });
    }
    res.status(401).json({ code: 401, msg: "Incorrect password" });
  });
  app.post("/api/logout", (req, res) => {
    res.clearCookie(AUTH_COOKIE, { path: "/" });
    res.json({ code: 200, msg: "ok" });
  });

  // Gate everything else: valid cookie → continue; browser navigation → login
  // page; any other request → 401.
  app.use((req, res, next) => {
    if (tokenValid(readCookie(req, AUTH_COOKIE))) return next();
    if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
      return res.status(200).type("html").send(loginPage());
    }
    res.status(401).json({ code: 401, msg: "Authentication required" });
  });
}

app.use(express.static(path.join(__dirname, "public")));
app.use("/video", express.static(VIDEO_DIR)); // saved videos (per-project subfolders)
app.use("/images", express.static(IMAGES_DIR)); // saved reference media (per-project subfolders)

// Upload raw file bytes to kie.ai's file host (multipart stream — no base64
// inflation, ~25% less upstream bandwidth than the old base64 endpoint).
// Returns downloadUrl.
async function uploadToKie(buf, mime, fileName) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), fileName || "file");
  form.append("uploadPath", "seedance-app/references");
  if (fileName) form.append("fileName", fileName);
  const up = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
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
  "bytedance/seedance-2-5",
  "bytedance/seedance-2",
  "bytedance/seedance-2-fast",
  "bytedance/seedance-2-mini",
  "seedream/5-lite-image-to-image",
  "seedream/5-lite-text-to-image",
  "seedream/5-pro-image-to-image",
  "seedream/5-pro-text-to-image",
]);

app.post("/api/create", (req, res) => {
  // `generatePreview` is a UI-only flag (stored in History, honored by the client);
  // strip it so it isn't forwarded to the kie.ai API as an unknown input field.
  const { model: requestedModel, generatePreview, ...input } = req.body || {};
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

// =========================================================================
// ComfyUI: run local API-format workflows from the UI. Workflows live in
// WORKFLOWS_DIR and may contain {{name=default|opt|opt}} tokens; the UI renders
// a control per token and posts back {file, values}. We substitute, forward to
// ComfyUI /prompt, and normalize /history polling into the same shape the
// kie.ai path uses so the frontend job flow is shared.
// =========================================================================

// Parse a single token body (the text between {{ }}): "name", "name=default",
// "name=default|opt1|opt2", plus optional trailing layout hints separated by ";":
// a width ("; 1/4") and/or an order ("; #8"). Returns {name, default, options,
// width, order}. Hints are layout-only and ignored when substituting values.
const WIDTH_RE = /^(full|1|1\/2|1\/3|1\/4|2\/3|3\/4)$/;
function parseTokenSpec(inner) {
  inner = String(inner);
  let width = null;
  let order = null;
  // Strip trailing "; <hint>" segments (a width like "1/4" and/or an order "#8").
  for (;;) {
    const semi = inner.lastIndexOf(";");
    if (semi < 0) break;
    const h = inner.slice(semi + 1).trim();
    const orderMatch = h.match(/^#(\d+)$/);
    if (WIDTH_RE.test(h)) width = h;
    else if (orderMatch) order = Number(orderMatch[1]);
    else break;
    inner = inner.slice(0, semi);
  }
  const parts = inner.split("|");
  const head = parts[0] || "";
  const options = parts.slice(1).map((s) => s.trim()).filter((s) => s.length);
  const eq = head.indexOf("=");
  const name = (eq >= 0 ? head.slice(0, eq) : head).trim();
  const def = eq >= 0 ? head.slice(eq + 1).trim() : "";
  return { name, default: def, options, width, order };
}

// All distinct tokens in a workflow's raw text, first occurrence wins.
function parseWorkflowTokens(text) {
  const seen = new Map();
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const spec = parseTokenSpec(m[1]);
    if (spec.name && !seen.has(spec.name)) seen.set(spec.name, spec);
  }
  return [...seen.values()];
}

// Replace tokens in a string. If the whole string is a single token, return the
// raw value (preserving number/boolean type); otherwise interpolate as text.
function resolveTokenString(str, values) {
  const whole = str.match(/^\s*\{\{([\s\S]*)\}\}\s*$/);
  if (whole) {
    const spec = parseTokenSpec(whole[1]);
    const v = values[spec.name];
    return v !== undefined && v !== null ? v : spec.default;
  }
  return str.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner) => {
    const spec = parseTokenSpec(inner);
    const v = values[spec.name];
    return String(v !== undefined && v !== null ? v : spec.default);
  });
}

// Deep-clone a parsed workflow, substituting tokens in every string leaf.
function substituteWorkflow(node, values) {
  if (typeof node === "string") return resolveTokenString(node, values);
  if (Array.isArray(node)) return node.map((n) => substituteWorkflow(n, values));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substituteWorkflow(v, values);
    return out;
  }
  return node;
}

// Resolve a workflow filename to a path inside WORKFLOWS_DIR (no traversal).
function workflowPath(file) {
  if (!file || typeof file !== "string") return null;
  const resolved = path.resolve(WORKFLOWS_DIR, file);
  const base = path.resolve(WORKFLOWS_DIR);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  if (!resolved.toLowerCase().endsWith(".json")) return null;
  return resolved;
}

// List workflows + their tokens (so the UI can render controls).
app.get("/api/workflows", (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    /* dir missing — treated as empty */
  }
  const list = files.sort().map((file) => {
    try {
      const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
      JSON.parse(text); // validate it's JSON (tokens are valid JSON strings)
      return { file, name: file.replace(/\.json$/i, ""), tokens: parseWorkflowTokens(text) };
    } catch (err) {
      return { file, name: file.replace(/\.json$/i, ""), tokens: [], error: err.message };
    }
  });
  res.json({ code: 200, msg: "success", data: list });
});

// Enriched token metadata for one workflow: combo tokens get their installed-file
// options and numeric tokens get min/max/step, both from ComfyUI's /object_info.
// Also returns the installed LoRA list for the dynamic-LoRA picker. `offline: true`
// when ComfyUI is unreachable (the client then locks the picker controls).
app.get("/api/comfy/workflow-meta", async (req, res) => {
  const wfPath = workflowPath(req.query.file);
  if (!wfPath || !fs.existsSync(wfPath)) return res.status(400).json({ code: 400, msg: "Unknown workflow file" });
  let workflow, tokens;
  try {
    const text = fs.readFileSync(wfPath, "utf8");
    workflow = JSON.parse(text);
    tokens = parseWorkflowTokens(text);
  } catch (err) {
    return res.status(400).json({ code: 400, msg: `Workflow is not valid JSON: ${err.message}` });
  }
  // Attach each token's node input key (e.g. `vae_name`, `image`) — available even
  // offline, and used to tell a model-file selector from a media-upload field.
  const nodeMap = mapTokenNodes(workflow);
  const withKeys = tokens.map((t) => ({
    ...t,
    inputKey: nodeMap.get(t.name)?.input || null,
    nodeId: nodeMap.get(t.name)?.id || null,
  }));
  const bypassable = bypassableNodes(workflow); // enable/disable toggles (offline-safe)
  let objectInfo;
  try {
    objectInfo = await getObjectInfo();
  } catch {
    return res.json({
      code: 200,
      msg: "success",
      data: { offline: true, tokens: withKeys, loraOptions: [], bypassable },
    });
  }
  const enriched = withKeys.map((t) => enrichToken(t, nodeMap, objectInfo));
  res.json({
    code: 200,
    msg: "success",
    data: { offline: false, tokens: enriched, loraOptions: loraOptionsFrom(objectInfo), bypassable },
  });
});

// Per-workflow saved config (chosen values + LoRA list), stored server-side so
// it's shared across devices. Read {} when nothing saved yet.
function comfySettingsPath(file) {
  const base = path.basename(String(file || ""), ".json").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base ? path.join(COMFY_SETTINGS_DIR, `${base}.json`) : null;
}
app.get("/api/comfy/settings", (req, res) => {
  const p = comfySettingsPath(req.query.file);
  if (!p) return res.status(400).json({ code: 400, msg: "file is required" });
  let data = {};
  if (fs.existsSync(p)) {
    try {
      data = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      data = {};
    }
  }
  res.json({ code: 200, msg: "success", data });
});
app.put("/api/comfy/settings", (req, res) => {
  const p = comfySettingsPath(req.query.file);
  if (!p) return res.status(400).json({ code: 400, msg: "file is required" });
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJson(p, req.body && typeof req.body === "object" ? req.body : {});
    res.json({ code: 200, msg: "saved" });
  } catch (err) {
    console.error("Failed to save comfy settings:", err);
    res.status(500).json({ code: 500, msg: "Failed to save settings" });
  }
});

// Upload one image into ComfyUI's input folder; returns the LoadImage-ready name.
// Source is either a base64 data URL or a saved gallery item `id` (so ComfyUI
// inputs are the same locally-stored files the API side uses).
app.post("/api/comfy/upload", async (req, res) => {
  const { base64Data, fileName, id } = req.body || {};
  let buf, name;
  try {
    if (id) {
      const entry = readJson(IMAGES_FILE).find((i) => i.id === id);
      if (!entry) return res.status(404).json({ code: 404, msg: "gallery item not found" });
      buf = fs.readFileSync(path.join(IMAGES_DIR, entry.storedName));
      name = entry.name || fileName || "image.png";
    } else if (base64Data) {
      buf = Buffer.from(String(base64Data).split(",").pop(), "base64");
      name = fileName || "image.png";
    } else {
      return res.status(400).json({ code: 400, msg: "base64Data or id is required" });
    }
    const form = new FormData();
    form.append("image", new Blob([buf]), name);
    form.append("overwrite", "true");
    const r = await fetch(`${COMFYUI_URL}/upload/image`, { method: "POST", body: form });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.name) {
      return res.status(502).json({ code: 502, msg: "ComfyUI rejected the image upload" });
    }
    const ref = body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
    res.json({ code: 200, msg: "success", data: { filename: ref } });
  } catch (err) {
    console.error("ComfyUI upload error:", err);
    res.status(502).json({ code: 502, msg: `Could not reach ComfyUI at ${COMFYUI_URL}` });
  }
});

// True if any of a node's input strings contains a token with the given name.
function nodeHasToken(node, name) {
  for (const v of Object.values(node?.inputs || {})) {
    if (typeof v !== "string") continue;
    const re = /\{\{([\s\S]*?)\}\}/g;
    let m;
    while ((m = re.exec(v)) !== null) if (parseTokenSpec(m[1]).name === name) return true;
  }
  return false;
}

// Remove loader nodes whose (optional) media token was left empty, plus any
// now-dangling `[nodeId, idx]` connections that referenced them. Lets a workflow
// wire many reference slots while the user fills only the ones they have.
function pruneWorkflow(workflow, pruneNames) {
  if (!Array.isArray(pruneNames) || !pruneNames.length) return workflow;
  const removed = new Set();
  for (const name of pruneNames) {
    for (const [id, node] of Object.entries(workflow)) {
      if (nodeHasToken(node, name)) removed.add(id);
    }
  }
  for (const id of removed) delete workflow[id];
  for (const node of Object.values(workflow)) {
    if (!node?.inputs) continue;
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && removed.has(String(v[0]))) delete node.inputs[k];
    }
  }
  return workflow;
}

// --- ComfyUI /object_info: available files + input metadata -------------------
// Cached briefly so the workflow-meta endpoint and lora injection don't hammer it.
let objectInfoCache = null;
let objectInfoAt = 0;
const OBJECT_INFO_TTL_MS = 30000;
async function getObjectInfo(force = false) {
  if (!force && objectInfoCache && Date.now() - objectInfoAt < OBJECT_INFO_TTL_MS) return objectInfoCache;
  const r = await fetch(`${COMFYUI_URL}/object_info`);
  if (!r.ok) throw new Error(`object_info ${r.status}`);
  objectInfoCache = await r.json();
  objectInfoAt = Date.now();
  return objectInfoCache;
}

// Map each token name → the node id + class_type + input key it first appears in,
// so we can look its allowed values / numeric range up in /object_info and group it
// under its node's enable/disable toggle.
function mapTokenNodes(workflow) {
  const map = new Map();
  for (const [id, node] of Object.entries(workflow || {})) {
    const cls = node?.class_type;
    if (!cls || !node.inputs) continue;
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v !== "string") continue;
      const re = /\{\{([\s\S]*?)\}\}/g;
      let m;
      while ((m = re.exec(v)) !== null) {
        const name = parseTokenSpec(m[1]).name;
        if (name && !map.has(name)) map.set(name, { id, classType: cls, input: k });
      }
    }
  }
  return map;
}

// Attach /object_info metadata to a token: a combo (enum) becomes a dropdown of the
// installed files/choices; a FLOAT/INT gets its min/max/step. Author-supplied
// inline options (|a|b) always win. A combo that's an *uploadable* media input
// (LoadImage.image, VHS_LoadVideo.video, …) carries `uploadKind` so the UI shows an
// upload dropzone instead of a file dropdown — distinguishing e.g. `video`
// (uploadable) from `vae_name` (a model-file picker whose token happens to be named
// "video_vae").
function enrichToken(token, nodeMap, objectInfo) {
  if (token.options && token.options.length) return token;
  const loc = nodeMap.get(token.name);
  if (!loc) return token;
  const info = objectInfo?.[loc.classType];
  const spec = info?.input?.required?.[loc.input] || info?.input?.optional?.[loc.input];
  if (!Array.isArray(spec)) return token;
  const [type, cfg] = spec;
  // A combo (enum) is reported one of two ways: legacy nodes put the choices array
  // directly in `type` (e.g. VAELoader.vae_name); newer-schema nodes report the
  // string "COMBO" with the choices in cfg.options (e.g. KSamplerSelect.sampler_name).
  const comboOptions = Array.isArray(type) ? type : type === "COMBO" ? cfg?.options : null;
  if (Array.isArray(comboOptions)) {
    const key = (loc.input || "").toLowerCase();
    let uploadKind = null;
    if (cfg?.image_upload || key === "image") uploadKind = "image";
    else if (cfg?.video_upload || key === "video") uploadKind = "video";
    else if (cfg?.audio_upload || key === "audio") uploadKind = "audio";
    return { ...token, combo: true, comboOptions, uploadKind };
  }
  if (type === "FLOAT" || type === "INT") {
    // ComfyUI reports "unbounded" fields with sentinel bounds (±sys.maxsize,
    // ±float_max). Passed to <input min/max>, those break the spinner: the browser
    // uses `min` as the stepping base and at ~1e18+ magnitude can't represent normal
    // values, so the arrows do nothing. Drop bounds beyond the safe-integer range so
    // the field is treated as unbounded (arrows work) instead.
    const sane = (v) => (Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? v : null);
    return {
      ...token,
      num: type === "INT" ? "int" : "float",
      min: sane(cfg?.min),
      max: sane(cfg?.max),
      step: sane(cfg?.step) ?? (type === "INT" ? 1 : null),
    };
  }
  return token;
}

// The installed LoRA file list (for the dynamic-LoRA picker).
function loraOptionsFrom(objectInfo) {
  return (
    objectInfo?.LoraLoader?.input?.required?.lora_name?.[0] ||
    objectInfo?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] ||
    []
  );
}

// --- dynamic LoRA injection --------------------------------------------------
const clampStrength = (v) => Math.max(-5, Math.min(5, Number(v) || 0));
const linkEq = (a, b) =>
  Array.isArray(a) && a.length === 2 && Array.isArray(b) && String(a[0]) === String(b[0]) && a[1] === b[1];

// Splice a chain of LoraLoader nodes between the workflow's MODEL/CLIP source and
// everything that consumes them — so any workflow gets extra LoRAs without being
// pre-wired. `loras` is [{name, strength}]. Throws if no MODEL source is found.
function injectLoras(workflow, loras) {
  const enabled = (Array.isArray(loras) ? loras : []).filter((l) => l && l.name);
  if (!enabled.length) return workflow;

  const samplerClasses = new Set(["KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"]);
  const linkInput = (pred) => {
    // Prefer a sampler's model link; fall back to any node with a `model` link input.
    for (const node of Object.values(workflow)) {
      if (samplerClasses.has(node.class_type) && Array.isArray(node.inputs?.model) && pred("model", node)) {
        return node.inputs.model;
      }
    }
    for (const node of Object.values(workflow)) {
      if (Array.isArray(node.inputs?.model)) return node.inputs.model;
    }
    return null;
  };
  const modelSource = linkInput(() => true);
  if (!modelSource) throw new Error("Couldn't find a MODEL input to attach LoRAs to (is this a checkpoint workflow?).");

  let clipSource = null;
  for (const node of Object.values(workflow)) {
    // Any CLIP text encoder (CLIPTextEncode, CLIPTextEncodeSDXL, …) with a clip link.
    if (/cliptextencode/i.test(node.class_type || "") && Array.isArray(node.inputs?.clip)) {
      clipSource = node.inputs.clip;
      break;
    }
  }
  const useClip = !!clipSource;

  // Capture consumers of the original sources BEFORE adding the lora nodes.
  const modelConsumers = [];
  const clipConsumers = [];
  for (const [id, node] of Object.entries(workflow)) {
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (linkEq(v, modelSource)) modelConsumers.push([id, k]);
      if (useClip && linkEq(v, clipSource)) clipConsumers.push([id, k]);
    }
  }

  let nextId = 1 + Math.max(0, ...Object.keys(workflow).map((k) => Number(k)).filter(Number.isFinite));
  let prevModel = modelSource;
  let prevClip = clipSource;
  for (const l of enabled) {
    const id = String(nextId++);
    const s = clampStrength(l.strength);
    if (useClip) {
      workflow[id] = {
        class_type: "LoraLoader",
        inputs: { lora_name: l.name, strength_model: s, strength_clip: s, model: prevModel, clip: prevClip },
      };
      prevModel = [id, 0];
      prevClip = [id, 1];
    } else {
      workflow[id] = {
        class_type: "LoraLoaderModelOnly",
        inputs: { lora_name: l.name, strength_model: s, model: prevModel },
      };
      prevModel = [id, 0];
    }
  }
  for (const [id, k] of modelConsumers) workflow[id].inputs[k] = prevModel;
  if (useClip) for (const [id, k] of clipConsumers) workflow[id].inputs[k] = prevClip;
  return workflow;
}

// Remove an optional "patch" node (e.g. Sage Attention) and reconnect its
// passthrough, so it can be disabled for users who don't have that custom node
// installed. The passthrough source is the node's `model` link input (or its sole
// link input); consumers of the node's output are rewired to that source.
function bypassNode(workflow, id) {
  const node = workflow[id];
  if (!node) return;
  const linkInputs = Object.entries(node.inputs || {}).filter(([, v]) => Array.isArray(v) && v.length === 2);
  const src =
    (Array.isArray(node.inputs?.model) && node.inputs.model) ||
    (linkInputs.length === 1 ? linkInputs[0][1] : null);
  for (const n of Object.values(workflow)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && String(v[0]) === String(id)) {
        if (src) n.inputs[k] = src;
        else delete n.inputs[k];
      }
    }
  }
  delete workflow[id];
}

// Nodes an author marked `_meta.bypassable` — the UI offers an enable/disable toggle
// for each (so an optional custom node can be turned off).
function bypassableNodes(workflow) {
  return Object.entries(workflow || {})
    .filter(([, n]) => n?._meta?.bypassable)
    .map(([id, n]) => ({ id, title: n._meta.title || `Node ${id}` }));
}

// --- ComfyUI errors → friendly text ------------------------------------------
// Turn a /prompt validation rejection (node_errors) into readable lines instead
// of dumping raw JSON on the job card. A missing model reads as e.g.
// "CheckpointLoaderSimple (node 12): Value not in list — ckpt_name: 'x' not in […]".
function formatComfyPromptError(body) {
  const lines = [];
  if (body?.error) {
    const e = body.error;
    const base = e.message || (typeof e === "string" ? e : "");
    if (base) lines.push(e.details ? `${base}: ${e.details}` : base);
  }
  for (const [nodeId, info] of Object.entries(body?.node_errors || {})) {
    const where = info.class_type ? `${info.class_type} (node ${nodeId})` : `node ${nodeId}`;
    for (const e of info.errors || []) {
      let detail = e.details || "";
      if (detail.length > 300) detail = detail.slice(0, 297) + "…";
      lines.push(detail ? `${where}: ${e.message} — ${detail}` : `${where}: ${e.message}`);
    }
  }
  return lines.length ? lines.join("\n") : "ComfyUI rejected the workflow.";
}

// Turn a /history execution_error into a readable one-liner. Common failures
// (out of VRAM, model mismatch, missing file) get a short plain-English headline
// instead of the raw traceback message.
function formatComfyExecError(entry) {
  const m = (entry.status?.messages || []).find((x) => x[0] === "execution_error");
  const info = m?.[1] || {};
  const raw = info.exception_message || "";
  const where = info.node_type ? `${info.node_type}: ` : "";
  const hay = `${info.exception_type || ""} ${raw}`.toLowerCase();
  if (hay.includes("out of memory") || hay.includes("outofmemory") || hay.includes("cuda oom")) {
    return `${where}Out of VRAM — the GPU ran out of memory. Try a lower resolution, fewer frames/steps, or a lighter model.`;
  }
  if (hay.includes("error(s) in loading state_dict") || hay.includes("size mismatch")) {
    return `${where}Model mismatch — a loaded checkpoint/LoRA doesn't fit this workflow's nodes.`;
  }
  if (hay.includes("no such file") || hay.includes("filenotfounderror") || hay.includes("cannot find")) {
    return `${where}Missing file — a model or input the workflow needs isn't where ComfyUI expects it.`;
  }
  if (!raw) return "ComfyUI reported an execution error.";
  return `${where}${raw}`;
}

// --- live progress via the ComfyUI websocket ---------------------------------
// ComfyUI broadcasts run progress (sampler steps, etc.) over /ws. We keep one
// connection and remember the latest {value,max} per prompt so /api/comfy/status
// can report a % while a run is in flight. The socket is opened lazily when a run
// is generated/polled, and the next poll reconnects it if it dropped.
const COMFY_WS_URL = COMFYUI_URL.replace(/^http/i, "ws") + "/ws?clientId=kie-seedance-ui";
let comfyWs = null;
let comfyWsConnecting = false;
let comfyCurrentPrompt = null;
const comfyProgress = new Map(); // promptId -> { value, max, updatedAt }

function ensureComfyWs() {
  if (comfyWs || comfyWsConnecting) return;
  comfyWsConnecting = true;
  let ws;
  try {
    ws = new WebSocket(COMFY_WS_URL);
  } catch {
    comfyWsConnecting = false;
    return;
  }
  const drop = () => {
    if (comfyWs === ws) comfyWs = null;
    comfyWsConnecting = false;
  };
  ws.addEventListener("open", () => { comfyWs = ws; comfyWsConnecting = false; });
  ws.addEventListener("close", drop);
  ws.addEventListener("error", drop);
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return; // ignore binary preview frames
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { type, data } = msg || {};
    if (type === "execution_start" || type === "executing") {
      if (data?.prompt_id) comfyCurrentPrompt = data.prompt_id;
    } else if (type === "progress") {
      const pid = data?.prompt_id || comfyCurrentPrompt;
      if (pid && Number.isFinite(data?.value) && Number.isFinite(data?.max)) {
        comfyProgress.set(pid, { value: data.value, max: data.max, updatedAt: Date.now() });
      }
    } else if (
      type === "executed" ||
      type === "execution_success" ||
      type === "execution_error" ||
      type === "execution_interrupted"
    ) {
      if (data?.prompt_id) comfyProgress.delete(data.prompt_id);
    }
  });
}

// Drop progress we haven't heard about in 10 min (finished/abandoned prompts).
function pruneComfyProgress() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [pid, p] of comfyProgress) if (p.updatedAt < cutoff) comfyProgress.delete(pid);
}

// --- system stats (CPU / GPU / VRAM) -----------------------------------------
// CPU % is derived from host cpu-time deltas between calls (non-blocking). GPU
// utilization + VRAM come from `nvidia-smi` when present; if it isn't (no NVIDIA
// GPU / not on PATH), VRAM falls back to ComfyUI's /system_stats and GPU % is null.
function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}
let lastCpuSnap = null;
function cpuPercent() {
  const now = cpuSnapshot();
  const prev = lastCpuSnap;
  lastCpuSnap = now;
  if (!prev) return null; // need two samples; first call primes it
  const idleD = now.idle - prev.idle;
  const totalD = now.total - prev.total;
  if (totalD <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleD / totalD) * 100)));
}

let nvidiaSmiMissing = false; // stop shelling out once we know it's not there
function nvidiaSmi() {
  if (nvidiaSmiMissing) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu,memory.used,memory.total,name", "--format=csv,noheader,nounits"],
      { timeout: 2500, windowsHide: true },
      (err, stdout) => {
        if (err) {
          if (err.code === "ENOENT") nvidiaSmiMissing = true;
          return resolve(null);
        }
        const gpus = stdout
          .trim()
          .split("\n")
          .map((line) => {
            const [util, memUsed, memTotal, ...name] = line.split(",").map((s) => s.trim());
            return { util: Number(util), memUsed: Number(memUsed), memTotal: Number(memTotal), name: name.join(",") };
          })
          .filter((g) => Number.isFinite(g.util) && Number.isFinite(g.memTotal) && g.memTotal > 0);
        resolve(gpus.length ? gpus : null);
      }
    );
  });
}

// VRAM (in MiB) from ComfyUI when nvidia-smi is unavailable.
async function comfyVram() {
  try {
    const r = await fetch(`${COMFYUI_URL}/system_stats`);
    const s = await r.json();
    const dev = (s.devices || []).find((d) => d.type !== "cpu" && d.vram_total) || (s.devices || [])[0];
    if (!dev || !dev.vram_total) return null;
    const used = dev.vram_total - (dev.vram_free ?? 0);
    return {
      used: Math.round(used / 1048576),
      total: Math.round(dev.vram_total / 1048576),
      pct: Math.round((used / dev.vram_total) * 100),
    };
  } catch {
    return null;
  }
}

// Substitute a workflow's tokens and queue it on ComfyUI. Returns the promptId and
// a server-created pending History id (created atomically with queueing, so a flaky
// client — especially mobile — can't drop between queue and history-create and
// orphan the run).
app.post("/api/comfy/generate", async (req, res) => {
  ensureComfyWs(); // start listening for progress before the run begins
  const { file, values, prune, loras, bypass, input, mediaLocalIds, projectId, refVideoSeconds } = req.body || {};
  const wfPath = workflowPath(file);
  if (!wfPath || !fs.existsSync(wfPath)) {
    return res.status(400).json({ code: 400, msg: "Unknown workflow file" });
  }
  let workflow;
  try {
    workflow = JSON.parse(fs.readFileSync(wfPath, "utf8"));
    workflow = pruneWorkflow(workflow, prune); // drop empty optional reference loaders
    workflow = substituteWorkflow(workflow, values || {});
    for (const id of Array.isArray(bypass) ? bypass : []) bypassNode(workflow, String(id)); // disabled patch nodes
    workflow = injectLoras(workflow, loras); // splice in any dynamically-added LoRAs
  } catch (err) {
    return res.status(400).json({ code: 400, msg: err.message || "Workflow could not be prepared" });
  }
  try {
    const r = await fetch(`${COMFYUI_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.prompt_id) {
      return res.status(r.status || 502).json({ code: r.status || 502, msg: formatComfyPromptError(body) });
    }
    // Create the pending History entry now, so the server-side sweep can finish the
    // run even if the client never makes a second call.
    let historyId = null;
    try {
      const proj = resolveProject(projectId);
      const entry = makeHistoryEntry({
        id: `${Date.now()}`,
        taskId: body.prompt_id,
        projectId: proj.id,
        input: input || { model: `comfy:${file}`, values },
        mediaLocalIds,
        refVideoSeconds,
        imageLocalIds: mediaLocalIds?.image || [],
        status: "pending",
      });
      const entries = readJson(HISTORY_FILE);
      entries.unshift(entry);
      writeJson(HISTORY_FILE, entries);
      historyId = entry.id;
    } catch (err) {
      console.error("Failed to create pending history entry:", err);
    }
    res.json({ code: 200, msg: "success", data: { promptId: body.prompt_id, historyId } });
  } catch (err) {
    console.error("ComfyUI generate error:", err);
    res.status(502).json({ code: 502, msg: `Could not reach ComfyUI at ${COMFYUI_URL}` });
  }
});

// Collect a ComfyUI history entry's output files as viewable /view URLs (video/
// animation first, then stills).
function collectComfyOutputs(entry) {
  const urls = [];
  for (const out of Object.values(entry.outputs || {})) {
    for (const key of ["videos", "gifs", "images"]) {
      for (const f of out[key] || []) {
        urls.push(
          `${COMFYUI_URL}/view?filename=${encodeURIComponent(f.filename)}` +
            `&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${encodeURIComponent(f.type || "output")}`
        );
      }
    }
  }
  return urls;
}

// Actual execution time for a finished prompt, from ComfyUI's own timestamps in
// `status.messages` (execution_start → execution_success/error, epoch ms). This is
// the per-prompt run time — unlike now-minus-createdAt, it excludes time the prompt
// spent waiting behind earlier items when several are queued at once. Returns ms, or
// null if the timestamps aren't present.
function comfyExecRuntime(entry) {
  const messages = entry?.status?.messages;
  if (!Array.isArray(messages)) return null;
  let start = null;
  let end = null;
  for (const m of messages) {
    const [type, data] = m || [];
    const ts = Number(data?.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (type === "execution_start") start = start == null ? ts : Math.min(start, ts);
    else if (type === "execution_success" || type === "execution_error" || type === "execution_interrupted")
      end = end == null ? ts : Math.max(end, ts);
  }
  return start != null && end != null && end >= start ? end - start : null;
}

// Is a prompt still queued/running on ComfyUI? true/false, or null if unknown
// (ComfyUI unreachable).
async function comfyPromptQueued(promptId) {
  try {
    const q = await fetch(`${COMFYUI_URL}/queue`).then((r) => r.json());
    const inList = (list) => (list || []).some((it) => it[1] === promptId);
    return inList(q.queue_running) || inList(q.queue_pending);
  } catch {
    return null;
  }
}

// Poll a ComfyUI job; normalize to the kie.ai status shape the frontend expects.
app.get("/api/comfy/status", async (req, res) => {
  const promptId = req.query.promptId;
  if (!promptId) return res.status(400).json({ code: 400, msg: "promptId is required" });
  ensureComfyWs(); // keep the progress socket alive while a run is polled
  pruneComfyProgress();
  const prog = comfyProgress.get(promptId);
  const progress = prog ? { value: prog.value, max: prog.max } : undefined;
  try {
    const r = await fetch(`${COMFYUI_URL}/history/${encodeURIComponent(promptId)}`);
    const hist = await r.json().catch(() => ({}));
    const entry = hist?.[promptId];
    if (!entry) {
      // Not in history. Still queued/running → keep waiting; otherwise ComfyUI has
      // no record of it (usually it was restarted) → "lost", so the UI can stop
      // polling forever instead of spinning on "Generating…".
      const queued = await comfyPromptQueued(promptId);
      const state = queued === false ? "lost" : "waiting";
      if (state === "lost") comfyProgress.delete(promptId);
      return res.json({ code: 200, msg: "success", data: { state, progress } });
    }

    if (entry.status?.status_str === "error") {
      comfyProgress.delete(promptId);
      return res.json({ code: 200, msg: "success", data: { state: "fail", failMsg: formatComfyExecError(entry) } });
    }

    const urls = collectComfyOutputs(entry);
    if (!urls.length) return res.json({ code: 200, msg: "success", data: { state: "waiting", progress } });
    res.json({
      code: 200,
      msg: "success",
      // runtimeMs is ComfyUI's own per-prompt execution time so the client can store
      // the actual run time, not now-minus-created (which over-counts queued items).
      data: { state: "success", resultJson: JSON.stringify({ resultUrls: urls }), runtimeMs: comfyExecRuntime(entry) },
    });
  } catch (err) {
    console.error("ComfyUI status error:", err);
    res.status(502).json({ code: 502, msg: `Could not reach ComfyUI at ${COMFYUI_URL}` });
  }
});

// Cancel one ComfyUI job without stopping ComfyUI: drop it from the queue if it's
// still pending, or interrupt it if it's the one currently running.
app.post("/api/comfy/cancel", async (req, res) => {
  const promptId = req.body?.promptId;
  if (!promptId) return res.status(400).json({ code: 400, msg: "promptId is required" });
  try {
    const queue = await fetch(`${COMFYUI_URL}/queue`).then((r) => r.json()).catch(() => ({}));
    const inList = (list) => (list || []).some((item) => item[1] === promptId);
    const running = inList(queue.queue_running);
    const pending = inList(queue.queue_pending);
    if (pending) {
      await fetch(`${COMFYUI_URL}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
      });
    }
    if (running) await fetch(`${COMFYUI_URL}/interrupt`, { method: "POST" });
    res.json({ code: 200, msg: "cancelled", data: { running, pending } });
  } catch (err) {
    console.error("ComfyUI cancel error:", err);
    res.status(502).json({ code: 502, msg: `Could not reach ComfyUI at ${COMFYUI_URL}` });
  }
});

// --- server-side completion watcher ------------------------------------------
// A pending ComfyUI run is finished by whichever poller sees it done first: the
// browser, OR this background sweep. The sweep is the safety net — it copies the
// output and marks the entry done even if the browser was closed/tabbed away when
// the run finished (as long as this server + ComfyUI stay up). The watch list is
// just the pending comfy entries in history.json, so it survives a server restart.
const COMFY_WATCH_INTERVAL_MS = 15000;
const COMFY_LOST_GRACE_MS = 30000; // don't declare a prompt "lost" younger than this
let comfyWatchBusy = false;

// Finish one pending entry: download its output (→ done) or mark it failed. Re-reads
// history so it no-ops if the browser already finished the same entry.
async function finalizePendingComfy(id, { resultUrl, fail, runtimeMs }) {
  const entries = readJson(HISTORY_FILE);
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.status !== "pending") return; // already finished elsewhere
  if (resultUrl) {
    entry.resultUrl = resultUrl;
    const localVideo = await downloadOutput(resultUrl, resolveProject(entry.projectId), entry.id);
    if (localVideo) entry.localVideo = localVideo;
    entry.status = "done";
    // Prefer ComfyUI's own per-prompt execution time; fall back to since-created only
    // when it's unavailable (older ComfyUI / missing timestamps).
    entry.runtimeMs =
      typeof runtimeMs === "number" ? runtimeMs : Date.now() - new Date(entry.createdAt).getTime();
  } else {
    entry.status = "failed";
    if (fail) entry.error = fail;
  }
  // Re-read once more so a concurrent write (client result endpoint) isn't clobbered.
  const latest = readJson(HISTORY_FILE);
  const idx = latest.findIndex((e) => e.id === id);
  if (idx >= 0 && latest[idx].status === "pending") {
    latest[idx] = entry;
    writeJson(HISTORY_FILE, latest);
  }
}

async function sweepPendingComfy() {
  if (comfyWatchBusy) return;
  comfyWatchBusy = true;
  try {
    const pending = readJson(HISTORY_FILE).filter(
      (e) => e.status === "pending" && e.taskId && (e.input?.model || "").startsWith("comfy:")
    );
    if (!pending.length) return;
    let queueSnapshot = undefined; // fetched once, lazily, only if a prompt is missing
    for (const entry of pending) {
      let hist;
      try {
        hist = await fetch(`${COMFYUI_URL}/history/${encodeURIComponent(entry.taskId)}`).then((r) => r.json());
      } catch {
        return; // ComfyUI unreachable — leave entries pending, retry next sweep
      }
      const h = hist?.[entry.taskId];
      if (h) {
        if (h.status?.status_str === "error") {
          await finalizePendingComfy(entry.id, { fail: formatComfyExecError(h) });
        } else {
          const urls = collectComfyOutputs(h);
          if (urls.length) await finalizePendingComfy(entry.id, { resultUrl: urls[0], runtimeMs: comfyExecRuntime(h) });
          // in history but no outputs yet → still running; leave pending
        }
        continue;
      }
      // Not in history: give young prompts grace (submit→queue race), then decide.
      if (Date.now() - new Date(entry.createdAt).getTime() < COMFY_LOST_GRACE_MS) continue;
      if (queueSnapshot === undefined) {
        try {
          queueSnapshot = await fetch(`${COMFYUI_URL}/queue`).then((r) => r.json());
        } catch {
          return; // can't tell — leave pending
        }
      }
      const inQ = (list) => (list || []).some((it) => it[1] === entry.taskId);
      if (inQ(queueSnapshot.queue_running) || inQ(queueSnapshot.queue_pending)) continue; // still queued
      await finalizePendingComfy(entry.id, {
        fail:
          "ComfyUI has no record of this run (it was likely restarted after it finished). " +
          "Any output stays in ComfyUI's output folder; re-run to regenerate into the app.",
      });
    }
  } catch (err) {
    console.error("ComfyUI sweep error:", err);
  } finally {
    comfyWatchBusy = false;
  }
}
setInterval(sweepPendingComfy, COMFY_WATCH_INTERVAL_MS);
setTimeout(sweepPendingComfy, 4000); // an early pass shortly after startup

// Host CPU % + GPU util % + VRAM usage, for the live readout during local runs.
app.get("/api/comfy/stats", async (req, res) => {
  const cpu = cpuPercent();
  const ramTotal = os.totalmem();
  const ram = Math.round((1 - os.freemem() / ramTotal) * 100);
  let gpu = null;
  let vram = null;
  const gpus = await nvidiaSmi();
  if (gpus) {
    const g = gpus[0]; // primary GPU
    gpu = g.util;
    vram = { used: g.memUsed, total: g.memTotal, pct: Math.round((g.memUsed / g.memTotal) * 100) };
  } else {
    vram = await comfyVram(); // GPU % unavailable without nvidia-smi
  }
  res.json({ code: 200, msg: "success", data: { cpu, gpu, vram, ram } });
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

// --- export the visible history to a shareable, self-contained folder ------
const isImageOutputModel = (model) => (model || "").includes("-to-image");

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function modelLabel(model) {
  const m = model || "bytedance/seedance-2";
  if (m === "bytedance/seedance-2-5") return "Seedance 2.5";
  if (m === "bytedance/seedance-2") return "Seedance 2";
  if (m === "bytedance/seedance-2-fast") return "Seedance 2 Fast";
  if (m === "bytedance/seedance-2-mini") return "Seedance 2 Mini";
  const family = m.includes("5-pro") ? "Seedream 5.0 Pro" : "Seedream 5.0 Lite";
  if (m.includes("text-to-image")) return `${family} (text-to-image)`;
  if (m.includes("image-to-image")) return `${family} (image-to-image)`;
  return m;
}

// Ordered [label, value] rows shown under each entry's prompt.
function entryMetaRows(entry) {
  const input = entry.input || {};
  const rows = [["Model", modelLabel(input.model)]];
  if (isImageOutputModel(input.model)) {
    if (input.quality) rows.push(["Quality", input.quality]);
  } else {
    if (input.resolution) rows.push(["Resolution", input.resolution]);
    if (input.duration) rows.push(["Duration", `${input.duration}s`]);
  }
  if (input.aspect_ratio) rows.push(["Aspect ratio", input.aspect_ratio]);
  if (typeof entry.costCredits === "number") rows.push(["Cost", `${entry.costCredits.toLocaleString()} credits`]);
  if (entry.createdAt) rows.push(["Date", new Date(entry.createdAt).toLocaleString()]);
  return rows;
}

// A click-to-enlarge thumbnail (src is our own controlled relative path).
function exportThumb(kind, src, name) {
  const s = escapeHtml(src);
  if (kind === "video") {
    return `<button class="thumb" onclick="openLb('video','${s}')"><video src="${s}#t=0.1" muted preload="metadata"></video><span class="play">▶</span></button>`;
  }
  if (kind === "audio") {
    return `<button class="thumb audio" onclick="openLb('audio','${s}')"><span class="ico">♪</span><span class="nm">${escapeHtml(name || "audio")}</span></button>`;
  }
  return `<button class="thumb" onclick="openLb('image','${s}')"><img src="${s}" loading="lazy" alt="${escapeHtml(name || "")}"></button>`;
}

function buildExportHtml(view, meta) {
  const cards = view
    .map(({ entry, inputs, output }) => {
      const input = entry.input || {};
      const metaRows = entryMetaRows(entry)
        .map(([k, v]) => `<div class="mrow"><span class="mk">${escapeHtml(k)}</span><span class="mv">${escapeHtml(v)}</span></div>`)
        .join("");
      const inputThumbs = inputs.map((i) => exportThumb(i.kind, i.src, i.name)).join("");
      return `<section class="card">
  <div class="col left">
    <div class="prompt">${escapeHtml(input.prompt || "(no prompt)")}</div>
    <div class="meta">${metaRows}</div>
    ${
      inputs.length
        ? `<div class="lbl">Inputs (${inputs.length})</div><div class="thumbs">${inputThumbs}</div>`
        : `<div class="lbl">Inputs</div><div class="muted">None</div>`
    }
  </div>
  <div class="col right">
    <div class="lbl">Output</div>
    ${output ? exportThumb(output.kind, output.src, "") : `<div class="muted">Output not saved locally.</div>`}
  </div>
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Seedance export — ${escapeHtml(meta.scopeLabel)}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0f1115;color:#e6e8ec;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
  header{padding:1.5rem 1.25rem;border-bottom:1px solid #2a2f3a}
  h1{margin:0 0 .25rem;font-size:1.3rem}
  header p{margin:0;color:#8a92a3;font-size:.85rem}
  main{max-width:1100px;margin:0 auto;padding:1.25rem}
  .card{display:flex;gap:1rem;background:#181b22;border:1px solid #2a2f3a;border-radius:12px;padding:1rem;margin-bottom:1rem}
  .col{min-width:0}
  .left{flex:1.2}
  .right{flex:1;display:flex;flex-direction:column;align-items:flex-start}
  .prompt{white-space:pre-wrap;word-break:break-word;margin-bottom:.6rem}
  .meta{display:flex;flex-wrap:wrap;gap:.35rem .9rem;margin-bottom:.7rem}
  .mrow{font-size:.78rem}
  .mk{color:#8a92a3}
  .mv{color:#e6e8ec;margin-left:.3rem}
  .lbl{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:#8a92a3;margin:.4rem 0 .35rem}
  .thumbs{display:flex;flex-wrap:wrap;gap:.5rem}
  .muted{color:#8a92a3;font-size:.85rem}
  .thumb{position:relative;padding:0;border:1px solid #2a2f3a;border-radius:8px;overflow:hidden;background:#0f1115;cursor:zoom-in;width:120px;height:120px;display:flex;align-items:center;justify-content:center}
  .right .thumb{width:100%;height:auto;min-height:160px;max-height:420px}
  .thumb img,.thumb video{width:100%;height:100%;object-fit:contain;display:block}
  .right .thumb img,.right .thumb video{max-height:420px}
  .thumb .play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.6rem;color:#fff;text-shadow:0 1px 4px #000;pointer-events:none}
  .thumb.audio{flex-direction:column;gap:.25rem;color:#e6e8ec}
  .thumb.audio .ico{font-size:1.6rem}
  .thumb.audio .nm{font-size:.65rem;color:#8a92a3;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 .3rem}
  #lb{display:none;position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.88);align-items:center;justify-content:center;padding:2rem}
  #lb img,#lb video{max-width:92vw;max-height:92vh;border-radius:8px}
  #lb audio{width:min(480px,92vw)}
  .lb-x{position:fixed;top:16px;right:20px;width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:22px;display:flex;align-items:center;justify-content:center;cursor:pointer}
  @media(max-width:640px){.card{flex-direction:column}}
</style></head><body>
<header>
  <h1>Seedance export</h1>
  <p>${escapeHtml(meta.scopeLabel)} &middot; ${meta.count} generation${meta.count === 1 ? "" : "s"} &middot; <b>${meta.totalCredits.toLocaleString()} credits total</b> &middot; exported ${escapeHtml(new Date().toLocaleString())}</p>
</header>
<main>
${cards}
</main>
<div id="lb" onclick="closeLb(event)"><span class="lb-x">&times;</span><div id="lb-c"></div></div>
<script>
  function openLb(kind, src){
    var c=document.getElementById('lb-c'); c.innerHTML='';
    var el;
    if(kind==='video'){el=document.createElement('video');el.src=src;el.controls=true;el.autoplay=true;}
    else if(kind==='audio'){el=document.createElement('audio');el.src=src;el.controls=true;el.autoplay=true;}
    else{el=document.createElement('img');el.src=src;}
    c.appendChild(el);
    document.getElementById('lb').style.display='flex';
  }
  function closeLb(e){
    if(e.target.id==='lb' || (e.target.className && e.target.className.indexOf('lb-x')>-1)){
      document.getElementById('lb').style.display='none';
      document.getElementById('lb-c').innerHTML='';
    }
  }
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){document.getElementById('lb').style.display='none';document.getElementById('lb-c').innerHTML='';}
  });
</script>
</body></html>`;
}

app.post("/api/export", (req, res) => {
  const { projectId } = req.body || {};
  // Export is always scoped to a single project — there is no all-projects export.
  if (!projectId || projectId === "all") {
    return res.status(400).json({ code: 400, msg: "Choose a specific project to export." });
  }
  const scope = resolveProject(projectId);

  const allHistory = readJson(HISTORY_FILE);
  const entries = allHistory.filter((e) => (e.projectId || "default") === scope.id);
  if (!entries.length) {
    return res.status(400).json({ code: 400, msg: "No history to export for this project." });
  }

  const imgById = new Map(readJson(IMAGES_FILE).map((i) => [i.id, i]));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-07-30T12-34-56
  const folderName = `export-${scope.slug}-${stamp}`;
  const outDir = path.join(EXPORTS_DIR, folderName);

  try {
    fs.mkdirSync(path.join(outDir, "input"), { recursive: true });
    fs.mkdirSync(path.join(outDir, "output"), { recursive: true });
  } catch (err) {
    console.error("Export: failed to create folder:", err);
    return res.status(500).json({ code: 500, msg: "Failed to create export folder." });
  }

  let copied = 0;
  // Copy a source file into the given subfolder (input/ or output/) under
  // destName; returns the relative href or null.
  const copyInto = (srcAbs, subdir, destName) => {
    try {
      if (!srcAbs || !fs.existsSync(srcAbs)) return null;
      fs.copyFileSync(srcAbs, path.join(outDir, subdir, destName));
      copied++;
      return `${subdir}/${destName}`;
    } catch (err) {
      console.error("Export copy failed:", srcAbs, err.message);
      return null;
    }
  };

  const view = entries.map((entry) => {
    const media = entry.mediaLocalIds || { image: entry.imageLocalIds || [] };
    const inputs = [];
    for (const kind of ["image", "video", "audio"]) {
      const ids = Array.isArray(media[kind]) ? media[kind] : [];
      ids.forEach((id, idx) => {
        const g = imgById.get(id);
        if (!g) return; // gallery item was deleted — nothing local to copy
        const ext = path.extname(g.storedName) || "";
        const href = copyInto(path.join(IMAGES_DIR, g.storedName), "input", `${entry.id}-${kind}-${idx}${ext}`);
        if (href) inputs.push({ kind, src: href, name: g.name || "" });
      });
    }

    let output = null;
    if (entry.localVideo?.startsWith("/video/")) {
      const rel = entry.localVideo.slice("/video/".length);
      const ext = path.extname(rel) || "";
      const href = copyInto(path.join(VIDEO_DIR, rel), "output", `${entry.id}${ext}`);
      // Kind from the model, or from the file extension (ComfyUI outputs aren't
      // typed by the model id and may be images or video).
      const isImg = isImageOutputModel(entry.input?.model) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(rel);
      if (href) output = { kind: isImg ? "image" : "video", src: href };
    }
    return { entry, inputs, output };
  });

  try {
    const totalCredits = entries.reduce((sum, e) => sum + (typeof e.costCredits === "number" ? e.costCredits : 0), 0);
    const html = buildExportHtml(view, { scopeLabel: scope.name, count: entries.length, totalCredits });
    fs.writeFileSync(path.join(outDir, "index.html"), html);
  } catch (err) {
    console.error("Export: failed to write index.html:", err);
    return res.status(500).json({ code: 500, msg: "Failed to write export page." });
  }

  // Best-effort: reveal the finished export in the OS file browser.
  try {
    const cmd =
      process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [outDir], { detached: true, stdio: "ignore" }).unref();
  } catch {}

  res.json({
    code: 200,
    msg: "exported",
    data: { folder: folderName, path: outDir, entries: entries.length, filesCopied: copied },
  });
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
    const up = await uploadToKie(buf, entry.mime, entry.name);
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

// Download a finished result into a project's video folder; returns the served
// /video/... path, or null on failure.
async function downloadOutput(resultUrl, proj, id) {
  try {
    const r = await fetch(resultUrl);
    if (!r.ok) return null;
    // Extension from the path, or from a ?filename= query (ComfyUI /view uses that).
    let fnameHint = resultUrl.split("?")[0];
    try {
      const q = new URL(resultUrl, "http://localhost").searchParams.get("filename");
      if (q) fnameHint = q;
    } catch {
      /* non-URL resultUrl — fall back to the path */
    }
    const ext = (fnameHint.match(/\.(\w+)$/)?.[1] || "mp4").toLowerCase();
    const fileName = `${id}.${ext}`;
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.join(VIDEO_DIR, proj.slug), { recursive: true });
    fs.writeFileSync(path.join(VIDEO_DIR, proj.slug, fileName), buf);
    return `/video/${proj.slug}/${fileName}`;
  } catch (err) {
    console.error("Failed to download output:", err);
    return null;
  }
}

// Build a history entry object (output fields may be null for a pending entry).
function makeHistoryEntry({ id, taskId, projectId, input, resultUrl, localVideo, costCredits, refVideoSeconds, imageLocalIds, mediaLocalIds, status, runtimeMs }) {
  return {
    id,
    createdAt: new Date().toISOString(),
    taskId: taskId || null,
    projectId,
    input: input || {},
    resultUrl: resultUrl || null,
    localVideo: localVideo || null,
    costCredits: typeof costCredits === "number" ? costCredits : null,
    status: status || "done",
    // wall time from submit to finished output (ms); null until done
    runtimeMs: typeof runtimeMs === "number" ? runtimeMs : null,
    // total seconds of reference video inputs (video refs bill by combined duration)
    refVideoSeconds: typeof refVideoSeconds === "number" ? refVideoSeconds : 0,
    imageLocalIds: Array.isArray(imageLocalIds) ? imageLocalIds : [],
    // per-kind local ids: { image: [], video: [], audio: [] }
    mediaLocalIds: mediaLocalIds && typeof mediaLocalIds === "object" ? mediaLocalIds : null,
  };
}

// --- save a finished generation to history (+ download the video) -------
app.post("/api/save", async (req, res) => {
  const { input, taskId, resultUrl, costCredits, imageLocalIds, mediaLocalIds, projectId, refVideoSeconds, startedAt } =
    req.body || {};
  if (!resultUrl) return res.status(400).json({ code: 400, msg: "resultUrl is required" });

  const proj = resolveProject(projectId);
  const id = `${Date.now()}`;
  const localVideo = await downloadOutput(resultUrl, proj, id);
  // No pending entry existed, so runtime comes from the client's job start time.
  const runtimeMs = typeof startedAt === "number" ? Date.now() - startedAt : null;
  const entry = makeHistoryEntry({
    id, taskId, projectId: proj.id, input, resultUrl, localVideo, costCredits, refVideoSeconds, imageLocalIds, mediaLocalIds, runtimeMs,
  });
  const entries = readJson(HISTORY_FILE);
  entries.unshift(entry);
  writeJson(HISTORY_FILE, entries);
  res.json({ code: 200, msg: "saved", data: entry });
});

// --- create a PENDING history entry at submit time (prompt saved immediately,
// before the generation succeeds, so a failed/stopped run doesn't lose it) ----
app.post("/api/history", (req, res) => {
  const { input, taskId, mediaLocalIds, projectId, refVideoSeconds, imageLocalIds } = req.body || {};
  const proj = resolveProject(projectId);
  const entry = makeHistoryEntry({
    id: `${Date.now()}`, taskId, projectId: proj.id, input, mediaLocalIds, refVideoSeconds, imageLocalIds,
    status: "pending",
  });
  const entries = readJson(HISTORY_FILE);
  entries.unshift(entry);
  writeJson(HISTORY_FILE, entries);
  res.json({ code: 200, msg: "created", data: entry });
});

// --- attach the finished output to a pending entry (downloads the file) -------
app.post("/api/history/:id/result", async (req, res) => {
  const { resultUrl, costCredits, runtimeMs } = req.body || {};
  const entries = readJson(HISTORY_FILE);
  const entry = entries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ code: 404, msg: "history entry not found" });

  // Idempotent: if the server-side sweep already finished this entry, don't
  // re-download or recompute the run-time.
  if (entry.status === "done" && entry.localVideo) {
    return res.json({ code: 200, msg: "already-done", data: entry });
  }

  if (resultUrl) {
    entry.resultUrl = resultUrl;
    const localVideo = await downloadOutput(resultUrl, resolveProject(entry.projectId), entry.id);
    if (localVideo) entry.localVideo = localVideo;
  }
  if (typeof costCredits === "number") entry.costCredits = costCredits;
  entry.status = "done";
  // Prefer a caller-supplied run time (ComfyUI's real per-prompt execution time);
  // fall back to since-created for kie.ai jobs, which are submitted one at a time.
  entry.runtimeMs =
    typeof runtimeMs === "number" ? runtimeMs : Date.now() - new Date(entry.createdAt).getTime();
  writeJson(HISTORY_FILE, entries);
  res.json({ code: 200, msg: "updated", data: entry });
});

// Mark a still-pending entry failed (definitive failure or user cancel). Guarded on
// `pending` so it never clobbers a finished entry (e.g. one the sweep completed).
app.post("/api/history/:id/fail", (req, res) => {
  const entries = readJson(HISTORY_FILE);
  const entry = entries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ code: 404, msg: "history entry not found" });
  if (entry.status === "pending") {
    entry.status = "failed";
    entry.error = String(req.body?.error || "Generation failed.");
    writeJson(HISTORY_FILE, entries);
  }
  res.json({ code: 200, msg: "ok", data: entry });
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

// --- delete a history entry (and its saved output file) -------------------
app.delete("/api/history/:id", (req, res) => {
  const entries = readJson(HISTORY_FILE);
  const idx = entries.findIndex((e) => e.id === req.params.id);
  if (idx < 0) return res.status(404).json({ code: 404, msg: "history entry not found" });

  const entry = entries[idx];
  // Best-effort removal of the saved output file (input gallery media is shared,
  // so it's left alone).
  if (entry.localVideo?.startsWith("/video/")) {
    try {
      fs.unlinkSync(path.join(VIDEO_DIR, entry.localVideo.slice("/video/".length)));
    } catch (err) {
      if (err.code !== "ENOENT") console.error("Failed to delete output file:", err.message);
    }
  }
  entries.splice(idx, 1);
  writeJson(HISTORY_FILE, entries);
  res.json({ code: 200, msg: "deleted" });
});

// extension → mime for adding a generated output into the gallery
const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
};

// --- copy a generation's saved output into the gallery (same project) -----
app.post("/api/history/:id/to-gallery", (req, res) => {
  const entries = readJson(HISTORY_FILE);
  const entry = entries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ code: 404, msg: "history entry not found" });
  if (!entry.localVideo?.startsWith("/video/")) {
    return res.status(400).json({ code: 400, msg: "no saved output file for this entry" });
  }

  const rel = entry.localVideo.slice("/video/".length); // <slug>/<file>
  const src = path.join(VIDEO_DIR, rel);
  if (!fs.existsSync(src)) {
    return res.status(404).json({ code: 404, msg: "saved output file is missing on disk" });
  }

  const ext = (path.extname(src).slice(1) || "png").toLowerCase();
  const mime = MIME_BY_EXT[ext] || "image/png";
  const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "image";
  const proj = resolveProject(entry.projectId);
  const id = randomUUID();
  const storedName = `${proj.slug}/${id}.${ext}`;

  try {
    fs.mkdirSync(path.join(IMAGES_DIR, proj.slug), { recursive: true });
    fs.copyFileSync(src, path.join(IMAGES_DIR, storedName));
  } catch (err) {
    console.error("Failed to copy output into gallery:", err);
    return res.status(500).json({ code: 500, msg: "Failed to add to gallery" });
  }

  const galleryEntry = {
    id,
    kind,
    projectId: proj.id,
    storedName,
    name: `generated-${entry.id}.${ext}`,
    mime,
    localUrl: `/images/${storedName}`,
    createdAt: new Date().toISOString(),
  };
  const images = readJson(IMAGES_FILE);
  images.unshift(galleryEntry);
  writeJson(IMAGES_FILE, images);

  res.json({ code: 200, msg: "added", image: galleryEntry });
});

// IPv4 addresses of this machine on the local network (for the startup hint).
function lanUrls(port) {
  const urls = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) urls.push(`http://${i.address}:${port}`);
    }
  }
  return urls;
}

app.listen(PORT, HOST, () => {
  const loopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
  console.log(`\n  Seedance app running:  http://localhost:${PORT}`);
  console.log(`  Password protection:   ${AUTH_ENABLED ? "ON" : "OFF (set APP_PASSWORD in .env to enable)"}`);

  if (!loopback) {
    const urls = lanUrls(PORT);
    if (urls.length) {
      console.log("\n  On your home network (other devices on the same Wi-Fi/LAN):");
      for (const u of urls) console.log(`    ${u}`);
    }
    const noLogin =
      "\n  ⚠ LAN access is ON (HOST=" +
      HOST +
      "). There is no login: anyone on your network who\n" +
      "    opens this URL can use the app and spend your kie.ai credits. Consider\n" +
      "    setting APP_PASSWORD in .env. Only enable LAN access on a network you trust,\n" +
      "    and never port-forward it to the internet.\n" +
      "    (Windows may also prompt to allow Node through the firewall the first time.)";
    const withLogin =
      "\n  ⚠ LAN access is ON (HOST=" +
      HOST +
      "). The app is password-protected, but still: only enable\n" +
      "    LAN access on a network you trust, and never port-forward it to the internet.\n" +
      "    (Windows may also prompt to allow Node through the firewall the first time.)";
    console.log(AUTH_ENABLED ? withLogin : noLogin);
  }
  console.log("");
});
