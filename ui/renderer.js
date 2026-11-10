"use strict";

const $ = (id) => document.getElementById(id);
const api = window.eraser;
const editable = new Set(["draft", "error"]);
const removable = new Set([
  "draft",
  "error",
  "completed",
  "cloud_failed",
  "download_error",
]);
const statuses = {
  draft: "待开始",
  queued: "排队中",
  uploading: "上传中",
  submitting: "提交中",
  processing: "云端处理中",
  query_error: "等待恢复查询",
  submission_unknown: "提交待核对",
  downloading: "下载中",
  download_pending: "等待下载",
  download_error: "下载待重试",
  completed: "已完成",
  cloud_failed: "处理失败",
  error: "待调整",
};
let state = {
  tasks: [],
  settings: { theme: "light", outputDir: "" },
  hasKey: false,
};
let selectedId = null;
let currentView = "source";
let previewKey = "";
let drawing = null;
let toastTimer;
let dragDepth = 0;
let actionPending = false;

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}
function current() {
  return state.tasks.find((task) => task.id === selectedId);
}
function time(value) {
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function toast(message, isError = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", isError);
  $("toast").hidden = false;
  toastTimer = setTimeout(
    () => {
      $("toast").hidden = true;
    },
    isError ? 7000 : 3500,
  );
}
async function perform(action) {
  try {
    return await action();
  } catch (error) {
    toast(error.message, true);
    return null;
  }
}
function selectTask(id) {
  drawing = null;
  selectedId = id;
  currentView = "source";
  render();
}
function receive(value) {
  state = value;
  if (!state.tasks.some((task) => task.id === selectedId))
    selectedId = state.tasks[0]?.id || null;
  render();
}
function renderTasks() {
  $("taskCount").textContent = state.tasks.length;
  $("taskList").innerHTML = state.tasks.length
    ? state.tasks
        .map(
          (task) => `
    <div class="task-item ${task.id === selectedId ? "selected" : ""}" data-task="${task.id}" role="button" tabindex="0" aria-label="${escapeHTML(task.name)}，${statuses[task.state] || task.state}" aria-pressed="${task.id === selectedId}">
      <div class="task-thumb">${icon(task.state === "completed" ? "check" : "video")}</div>
      <div class="task-info"><span class="task-name" title="${escapeHTML(task.name)}">${escapeHTML(task.name)}</span><div class="task-subline"><span class="task-pill ${task.state}">${statuses[task.state] || "等待中"}</span><span>${task.duration ? time(task.duration) : task.sourceType === "local" ? `${(task.size / 1024 ** 2).toFixed(1)} MB` : "网络视频"}</span></div></div>
      ${removable.has(task.state) ? `<button class="remove-task" data-remove="${task.id}" title="移除任务记录" aria-label="移除任务记录">${icon("close")}</button>` : ""}
    </div>`,
        )
        .join("")
    : '<div class="list-empty">这里会显示你的视频任务<br>也可以直接拖入视频文件</div>';
  const done = state.tasks.filter((task) => task.state === "completed").length;
  const waiting = state.tasks.filter((task) => editable.has(task.state)).length;
  $("queueSummary").textContent = state.tasks.length
    ? `${done} 个已完成 · ${waiting} 个待开始`
    : "任务记录自动保存";
  $("batchStartBtn").disabled = !waiting || actionPending;
}
function renderPreview(task) {
  if (currentView === "output" && !task?.outputPreview) currentView = "source";
  $("sourceTab").classList.toggle("active", currentView === "source");
  $("outputTab").classList.toggle("active", currentView === "output");
  $("outputTab").disabled = !task?.outputPreview;
  $("previewTitle").textContent = task?.name || "视频预览";
  $("previewTitle").title = task?.name || "";
  $("emptyState").hidden = Boolean(task);
  $("videoFrame").hidden = !task;
  $("compareBtn").hidden = !task;
  $("compareBtn").textContent = task?.outputPreview
    ? "双击预览 · 滑动对比 ↗"
    : "双击放大预览 ↗";
  const key = task ? `${task.id}/${currentView}` : "";
  if (key !== previewKey) {
    previewKey = key;
    const video = $("video");
    video.pause();
    $("previewError").hidden = true;
    $("playBtn").disabled = true;
    $("fullscreenBtn").disabled = true;
    $("seekBar").disabled = true;
    $("seekBar").value = 0;
    $("currentTime").textContent = "00:00";
    $("totalTime").textContent = time(task?.duration);
    video.removeAttribute("src");
    if (task)
      video.src =
        currentView === "output" ? task.outputPreview : task.sourcePreview;
    video.load();
  }
  let metadata = "添加视频后可预览并选择擦除范围";
  if (task) {
    const parts = [];
    if (task.width && task.height) parts.push(`${task.width} × ${task.height}`);
    if (task.duration) parts.push(time(task.duration));
    if (task.size) parts.push(`${(task.size / 1024 ** 2).toFixed(1)} MB`);
    parts.push(currentView === "output" ? "擦除结果 · MP4" : "原视频");
    metadata = parts.join(" · ");
  }
  $("videoMeta").textContent = metadata;
  const canDraw =
    task &&
    editable.has(task.state) &&
    task.options.selection === "region" &&
    currentView === "source" &&
    $("video").videoWidth &&
    $("previewError").hidden;
  $("selectionOverlay").classList.toggle("drawing-enabled", Boolean(canDraw));
  $("drawHint").hidden = !canDraw;
  renderOverlay();
}
function renderSettings(task) {
  const config = task?.options || {
    selection: "auto",
    modelVersion: "v5",
    encodeMode: "Quality",
    rect: null,
  };
  const locked = !task || !editable.has(task.state);
  $("autoModeBtn").classList.toggle("active", config.selection === "auto");
  $("regionModeBtn").classList.toggle("active", config.selection === "region");
  $("autoModeBtn").disabled = locked;
  $("regionModeBtn").disabled = locked;
  $("modelVersion").value = config.modelVersion;
  $("encodeMode").value = config.encodeMode;
  $("modelVersion").disabled = locked;
  $("encodeMode").disabled = locked;
  $("clearRectBtn").hidden =
    locked || config.selection !== "region" || !config.rect;
  $("modeHelp").textContent =
    config.selection === "region"
      ? config.rect
        ? "选区已保存。可再次拖动，重新框选文字区域。"
        : "切换到原视频，在画面上拖动框选需要擦除的文字。"
      : "适合画面下半部分、居中的白色字幕。";
  if (locked && config.selection === "region") {
    $("modeHelp").textContent =
      "本任务使用手动框选，擦除选区已保存在任务记录中。";
  }
  $("outputFolder").textContent = state.settings.outputDir || "选择文件夹";
  $("folderBtn").title = state.settings.outputDir;
  $("estimatedCost").textContent = task?.duration
    ? `约 ¥${(task.duration / 60).toFixed(2)}`
    : "按视频时长";
  const start = $("startBtn");
  start.classList.toggle("completed-action", task?.state === "completed");
  let label = "开始擦除";
  let name = "spark";
  let disabled = !task || actionPending;
  if (task) {
    if (task.state === "completed") {
      label = "打开成片文件夹";
      name = "folder";
    } else if (task.state === "download_error") {
      label = "重试下载成片";
      name = "refresh";
    } else if (task.state === "query_error") {
      label = "立即恢复查询";
      name = "refresh";
    } else if (task.state === "submission_unknown") {
      label = "恢复原请求";
      name = "refresh";
      disabled ||= !task.canRestoreSubmission;
    } else if (task.canUnqueue) {
      label = "取消排队";
      name = "close";
    } else if (!editable.has(task.state)) {
      label = statuses[task.state] || "处理中";
      disabled = true;
    }
  }
  start.innerHTML = `${icon(name)}<span>${label}</span>${icon("arrow")}`;
  start.disabled = disabled;
}
function renderStatus(task) {
  let title = "准备就绪";
  let detail = state.hasKey
    ? "添加视频后开始字幕擦除，成片将自动保存到本机"
    : "配置 API Key 后，即可开始字幕擦除";
  if (task) {
    title = statuses[task.state] || "等待处理";
    const details = {
      draft: "选择自动识别或手动框选，确认参数后开始处理。",
      queued: "等待前面的任务完成，将依次处理。",
      uploading: "正在将原视频上传至火山引擎，请保持网络连接。",
      submitting: "正在向火山引擎提交字幕擦除任务。",
      processing: "火山引擎正在处理。软件会定时查询，完成后自动下载。",
      query_error: "查询暂时中断，将继续查询已有任务。",
      submission_unknown: "提交结果暂未确认，请恢复原请求或在火山控制台核对。",
      download_pending: "云端处理已完成，正在准备保存成片。",
      downloading: "正在将处理后的 MP4 保存到本机。",
      download_error:
        "云端处理已完成，可重试下载。默认结果链接有效期为 24 小时。",
      completed: "成片已保存到本机，可切换上方的“擦除结果”预览。",
      cloud_failed: "云端处理失败，请查看错误详情并核对火山控制台记录。",
      error: "检查文件、网络和设置后，可再次开始。",
    };
    detail = task.error || details[task.state];
    if (task.state === "query_error") detail += " 软件将自动继续查询原任务。";
    if (task.state === "completed") detail = task.outputPath;
  }
  if (state.credentialError) detail = state.credentialError;
  if (state.fatalError) {
    title = "任务记录保存异常";
    detail = state.fatalError;
  }
  $("statusTitle").textContent = title;
  $("statusDetail").textContent = detail;
  $("statusDetail").title = detail;
  $("taskStatus").classList.toggle(
    "failed",
    Boolean(task?.error || state.fatalError || state.credentialError),
  );
  const moving =
    task &&
    [
      "uploading",
      "downloading",
      "processing",
      "submitting",
      "download_pending",
      "query_error",
    ].includes(task.state);
  const realProgress =
    task &&
    ["uploading", "downloading"].includes(task.state) &&
    Number.isFinite(task.progress);
  $("progressTrack").hidden = !moving;
  $("progressTrack").classList.toggle("indeterminate", moving && !realProgress);
  $("progressFill").style.width = `${realProgress ? task.progress : 0}%`;
  $("statusPercent").textContent = realProgress ? `${task.progress}%` : "";
}
function render() {
  document.documentElement.dataset.theme = state.settings.theme;
  $("footerNote").textContent =
    `v${state.version || "1.0.0"} · 任务自动保存 · 成片自动下载`;
  $("themeBtn").innerHTML = icon(
    state.settings.theme === "dark" ? "sun" : "moon",
  );
  $("keyStatus").classList.toggle("ready", state.hasKey);
  $("keyStatus").innerHTML =
    `<span></span>${state.hasKey ? "API 已配置" : "尚未配置 API"}`;
  renderTasks();
  const task = current();
  renderSettings(task);
  renderPreview(task);
  renderStatus(task);
}

async function pickFiles() {
  const ids = await perform(() => api.pickFiles());
  if (ids?.length) selectTask(ids[0]);
}
function openSettings() {
  $("apiKeyInput").value = "";
  $("apiKeyInput").placeholder = state.hasKey
    ? "已保存密钥，填写新值可更换"
    : "粘贴 AI MediaKit API Key";
  $("savedKeyHint").textContent =
    state.credentialError ||
    (state.hasKey
      ? "密钥已加密保存。留空将继续使用已保存密钥。"
      : "密钥通过 Windows 加密保存在本机。");
  $("clearKeyBtn").hidden = !state.hasKey && !state.credentialError;
  $("settingsDialog").showModal();
}
async function changeOptions(patch) {
  const task = current();
  if (!task || !editable.has(task.state)) return;
  await perform(() =>
    api.updateOptions(task.id, { ...task.options, ...patch }),
  );
}
async function confirmStart(ids) {
  if (actionPending) return;
  if (!state.hasKey) {
    openSettings();
    return;
  }
  const jobs = ids
    .map((id) => state.tasks.find((task) => task.id === id))
    .filter(Boolean);
  if (!jobs.length) return;
  if (
    jobs.some(
      (task) => task.options.selection === "region" && !task.options.rect,
    )
  ) {
    toast("请先为手动框选的任务选定擦除区域。", true);
    return;
  }
  const knownDuration = jobs.every((task) => task.duration > 0);
  const total = jobs.reduce((sum, task) => sum + task.duration, 0);
  $("confirmText").textContent =
    `即将处理 ${jobs.length} 个视频。\n${knownDuration ? `视频总时长 ${time(total)}，预计费用约 ¥${(total / 60).toFixed(2)}。` : "部分视频时长尚未读取，费用按实际处理时长计算，单价 1 元 / 分钟。"}`;
  const confirmed = await new Promise((resolve) => {
    const dialog = $("confirmDialog");
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "start"),
      { once: true },
    );
    dialog.returnValue = "";
    dialog.showModal();
  });
  if (!confirmed) return;
  actionPending = true;
  renderSettings(current());
  await perform(() => api.start(ids));
  actionPending = false;
  render();
}
async function primaryAction() {
  const task = current();
  if (!task) return;
  if (task.state === "completed") return perform(() => api.reveal(task.id));
  if (task.state === "queued") return perform(() => api.unqueue(task.id));
  if (
    ["download_error", "query_error", "submission_unknown"].includes(task.state)
  )
    return perform(() => api.retry(task.id));
  return confirmStart([task.id]);
}

