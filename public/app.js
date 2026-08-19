const form = document.getElementById("genForm");
const submitBtn = document.getElementById("submitBtn");

// Container for per-generation job cards (many can run at once).
const jobsEl = document.getElementById("jobs");
const jobsHeader = document.getElementById("jobsHeader");
const closeAllJobsBtn = document.getElementById("closeAllJobs");

const errorEl = document.getElementById("error");

// Gallery
const galleryEl = document.getElementById("gallery");
const galleryCount = document.getElementById("galleryCount");
const galleryEmpty = document.getElementById("galleryEmpty");

// Credits + estimate
const creditsValue = document.getElementById("creditsValue");
const refreshCredits = document.getElementById("refreshCredits");
const estimateEl = document.getElementById("estimate");
const projectCreditsTotal = document.getElementById("projectCreditsTotal");
const projectCreditsBreakdown = document.getElementById("projectCreditsBreakdown");

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

// Persisted in-flight tasks so a tab reload can resume polling instead of losing
// them. Stored as an ARRAY so multiple concurrent generations all survive reload.
const INFLIGHT_KEY = "seedance_inflight";
const INFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // ignore tasks older than a day

// Fields of a job that need to persist for a reload-time resume.
function serializeJob(job) {
  const { jobId, taskId, historyId, input, mediaLocalIds, balanceBefore, projectId, refSecs, startedAt } = job;
  return { jobId, taskId, historyId, input, mediaLocalIds, balanceBefore, projectId, refSecs, startedAt };
}

function loadInflightList() {
  try {
    const raw = JSON.parse(localStorage.getItem(INFLIGHT_KEY) || "null");
    if (Array.isArray(raw)) return raw;
    if (raw?.taskId) return [raw]; // migrate the old single-object format
    return [];
  } catch {
    return [];
  }
}
function saveInflightList(list) {
  try {
    if (list.length) localStorage.setItem(INFLIGHT_KEY, JSON.stringify(list));
    else localStorage.removeItem(INFLIGHT_KEY);
  } catch {}
}
function addInflight(job) {
  const list = loadInflightList().filter((j) => j.taskId !== job.taskId);
  list.push(serializeJob(job));
  saveInflightList(list);
}
function removeInflight(taskId) {
  saveInflightList(loadInflightList().filter((j) => j.taskId !== taskId));
}

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
const lightboxPrev = document.getElementById("lightboxPrev");
const lightboxNext = document.getElementById("lightboxNext");

// When opened from History, holds the list being browsed + current position, so
// the ‹ › arrows (and ←/→ keys) can step through it. Null for single-item opens.
let lightboxNav = null;

function renderLightboxMedia(kind, src, name) {
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
}

function openLightbox(kind, src, name, nav = null) {
  lightboxNav = nav?.items?.length ? nav : null;
  renderLightboxMedia(kind, src, name);
  updateLightboxNav();
  show(lightbox);
}

// Show the arrows only while browsing a list, and hide each at its end.
function updateLightboxNav() {
  const active = !!lightboxNav;
  lightboxPrev.classList.toggle("hidden", !active || lightboxNav.index <= 0);
  lightboxNext.classList.toggle("hidden", !active || lightboxNav.index >= lightboxNav.items.length - 1);
}

function stepLightbox(delta) {
  if (!lightboxNav) return;
  const i = lightboxNav.index + delta;
  if (i < 0 || i >= lightboxNav.items.length) return;
  lightboxNav.index = i;
  const m = historyItemMedia(lightboxNav.items[i]);
  renderLightboxMedia(m.kind, m.src, m.name);
  updateLightboxNav();
}

function closeLightbox() {
  hide(lightbox);
  lightboxContent.innerHTML = ""; // drops the element so playback stops
  lightboxNav = null;
  updateLightboxNav();
}

