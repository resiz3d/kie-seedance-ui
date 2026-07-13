const form = document.getElementById("genForm");
const submitBtn = document.getElementById("submitBtn");

const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");
const spinner = document.getElementById("spinner");
const taskIdEl = document.getElementById("taskId");

const resultEl = document.getElementById("result");
const video = document.getElementById("video");
const resultImage = document.getElementById("resultImage");
const downloadLink = document.getElementById("downloadLink");
const resultMeta = document.getElementById("resultMeta");

const errorEl = document.getElementById("error");

// Gallery
const galleryEl = document.getElementById("gallery");
const galleryCount = document.getElementById("galleryCount");
const galleryEmpty = document.getElementById("galleryEmpty");

// Credits + estimate
const creditsValue = document.getElementById("creditsValue");
const refreshCredits = document.getElementById("refreshCredits");
const estimateEl = document.getElementById("estimate");

// History
const historyEl = document.getElementById("history");
const historyEmpty = document.getElementById("historyEmpty");
const historyFilter = document.getElementById("historyFilter");

// Projects
const projectSelect = document.getElementById("projectSelect");
const newProjectBtn = document.getElementById("newProject");
const renameProjectBtn = document.getElementById("renameProject");
const deleteProjectBtn = document.getElementById("deleteProject");

const PROJECT_KEY = "seedance_project";
let projects = [];
let activeProjectId = localStorage.getItem(PROJECT_KEY) || "default";

const POLL_INTERVAL_MS = 5000;

// Persisted in-flight task so a tab reload can resume polling instead of losing it.
const INFLIGHT_KEY = "seedance_inflight";
const INFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // ignore tasks older than a day

function saveInflight(obj) {
  try {
    localStorage.setItem(INFLIGHT_KEY, JSON.stringify(obj));
  } catch {}
}
function clearInflight() {
  try {
    localStorage.removeItem(INFLIGHT_KEY);
  } catch {}
}
function loadInflight() {
  try {
    return JSON.parse(localStorage.getItem(INFLIGHT_KEY) || "null");
  } catch {
    return null;
  }
}

// Seed credit rates (credits/sec) measured from real runs; refined from history.
const SEED_RATES = { "480p": 19, "720p": 41 };

let currentCredits = null;
let historyEntries = [];
let galleryItems = [];

function show(el) {
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
}

// --- lightbox (full-size media overlay) --------------------------------------
const lightbox = document.getElementById("lightbox");
const lightboxContent = document.getElementById("lightboxContent");

function openLightbox(kind, src, name) {
  lightboxContent.innerHTML = "";
  let el;
  if (kind === "video") {
    el = document.createElement("video");
    el.src = src;
    el.controls = true;
    el.autoplay = true;
  } else if (kind === "audio") {
    el = document.createElement("audio");
    el.src = src;
    el.controls = true;
  } else {
    el = document.createElement("img");
    el.src = src;
    el.alt = name || "";
  }
  lightboxContent.appendChild(el);
  show(lightbox);
}

function closeLightbox() {
  hide(lightbox);
  lightboxContent.innerHTML = ""; // drops the element so playback stops
}

lightbox.addEventListener("click", (e) => {
  // close on backdrop or the × — but not on the media itself
  if (e.target === lightbox || e.target.id === "lightboxClose") closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !lightbox.classList.contains("hidden")) closeLightbox();
});

// Small corner button that opens a thumb's media full-size.
function makeZoomButton(kind, src, name) {
  const zoom = document.createElement("button");
  zoom.type = "button";
  zoom.className = "zoom";
  zoom.textContent = "⤢";
  zoom.title = "View full size";
  zoom.addEventListener("click", (e) => {
    e.stopPropagation();
    openLightbox(kind, src, name);
  });
  return zoom;
}

// ===========================================================================
// Media lists (images / videos / audio) — one factory drives all three.
// Items: { uid, localId, remoteUrl, thumb, name, status }
//   localId   — id of a locally-saved file (hosted on kie.ai at generate time)
//   remoteUrl — a URL dropped directly (used as-is, no upload)
// Dropping a file only saves it locally; nothing goes to the kie.ai API
// until Generate is clicked.
// ===========================================================================

const REORDER_TYPE = "application/x-seedance-reorder";
let nextUid = 1;

const KIND_LABEL = { image: "Image", video: "Video", audio: "Audio" };