function geometry() {
  const video = $("video");
  const bounds = $("videoFrame").getBoundingClientRect();
  if (
    !video.videoWidth ||
    !video.videoHeight ||
    !bounds.width ||
    !bounds.height
  )
    return null;
  const scale = Math.min(
    bounds.width / video.videoWidth,
    bounds.height / video.videoHeight,
  );
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return {
    width,
    height,
    left: (bounds.width - width) / 2,
    top: (bounds.height - height) / 2,
    bounds,
  };
}
function pointerPosition(event, clamp = false) {
  const box = geometry();
  if (!box) return null;
  let x = (event.clientX - box.bounds.left - box.left) / box.width;
  let y = (event.clientY - box.bounds.top - box.top) / box.height;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  return { x, y };
}
function drawnRectangle() {
  if (!drawing) return null;
  return {
    top_left_x: Math.min(drawing.start.x, drawing.end.x),
    top_left_y: Math.min(drawing.start.y, drawing.end.y),
    bottom_right_x: Math.max(drawing.start.x, drawing.end.x),
    bottom_right_y: Math.max(drawing.start.y, drawing.end.y),
  };
}
function renderOverlay() {
  const overlay = $("selectionOverlay");
  overlay.replaceChildren();
  const task = current();
  const box = geometry();
  const rect = drawing ? drawnRectangle() : task?.options.rect;
  if (
    !box ||
    !rect ||
    task?.options.selection !== "region" ||
    currentView !== "source"
  )
    return;
  const x = box.left + rect.top_left_x * box.width;
  const y = box.top + rect.top_left_y * box.height;
  const width = (rect.bottom_right_x - rect.top_left_x) * box.width;
  const height = (rect.bottom_right_y - rect.top_left_y) * box.height;
  overlay.setAttribute(
    "viewBox",
    `0 0 ${box.bounds.width} ${box.bounds.height}`,
  );
  const selection = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "rect",
  );
  for (const [key, value] of Object.entries({
    x,
    y,
    width,
    height,
    rx: 3,
    fill: "#9a81ff22",
    stroke: "#a58bff",
    "stroke-width": 2,
  }))
    selection.setAttribute(key, value);
  overlay.append(selection);
  for (const [cx, cy] of [
    [x, y],
    [x + width, y],
    [x, y + height],
    [x + width, y + height],
  ]) {
    const corner = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    for (const [key, value] of Object.entries({
      x: cx - 3,
      y: cy - 3,
      width: 6,
      height: 6,
      rx: 1,
      fill: "#d3c5ff",
      stroke: "#7c61ce",
    }))
      corner.setAttribute(key, value);
    overlay.append(corner);
  }
}