lightbox.addEventListener("click", (e) => {
  // close on backdrop or the × — but not on the media itself
  if (e.target === lightbox || e.target.id === "lightboxClose") closeLightbox();
});
lightboxPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  stepLightbox(-1);
});
lightboxNext.addEventListener("click", (e) => {
  e.stopPropagation();
  stepLightbox(1);
});
document.addEventListener("keydown", (e) => {
  if (lightbox.classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") stepLightbox(-1);
  else if (e.key === "ArrowRight") stepLightbox(1);
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

// `kind` is the list's DOM/id namespace (image/video/audio/firstFrame/lastFrame).
// opts.mediaType is the actual media family for rendering + file-type filtering
// (defaults to kind); opts.single caps the list at one item (first/last frame).
// opts.max caps a multi list at N items. opts.build creates the field DOM (with a
// per-field gallery picker) instead of binding to fixed ids in index.html — used
// by ComfyUI workflow controls, so they get the same reorder/zoom/gallery UI.
// opts.label / opts.labelSep set the numbered badge text (e.g. "Picture 1").
function makeMediaList(kind, opts = {}) {
  const mediaType = opts.mediaType || kind;
  const single = !!opts.single;
  const max = single ? 1 : opts.max || Infinity;
  const numLabel = opts.label || KIND_LABEL[mediaType];
  const numSep = opts.labelSep ?? "";

  let dropzone, thumbs, fileInput, clearBtn, galleryWrap, galleryThumbs, galleryEmptyEl, fieldEl;
  if (opts.build) {
    // Build the field ourselves (ComfyUI controls have no static markup).
    const noun = mediaType === "audio" ? "audio files" : `${mediaType}s`;
    fieldEl = document.createElement("div");
    fieldEl.className = "field";
    fieldEl.innerHTML =
      `<div class="field-head"><span>${escapeHtmlJs(opts.title || numLabel)} ` +
      `<span class="hint">${escapeHtmlJs(opts.hint || "")}</span></span>` +
      `<button type="button" class="link-btn hidden">Clear all</button></div>` +
      `<div class="dropzone"><div class="thumbs"></div>` +
      `<p class="dz-hint">Drop ${noun} here or <span class="browse">browse</span></p>` +
      `<input type="file" accept="${mediaType}/*" multiple hidden /></div>` +
      `<details class="gallery-wrap comfy-gallery"><summary>Pick from gallery</summary>` +
      `<p class="dz-hint gallery-empty">No saved ${mediaType}s in this project yet.</p>` +
      `<div class="thumbs gallery"></div></details>`;
    dropzone = fieldEl.querySelector(".dropzone");
    thumbs = fieldEl.querySelector(".dropzone .thumbs");
    fileInput = fieldEl.querySelector("input[type=file]");
    clearBtn = fieldEl.querySelector(".link-btn");
    galleryWrap = fieldEl.querySelector(".comfy-gallery");
    galleryThumbs = fieldEl.querySelector(".gallery");
    galleryEmptyEl = fieldEl.querySelector(".gallery-empty");
  } else {
    dropzone = document.getElementById(`dz-${kind}`);
    thumbs = document.getElementById(`thumbs-${kind}`);
    fileInput = document.getElementById(`file-${kind}`);
    clearBtn = document.getElementById(`clear-${kind}`);
  }
  const reorderType = `${REORDER_TYPE}-${kind}`; // reorder stays within one list
  const roomFor = (n = 1) => list.items.length + n <= max;

  const list = {
    kind,
    el: fieldEl, // set when opts.build
    items: [],

    render() {
      thumbs.innerHTML = "";
      let n = 0; // numbers only "ready" items, matching the URL order sent
      for (const item of list.items) {
        const div = document.createElement("div");
        div.className = `thumb ${item.status}${mediaType === "audio" ? " audio-thumb" : ""}`;
        div.title = item.name || item.remoteUrl || "";
        div.draggable = !single; // single-item frames don't reorder

        div.appendChild(makeThumbContent(mediaType, item));

        if (item.status === "ready" && !single) {
          n++;
          const label = document.createElement("span");
          label.className = "img-label";
          label.textContent = `${numLabel}${numSep}${n}`;
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
        if (zoomSrc) div.appendChild(makeZoomButton(mediaType, zoomSrc, item.name));

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
      if (single) list.items = [];
      else if (!roomFor()) return;
      const entry = { uid: nextUid++, localId: null, remoteUrl: url, thumb: url, name: url, status: "ready" };
      list.items.push(entry);
      list.render();
      if (mediaType === "video") {
        probeDuration(url).then((d) => {
          entry.durationSec = d;
          updateEstimate();
        });
      }
    },

    // Read a local file, show a thumbnail, and save it locally only.
    addFile(file) {
      if (single) list.items = [];
      else if (!roomFor()) return;
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
          if (mediaType === "video") {
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
      if (single) list.items = [];
      else if (!roomFor()) return;
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
      if (mediaType === "video") {
        probeDuration(item.localUrl).then((d) => {
          entry.durationSec = d;
          updateEstimate();
        });
      }
    },

    addFiles(fileList) {
      let files = single ? [...fileList].slice(0, 1) : [...fileList];
      if (Number.isFinite(max)) files = files.slice(0, Math.max(0, max - list.items.length));
      for (const file of files) {
        if (file.type.startsWith(`${mediaType}/`)) list.addFile(file);
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
    if (opts.localOnly) return; // ComfyUI needs a real file, not a hosted URL
    const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (url && /^https?:\/\//i.test(url.trim())) list.addUrl(url.trim());
  });

  clearBtn.addEventListener("click", () => list.clear());

  // Per-field gallery picker (built lists only): reuse this project's saved media.
  if (galleryWrap) {
    const renderPicker = () => {
      galleryThumbs.innerHTML = "";
      const gitems = galleryItems.filter(
        (i) => (i.kind || "image") === mediaType && (i.projectId || "default") === activeProjectId
      );
      galleryEmptyEl.classList.toggle("hidden", gitems.length > 0);
      for (const item of gitems) {
        const div = document.createElement("div");
        div.className = `thumb ready${mediaType === "audio" ? " audio-thumb" : ""}`;
        div.title = `${item.name} — click to add`;
        div.appendChild(makeThumbContent(mediaType, { thumb: item.localUrl, name: item.name }));
        div.addEventListener("click", () => list.addFromGallery(item));
        galleryThumbs.appendChild(div);
      }
    };
    galleryWrap.addEventListener("toggle", () => { if (galleryWrap.open) renderPicker(); });
  }

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
  // Seedance 2.5 start/end keyframes — single image each, rendered like images.
  firstFrame: makeMediaList("firstFrame", { mediaType: "image", single: true }),
  lastFrame: makeMediaList("lastFrame", { mediaType: "image", single: true }),
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

// Export the currently-filtered history to a shareable, self-contained folder.
document.getElementById("exportHistory").addEventListener("click", async () => {
  const btn = document.getElementById("exportHistory");
  // Export is per-project — the History filter must be on a specific project.
  const projectId = historyFilter.value;
  if (!projectId || projectId === "all") {
    alert('Pick a specific project in the History filter to export (the "All projects" view can\'t be exported).');
    return;
  }
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Exporting…";
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.msg || "Export failed");
    alert(
      `Exported ${data.data.entries} generation(s) (${data.data.filesCopied} files) to:\n\n` +
        `${data.data.path}\n\n` +
        `It opened in your file browser. Open index.html to view it, or zip the folder to share.`
    );
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
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

// How many of the most-recent matching runs feed a price estimate. Estimates are
// built from the LATEST runs (not an all-time average) so they track price
// changes — sales starting or ending — in both directions with no manual reset;
// taking the median of a few shrugs off the billing noise of overlapping runs.
const RECENT_RATE_SAMPLES = 3;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The matching history entries, newest first (defensive re-sort — don't rely on
// stored order). `extra` narrows further (e.g. seedream quality tier).
function recentMatches(model, extra = () => true) {
  return historyEntries
    .filter(
      (e) =>
        (e.input?.model || "bytedance/seedance-2") === model &&
        typeof e.costCredits === "number" &&
        e.costCredits > 0 &&
        extra(e)
    )
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

// credits/sec from the most recent matching runs (video), using effective seconds
// (output duration + reference-video seconds, since video refs appear to bill by
// combined input+output duration). Null until at least one matching run exists.
function ratePerSec(model, resolution, audioOn) {
  const rates = recentMatches(
    model,
    (e) =>
      e.input?.resolution === resolution &&
      (e.input?.generate_audio !== false) === audioOn &&
      e.input?.duration > 0
  )
    .slice(0, RECENT_RATE_SAMPLES)
    .map((e) => e.costCredits / (e.input.duration + (e.refVideoSeconds || 0)));
  return rates.length ? { rate: median(rates), n: rates.length } : null;
}

function updateEstimate() {
  const model = modelSelect.value;

  // Image models: flat per-generation cost, learned per model + quality tier.
  if (isSeedream()) {
    const quality = qualitySelect.value;
    const costs = recentMatches(model, (e) => (e.input?.quality || "basic") === quality)
      .slice(0, RECENT_RATE_SAMPLES)
      .map((e) => e.costCredits);
    if (!costs.length) {
      estimateEl.textContent = `No estimate yet for ${seedreamLabel(model)} (${quality}) — will measure after a run.`;
      estimateEl.title = "";
      return;
    }
    const est = Math.round(median(costs));
    estimateEl.innerHTML = `Est. cost: ~<b>${est.toLocaleString()}</b> credits`;
    estimateEl.title = `Median of your ${costs.length} most recent ${seedreamLabel(model)} run${costs.length > 1 ? "s" : ""} at this quality.`;
    return;
  }

  const resolution = document.getElementById("resolution").value;
  const duration = Number(document.getElementById("duration").value) || 0;
  const audioOn = document.getElementById("generate_audio").checked;
  const r = ratePerSec(model, resolution, audioOn);
  if (!r || !duration) {
    const label = `${videoModelLabel(model)} at ${resolution}`;
    estimateEl.textContent = `No estimate yet for ${label} — will measure after a run.`;
    estimateEl.title = "";
    return;
  }
  const refSecs = refVideoSeconds();
  const est = Math.round(r.rate * (duration + refSecs));
  const refNote = refSecs > 0 ? ` (incl. ~${Math.round(refSecs)}s video ref)` : "";
  const overLimit = refSecs > 15 ? ` ⚠ video refs exceed the 15s total limit` : "";
  estimateEl.innerHTML = `Est. cost: ~<b>${est.toLocaleString()}</b> credits${refNote}${overLimit}`;
  estimateEl.title = `Based on your ${r.n} most recent run${r.n > 1 ? "s" : ""} at this resolution/audio setting (median).`;
}

["resolution", "duration"].forEach((id) =>
  document.getElementById(id).addEventListener("input", updateEstimate)
);
document.getElementById("generate_audio").addEventListener("change", updateEstimate);

// Per-model form shaping: Seedance 2 Fast and Mini cap resolution at 720p;
// Seedream 5.0 Lite is image-to-image (no duration/resolution/audio/video, has
// quality, different aspect ratios).
const modelSelect = document.getElementById("model");
const resolutionSelect = document.getElementById("resolution");
const qualitySelect = document.getElementById("quality");
const aspectSelect = document.getElementById("aspect_ratio");

const VIDEO_ASPECTS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
// Seedance 2.5 and 2.0 Mini add an "adaptive" ratio (2.0 and Fast don't).
const VIDEO_ASPECTS_ADAPTIVE = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const IMAGE_ASPECTS = ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"];

// Output-format options by output medium: [value, label].
const IMAGE_FORMATS = [["png", "PNG"], ["jpeg", "JPEG"]];
const VIDEO_FORMATS = [["mp4", "mp4"], ["mov", "mov"]];

const isSeedream = () => modelSelect.value.startsWith("seedream/");
const is25 = () => modelSelect.value === "bytedance/seedance-2-5";
// Local ComfyUI workflows are selected as `comfy:<file.json>`.
const isComfy = () => modelSelect.value.startsWith("comfy:");
const comfyFile = () => modelSelect.value.slice("comfy:".length);
// Every Seedance video model (2.5 / 2 / Fast / Mini) exposes first/last-frame
// inputs; 2.5-only extras (mp4/mov, adaptive, 30s, return_last_frame) stay on is25.
const isSeedanceVideo = () => modelSelect.value.startsWith("bytedance/seedance-");

// Seedance makes reference images and first/last frames mutually exclusive (the
// API rejects mixing them), so a toggle picks which set is active. Only the active
// set is shown and sent. `frameMode()` is the raw toggle; `usesFrames()` is true
// only when a Seedance video model is active AND the toggle is on frames.
function frameMode() {
  return document.querySelector('input[name="imageSource"]:checked')?.value || "refs";
}
const usesFrames = () => isSeedanceVideo() && frameMode() === "frames";
const isI2I = () => isSeedream() && modelSelect.value.endsWith("-image-to-image");
const isT2I = () => isSeedream() && modelSelect.value.endsWith("-text-to-image");
// all seedream variants end in "-to-image"; video models never do
const isImageOutput = (model) => (model || "").includes("-to-image");

// Video variants that top out at 720p (the standard model reaches 1080p/4k).
const CAPPED_720_MODELS = new Set([
  "bytedance/seedance-2-5",
  "bytedance/seedance-2-fast",
  "bytedance/seedance-2-mini",
]);

// Models whose aspect_ratio list includes "adaptive" (2.5 and 2.0 Mini per the
// kie.ai docs; 2.0 and Fast do not offer it).
const ADAPTIVE_ASPECT_MODELS = new Set(["bytedance/seedance-2-5", "bytedance/seedance-2-mini"]);
const hasAdaptiveAspect = () => ADAPTIVE_ASPECT_MODELS.has(modelSelect.value);
const isCapped720 = () => CAPPED_720_MODELS.has(modelSelect.value);

// Short suffix distinguishing the non-standard video variants in labels.
const VIDEO_VARIANT_LABEL = {
  "bytedance/seedance-2-5": "2.5",
  "bytedance/seedance-2-fast": "Fast",
  "bytedance/seedance-2-mini": "Mini",
};

// Full display name for a video model id.
function videoModelLabel(model) {
  if (model === "bytedance/seedance-2-5") return "Seedance 2.5";
  if (model === "bytedance/seedance-2-fast") return "Seedance 2 Fast";
  if (model === "bytedance/seedance-2-mini") return "Seedance 2 Mini";
  return "Seedance 2";
}

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

function setAspectOptions(values, preferred = "16:9") {
  const cur = aspectSelect.value;
  aspectSelect.innerHTML = "";
  for (const v of values) aspectSelect.appendChild(new Option(v, v));
  aspectSelect.value = values.includes(cur)
    ? cur
    : values.includes(preferred)
    ? preferred
    : values[0];
}

// Repopulate the output-format select for the active output medium.
const outputFormatSelect = document.getElementById("output_format");
function setFormatOptions(values, def) {
  const cur = outputFormatSelect.value;
  outputFormatSelect.innerHTML = "";
  for (const [v, label] of values) outputFormatSelect.appendChild(new Option(label, v));
  outputFormatSelect.value = values.some(([v]) => v === cur) ? cur : def;
}

// kie.ai form fields hidden entirely when a local ComfyUI workflow is selected.
const KIE_FIELDS = [
  "promptField", "imageSourceField", "imageField", "galleryWrap", "firstFrameField",
  "lastFrameField", "videoField", "audioField", "optionsRow", "checksRow",
];

function applyModelUI() {
  const comfy = isComfy();
  const cc = document.getElementById("comfyControls");
  cc.classList.toggle("hidden", !comfy);
  cc.classList.toggle("comfy-grid", comfy);
  document.getElementById("comfyCountField").classList.toggle("hidden", !comfy);
  if (comfy) {
    // Swap the whole kie.ai form for token-driven workflow controls.
    for (const id of KIE_FIELDS) document.getElementById(id).classList.add("hidden");
    estimateEl.classList.add("hidden");
    renderComfyControls();
    updateModelChrome();
    return;
  }
  for (const id of KIE_FIELDS) document.getElementById(id).classList.remove("hidden");
  estimateEl.classList.remove("hidden");

  const seedream = isSeedream();
  const capped = isCapped720();
  const frames = is25();
  for (const id of ["videoField", "audioField", "resolutionField", "durationField", "genAudioField", "webSearchField"]) {
    document.getElementById(id).classList.toggle("hidden", seedream);
  }
  // Seedance video models make reference images and first/last frames mutually
  // exclusive, so a toggle chooses which set is shown. `refsHidden` hides
  // reference images (text-to-image, or any Seedance model in frames mode); the
  // frame dropzones show only in that mode. "return last frame" is a 2.5-only
  // output option.
  const seedanceVideo = isSeedanceVideo();
  const framesMode = usesFrames();
  const refsHidden = isT2I() || framesMode;
  document.getElementById("imageSourceField").classList.toggle("hidden", !seedanceVideo);
  document.getElementById("imageField").classList.toggle("hidden", refsHidden);
  document.getElementById("galleryWrap").classList.toggle("hidden", refsHidden);
  document.getElementById("qualityField").classList.toggle("hidden", !seedream);
  for (const id of ["firstFrameField", "lastFrameField"]) {
    document.getElementById(id).classList.toggle("hidden", !framesMode);
  }
  document.getElementById("returnLastFrameField").classList.toggle("hidden", !frames);
  // Output format applies to Seedream Pro (png/jpeg) and Seedance 2.5 (mp4/mov).
  const showFormat = isSeedreamPro() || frames;
  document.getElementById("formatField").classList.toggle("hidden", !showFormat);
  if (frames) setFormatOptions(VIDEO_FORMATS, "mp4");
  else if (isSeedreamPro()) setFormatOptions(IMAGE_FORMATS, "png");
  if (seedream) setQualityLabels();
  setAspectOptions(
    seedream ? IMAGE_ASPECTS : hasAdaptiveAspect() ? VIDEO_ASPECTS_ADAPTIVE : VIDEO_ASPECTS,
    frames ? "adaptive" : "16:9" // only 2.5 documents adaptive as its default
  );
  for (const opt of resolutionSelect.options) {
    if (opt.value === "1080p" || opt.value === "4k") opt.disabled = capped;
  }
  if (capped && (resolutionSelect.value === "1080p" || resolutionSelect.value === "4k")) {
    resolutionSelect.value = "720p";
  }
  // Seedance 2.5 allows up to 30s; the other video models cap at 15s.
  const durInput = document.getElementById("duration");
  durInput.max = frames ? 30 : 15;
  if (Number(durInput.value) > Number(durInput.max)) durInput.value = durInput.max;
  updatePromptCount(); // the cap depends on the selected model
  updateEstimate();
  updateModelChrome();
}

// Retitle the page and the Generate button for the selected model.
function updateModelChrome() {
  const label = modelSelect.options[modelSelect.selectedIndex].textContent.replace(/\s*\(.*\)$/, "").trim();
  if (isComfy()) {
    document.getElementById("pageTitle").textContent = label;
    document.getElementById("pageSub").innerHTML =
      `Run ${escapeHtmlJs(label)} on your local ComfyUI ` +
      `<span class="experimental-tag">Experimental</span>`;
    document.title = label;
    submitBtn.textContent = "Generate";
    return;
  }
  const image = isSeedream();
  const medium = image ? "image" : "video";
  document.getElementById("pageTitle").textContent = label;
  document.getElementById("pageSub").textContent = `Generate ${medium} with the ${label} model`;
  document.title = label;
  submitBtn.textContent = image ? "Generate Image" : "Generate Video";
}
const MODEL_KEY = "seedance_last_model";
modelSelect.addEventListener("change", () => {
  applyModelUI();
  scheduleComfyStats(0); // show/hide the host-stats strip promptly on model switch
  try {
    localStorage.setItem(MODEL_KEY, modelSelect.value);
  } catch {
    /* storage blocked — non-fatal */
  }
});
qualitySelect.addEventListener("change", updateEstimate);
// Switching the 2.5 image-source toggle re-shapes which reference set is shown.
document
  .querySelectorAll('input[name="imageSource"]')
  .forEach((r) => r.addEventListener("change", applyModelUI));

// =========================================================================
// ComfyUI: local workflows chosen from the model dropdown. Each workflow's
// {{tokens}} become form controls (inferred from the token name); on Generate
// we upload any image inputs, post to the server, and reuse the job-card +
// history flow. See docs/COMFYUI.md.
// =========================================================================
let comfyWorkflows = [];
const comfyControlsEl = document.getElementById("comfyControls");
let comfyFields = []; // [{ name, getValue() }] for the active workflow

const escapeHtmlJs = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

// Load the workflow list and (re)build the "Local · ComfyUI" dropdown group.
async function loadWorkflows() {
  try {
    const res = await fetch("/api/workflows");
    comfyWorkflows = (await res.json()).data || [];
  } catch {
    comfyWorkflows = [];
  }
  modelSelect.querySelector('optgroup[data-comfy]')?.remove();
  if (comfyWorkflows.length) {
    const group = document.createElement("optgroup");
    group.label = "Local · ComfyUI (Experimental)";
    group.setAttribute("data-comfy", "");
    for (const w of comfyWorkflows) {
      const opt = new Option(w.error ? `${w.name} (invalid JSON)` : w.name, `comfy:${w.file}`);
      opt.disabled = !!w.error;
      group.appendChild(opt);
    }
    modelSelect.appendChild(group);
  }
  restoreLastModel(); // now that comfy options exist, reselect the last-used model
}

// Reselect the last-used model (base or comfy:) if it's still a valid option.
function restoreLastModel() {
  let last = null;
  try {
    last = localStorage.getItem(MODEL_KEY);
  } catch {
    /* storage blocked */
  }
  if (!last || last === modelSelect.value) return;
  const opt = [...modelSelect.options].find((o) => o.value === last && !o.disabled);
  if (!opt) return;
  modelSelect.value = last;
  applyModelUI();
}

// Choose a control type from a token's name/options. Media checks are ordered
// audio → video → image so "ref_video_audio" (a video's audio track) reads as audio.
function comfyControlType(token) {
  if (token.options?.length) return "select";
  const n = token.name.toLowerCase();
  if (/prompt/.test(n)) return "textarea";
  if (/audio/.test(n)) return "audio";
  if (/video/.test(n)) return "video";
  if (/(image|img|frame|photo|picture)/.test(n)) return "image";
  if (
    /(seed|steps|cfg|width|height|length|duration|fps|frames|count|denoise|strength|scale|megapixel|batch)/.test(n) ||
    (token.default !== "" && !Number.isNaN(Number(token.default)))
  )
    return "number";
  return "text";
}

// Media control types share one factory (image/video/audio).
const MEDIA_TYPES = new Set(["image", "video", "audio"]);

// Token width hint → columns of a 12-col grid. Prompt always spans full; media and
// scalars default to full unless the token declares a width (e.g. "; 1/4").
const WIDTH_SPAN = { "1/2": 6, "1/3": 4, "1/4": 3, "2/3": 8, "3/4": 9, full: 12, "1": 12 };
function comfySpan(token, type) {
  if (type === "textarea") return 12;
  return WIDTH_SPAN[token.width] || 12;
}

const prettyLabel = (name) => name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

// A single-media (image/video/audio) control. Dropped files are saved to the
// project gallery (same store the kie.ai side uses) so they're reusable and
// included in exports; you can also pick an existing gallery item of that kind.
// At generate time the chosen file is pushed into ComfyUI's input folder by id.
const MEDIA_ARTICLE = { image: "an image", video: "a video", audio: "an audio file" };
function makeComfyMedia(token, mediaKind) {
  const field = document.createElement("div");
  field.className = "field";
  field.innerHTML =
    `<div class="field-head"><span>${escapeHtmlJs(prettyLabel(token.name))}</span>` +
    `<button type="button" class="link-btn hidden">Clear</button></div>` +
    `<div class="dropzone"><div class="thumbs"></div>` +
    `<p class="dz-hint">Drop ${MEDIA_ARTICLE[mediaKind]} here or <span class="browse">browse</span></p>` +
    `<input type="file" accept="${mediaKind}/*" hidden /></div>` +
    `<details class="gallery-wrap comfy-gallery"><summary>Pick from gallery</summary>` +
    `<p class="dz-hint gallery-empty">No saved ${mediaKind}s in this project yet.</p>` +
    `<div class="thumbs gallery"></div></details>`;
  const dz = field.querySelector(".dropzone");
  const thumbs = field.querySelector(".thumbs");
  const clearBtn = field.querySelector(".link-btn");
  const fileInput = field.querySelector("input[type=file]");
  const galleryWrap = field.querySelector(".comfy-gallery");
  const galleryThumbs = field.querySelector(".gallery");
  const galleryEmptyEl = field.querySelector(".gallery-empty");

  // source: { id, url, name } from a saved gallery item (dropped files get saved
  // there first). uploadedRef caches the ComfyUI filename after one upload.
  let source = null, uploadedRef = null;

  const previewThumb = (url, name) => {
    const div = document.createElement("div");
    div.className = `thumb ready${mediaKind === "audio" ? " audio-thumb" : ""}`;
    div.appendChild(makeThumbContent(mediaKind, { thumb: url, name }));
    return div;
  };
  const render = () => {
    thumbs.innerHTML = "";
    clearBtn.classList.toggle("hidden", !source);
    if (source) thumbs.appendChild(previewThumb(source.url, source.name));
  };
  const setSource = (s) => { source = s; uploadedRef = null; render(); };

  // Save a dropped/browsed file into the project gallery, then use it.
  const take = (file) => {
    if (!file || !file.type.startsWith(`${mediaKind}/`)) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64Data: reader.result, fileName: file.name, projectId: activeProjectId }),
        });
        const data = await res.json();
        if (!res.ok || !data.image?.id) throw new Error(data.msg || "Save failed");
        setSource({ id: data.image.id, url: data.image.localUrl || reader.result, name: data.image.name });
        loadGallery(); // refresh the shared + per-control galleries
      } catch (err) {
        console.error(err);
        setError(`Couldn't save ${file.name}: ${err.message || err}`);
      }
    };
    reader.readAsDataURL(file);
  };

  // Populate the picker with this project's saved media of this kind when opened.
  const renderGalleryPicker = () => {
    galleryThumbs.innerHTML = "";
    const items = galleryItems.filter(
      (i) => (i.kind || "image") === mediaKind && (i.projectId || "default") === activeProjectId
    );
    galleryEmptyEl.classList.toggle("hidden", items.length > 0);
    for (const item of items) {
      const div = previewThumb(item.localUrl, item.name);
      div.title = `${item.name} — click to use`;
      div.addEventListener("click", () => {
        setSource({ id: item.id, url: item.localUrl, name: item.name });
        galleryWrap.open = false;
      });
      galleryThumbs.appendChild(div);
    }
  };

  dz.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { take(fileInput.files[0]); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((e) =>
    dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((e) =>
    dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove("dragover"); })
  );
  dz.addEventListener("drop", (ev) => { if (ev.dataTransfer.files?.length) take(ev.dataTransfer.files[0]); });
  clearBtn.addEventListener("click", () => setSource(null));
  galleryWrap.addEventListener("toggle", () => { if (galleryWrap.open) renderGalleryPicker(); });

  return {
    el: field,
    name: token.name,
    isMedia: true,
    mediaKind,
    mediaKey: token.name,
    capacity: 1,
    hasDefault: token.default !== "",
    set() {}, // a scalar value can't fill a media control — skip on scalar prefill
    // Restore a previously-used file (last-used defaults, or history re-import).
    setMedia(arr) {
      const it = (arr || [])[0];
      setSource(it && it.id ? { id: it.id, url: it.url, name: it.name } : null);
    },
    peekMedia: () => (source ? [{ id: source.id, url: source.url, name: source.name }] : []),
    localId: () => source?.id || null,
    async getValue() {
      if (!source) return token.default || "";
      if (uploadedRef) return uploadedRef;
      const res = await fetch("/api/comfy/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: source.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.data?.filename) throw new Error(data.msg || `Failed to upload ${token.name}`);
      uploadedRef = data.data.filename;
      return uploadedRef;
    },
  };
}

// Render the controls for the selected workflow.
function renderComfyControls() {
  comfyControlsEl.innerHTML = "";
  comfyFields = [];
  const wf = comfyWorkflows.find((w) => w.file === comfyFile());
  if (!wf) {
    comfyControlsEl.innerHTML = `<p class="muted">Workflow not found — try reloading.</p>`;
    return;
  }
  if (wf.error) {
    comfyControlsEl.innerHTML = `<p class="muted">This workflow isn't valid JSON: ${escapeHtmlJs(wf.error)}</p>`;
    return;
  }
  if (!wf.tokens.length) {
    comfyControlsEl.innerHTML =
      `<p class="muted">No <code>{{tokens}}</code> found in <b>${escapeHtmlJs(wf.name)}</b>. ` +
      `It will run exactly as saved. Add tokens like <code>{{prompt}}</code> to expose controls.</p>`;
    return;
  }
  // Build render items, grouping numbered media tokens (picture1, picture2, …)
  // into one multi-upload control per series — like the kie.ai reference fields.
  const items = [];
  const seriesByKey = new Map();
  wf.tokens.forEach((token, scanIndex) => {
    const type = comfyControlType(token);
    if (MEDIA_TYPES.has(type)) {
      const m = token.name.match(/^(.*?)(\d+)$/);
      if (m) {
        const key = `${type}:${m[1]}`;
        let it = seriesByKey.get(key);
        if (!it) {
          it = { kind: "series", type, base: m[1], entries: [], order: undefined, scanIndex };
          seriesByKey.set(key, it);
          items.push(it);
        }
        it.entries.push({ token, index: Number(m[2]) });
        if (token.order != null && (it.order == null || token.order < it.order)) it.order = token.order;
        return;
      }
      items.push({ kind: "single-media", type, token, order: token.order, scanIndex });
      return;
    }
    items.push({ kind: "scalar", type, token, order: token.order, scanIndex });
  });
  // A one-entry "series" is just a single control.
  for (const it of items) {
    if (it.kind === "series" && it.entries.length === 1) { it.kind = "single-media"; it.token = it.entries[0].token; }
  }
  // Order by the "; #N" hint; items without one keep scan order, after ordered ones.
  items.sort((a, b) => (a.order ?? 1000 + a.scanIndex) - (b.order ?? 1000 + b.scanIndex));

  for (const it of items) {
    if (it.kind === "series") {
      const entries = it.entries.sort((a, b) => a.index - b.index);
      const ctrl = makeComfyMediaMulti(it.base, it.type, entries.map((e) => e.token.name));
      ctrl.el.style.gridColumn = `span ${WIDTH_SPAN[entries[0].token.width] || 12}`;
      comfyControlsEl.appendChild(ctrl.el);
      comfyFields.push(ctrl);
    } else if (it.kind === "single-media") {
      const ctrl = makeComfyMedia(it.token, it.type);
      ctrl.el.style.gridColumn = `span ${comfySpan(it.token, it.type)}`;
      comfyControlsEl.appendChild(ctrl.el);
      comfyFields.push(ctrl);
    } else {
      renderScalarControl(it.token, it.type);
    }
  }
  // Overlay last-used values (over the token defaults) so the form reopens with
  // what you last ran.
  const saved = loadComfyDefaults(wf.file);
  if (saved) prefillComfyControls(saved);
}

// Build one scalar control (select / number / text / textarea) and register it.
function renderScalarControl(token, type) {
  const field = document.createElement("div");
  field.className = "field";
  field.style.gridColumn = `span ${comfySpan(token, type)}`;
  const head = document.createElement("div");
  head.className = "field-head";
  head.innerHTML = `<span>${escapeHtmlJs(prettyLabel(token.name))}</span>`;
  field.appendChild(head);
  let afterMode = null; // seed "control after generate" <select>, if present

  // Options are "value" or "Label=value" (e.g. Enabled=1|Disabled=0), so a
  // dropdown can show a friendly label while writing a different value.
  const parsedOptions =
    type === "select"
      ? token.options.map((o) => {
          const i = o.indexOf("=");
          return i >= 0 ? { label: o.slice(0, i).trim(), value: o.slice(i + 1).trim() } : { label: o, value: o };
        })
      : [];
  // A dropdown whose option values are all numbers should send a number.
  const numericSelect =
    type === "select" && parsedOptions.every((o) => o.value !== "" && !Number.isNaN(Number(o.value)));

  let input;
  if (type === "select") {
    input = document.createElement("select");
    for (const o of parsedOptions) input.appendChild(new Option(o.label, o.value));
    input.value = parsedOptions.some((o) => o.value === token.default) ? token.default : parsedOptions[0].value;
  } else if (type === "textarea") {
    input = document.createElement("textarea");
    input.rows = 4;
    input.value = token.default || "";
  } else {
    input = document.createElement("input");
    input.type = type === "number" ? "number" : "text";
    input.value = token.default || "";
    if (type === "number" && token.name.toLowerCase().includes("seed")) {
      // "Control after generate" mirrors ComfyUI's seed widget: how the seed
      // changes for the next run after you queue one.
      afterMode = document.createElement("select");
      afterMode.className = "seed-after";
      afterMode.title = "Control after generate";
      for (const m of ["fixed", "increment", "decrement", "randomize"]) afterMode.appendChild(new Option(m, m));
      afterMode.value = "fixed";
      const dice = document.createElement("button");
      dice.type = "button";
      dice.className = "link-btn";
      dice.textContent = "🎲";
      dice.title = "Randomize now";
      dice.addEventListener("click", () => { input.value = randomSeed(); });
      head.appendChild(afterMode);
      head.appendChild(dice);
    }
  }
  field.appendChild(input);
  comfyControlsEl.appendChild(field);
  const readValue = () => (type === "number" || numericSelect ? Number(input.value) : input.value);
  const ctrl = {
    name: token.name,
    getValue: async () => readValue(),
    peek: readValue, // sync read, for saving last-used defaults
    set: (v) => { input.value = v; },
  };
  if (afterMode) {
    ctrl.advance = () => {
      const cur = Number(input.value) || 0;
      if (afterMode.value === "increment") input.value = cur + 1;
      else if (afterMode.value === "decrement") input.value = cur - 1;
      else if (afterMode.value === "randomize") input.value = randomSeed();
    };
    // Remember the fixed/increment/decrement/randomize choice in last-used settings.
    ctrl.peekAfter = () => afterMode.value;
    ctrl.setAfter = (v) => { if (v) afterMode.value = v; };
  }
  comfyFields.push(ctrl);
}

// A multi-file control for a numbered token series (picture1, picture2, …). Built
// on the same reference-list component as the kie.ai fields — so it gets drag-to-
// reorder, "view full size", and the gallery picker for free — with numbered
// badges ("Picture 1, 2…"). The Nth file fills the Nth token; unfilled tokens are
// pruned at submit.
let comfyListSeq = 0;
function makeComfyMediaMulti(base, mediaKind, tokenNames) {
  const label = prettyLabel(base);
  const max = tokenNames.length;
  const list = makeMediaList(`comfy-${base}-${comfyListSeq++}`, {
    mediaType: mediaKind,
    build: true, // create our own field DOM (no static markup)
    gallery: true, // per-field "Pick from gallery"
    localOnly: true, // ComfyUI needs a saved file, not a hosted URL
    max,
    title: label,
    label,
    labelSep: " ", // "Picture 1" rather than "Picture1"
    hint: `(up to ${max}, in order — drag to reorder)`,
  });

  const ready = () => list.items.filter((i) => i.status === "ready");

  return {
    el: list.el,
    isMultiMedia: true,
    mediaKind,
    mediaKey: base,
    capacity: max,
    // Restore previously-used files (last-used defaults, or history re-import).
    setMedia(arr) {
      list.items = [];
      for (const it of (arr || []).slice(0, max)) {
        if (it?.id) list.addFromGallery({ id: it.id, localUrl: it.url, name: it.name });
      }
      list.render();
    },
    peekMedia: () =>
      ready()
        .filter((i) => i.localId)
        .map((i) => ({ id: i.localId, url: i.thumb, name: i.name })),
    localIds: () => list.localIds(),
    async resolve() {
      const values = {};
      const prune = [];
      const filled = ready();
      for (let i = 0; i < tokenNames.length; i++) {
        const it = filled[i];
        if (!it) { prune.push(tokenNames[i]); continue; }
        if (!it.localId) throw new Error(`${label}: drop a file (URL inputs aren't supported for local workflows).`);
        if (!it.comfyRef) {
          const res = await fetch("/api/comfy/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: it.localId }),
          });
          const data = await res.json();
          if (!res.ok || !data.data?.filename) throw new Error(data.msg || `Failed to upload ${tokenNames[i]}`);
          it.comfyRef = data.data.filename;
        }
        values[tokenNames[i]] = it.comfyRef;
      }
      return { values, prune };
    },
  };
}

// Prefill the active workflow's controls from a saved values blob. Scalar values
// live at the top level; last-used media files (if any) live under `__media`,
// keyed by control (media can't be restored from a saved values blob otherwise).
function prefillComfyControls(values) {
  const media = values.__media || null;
  const after = values.__after || null;
  for (const f of comfyFields) {
    if (media && typeof f.setMedia === "function" && f.mediaKey in media) {
      f.setMedia(media[f.mediaKey]);
    } else if (f.name in values && typeof f.set === "function") {
      f.set(values[f.name]);
    }
    if (after && typeof f.setAfter === "function" && f.name in after) f.setAfter(after[f.name]);
  }
}

// Re-populate a ComfyUI workflow's media fields from a saved History entry's
// gallery ids. Ids are resolved to the saved files and distributed across the
// media controls of each kind in order (each takes up to its capacity).
async function restoreComfyMedia(entry) {
  const localIds = entry.mediaLocalIds || { image: entry.imageLocalIds || [] };
  const kinds = ["image", "video", "audio"];
  if (!kinds.some((k) => (localIds[k] || []).length)) return;
  let saved = [];
  try {
    saved = await fetch("/api/images").then((r) => r.json()).then((d) => d.data || []);
  } catch {
    return;
  }
  const byId = new Map(saved.map((i) => [i.id, i]));
  for (const kind of kinds) {
    const items = (localIds[kind] || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((i) => ({ id: i.id, url: i.localUrl, name: i.name }));
    let queue = items;
    for (const f of comfyFields) {
      if (f.mediaKind !== kind || typeof f.setMedia !== "function") continue;
      f.setMedia(queue.slice(0, f.capacity || 1));
      queue = queue.slice(f.capacity || 1);
    }
  }
}

// Last-used values per workflow (localStorage) so the form reopens with what you
// last ran — including the media files you picked (by gallery id/url, under
// `__media`). Token `=default`s are the base; these override them.
const comfyDefaultsKey = (file) => `comfy_defaults:${file}`;
function loadComfyDefaults(file) {
  try {
    return JSON.parse(localStorage.getItem(comfyDefaultsKey(file)) || "null");
  } catch {
    return null;
  }
}
function saveComfyDefaults(file) {
  const defaults = { __media: {}, __after: {} };
  for (const f of comfyFields) {
    if (typeof f.peekMedia === "function") defaults.__media[f.mediaKey] = f.peekMedia();
    else if (typeof f.peek === "function") defaults[f.name] = f.peek();
    if (typeof f.peekAfter === "function") defaults.__after[f.name] = f.peekAfter();
  }
  try {
    localStorage.setItem(comfyDefaultsKey(file), JSON.stringify(defaults));
  } catch {
    /* storage full/blocked — non-fatal */
  }
}

// Gather token values (uploading media to ComfyUI as needed). Empty optional media
// controls are returned in `prune` so the server can drop their loader nodes.
async function collectComfyValues() {
  const values = {};
  const prune = [];
  for (const f of comfyFields) {
    if (f.isMultiMedia) {
      const r = await f.resolve(); // fills the filled slots, prunes the empty ones
      Object.assign(values, r.values);
      prune.push(...r.prune);
      continue;
    }
    if (f.isMedia && !f.hasDefault && !f.localId()) {
      prune.push(f.name); // nothing selected — prune this reference loader
      continue;
    }
    values[f.name] = await f.getValue();
  }
  return { values, prune };
}

// How many generations to queue (the ×N counter, local ComfyUI only).
function comfyQueueCount() {
  const n = Math.floor(Number(document.getElementById("comfyCount").value) || 1);
  return Math.min(20, Math.max(1, n));
}

// Submit a ComfyUI workflow. Queues `count` runs back-to-back; between runs the
// seed advances (control-after-generate), so with a randomize/increment seed each
// queued run differs. Media uploads are cached, so only the first run uploads.
async function submitComfy() {
  const wf = comfyWorkflows.find((w) => w.file === comfyFile());
  if (!wf) return setError("Workflow not found — try reloading.");
  hide(errorEl);
  submitBtn.disabled = true;
  const count = comfyQueueCount();
  try {
    for (let i = 0; i < count; i++) {
      const { values, prune } = await collectComfyValues();
      const mediaIds = { image: [], video: [], audio: [] };
      for (const f of comfyFields) {
        if (f.isMultiMedia) mediaIds[f.mediaKind]?.push(...f.localIds());
        else if (f.isMedia) {
          const localId = f.localId();
          if (localId) mediaIds[f.mediaKind]?.push(localId);
        }
      }
      const input = { model: `comfy:${wf.file}`, workflow: wf.name, values };
      if (typeof values.prompt === "string" && values.prompt.trim()) input.prompt = values.prompt.trim();
      await queueComfyRun(wf, values, prune, mediaIds, input);
      // Advance seeds for the next queued run (no-op when the mode is "fixed").
      for (const f of comfyFields) if (typeof f.advance === "function") f.advance();
    }
    saveComfyDefaults(wf.file); // remember the final values
  } finally {
    submitBtn.disabled = false;
  }
}

// Queue one ComfyUI run: create its card, submit, save the prompt to History
// immediately, wire Cancel, and start polling.
async function queueComfyRun(wf, values, prune, mediaIds, input) {
  const job = {
    jobId: nextJobId++,
    taskId: null,
    input,
    mediaLocalIds: mediaIds,
    projectId: activeProjectId,
    startedAt: Date.now(),
  };
  const card = createJobCard(job);
  card.el.classList.add("comfy-job"); // marks local runs for the host-stats readout
  try {
    card.setStatus("Queueing on ComfyUI…");
    const res = await fetch("/api/comfy/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: wf.file, values, prune }),
    });
    const data = await res.json();
    if (!res.ok || data.code !== 200 || !data.data?.promptId) {
      throw new Error(data.msg || "ComfyUI rejected the workflow.");
    }
    job.taskId = data.data.promptId;
    card.setTaskId(job.taskId);
    card.setStatus("Generating on ComfyUI… this can take a while.");
    // Save the prompt/settings to History now — before it finishes — so a failed
    // or cancelled run doesn't lose them.
    job.historyId = await createHistoryEntry(job.input, job.taskId, job.mediaLocalIds, job.projectId, 0);
    addInflight(job);
    wireComfyCancel(job, card);
    pollComfyJob(job, card);
  } catch (err) {
    card.fail(err.message || String(err));
  }
}

// Poll a ComfyUI job (server normalizes /history into the kie.ai status shape).
async function pollComfyJob(job, card) {
  if (job.cancelled) return; // stopped by the user
  try {
    const res = await fetch(`/api/comfy/status?promptId=${encodeURIComponent(job.taskId)}`);
    if (job.cancelled) return; // cancelled while this poll was in flight
    const data = await res.json();
    if (!res.ok || data.code !== 200) {
      if (res.status >= 400 && res.status < 500) removeInflight(job.taskId);
      throw new Error(data.msg || `Status check failed (${res.status})`);
    }
    const state = data.data?.state;
    if (state === "success") {
      removeInflight(job.taskId);
      const url = JSON.parse(data.data.resultJson || "{}").resultUrls?.[0];
      if (!url) throw new Error("Finished, but ComfyUI returned no output file.");
      const isImg = /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(url);
      card.showResult(isImg, url, ""); // local model — no credit cost
      attachHistoryResult(job, url, null);
      return;
    }
    if (state === "fail") {
      removeInflight(job.taskId);
      throw new Error(data.data?.failMsg || "ComfyUI generation failed.");
    }
    // Still running — surface live step progress if ComfyUI reported any (this
    // also drives the elapsed/ETA clock on the card).
    const prog = data.data?.progress;
    if (prog && prog.max > 0) card.setProgress(prog.value, prog.max);
    setTimeout(() => pollComfyJob(job, card), POLL_INTERVAL_MS);
  } catch (err) {
    if (job.cancelled) return; // cancellation isn't a failure
    card.fail(err.message || String(err));
  }
}

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
// Form-level error (validation / pre-submit failures). Per-job errors live on
// the job card instead — see JobCard.fail().
function setError(msg) {
  errorEl.textContent = msg;
  show(errorEl);
}

// --- job cards ---------------------------------------------------------------
// Each generation gets its own card so many can run at once. A card walks
// through: submitting → generating → (success shows the result | fail shows the
// error). Terminal cards get a dismiss × and stay until the user clears them.
let nextJobId = 1;

// Finished/failed cards — the ones safe to dismiss ("running" ones are still
// working and have no × yet, so Close All leaves them alone).
function terminalCards() {
  return [...jobsEl.querySelectorAll(".job-card")].filter((c) => c.dataset.status !== "running");
}

// Keep the container + Close All header in sync with the cards on screen.
function updateJobsChrome() {
  jobsEl.classList.toggle("hidden", jobsEl.children.length === 0);
  // Only worth a bulk control once there's more than one preview to clear.
  jobsHeader.classList.toggle("hidden", terminalCards().length < 2);
}

closeAllJobsBtn.addEventListener("click", () => {
  for (const card of terminalCards()) card.remove();
  updateJobsChrome();
});

// Human-readable elapsed/ETA, e.g. "8s", "2m 05s", "1h 03m".
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function createJobCard(job) {
  const card = document.createElement("div");
  card.className = "job-card";
  card.dataset.status = "running";

  const main = document.createElement("div");
  main.className = "job-main";

  const line = document.createElement("div");
  line.className = "status-line";
  const spin = document.createElement("span");
  spin.className = "spinner";
  const statusText = document.createElement("span");
  statusText.className = "job-status";
  statusText.textContent = "Submitting…";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "job-cancel hidden";
  cancelBtn.textContent = "Cancel";
  line.append(spin, statusText, cancelBtn);

  const taskIdEl = document.createElement("div");
  taskIdEl.className = "task-id";

  // Live progress bar (ComfyUI runs report sampler steps; hidden until we get one).
  const progressWrap = document.createElement("div");
  progressWrap.className = "job-progress hidden";
  const progressBar = document.createElement("div");
  progressBar.className = "job-progress-bar";
  progressWrap.appendChild(progressBar);

  main.append(line, taskIdEl, progressWrap);

  const result = document.createElement("div");
  result.className = "job-result hidden";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "job-dismiss hidden";
  dismiss.textContent = "×";
  dismiss.title = "Dismiss";
  dismiss.addEventListener("click", () => {
    card.remove();
    updateJobsChrome();
  });

  card.append(dismiss, main, result);
  jobsEl.prepend(card); // newest on top
  updateJobsChrome();

  // Progress state for the live elapsed/ETA clock. `anchor` is the first tick of
  // the current sampler pass; rate = steps since the anchor / time since it. A
  // 1s ticker repaints the status line so elapsed advances between polls.
  let progInfo = null; // { value, max, anchorT, anchorValue }
  let progStartedAt = null;
  let progTicker = null;

  const paintProgress = () => {
    if (!progInfo) return;
    const { value, max, anchorT, anchorValue } = progInfo;
    const now = Date.now();
    const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
    const elapsed = fmtDuration(now - (progStartedAt || now));
    let eta = "";
    const dv = value - anchorValue;
    const dt = now - anchorT;
    if (value < max && dv > 0 && dt > 0) {
      eta = ` · ~${fmtDuration((max - value) * (dt / dv))} left`;
    }
    statusText.textContent = `Generating on ComfyUI… step ${value}/${max} (${pct}%) · ${elapsed} elapsed${eta}`;
  };
  const stopProgressClock = () => {
    clearInterval(progTicker);
    progTicker = null;
  };

  const api = {
    el: card,
    setStatus(text) {
      statusText.textContent = text;
    },
    setTaskId(taskId) {
      taskIdEl.textContent = `Task ID: ${taskId}`;
    },
    // Update the live progress bar + elapsed/ETA clock (0–100% from value/max).
    setProgress(value, max) {
      if (!max || max <= 0) return;
      progStartedAt ??= job.startedAt || Date.now();
      // New sampler pass (value reset) or first sighting → re-anchor the rate.
      if (!progInfo || value < progInfo.value) progInfo = { value, max, anchorT: Date.now(), anchorValue: value };
      else progInfo = { value, max, anchorT: progInfo.anchorT, anchorValue: progInfo.anchorValue };
      const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
      progressBar.style.width = `${pct}%`;
      progressWrap.classList.remove("hidden");
      paintProgress();
      if (!progTicker) progTicker = setInterval(paintProgress, 1000);
    },
    showResult(isImage, url, costText) {
      card.dataset.status = "done";
      line.remove();
      progressWrap.remove();
      stopProgressClock();
      const media = document.createElement(isImage ? "img" : "video");
      media.src = url;
      if (!isImage) media.controls = true;
      if (isImage) {
        media.alt = "Generated image";
        media.classList.add("zoomable"); // click to open full-size
        media.addEventListener("click", () => openLightbox("image", url, "Generated image"));
      }
      const meta = document.createElement("p");
      meta.className = "hist-meta";
      meta.textContent = costText || "";
      const link = document.createElement("a");
      link.className = "job-download";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open result in new tab";
      result.append(media, meta, link);
      show(result);
      dismiss.classList.remove("hidden");
      updateJobsChrome();
    },
    fail(msg) {
      card.dataset.status = "failed";
      line.remove();
      progressWrap.remove();
      stopProgressClock();
      const err = document.createElement("pre");
      err.className = "job-error";
      err.textContent = msg;
      result.append(err);
      show(result);
      dismiss.classList.remove("hidden");
      updateJobsChrome();
    },
    // Show a Cancel button while running; `fn` runs on click (once).
    onCancel(fn) {
      cancelBtn.classList.remove("hidden");
      cancelBtn.addEventListener(
        "click",
        async () => {
          cancelBtn.disabled = true;
          statusText.textContent = "Cancelling…";
          await fn();
        },
        { once: true }
      );
    },
    // Terminal "cancelled" state (distinct from a failure).
    cancelled(msg) {
      card.dataset.status = "cancelled";
      line.remove();
      progressWrap.remove();
      stopProgressClock();
      const note = document.createElement("p");
      note.className = "job-note";
      note.textContent = msg || "Cancelled.";
      result.append(note);
      show(result);
      dismiss.classList.remove("hidden");
      updateJobsChrome();
    },
  };
  return api;
}

// Wire the Cancel button on a ComfyUI job card: cancel the specific prompt on
// ComfyUI (interrupt if running, drop from the queue if pending) without stopping
// ComfyUI itself. The prompt is already in History, so it can be re-run.
function wireComfyCancel(job, card) {
  card.onCancel(async () => {
    job.cancelled = true;
    removeInflight(job.taskId);
    try {
      await fetch("/api/comfy/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptId: job.taskId }),
      });
    } catch (err) {
      console.error("Cancel failed:", err);
    }
    card.cancelled("Cancelled. The prompt is saved in History — re-run it any time.");
  });
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
  const input = {
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
  // Start/end keyframes — all Seedance video models. `resolved` is already
  // mode-gated (empty unless the frames toggle is active), so these never coexist
  // with reference_image_urls.
  if (resolved.firstFrame?.[0]) input.first_frame_url = resolved.firstFrame[0];
  if (resolved.lastFrame?.[0]) input.last_frame_url = resolved.lastFrame[0];
  // 2.5-only extras: output format + last-frame return.
  if (is25()) {
    input.output_format = document.getElementById("output_format").value;
    input.return_last_frame = document.getElementById("return_last_frame").checked;
  }
  return input;
}

// --- submit / generate --------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Local ComfyUI workflows have their own submit path (no kie.ai uploads/credits).
  if (isComfy()) {
    submitComfy();
    return;
  }

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

  hide(errorEl);
  // Lock only for the upload→create window so a double-click can't double-submit
  // the same form. It re-enables once the task is created, freeing you to queue
  // another generation while this one keeps polling in the background.
  submitBtn.disabled = true;

  const mediaLocalIds = {
    image: isT2I() || usesFrames() ? [] : lists.image.localIds(),
    video: isSeedream() ? [] : lists.video.localIds(),
    audio: isSeedream() ? [] : lists.audio.localIds(),
    firstFrame: usesFrames() ? lists.firstFrame.localIds() : [],
    lastFrame: usesFrames() ? lists.lastFrame.localIds() : [],
  };

  const job = {
    jobId: nextJobId++,
    taskId: null,
    input: null,
    mediaLocalIds,
    balanceBefore: null,
    projectId: activeProjectId, // pin now so a mid-run project switch can't misfile it
    refSecs: isSeedream() ? 0 : refVideoSeconds(),
    startedAt: Date.now(),
  };
  const card = createJobCard(job);

  // Host reference media on kie.ai now — nothing was sent when they were dropped.
  let resolved;
  try {
    if (allItems().some((i) => i.status === "ready")) {
      card.setStatus("Uploading reference media…");
    }
    resolved = {
      // only upload the reference kinds the selected model+mode actually uses
      // (2.5 forbids mixing reference images with first/last frames)
      image: isT2I() || usesFrames() ? [] : await lists.image.resolve(),
      video: isSeedream() ? [] : await lists.video.resolve(),
      audio: isSeedream() ? [] : await lists.audio.resolve(),
      firstFrame: usesFrames() ? await lists.firstFrame.resolve() : [],
      lastFrame: usesFrames() ? await lists.lastFrame.resolve() : [],
    };
  } catch (err) {
    card.fail(err.message || "Failed to upload reference media.");
    submitBtn.disabled = false;
    return;
  }

  job.input = collectInput(resolved);
  card.setStatus("Submitting…");

  // Snapshot the balance so we can measure actual cost on completion. (With
  // overlapping runs this delta is unreliable; the per-task creditsConsumed
  // reported on completion is the primary source and stays accurate.)
  job.balanceBefore = await loadCredits();

  try {
    job.taskId = await createTask(job.input, card);
    card.setTaskId(job.taskId);
    card.setStatus("Generating… this can take a few minutes.");
    // Save the prompt/settings to History now so a failed run doesn't lose them.
    job.historyId = await createHistoryEntry(job.input, job.taskId, job.mediaLocalIds, job.projectId, job.refSecs);
    addInflight(job);
    pollJob(job, card);
  } catch (err) {
    card.fail(err.message || String(err));
  } finally {
    submitBtn.disabled = false;
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST /api/create, retrying on HTTP 429 — kie.ai's one hard limit is 20 new
// requests / 10s, and rejected requests are NOT queued, so we back off and retry.
const RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_BACKOFF_MS = 6000;
async function createTask(input, card) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      card.setStatus(`Rate-limited — retrying (${attempt + 1}/${RATE_LIMIT_RETRIES})…`);
      await sleep(RATE_LIMIT_BACKOFF_MS);
      continue;
    }
    if (!res.ok || data.code !== 200 || !data.data?.taskId) {
      throw new Error(data.msg || `Request failed (${res.status})`);
    }
    return data.data.taskId;
  }
}

async function pollJob(job, card) {
  const { taskId, input, mediaLocalIds, balanceBefore, projectId, refSecs } = job;
  try {
    const res = await fetch(`/api/status?taskId=${encodeURIComponent(taskId)}`);
    const data = await res.json();

    if (!res.ok || data.code !== 200) {
      // 4xx means the task is gone/invalid — terminal, stop tracking it.
      if (res.status >= 400 && res.status < 500) removeInflight(taskId);
      throw new Error(data.msg || `Status check failed (${res.status})`);
    }

    const state = data.data?.state;

    if (state === "success") {
      removeInflight(taskId);
      const parsed = JSON.parse(data.data.resultJson || "{}");
      const url = parsed.resultUrls?.[0];
      if (!url) throw new Error("Task succeeded but no result URL was returned.");

      // Prefer the API's exact per-task cost (creditsConsumed on recordInfo);
      // fall back to the balance delta for older responses (unreliable when
      // runs overlap — see the submit-time note).
      const balanceAfter = await loadCredits(); // also refreshes the header balance
      let cost = null;
      const reported = Number(data.data.creditsConsumed);
      if (Number.isFinite(reported) && reported > 0) {
        cost = reported;
      } else if (typeof balanceBefore === "number" && typeof balanceAfter === "number") {
        const delta = balanceBefore - balanceAfter;
        if (delta > 0) cost = delta;
      }

      card.showResult(
        isImageOutput(input?.model),
        url,
        cost != null ? `Used ~${cost.toLocaleString()} credits` : ""
      );
      attachHistoryResult(job, url, cost);
      return;
    }

    if (state === "fail") {
      removeInflight(taskId);
      throw new Error(
        data.data?.failMsg || `Generation failed (code ${data.data?.failCode ?? "?"}).`
      );
    }

    setTimeout(() => pollJob(job, card), POLL_INTERVAL_MS);
  } catch (err) {
    // Transient status-check errors keep the inflight record (a reload can
    // resume it); terminal states already removed it above.
    card.fail(err.message || String(err));
  }
}

// --- history -------------------------------------------------------------------
// Create a PENDING history entry at submit time so the prompt/settings are saved
// immediately — a run that later fails, stalls, or is cancelled won't lose them.
// Returns the new entry's id (to attach the output to on success).
async function createHistoryEntry(input, taskId, mediaLocalIds, projectId, refSecs) {
  try {
    const res = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input,
        taskId,
        mediaLocalIds,
        refVideoSeconds: typeof refSecs === "number" ? refSecs : 0,
        projectId: projectId || activeProjectId,
        imageLocalIds: mediaLocalIds?.image || [], // kept for older readers of history.json
      }),
    });
    const data = await res.json();
    loadHistory();
    return data.data?.id || null;
  } catch (err) {
    console.error("Failed to create history entry:", err);
    return null;
  }
}