function makeMediaList(kind) {
  const dropzone = document.getElementById(`dz-${kind}`);
  const thumbs = document.getElementById(`thumbs-${kind}`);
  const fileInput = document.getElementById(`file-${kind}`);
  const clearBtn = document.getElementById(`clear-${kind}`);
  const reorderType = `${REORDER_TYPE}-${kind}`; // reorder stays within one list

  const list = {
    kind,
    items: [],

    render() {
      thumbs.innerHTML = "";
      let n = 0; // numbers only "ready" items, matching the URL order sent
      for (const item of list.items) {
        const div = document.createElement("div");
        div.className = `thumb ${item.status}${kind === "audio" ? " audio-thumb" : ""}`;
        div.title = item.name || item.remoteUrl || "";
        div.draggable = true;

        div.appendChild(makeThumbContent(kind, item));

        if (item.status === "ready") {
          n++;
          const label = document.createElement("span");
          label.className = "img-label";
          label.textContent = `${KIND_LABEL[kind]}${n}`;
          div.appendChild(label);
        }

        const x = document.createElement("button");
        x.type = "button";
        x.className = "x";
        x.textContent = "×";
        x.title = "Remove";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          list.items = list.items.filter((i) => i.uid !== item.uid);
          list.render();
        });
        div.appendChild(x);

        const zoomSrc = item.thumb || item.remoteUrl;
        if (zoomSrc) div.appendChild(makeZoomButton(kind, zoomSrc, item.name));

        // drag-to-reorder within this list
        div.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData(reorderType, String(item.uid));
          e.dataTransfer.effectAllowed = "move";
          div.classList.add("dragging");
        });
        div.addEventListener("dragend", () => {
          div.classList.remove("dragging");
          thumbs.querySelectorAll(".drop-target").forEach((t) => t.classList.remove("drop-target"));
        });
        div.addEventListener("dragover", (e) => {
          if (![...e.dataTransfer.types].includes(reorderType)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          div.classList.add("drop-target");
        });
        div.addEventListener("dragleave", () => div.classList.remove("drop-target"));
        div.addEventListener("drop", (e) => {
          if (![...e.dataTransfer.types].includes(reorderType)) return;
          e.preventDefault();
          e.stopPropagation();
          div.classList.remove("drop-target");
          list.reorder(Number(e.dataTransfer.getData(reorderType)), item.uid);
        });

        thumbs.appendChild(div);
      }
      clearBtn.classList.toggle("hidden", list.items.length === 0);
      updateEstimate();
    },

    reorder(fromUid, toUid) {
      if (fromUid === toUid) return;
      const from = list.items.findIndex((i) => i.uid === fromUid);
      const to = list.items.findIndex((i) => i.uid === toUid);
      if (from < 0 || to < 0) return;
      const [moved] = list.items.splice(from, 1);
      list.items.splice(to, 0, moved);
      list.render();
    },

    addUrl(url) {
      if (!url) return;
      const entry = { uid: nextUid++, localId: null, remoteUrl: url, thumb: url, name: url, status: "ready" };
      list.items.push(entry);
      list.render();
      if (kind === "video") {
        probeDuration(url).then((d) => {
          entry.durationSec = d;
          updateEstimate();
        });
      }
    },

    // Read a local file, show a thumbnail, and save it locally only.
    addFile(file) {
      const reader = new FileReader();
      reader.onload = async () => {
        const entry = {
          uid: nextUid++,
          localId: null,
          remoteUrl: null,
          thumb: reader.result,
          name: file.name,
          status: "saving",
        };
        list.items.push(entry);
        list.render();

        try {
          const res = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base64Data: reader.result, fileName: file.name, projectId: activeProjectId }),
          });
          const data = await res.json();
          if (!res.ok || !data.image?.id) throw new Error(data.msg || "Save failed");
          entry.localId = data.image.id;
          entry.thumb = data.image.localUrl || entry.thumb;
          entry.status = "ready";
          if (kind === "video") {
            probeDuration(entry.thumb).then((d) => {
              entry.durationSec = d;
              updateEstimate();
            });
          }
          loadGallery();
        } catch (err) {
          console.error(err);
          entry.status = "error";
        }
        list.render();
      };
      reader.readAsDataURL(file);
    },

    addFromGallery(item) {
      const entry = {
        uid: nextUid++,
        localId: item.id,
        remoteUrl: null,
        thumb: item.localUrl,
        name: item.name,
        status: "ready",
      };
      list.items.push(entry);
      list.render();
      if (kind === "video") {
        probeDuration(item.localUrl).then((d) => {
          entry.durationSec = d;
          updateEstimate();
        });
      }
    },

    addFiles(fileList) {
      for (const file of fileList) {
        if (file.type.startsWith(`${kind}/`)) list.addFile(file);
      }
    },

    // Host any local items on kie.ai now, returning the ordered URL list.
    async resolve() {
      const ready = list.items.filter((i) => i.status === "ready");
      // Sequential on purpose: parallel uploads saturate the (usually much
      // smaller) upstream link and stall everything else on the connection.
      const urls = [];
      for (const item of ready) {
        if (item.remoteUrl) {
          urls.push(item.remoteUrl);
          continue;
        }
        if (!item.localId) throw new Error(`${item.name || kind}: missing source`);
        const res = await fetch("/api/reupload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.localId }),
        });
        const data = await res.json();
        if (!res.ok || !data.hostedUrl) throw new Error(`${item.name || kind}: upload failed`);
        urls.push(data.hostedUrl);
      }
      return urls;
    },

    localIds() {
      return list.items.filter((i) => i.status === "ready" && i.localId).map((i) => i.localId);
    },

    clear() {
      list.items = [];
      list.render();
    },
  };

  // --- dropzone interactions ---
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    list.addFiles(fileInput.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      if ([...e.dataTransfer.types].includes(reorderType)) return; // internal reorder, not a file drop
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === "dragleave" && dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    if ([...e.dataTransfer.types].includes(reorderType)) return;
    if (e.dataTransfer.files?.length) {
      list.addFiles(e.dataTransfer.files);
      return;
    }
    const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (url && /^https?:\/\//i.test(url.trim())) list.addUrl(url.trim());
  });

  clearBtn.addEventListener("click", () => list.clear());

  return list;
}