$("addFilesBtn").addEventListener("click", pickFiles);
$("emptyImportBtn").addEventListener("click", pickFiles);
$("addLinkBtn").addEventListener("click", () => {
  $("videoURLInput").value = "";
  $("linkDialog").showModal();
});
$("settingsBtn").addEventListener("click", openSettings);
$("keyStatus").addEventListener("click", openSettings);
$("docsBtn").addEventListener("click", () =>
  perform(() => api.openDocs("api")),
);
$("getKeyBtn").addEventListener("click", () =>
  perform(() => api.openDocs("key")),
);
$("themeBtn").addEventListener("click", () =>
  perform(() =>
    api.saveSettings({
      theme: state.settings.theme === "dark" ? "light" : "dark",
    }),
  ),
);
$("folderBtn").addEventListener("click", () =>
  perform(() => api.chooseFolder()),
);
$("clearKeyBtn").addEventListener("click", async () => {
  const result = await perform(async () => {
    await api.saveSettings({ theme: state.settings.theme, clearKey: true });
    return true;
  });
  if (result) {
    $("settingsDialog").close();
    toast("已清除保存的 API Key。");
  }
});
document
  .querySelectorAll(".close-dialog")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = { theme: state.settings.theme };
  const value = $("apiKeyInput").value.trim();
  if (value) input.newKey = value;
  const saved = await perform(async () => {
    await api.saveSettings(input);
    return true;
  });
  if (saved) {
    $("apiKeyInput").value = "";
    $("settingsDialog").close();
    toast("设置已保存。");
  }
});
$("settingsDialog").addEventListener("close", () => {
  $("apiKeyInput").value = "";
});
$("linkForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = await perform(() => api.addURL($("videoURLInput").value));
  if (id) {
    $("linkDialog").close();
    selectTask(id);
  }
});
$("taskList").addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    await perform(() => api.remove(remove.dataset.remove));
    return;
  }
  const item = event.target.closest("[data-task]");
  if (item) selectTask(item.dataset.task);
});
$("taskList").addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key) || event.target.closest("button"))
    return;
  const item = event.target.closest("[data-task]");
  if (item) {
    event.preventDefault();
    selectTask(item.dataset.task);
  }
});
$("autoModeBtn").addEventListener("click", () =>
  changeOptions({ selection: "auto" }),
);
$("regionModeBtn").addEventListener("click", async () => {
  currentView = "source";
  await changeOptions({ selection: "region" });
});
$("clearRectBtn").addEventListener("click", () =>
  changeOptions({ rect: null }),
);
$("modelVersion").addEventListener("change", (event) =>
  changeOptions({ modelVersion: event.target.value }),
);
$("encodeMode").addEventListener("change", (event) =>
  changeOptions({ encodeMode: event.target.value }),
);
$("startBtn").addEventListener("click", primaryAction);
$("batchStartBtn").addEventListener("click", () =>
  confirmStart(
    state.tasks
      .filter((task) => editable.has(task.state))
      .map((task) => task.id),
  ),
);
$("sourceTab").addEventListener("click", () => {
  currentView = "source";
  renderPreview(current());
});
$("outputTab").addEventListener("click", () => {
  currentView = "output";
  renderPreview(current());
});
$("playBtn").addEventListener("click", () => {
  const video = $("video");
  if (video.paused) perform(() => video.play());
  else video.pause();
});
$("fullscreenBtn").addEventListener("click", () => openComparison());
function openComparison() {
  const task = current();
  if (!task) return;
  $("video").pause();
  window.videoComparison.open(task, $("video").currentTime);
}
$("previewStage").addEventListener("dblclick", openComparison);
$("compareBtn").addEventListener("click", openComparison);
$("seekBar").addEventListener("input", (event) => {
  const video = $("video");
  if (Number.isFinite(video.duration))
    video.currentTime = (Number(event.target.value) / 1000) * video.duration;
});
$("video").addEventListener("loadedmetadata", () => {
  const video = $("video");
  const task = current();
  $("playBtn").disabled = false;
  $("fullscreenBtn").disabled = false;
  $("seekBar").disabled = !Number.isFinite(video.duration);
  $("previewError").hidden = true;
  $("totalTime").textContent = time(video.duration);
  if (task && currentView === "source")
    perform(() =>
      api.metadata(task.id, {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      }),
    );
  renderPreview(task);
});
$("video").addEventListener("error", () => {
  if (!current() || !$("video").getAttribute("src")) return;
  $("previewError").hidden = false;
  $("drawHint").hidden = true;
  $("selectionOverlay").classList.remove("drawing-enabled");
  $("playBtn").disabled = true;
  $("seekBar").disabled = true;
});
for (const event of ["play", "pause", "ended"])
  $("video").addEventListener(event, () => {
    $("playBtn").innerHTML = icon($("video").paused ? "play" : "pause");
  });