// Attach the finished output to a pending entry (downloads the file). Falls back
// to a fresh save if there's no pending id (e.g. a job resumed from a reload
// predating the pending entry).
async function attachHistoryResult(job, resultUrl, costCredits) {
  try {
    if (job.historyId) {
      await fetch(`/api/history/${job.historyId}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultUrl, costCredits }),
      });
    } else {
      await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: job.input,
          taskId: job.taskId,
          resultUrl,
          costCredits,
          mediaLocalIds: job.mediaLocalIds,
          refVideoSeconds: typeof job.refSecs === "number" ? job.refSecs : 0,
          projectId: job.projectId || activeProjectId,
          imageLocalIds: job.mediaLocalIds?.image || [],
        }),
      });
    }
    loadHistory();
  } catch (err) {
    console.error("Failed to save history result:", err);
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

// The history entries the current filter keeps, in display order — shared by
// the rendered list and the lightbox's ‹ › navigation so they stay in sync.
function filterHistory(entries) {
  const filter = historyFilter.value || "all";
  return filter === "all" ? entries : entries.filter((e) => (e.projectId || "default") === filter);
}

// True if a saved-output URL/path points at a still image (used for ComfyUI,
// whose output medium isn't derivable from the model id).
const isImageFile = (u) => /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(u || "");

// kind/src/name for opening a history entry in the lightbox.
function historyItemMedia(entry) {
  const input = entry.input || {};
  const src = entry.localVideo || entry.resultUrl; // localVideo is the saved output file
  const kind = (input.model || "").startsWith("comfy:")
    ? isImageFile(src) ? "image" : "video"
    : isImageOutput(input.model) ? "image" : "video";
  return { kind, src, name: input.prompt };
}

// Open a history entry full-size, with arrow navigation across the visible list.
function openHistoryLightbox(entry) {
  const items = filterHistory(historyEntries);
  const index = items.findIndex((e) => e.id === entry.id);
  const m = historyItemMedia(entry);
  openLightbox(m.kind, m.src, m.name, index >= 0 ? { items, index } : null);
}

// Human-readable spend category for a model id, used in the per-project credit
// breakdown. Entries predating model storage were Seedance 2 (matches the
// estimate code's default), Lite/Pro collapse i2i + t2i into one category.
function creditCategory(model) {
  const m = model || "bytedance/seedance-2";
  if (m.startsWith("comfy:")) return "ComfyUI (local)";
  if (m.startsWith("seedream/"))
    return m.includes("5-pro") ? "Seedream Pro" : "Seedream Lite";
  if (m === "bytedance/seedance-2-5") return "Seedance 2.5";
  if (m === "bytedance/seedance-2-fast") return "Seedance 2 Fast";
  if (m === "bytedance/seedance-2-mini") return "Seedance 2 Mini";
  if (m === "bytedance/seedance-2") return "Seedance 2";
  return "Other";
}

// Total (and per-category) credits spent in the active project, shown in the
// header line below the account balance.
function renderProjectCredits() {
  if (!projectCreditsTotal) return;
  const entries = historyEntries.filter(
    (e) => (e.projectId || "default") === activeProjectId
  );
  let total = 0;
  const byCat = new Map();
  for (const e of entries) {
    const c = typeof e.costCredits === "number" ? e.costCredits : 0;
    if (!c) continue;
    total += c;
    const cat = creditCategory(e.input?.model);
    byCat.set(cat, (byCat.get(cat) || 0) + c);
  }
  projectCreditsTotal.textContent = `${total.toLocaleString()} credits`;

  projectCreditsBreakdown.innerHTML = "";
  const rows = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "pc-empty";
    p.textContent = "No credits spent in this project yet.";
    projectCreditsBreakdown.appendChild(p);
    return;
  }
  for (const [cat, amt] of rows) {
    const row = document.createElement("div");
    row.className = "pc-row";
    const name = document.createElement("span");
    name.className = "pc-cat";
    name.textContent = cat;
    const val = document.createElement("span");
    val.className = "pc-amt";
    val.textContent = amt.toLocaleString();
    row.append(name, val);
    projectCreditsBreakdown.appendChild(row);
  }
}

function renderHistory(entries) {
  renderProjectCredits();
  historyEl.innerHTML = "";
  const filter = historyFilter.value || "all"; // used below for the per-entry project label
  const visible = filterHistory(entries);
  historyEmpty.classList.toggle("hidden", visible.length > 0);

  for (const entry of visible) {
    const input = entry.input || {};
    const card = document.createElement("div");
    card.className = "hist-card";

    // ComfyUI output medium isn't encoded in the model id — read it off the file.
    const comfyEntry = (input.model || "").startsWith("comfy:");
    const output = entry.localVideo || entry.resultUrl;
    const isImg = comfyEntry ? isImageFile(output) : isImageOutput(input.model);
    if (!output) {
      // Pending entry (saved at submit time, no output yet) — or a run that
      // failed/was cancelled before producing one. Prompt is preserved; Re-run works.
      const ph = document.createElement("div");
      ph.className = `hist-placeholder ${entry.status === "pending" ? "pending" : "unfinished"}`;
      ph.textContent = entry.status === "pending" ? "⏳ Generating…" : "no output — re-run below";
      card.appendChild(ph);
    } else {
      if (isImg) {
        const im = document.createElement("img");
        im.src = output; // localVideo holds the saved output file
        im.className = "hist-img zoomable";
        im.loading = "lazy";
        im.addEventListener("click", () => openHistoryLightbox(entry)); // full-size, with ‹ › nav
        card.appendChild(im);
      } else {
        const vid = document.createElement("video");
        vid.src = output;
        vid.controls = true;
        vid.preload = "metadata";
        card.appendChild(vid);
      }
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
    if (comfyEntry) {
      const wfName = input.workflow || input.model.slice("comfy:".length).replace(/\.json$/i, "");
      const seed = input.values?.seed;
      const seedStr = seed !== undefined && seed !== null && seed !== "" ? ` · seed ${seed}` : "";
      meta.textContent = `${date} · ComfyUI · ${wfName}${seedStr}${counts ? ` · ${counts}` : ""}${proj}`;
    } else if (isImg) {
      meta.textContent =
        `${date} · ${seedreamLabel(input.model)} · ${input.quality || "basic"} · ${input.aspect_ratio || "?"}` +
        `${counts ? ` · ${counts}` : ""}${cost}${proj}`;
    } else {
      const variant = VIDEO_VARIANT_LABEL[input.model] ? ` · ${VIDEO_VARIANT_LABEL[input.model]}` : "";
      meta.textContent =
        `${date}${variant} · ${input.resolution || "?"} · ${input.aspect_ratio || "?"} · ` +
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
    copyBtn.innerHTML = '<span class="btn-ico">⧉</span> Prompt';
    copyBtn.title = "Copy the prompt to the clipboard";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(input.prompt || "");
        copyBtn.textContent = "Copied!";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => (copyBtn.innerHTML = '<span class="btn-ico">⧉</span> Prompt'), 1200);
    });
    actions.appendChild(copyBtn);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn-secondary";
    openBtn.innerHTML = '<span class="btn-ico">⛶</span> Open';
    openBtn.title = "Open full size";
    openBtn.addEventListener("click", () => openHistoryLightbox(entry));
    actions.appendChild(openBtn);

    // add the generated image to the gallery for its own project
    if (isImg) {
      const galleryBtn = document.createElement("button");
      galleryBtn.type = "button";
      galleryBtn.className = "btn-secondary";
      galleryBtn.innerHTML = '<span class="btn-ico">＋</span> Gallery';
      galleryBtn.title = "Add this image to the gallery";
      galleryBtn.addEventListener("click", async () => {
        galleryBtn.disabled = true;
        try {
          const res = await fetch(`/api/history/${entry.id}/to-gallery`, { method: "POST" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.msg || "Failed to add to gallery");
          galleryBtn.innerHTML = "Added!";
          loadGallery();
          setTimeout(() => {
            galleryBtn.innerHTML = '<span class="btn-ico">＋</span> Gallery';
            galleryBtn.disabled = false;
          }, 1200);
        } catch (err) {
          alert(err.message || String(err));
          galleryBtn.innerHTML = '<span class="btn-ico">＋</span> Gallery';
          galleryBtn.disabled = false;
        }
      });
      actions.appendChild(galleryBtn);
    }

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

    // delete this entry (removes the saved output too) — with confirmation
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-secondary hist-delete";
    del.innerHTML = '<span class="btn-ico">🗑</span> Delete';
    del.title = "Delete this history item";
    del.addEventListener("click", async () => {
      if (!confirm("Delete this history item? This also removes its saved output file and can't be undone.")) return;
      del.disabled = true;
      try {
        const res = await fetch(`/api/history/${entry.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).msg || "Delete failed");
        loadHistory();
      } catch (err) {
        alert(err.message || String(err));
        del.disabled = false;
      }
    });
    actions.appendChild(del);

    body.appendChild(actions);
    card.appendChild(body);
    historyEl.appendChild(card);
  }
}