// Read a media file's duration (seconds) from its metadata; null if unreadable.
function probeDuration(src) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => resolve(null);
    v.src = src;
  });
}

// Total seconds of ready reference videos (video refs bill by combined
// input + output duration, per seedance2.ai — unconfirmed by kie.ai docs).
function refVideoSeconds() {
  return lists.video.items
    .filter((i) => i.status === "ready")
    .reduce((sum, i) => sum + (i.durationSec || 0), 0);
}

// Build the preview element for a thumb by kind.
function makeThumbContent(kind, item) {
  const src = item.thumb || item.remoteUrl || (item.localUrl ?? "");
  if (kind === "video") {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    v.preload = "metadata";
    v.draggable = false;
    return v;
  }
  if (kind === "audio") {
    const wrap = document.createElement("div");
    wrap.className = "audio-tile";
    wrap.draggable = false;
    const icon = document.createElement("span");
    icon.className = "audio-icon";
    icon.textContent = "♪";
    const name = document.createElement("span");
    name.className = "audio-name";
    name.textContent = item.name || "audio";
    wrap.append(icon, name);
    return wrap;
  }
  const el = document.createElement("img");
  el.src = src;
  el.draggable = false;
  return el;
}

const lists = {
  image: makeMediaList("image"),
  video: makeMediaList("video"),
  audio: makeMediaList("audio"),
};
const allItems = () => Object.values(lists).flatMap((l) => l.items);

// --- projects ----------------------------------------------------------------
function projectName(id) {
  return projects.find((p) => p.id === id)?.name || "Default";
}

async function loadProjects() {
  try {
    const res = await fetch("/api/projects");
    const data = await res.json();
    projects = data.data || [];
  } catch (err) {
    console.error("Failed to load projects:", err);
    projects = [{ id: "default", name: "Default" }];
  }
  if (!projects.some((p) => p.id === activeProjectId)) activeProjectId = "default";
  renderProjectControls();
}

function renderProjectControls() {
  projectSelect.innerHTML = "";
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    projectSelect.appendChild(opt);
  }
  projectSelect.value = activeProjectId;

  // history filter: All + each project; keep the current choice if still valid
  const prev = historyFilter.value || activeProjectId;
  historyFilter.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All projects";
  historyFilter.appendChild(all);
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    historyFilter.appendChild(opt);
  }
  historyFilter.value = [...historyFilter.options].some((o) => o.value === prev) ? prev : activeProjectId;

  renderGallery(galleryItems);
  renderHistory(historyEntries);
}

function setActiveProject(id) {
  activeProjectId = id;
  localStorage.setItem(PROJECT_KEY, id);
  projectSelect.value = id;
  historyFilter.value = id;
  renderGallery(galleryItems);
  renderHistory(historyEntries);
}

projectSelect.addEventListener("change", () => setActiveProject(projectSelect.value));
historyFilter.addEventListener("change", () => renderHistory(historyEntries));

// open the output folder matching the history filter (all → video/ root)
document.getElementById("openFolder").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/open-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: historyFilter.value || "all" }),
    });
    if (!res.ok) throw new Error((await res.json()).msg || "Failed to open folder");
  } catch (err) {
    alert(err.message || String(err));
  }
});

newProjectBtn.addEventListener("click", async () => {
  const name = prompt("New project name:");
  if (!name?.trim()) return;
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.data?.id) throw new Error(data.msg || "Failed to create project");
    await loadProjects();
    setActiveProject(data.data.id);
  } catch (err) {
    alert(err.message || String(err));
  }
});

renameProjectBtn.addEventListener("click", async () => {
  const current = projectName(activeProjectId);
  const name = prompt(`Rename project "${current}" to:`, current);
  if (!name?.trim() || name.trim() === current) return;
  try {
    const res = await fetch(`/api/projects/${activeProjectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.msg || "Rename failed");
    await loadProjects();
  } catch (err) {
    alert(err.message || String(err));
  }
});

deleteProjectBtn.addEventListener("click", async () => {
  if (activeProjectId === "default") {
    alert("The Default project cannot be deleted.");
    return;
  }
  const name = projectName(activeProjectId);
  if (!confirm(`Delete project "${name}"?\n\nIts gallery media and history will move to Default.`)) return;
  try {
    const res = await fetch(`/api/projects/${activeProjectId}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.msg || "Delete failed");
    await loadProjects();
    setActiveProject("default");
    loadGallery();
    loadHistory();
  } catch (err) {
    alert(err.message || String(err));
  }
});

// --- gallery ---------------------------------------------------------------
async function loadGallery() {
  try {
    const res = await fetch("/api/images");
    const data = await res.json();
    galleryItems = data.data || [];
    renderGallery(galleryItems);
  } catch (err) {
    console.error("Failed to load gallery:", err);
  }
}