$("video").addEventListener("timeupdate", () => {
  const video = $("video");
  $("currentTime").textContent = time(video.currentTime);
  $("seekBar").value = Number.isFinite(video.duration)
    ? (1000 * video.currentTime) / video.duration
    : 0;
});
$("selectionOverlay").addEventListener("pointerdown", (event) => {
  if (
    event.button !== 0 ||
    !$("selectionOverlay").classList.contains("drawing-enabled")
  )
    return;
  const point = pointerPosition(event);
  if (!point) return;
  $("video").pause();
  drawing = { taskId: selectedId, start: point, end: point };
  $("selectionOverlay").setPointerCapture(event.pointerId);
  renderOverlay();
});
$("selectionOverlay").addEventListener("pointermove", (event) => {
  if (!drawing) return;
  const point = pointerPosition(event, true);
  if (point) {
    drawing.end = point;
    renderOverlay();
  }
});
$("selectionOverlay").addEventListener("pointerup", async (event) => {
  if (!drawing) return;
  const taskId = drawing.taskId;
  const point = pointerPosition(event, true);
  if (point) drawing.end = point;
  const rect = drawnRectangle();
  drawing = null;
  if ($("selectionOverlay").hasPointerCapture(event.pointerId))
    $("selectionOverlay").releasePointerCapture(event.pointerId);
  if (
    taskId === selectedId &&
    rect.bottom_right_x - rect.top_left_x >= 0.01 &&
    rect.bottom_right_y - rect.top_left_y >= 0.01
  ) {
    await changeOptions({ rect });
  } else {
    renderOverlay();
    toast("选区太小，请拖动框选完整文字区域。");
  }
});
$("selectionOverlay").addEventListener("pointercancel", () => {
  drawing = null;
  renderOverlay();
});
new ResizeObserver(renderOverlay).observe($("videoFrame"));

document.addEventListener("dragenter", (event) => {
  if (!Array.from(event.dataTransfer.types).includes("Files")) return;
  event.preventDefault();
  dragDepth++;
  $("dropOverlay").hidden = false;
});
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("dropOverlay").hidden = true;
});
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("dropOverlay").hidden = true;
  if (!event.dataTransfer.files.length) return;
  const ids = await perform(() => api.dropFiles(event.dataTransfer.files));
  if (ids?.length) selectTask(ids[0]);
});
document.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "o" &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    pickFiles();
  }
});
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  toast(event.reason?.message || "操作未完成，请重试。", true);
});
api.onState(receive);
perform(async () => {
  receive(await api.getState());
});