// Populate the form from a saved history entry (local files re-host at generate).
async function applyEntry(entry) {
  const input = entry.input || {};

  // ComfyUI entries: reselect the workflow and prefill its controls (images can't
  // be restored from a saved ref, so they're left empty).
  if ((input.model || "").startsWith("comfy:")) {
    if (![...modelSelect.options].some((o) => o.value === input.model)) {
      setError(
        `Workflow "${input.workflow || input.model.slice("comfy:".length)}" isn't loaded — ` +
          `put its .json back in the workflows folder and reload.`
      );
      return;
    }
    modelSelect.value = input.model;
    applyModelUI(); // renders the workflow's controls with defaults
    prefillComfyControls(input.values || {});
    await restoreComfyMedia(entry); // re-populate the image/video/audio fields
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  modelSelect.value = input.model || "bytedance/seedance-2";
  // Restore the 2.5 image-source mode (frames if the entry saved either keyframe).
  const savedMode = input.first_frame_url || input.last_frame_url ? "frames" : "refs";
  const modeRadio = document.querySelector(`input[name="imageSource"][value="${savedMode}"]`);
  if (modeRadio) modeRadio.checked = true;
  applyModelUI(); // shape the form (and aspect options) before filling values
  document.getElementById("prompt").value = input.prompt || "";
  document.getElementById("resolution").value = input.resolution || "720p";
  if (input.aspect_ratio) aspectSelect.value = input.aspect_ratio;
  qualitySelect.value = input.quality || "basic";
  // applyModelUI already set the format options + default for this model; only
  // override when the saved entry recorded one.
  if (input.output_format) outputFormatSelect.value = input.output_format;
  updatePromptCount();
  if (input.duration) document.getElementById("duration").value = input.duration;
  document.getElementById("generate_audio").checked = input.generate_audio !== false;
  document.getElementById("web_search").checked = !!input.web_search;
  document.getElementById("nsfw_checker").checked = !!input.nsfw_checker;
  document.getElementById("return_last_frame").checked = !!input.return_last_frame;

  const saved = await fetch("/api/images").then((r) => r.json()).then((d) => d.data || []);
  const localIds = entry.mediaLocalIds || { image: entry.imageLocalIds || [] };
  const urlsByKind = {
    image: input.reference_image_urls || input.image_urls || [],
    video: input.reference_video_urls || [],
    audio: input.reference_audio_urls || [],
    firstFrame: input.first_frame_url ? [input.first_frame_url] : [],
    lastFrame: input.last_frame_url ? [input.last_frame_url] : [],
  };

  for (const kind of ["image", "video", "audio", "firstFrame", "lastFrame"]) {
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

// Resume every generation that was in flight when the tab was closed/reloaded.
function resumeInflight() {
  const fresh = loadInflightList().filter(
    (p) => p?.taskId && !(p.startedAt && Date.now() - p.startedAt > INFLIGHT_MAX_AGE_MS)
  );
  saveInflightList(fresh); // prune stale/aged-out entries

  for (const pending of fresh) {
    const job = {
      jobId: nextJobId++,
      taskId: pending.taskId,
      historyId: pending.historyId || null,
      input: pending.input,
      // older saved state used imageLocalIds (a plain array)
      mediaLocalIds: pending.mediaLocalIds || { image: pending.imageLocalIds || [] },
      balanceBefore: pending.balanceBefore,
      projectId: pending.projectId || activeProjectId,
      refSecs: pending.refSecs || 0,
      startedAt: pending.startedAt,
    };
    const card = createJobCard(job);
    card.setTaskId(job.taskId);
    card.setStatus("Resuming previous generation… this can take a few minutes.");
    // Route resumed jobs to the matching poller (ComfyUI vs kie.ai).
    const isComfyJob = (pending.input?.model || "").startsWith("comfy:");
    if (isComfyJob) card.el.classList.add("comfy-job");
    if (isComfyJob) wireComfyCancel(job, card);
    if (isComfyJob) pollComfyJob(job, card);
    else pollJob(job, card);
  }
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

// --- host stats readout (CPU / GPU / VRAM) --------------------------------------
// Shown whenever a ComfyUI workflow is selected or a local run is in flight:
// polls every 2s during an active run, every 5s while idle. Hidden (and not polled)
// otherwise, so we don't shell out to nvidia-smi when ComfyUI isn't in play.
const comfyStatsEl = document.getElementById("comfyStats");
const COMFY_STATS_ACTIVE_MS = 2000;
const COMFY_STATS_IDLE_MS = 5000;
let comfyStatsTimer = null;

function renderComfyStats(d) {
  if (!d) return;
  const pct = (v) => (v == null ? "–" : `${v}%`);
  const parts = [`CPU ${pct(d.cpu)}`, `GPU ${pct(d.gpu)}`];
  if (d.vram) {
    const gb = (mib) => (mib / 1024).toFixed(1);
    parts.push(`VRAM ${d.vram.pct}% (${gb(d.vram.used)}/${gb(d.vram.total)} GB)`);
  } else {
    parts.push("VRAM –");
  }
  comfyStatsEl.textContent = `⚙ ${parts.join("   ·   ")}`;
}

function scheduleComfyStats(delay) {
  clearTimeout(comfyStatsTimer);
  comfyStatsTimer = setTimeout(comfyStatsTick, delay);
}

async function comfyStatsTick() {
  const running = document.querySelector('.comfy-job[data-status="running"]');
  if (running || isComfy()) {
    try {
      const r = await fetch("/api/comfy/stats");
      const d = (await r.json())?.data;
      renderComfyStats(d);
      comfyStatsEl.classList.remove("hidden");
    } catch {
      /* transient — keep the last reading */
    }
  } else {
    comfyStatsEl.classList.add("hidden");
  }
  scheduleComfyStats(running ? COMFY_STATS_ACTIVE_MS : COMFY_STATS_IDLE_MS);
}
comfyStatsTick();

// --- initial load ---------------------------------------------------------------
applyModelUI(); // sync title, button, and model-dependent fields to the default
loadProjects();
loadCredits();
loadGallery();
loadHistory();
loadWorkflows(); // add any local ComfyUI workflows to the model dropdown
resumeInflight();