function renderGallery(items) {
  galleryEl.innerHTML = "";
  // strict per-project scoping (entries predating projects belong to Default)
  const visible = items.filter((i) => (i.projectId || "default") === activeProjectId);
  galleryCount.textContent = visible.length ? `(${visible.length})` : "";
  galleryEmpty.classList.toggle("hidden", visible.length > 0);

  for (const item of visible) {
    const kind = item.kind || "image"; // older entries predate the kind field
    const div = document.createElement("div");
    div.className = `thumb ready${kind === "audio" ? " audio-thumb" : ""}`;
    div.title = `${item.name} — click to add`;

    div.appendChild(makeThumbContent(kind, { thumb: item.localUrl, name: item.name }));

    if (kind !== "image") {
      const badge = document.createElement("span");
      badge.className = "img-label kind-badge";
      badge.textContent = kind;
      div.appendChild(badge);
    }

    div.addEventListener("click", () => lists[kind].addFromGallery(item));

    // move to another project (file physically moves)
    const mv = document.createElement("button");
    mv.type = "button";
    mv.className = "mv";
    mv.textContent = "⇄";
    mv.title = "Move to another project";
    mv.addEventListener("click", (e) => {
      e.stopPropagation();
      if (div.querySelector(".mv-select")) return;
      const sel = document.createElement("select");
      sel.className = "mv-select";
      const ph = new Option("Move to…", "", true, true);
      ph.disabled = true;
      sel.appendChild(ph);
      for (const p of projects) {
        if (p.id !== (item.projectId || "default")) sel.appendChild(new Option(p.name, p.id));
      }
      sel.addEventListener("click", (ev) => ev.stopPropagation());
      sel.addEventListener("change", async () => {
        try {
          const res = await fetch(`/api/images/${item.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: sel.value }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.msg || "Move failed");
          loadGallery();
        } catch (err) {
          alert(err.message || String(err));
          sel.remove();
        }
      });
      sel.addEventListener("blur", () => sel.remove());
      div.appendChild(sel);
      sel.focus();
    });
    div.appendChild(mv);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "×";
    del.title = "Delete from gallery";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await fetch(`/api/images/${item.id}`, { method: "DELETE" });
        loadGallery();
      } catch (err) {
        console.error(err);
      }
    });
    div.appendChild(del);

    div.appendChild(makeZoomButton(kind, item.localUrl, item.name));

    galleryEl.appendChild(div);
  }
}

// --- credits + estimate ------------------------------------------------------
async function loadCredits() {
  try {
    const res = await fetch("/api/credits");
    const data = await res.json();
    if (typeof data.data === "number") {
      currentCredits = data.data;
      creditsValue.textContent = currentCredits.toLocaleString();
    } else {
      creditsValue.textContent = "—";
    }
  } catch {
    creditsValue.textContent = "—";
  }
  return currentCredits;
}
refreshCredits.addEventListener("click", loadCredits);

// credits/sec: average of past runs matching resolution + audio setting, using
// effective seconds (output duration + reference-video seconds, since video
// refs appear to bill by combined input+output duration). Seed rates were
// measured with audio on.
function ratePerSec(model, resolution, audioOn) {
  const samples = historyEntries
    .filter(
      (e) =>
        (e.input?.model || "bytedance/seedance-2") === model &&
        e.input?.resolution === resolution &&
        (e.input?.generate_audio !== false) === audioOn &&
        typeof e.costCredits === "number" &&
        e.costCredits > 0 &&
        e.input?.duration > 0
    )
    .map((e) => e.costCredits / (e.input.duration + (e.refVideoSeconds || 0)));
  if (samples.length) {
    return { rate: samples.reduce((a, b) => a + b, 0) / samples.length, measured: true };
  }
  // seed rates were measured on the standard model only
  const seed = model === "bytedance/seedance-2" ? SEED_RATES[resolution] : null;
  return seed ? { rate: seed, measured: false } : null;
}

function updateEstimate() {
  const model = modelSelect.value;

  // Image models: flat per-generation cost, learned per model + quality tier.
  if (isSeedream()) {
    const quality = qualitySelect.value;
    const samples = historyEntries
      .filter(
        (e) =>
          e.input?.model === model &&
          (e.input?.quality || "basic") === quality &&
          typeof e.costCredits === "number" &&
          e.costCredits > 0
      )
      .map((e) => e.costCredits);
    if (!samples.length) {
      estimateEl.textContent = `No estimate yet for ${seedreamLabel(model)} (${quality}) — will measure after a run.`;
      estimateEl.title = "";
      return;
    }
    const est = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    estimateEl.innerHTML = `Est. cost: ~<b>${est.toLocaleString()}</b> credits`;
    estimateEl.title = "Average of your measured Seedream runs at this quality.";
    return;
  }

  const resolution = document.getElementById("resolution").value;
  const duration = Number(document.getElementById("duration").value) || 0;
  const audioOn = document.getElementById("generate_audio").checked;
  const r = ratePerSec(model, resolution, audioOn);
  if (!r || !duration) {
    const label = model === "bytedance/seedance-2-fast" ? `Seedance 2 Fast at ${resolution}` : resolution;
    estimateEl.textContent = `No estimate yet for ${label} — will measure after a run.`;
    estimateEl.title = "";
    return;
  }
  const refSecs = refVideoSeconds();
  const est = Math.round(r.rate * (duration + refSecs));
  const refNote = refSecs > 0 ? ` (incl. ~${Math.round(refSecs)}s video ref)` : "";
  const overLimit = refSecs > 15 ? ` ⚠ video refs exceed the 15s total limit` : "";
  estimateEl.innerHTML = `Est. cost: ~<b>${est.toLocaleString()}</b> credits${refNote}${overLimit}`;
  estimateEl.title = r.measured
    ? "Based on your measured past runs at this resolution/audio setting."
    : "Approximate, based on a seeded per-second rate. Will refine after you run it.";
}

["resolution", "duration"].forEach((id) =>
  document.getElementById(id).addEventListener("input", updateEstimate)
);
document.getElementById("generate_audio").addEventListener("change", updateEstimate);

// Per-model form shaping: Seedance 2 Fast caps resolution at 720p; Seedream
// 5.0 Lite is image-to-image (no duration/resolution/audio/video, has quality,
// different aspect ratios).
const modelSelect = document.getElementById("model");
const resolutionSelect = document.getElementById("resolution");
const qualitySelect = document.getElementById("quality");
const aspectSelect = document.getElementById("aspect_ratio");

const VIDEO_ASPECTS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const IMAGE_ASPECTS = ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"];

const isSeedream = () => modelSelect.value.startsWith("seedream/");
const isI2I = () => isSeedream() && modelSelect.value.endsWith("-image-to-image");
const isT2I = () => isSeedream() && modelSelect.value.endsWith("-text-to-image");
// all seedream variants end in "-to-image"; video models never do
const isImageOutput = (model) => (model || "").includes("-to-image");

// Short display name for a seedream model id, e.g. "Seedream Pro".
function seedreamLabel(model) {
  return (model || "").includes("5-pro") ? "Seedream Pro" : "Seedream Lite";
}

// Only the Pro variants document the output_format parameter.
const isSeedreamPro = () => isSeedream() && modelSelect.value.includes("5-pro");

// Quality tiers resolve to different output sizes per family:
// Lite: basic=2K, high=4K.  Pro: basic=1K, high=2K.
const QUALITY_LABELS = {
  lite: { basic: "Basic (2K)", high: "High (4K)" },
  pro: { basic: "Basic (1K)", high: "High (2K)" },
};

function setQualityLabels() {
  const tier = modelSelect.value.includes("5-pro") ? "pro" : "lite";
  for (const opt of qualitySelect.options) {
    opt.textContent = QUALITY_LABELS[tier][opt.value] || opt.value;
  }
}

function setAspectOptions(values) {
  const cur = aspectSelect.value;
  aspectSelect.innerHTML = "";
  for (const v of values) aspectSelect.appendChild(new Option(v, v));
  aspectSelect.value = values.includes(cur) ? cur : values.includes("16:9") ? "16:9" : values[0];
}

function applyModelUI() {
  const seedream = isSeedream();
  const fast = modelSelect.value === "bytedance/seedance-2-fast";
  for (const id of ["videoField", "audioField", "resolutionField", "durationField", "genAudioField", "webSearchField"]) {
    document.getElementById(id).classList.toggle("hidden", seedream);
  }
  // text-to-image takes no references at all — hide the image dropzone + gallery too
  document.getElementById("imageField").classList.toggle("hidden", isT2I());
  document.getElementById("galleryWrap").classList.toggle("hidden", isT2I());
  document.getElementById("qualityField").classList.toggle("hidden", !seedream);
  document.getElementById("formatField").classList.toggle("hidden", !isSeedreamPro());
  if (seedream) setQualityLabels();
  setAspectOptions(seedream ? IMAGE_ASPECTS : VIDEO_ASPECTS);
  for (const opt of resolutionSelect.options) {
    if (opt.value === "1080p" || opt.value === "4k") opt.disabled = fast;
  }
  if (fast && (resolutionSelect.value === "1080p" || resolutionSelect.value === "4k")) {
    resolutionSelect.value = "720p";
  }
  updatePromptCount(); // the cap depends on the selected model
  updateEstimate();
}
modelSelect.addEventListener("change", applyModelUI);
qualitySelect.addEventListener("change", updateEstimate);

// --- prompt length counter -----------------------------------------------
// Caps per the model docs: Seedance 20,000; Seedream Lite 3,000; Pro 5,000.
const promptEl = document.getElementById("prompt");
const promptCount = document.getElementById("promptCount");
const promptCapHint = document.getElementById("promptCapHint");

function promptCap() {
  if (!isSeedream()) return 20000;
  return isSeedreamPro() ? 5000 : 3000;
}

function updatePromptCount() {
  const cap = promptCap();
  const len = promptEl.value.length;
  promptCapHint.textContent = `(max ${cap.toLocaleString()} characters)`;
  promptCount.textContent = `${len.toLocaleString()} / ${cap.toLocaleString()}`;
  promptCount.classList.toggle("over", len > cap);
}
promptEl.addEventListener("input", updatePromptCount);
updatePromptCount();

// --- helpers ----------------------------------------------------------------
function setError(msg) {
  errorEl.textContent = msg;
  show(errorEl);
  hide(spinner);
}

function resetUi() {
  hide(errorEl);
  hide(resultEl);
  hide(statusEl);
  video.removeAttribute("src");
  resultImage.removeAttribute("src");
  hide(resultImage);
  resultMeta.textContent = "";
}

function collectInput(resolved) {
  if (isSeedream()) {
    const input = {
      model: modelSelect.value,
      prompt: document.getElementById("prompt").value.trim(),
      aspect_ratio: aspectSelect.value,
      quality: qualitySelect.value,
      nsfw_checker: document.getElementById("nsfw_checker").checked,
    };
    if (isI2I()) input.image_urls = resolved.image;
    if (isSeedreamPro()) input.output_format = document.getElementById("output_format").value;
    return input;
  }
  return {
    model: modelSelect.value,
    prompt: document.getElementById("prompt").value.trim(),
    reference_image_urls: resolved.image,
    reference_video_urls: resolved.video,
    reference_audio_urls: resolved.audio,
    generate_audio: document.getElementById("generate_audio").checked,
    resolution: document.getElementById("resolution").value,
    aspect_ratio: document.getElementById("aspect_ratio").value,
    duration: Number(document.getElementById("duration").value),
    web_search: document.getElementById("web_search").checked,
    nsfw_checker: document.getElementById("nsfw_checker").checked,
  };
}

// --- submit / generate --------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (allItems().some((i) => i.status === "saving")) {
    setError("Some files are still saving — wait a moment and try again.");
    return;
  }
  if (allItems().some((i) => i.status === "error")) {
    setError("Remove the failed file(s) before generating.");
    return;
  }
  if (isI2I() && !lists.image.items.some((i) => i.status === "ready")) {
    setError("Seedream image-to-image needs at least one reference image.");
    return;
  }
  if (promptEl.value.length > promptCap()) {
    setError(
      `Prompt is ${promptEl.value.length.toLocaleString()} characters — this model's limit is ${promptCap().toLocaleString()}.`
    );
    return;
  }

  resetUi();
  submitBtn.disabled = true;

  show(statusEl);
  show(spinner);
  taskIdEl.textContent = "";

  const mediaLocalIds = {
    image: isT2I() ? [] : lists.image.localIds(),
    video: isSeedream() ? [] : lists.video.localIds(),
    audio: isSeedream() ? [] : lists.audio.localIds(),
  };

  // Host reference media on kie.ai now — nothing was sent when they were dropped.
  let resolved;
  try {
    if (allItems().some((i) => i.status === "ready")) {
      statusText.textContent = "Uploading reference media…";
    }
    resolved = {
      // only upload the reference kinds the selected model actually uses
      image: isT2I() ? [] : await lists.image.resolve(),
      video: isSeedream() ? [] : await lists.video.resolve(),
      audio: isSeedream() ? [] : await lists.audio.resolve(),
    };
  } catch (err) {
    setError(err.message || "Failed to upload reference media.");
    submitBtn.disabled = false;
    return;
  }

  const input = collectInput(resolved);

  statusText.textContent = "Submitting…";

  // Snapshot the balance so we can measure actual cost on completion.
  const balanceBefore = await loadCredits();

  try {
    const res = await fetch("/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json();

    if (!res.ok || data.code !== 200 || !data.data?.taskId) {
      throw new Error(data.msg || `Request failed (${res.status})`);
    }

    const taskId = data.data.taskId;
    taskIdEl.textContent = `Task ID: ${taskId}`;
    statusText.textContent = "Generating… this can take a few minutes.";
    // pin the project at submit time so a mid-run project switch doesn't misfile the result
    const projectId = activeProjectId;
    const refSecs = isSeedream() ? 0 : refVideoSeconds();
    saveInflight({ taskId, input, mediaLocalIds, balanceBefore, projectId, refSecs, startedAt: Date.now() });
    pollStatus(taskId, input, mediaLocalIds, balanceBefore, projectId, refSecs);
  } catch (err) {
    setError(err.message || String(err));
    submitBtn.disabled = false;
  }
});

async function pollStatus(taskId, input, mediaLocalIds, balanceBefore, projectId, refSecs) {
  try {
    const res = await fetch(`/api/status?taskId=${encodeURIComponent(taskId)}`);
    const data = await res.json();

    if (!res.ok || data.code !== 200) {
      // 4xx means the task is gone/invalid — terminal, don't keep resuming it.
      if (res.status >= 400 && res.status < 500) clearInflight();
      throw new Error(data.msg || `Status check failed (${res.status})`);
    }

    const state = data.data?.state;

    if (state === "success") {
      clearInflight();
      const parsed = JSON.parse(data.data.resultJson || "{}");
      const url = parsed.resultUrls?.[0];
      if (!url) throw new Error("Task succeeded but no result URL was returned.");

      hide(statusEl);
      if (isImageOutput(input?.model)) {
        resultImage.src = url;
        show(resultImage);
        hide(video);
      } else {
        video.src = url;
        show(video);
        hide(resultImage);
      }
      downloadLink.href = url;
      show(resultEl);
      submitBtn.disabled = false;

      // Prefer the API's exact per-task cost (creditsConsumed on recordInfo);
      // fall back to the balance delta for older responses.
      const balanceAfter = await loadCredits(); // also refreshes the header balance
      let cost = null;
      const reported = Number(data.data.creditsConsumed);
      if (Number.isFinite(reported) && reported > 0) {
        cost = reported;
      } else if (typeof balanceBefore === "number" && typeof balanceAfter === "number") {
        const delta = balanceBefore - balanceAfter;
        if (delta > 0) cost = delta;
      }
      resultMeta.textContent = cost != null ? `Used ~${cost.toLocaleString()} credits` : "";

      saveToHistory(input, taskId, url, cost, mediaLocalIds, projectId, refSecs);
      return;
    }

    if (state === "fail") {
      clearInflight();
      throw new Error(
        data.data?.failMsg || `Generation failed (code ${data.data?.failCode ?? "?"}).`
      );
    }

    setTimeout(() => pollStatus(taskId, input, mediaLocalIds, balanceBefore, projectId, refSecs), POLL_INTERVAL_MS);
  } catch (err) {
    setError(err.message || String(err));
    submitBtn.disabled = false;
  }
}

// --- history -------------------------------------------------------------------
async function saveToHistory(input, taskId, resultUrl, costCredits, mediaLocalIds, projectId, refSecs) {
  try {
    await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input,
        taskId,
        resultUrl,
        costCredits,
        mediaLocalIds,
        refVideoSeconds: typeof refSecs === "number" ? refSecs : 0,
        projectId: projectId || activeProjectId,
        imageLocalIds: mediaLocalIds?.image || [], // kept for older readers of history.json
      }),
    });
    loadHistory();
  } catch (err) {
    console.error("Failed to save history:", err);
  }
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const data = await res.json();
    historyEntries = data.data || [];
    renderHistory(historyEntries);
    updateEstimate();
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

function renderHistory(entries) {
  historyEl.innerHTML = "";
  const filter = historyFilter.value || "all";
  const visible =
    filter === "all" ? entries : entries.filter((e) => (e.projectId || "default") === filter);
  historyEmpty.classList.toggle("hidden", visible.length > 0);

  for (const entry of visible) {
    const input = entry.input || {};
    const card = document.createElement("div");
    card.className = "hist-card";

    const isImg = isImageOutput(input.model);
    if (isImg) {
      const im = document.createElement("img");
      im.src = entry.localVideo || entry.resultUrl; // localVideo holds the saved output file
      im.className = "hist-img";
      im.loading = "lazy";
      card.appendChild(im);
    } else {
      const vid = document.createElement("video");
      vid.src = entry.localVideo || entry.resultUrl;
      vid.controls = true;
      vid.preload = "metadata";
      card.appendChild(vid);
    }

    const body = document.createElement("div");
    body.className = "hist-body";

    const prompt = document.createElement("div");
    prompt.className = "hist-prompt";
    prompt.textContent = input.prompt || "(no prompt)";
    body.appendChild(prompt);

    const meta = document.createElement("div");
    meta.className = "hist-meta";
    const date = new Date(entry.createdAt).toLocaleString();
    const counts = [
      [(input.reference_image_urls || input.image_urls || []).length, "img"],
      [(input.reference_video_urls || []).length, "vid"],
      [(input.reference_audio_urls || []).length, "aud"],
    ]
      .filter(([n]) => n > 0)
      .map(([n, t]) => `${n} ${t}`)
      .join(", ");
    const cost = typeof entry.costCredits === "number" ? ` · ${entry.costCredits.toLocaleString()} credits` : "";
    // show which project the entry belongs to when viewing all projects
    const proj = filter === "all" ? ` · ${projectName(entry.projectId || "default")}` : "";
    if (isImg) {
      meta.textContent =
        `${date} · ${seedreamLabel(input.model)} · ${input.quality || "basic"} · ${input.aspect_ratio || "?"}` +
        `${counts ? ` · ${counts}` : ""}${cost}${proj}`;
    } else {
      const fast = input.model === "bytedance/seedance-2-fast" ? " · Fast" : "";
      meta.textContent =
        `${date}${fast} · ${input.resolution || "?"} · ${input.aspect_ratio || "?"} · ` +
        `${input.duration || "?"}s${counts ? ` · ${counts}` : ""}${cost}${proj}`;
    }
    body.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "hist-actions";

    const reimport = document.createElement("button");
    reimport.type = "button";
    reimport.className = "btn-secondary";
    reimport.textContent = "Re-import";
    reimport.addEventListener("click", () => {
      applyEntry(entry);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    actions.appendChild(reimport);

    const rerun = document.createElement("button");
    rerun.type = "button";
    rerun.className = "btn-secondary";
    rerun.textContent = "Re-run";
    rerun.addEventListener("click", async () => {
      const entryProject = entry.projectId || "default";
      if (entryProject !== activeProjectId) {
        const ok = confirm(
          `This generation is from project "${projectName(entryProject)}".\n` +
            `The new result will be saved to the active project "${projectName(activeProjectId)}".\n\nContinue?`
        );
        if (!ok) return;
      }
      await applyEntry(entry);
      window.scrollTo({ top: 0, behavior: "smooth" });
      form.requestSubmit();
    });
    actions.appendChild(rerun);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-secondary";
    copyBtn.textContent = "Copy prompt";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(input.prompt || "");
        copyBtn.textContent = "Copied!";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => (copyBtn.textContent = "Copy prompt"), 1200);
    });
    actions.appendChild(copyBtn);

    const link = document.createElement("a");
    link.className = "btn-secondary";
    link.href = entry.localVideo || entry.resultUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = isImg ? "Open image" : "Open video";
    actions.appendChild(link);

    // reassign the entry to another project (files stay where they are)
    const projSel = document.createElement("select");
    projSel.className = "hist-project";
    projSel.title = "Move this entry (and its saved video) to another project";
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      projSel.appendChild(opt);
    }
    const entryProjectId = entry.projectId || "default";
    projSel.value = projSel.querySelector(`option[value="${entryProjectId}"]`) ? entryProjectId : "default";
    projSel.addEventListener("change", async () => {
      try {
        const res = await fetch(`/api/history/${entry.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: projSel.value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.msg || "Reassign failed");
        loadHistory();
      } catch (err) {
        alert(err.message || String(err));
        projSel.value = entryProjectId;
      }
    });
    actions.appendChild(projSel);

    body.appendChild(actions);
    card.appendChild(body);
    historyEl.appendChild(card);
  }
}

// Populate the form from a saved history entry (local files re-host at generate).
async function applyEntry(entry) {
  const input = entry.input || {};
  modelSelect.value = input.model || "bytedance/seedance-2";
  applyModelUI(); // shape the form (and aspect options) before filling values
  document.getElementById("prompt").value = input.prompt || "";
  document.getElementById("resolution").value = input.resolution || "720p";
  if (input.aspect_ratio) aspectSelect.value = input.aspect_ratio;
  qualitySelect.value = input.quality || "basic";
  document.getElementById("output_format").value = input.output_format || "png";
  updatePromptCount();
  document.getElementById("duration").value = input.duration || 15;
  document.getElementById("generate_audio").checked = input.generate_audio !== false;
  document.getElementById("web_search").checked = !!input.web_search;
  document.getElementById("nsfw_checker").checked = !!input.nsfw_checker;

  const saved = await fetch("/api/images").then((r) => r.json()).then((d) => d.data || []);
  const localIds = entry.mediaLocalIds || { image: entry.imageLocalIds || [] };
  const urlsByKind = {
    image: input.reference_image_urls || input.image_urls || [],
    video: input.reference_video_urls || [],
    audio: input.reference_audio_urls || [],
  };

  for (const kind of ["image", "video", "audio"]) {
    lists[kind].items = [];
    const ids = localIds[kind] || [];
    if (ids.length) {
      // Prefer locally-saved files (their old hosted URLs may have expired).
      for (const id of ids) {
        const item = saved.find((i) => i.id === id);
        if (item) lists[kind].addFromGallery(item);
        // if the saved file was deleted, silently skip it
      }
    } else {
      for (const url of urlsByKind[kind]) lists[kind].addUrl(url);
    }
    lists[kind].render();
  }

  updateEstimate();
}

// Resume a generation that was in flight when the tab was closed/reloaded.
function resumeInflight() {
  const pending = loadInflight();
  if (!pending?.taskId) return;
  if (pending.startedAt && Date.now() - pending.startedAt > INFLIGHT_MAX_AGE_MS) {
    clearInflight();
    return;
  }
  resetUi();
  submitBtn.disabled = true;
  show(statusEl);
  show(spinner);
  statusText.textContent = "Resuming previous generation… this can take a few minutes.";
  taskIdEl.textContent = `Task ID: ${pending.taskId}`;
  // older saved state used imageLocalIds (a plain array)
  const mediaLocalIds = pending.mediaLocalIds || { image: pending.imageLocalIds || [] };
  pollStatus(pending.taskId, pending.input, mediaLocalIds, pending.balanceBefore, pending.projectId || activeProjectId, pending.refSecs || 0);
}

// --- server-down banner ----------------------------------------------------------
// Infrequent ping so a dead server (closed terminal, crash) is surfaced instead of
// drops/generates silently failing. Also re-checks when the tab regains focus.
const offlineEl = document.getElementById("offline");
const PING_INTERVAL_MS = 30000;

async function checkServer() {
  try {
    const r = await fetch("/api/ping", { cache: "no-store" });
    offlineEl.classList.toggle("hidden", r.ok);
  } catch {
    offlineEl.classList.remove("hidden");
  }
}
setInterval(checkServer, PING_INTERVAL_MS);
window.addEventListener("focus", checkServer);

// --- initial load ---------------------------------------------------------------
loadProjects();
loadCredits();
loadGallery();
loadHistory();
resumeInflight();
