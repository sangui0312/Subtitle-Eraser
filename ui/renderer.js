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
let selectedRegion = null;
let toastTimer;
let dragDepth = 0;
let actionPending = false;
let importPending = false;

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
  selectedRegion = null;
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
    $("previewLoading").hidden = !task;
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
    mode: "Subtitle",
    modelVersion: "v5",
    encodeMode: "Quality",
    rects: [],
    timeFilter: { mode: "all", segments: [] },
    subtitleFilter: null,
  };
  const locked = !task || !editable.has(task.state);
  $("processingMode").value = config.mode;
  $("processingMode").disabled = locked;
  $("processingModeHelp").textContent =
    config.mode === "Subtitle"
      ? "识别画面下半部分的字幕。框选时处理与下半部分相交的区域。"
      : "检测全画面的字幕、人名、地名等叠加文字，可框选限定范围。";
  $("autoModeBtn").classList.toggle("active", config.selection === "auto");
  $("regionModeBtn").classList.toggle("active", config.selection === "region");
  $("autoModeBtn").disabled = locked;
  $("regionModeBtn").disabled = locked;
  $("modelVersion").value = config.modelVersion;
  $("encodeMode").value = config.encodeMode;
  $("modelVersion").disabled = locked;
  $("encodeMode").disabled = locked;
  $("clearRectBtn").hidden =
    locked || config.selection !== "region" || !config.rects.length;
  $("addRectBtn").hidden = config.selection !== "region";
  $("addRectBtn").disabled = locked || config.rects.length >= 20;
  $("addRectBtn").textContent = `新增区域（${config.rects.length}/20）`;
  $("regionList").hidden = config.selection !== "region";
  $("regionList").innerHTML = config.rects
    .map(
      (_rect, index) =>
        `<div class="region-item ${selectedRegion === index ? "active" : ""}"><button data-region="${index}" ${locked ? "disabled" : ""}>区域 ${index + 1}</button>${locked ? "" : `<button data-delete-region="${index}" aria-label="删除区域 ${index + 1}">×</button>`}</div>`,
    )
    .join("");
  $("modeHelp").textContent =
    config.selection === "region"
      ? selectedRegion === null
        ? "在原视频上拖动添加区域，点击区域编号可选中并重画。"
        : `已选中区域 ${selectedRegion + 1}，拖动可重画。点击“新增区域”继续添加。`
      : config.mode === "Subtitle"
        ? "默认检测画面下半部分的字幕。"
        : "默认检测整个视频画面中的文字。";
  if (locked && config.selection === "region") {
    $("modeHelp").textContent =
      "本任务使用手动框选，擦除选区已保存在任务记录中。";
  }
  $("timeRangesBtn").disabled = locked;
  const range = config.timeFilter;
  $("timeRangesSummary").textContent =
    range.mode === "all"
      ? "整段视频"
      : `${range.mode === "selected" ? "仅处理" : "跳过"} ${range.segments.length} 个片段 · ${range.segments.map((segment) => `${segment.start}–${segment.end}秒`).join("、")}`;
  const filter = config.subtitleFilter || {
    min_text_height_ratio: 0.01,
    max_text_height_ratio: config.modelVersion === "v4" ? 0.2 : 0.1,
    center_offset_ratio: 0.08,
  };
  $("customFilterEnabled").checked = Boolean(config.subtitleFilter);
  $("customFilterEnabled").disabled = locked || config.mode !== "Subtitle";
  $("subtitleFilterFields").hidden = !config.subtitleFilter;
  $("subtitleFilterFields").disabled = locked || config.mode !== "Subtitle";
  $("minTextHeight").value = Number(
    (filter.min_text_height_ratio * 100).toFixed(4),
  );
  $("maxTextHeight").value = Number(
    (filter.max_text_height_ratio * 100).toFixed(4),
  );
  $("centerOffset").value = Number(
    (filter.center_offset_ratio * 100).toFixed(4),
  );
  $("resetFilterBtn").disabled = locked || !config.subtitleFilter;
  $("outputFolder").textContent = state.settings.outputDir || "选择文件夹";
  $("folderBtn").title = state.settings.outputDir;
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
  renderElapsed(task);
  let title = "准备就绪";
  let detail = state.hasKey
    ? "添加视频后开始字幕擦除，成片将自动保存到本机"
    : "配置 API Key 后，即可开始字幕擦除";
  if (task) {
    title = statuses[task.state] || "等待处理";
    const details = {
      draft: "选择处理模式和擦除范围，确认参数后开始处理。",
      queued: "等待前面的任务完成，将依次处理。",
      uploading: "正在上传原视频，请保持网络连接。",
      submitting: "正在提交字幕擦除任务。",
      processing: "正在处理视频，完成后自动下载。",
      query_error: "查询暂时中断，将继续查询已有任务。",
      submission_unknown:
        "提交结果暂未确认，请恢复原请求或核对服务端任务记录。",
      download_pending: "云端处理已完成，正在准备保存成片。",
      downloading: "正在将处理后的 MP4 保存到本机。",
      download_error:
        "云端处理已完成，可重试下载。默认结果链接有效期为 24 小时。",
      completed: "成片已保存到本机，可切换上方的“擦除结果”预览。",
      cloud_failed: "处理失败，请查看错误详情并核对服务端任务记录。",
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
function renderElapsed(task = current()) {
  const cloud = $("cloudElapsedTime");
  cloud.hidden = !task?.taskId;
  cloud.textContent = "云端任务耗时未记录";
  if (task?.cloudCreatedAt > 0 && task.cloudFinishedAt >= task.cloudCreatedAt)
    cloud.textContent = `云端任务耗时 ${elapsedDuration(task.cloudFinishedAt - task.cloudCreatedAt)}`;
  const element = $("elapsedTime");
  element.hidden = !task || ["draft", "queued"].includes(task.state);
  if (element.hidden) return;
  if (!Number.isFinite(task.startedAt) || task.startedAt <= 0) {
    element.textContent = "耗时未记录";
    return;
  }
  const end = task.completedAt || task.finishedAt || Date.now();
  element.textContent = `${task.state === "completed" ? "总耗时" : "已耗时"} ${elapsedDuration(end - task.startedAt)}`;
}
function elapsedDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}小时` : ""}${minutes || hours ? `${minutes}分` : ""}${seconds % 60}秒`;
}
setInterval(() => renderElapsed(), 1000);
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

async function importFiles(action, allowCancel = false) {
  if (importPending) return;
  importPending = true;
  $("importLoading").hidden = false;
  for (const id of ["addFilesBtn", "emptyImportBtn", "addLinkBtn"])
    $(id).disabled = true;
  await new Promise(requestAnimationFrame);
  try {
    const ids = await action();
    if (!ids?.length) {
      if (!allowCancel)
        throw new Error("没有读取到视频文件，请重新拖入或点击添加视频。");
      return;
    }
    selectTask(ids[0]);
    toast(`已导入 ${ids.length} 个视频。`);
  } catch (error) {
    toast(error.message || "视频导入失败，请重新添加。", true);
  } finally {
    importPending = false;
    $("importLoading").hidden = true;
    for (const id of ["addFilesBtn", "emptyImportBtn", "addLinkBtn"])
      $(id).disabled = false;
  }
}
async function pickFiles() {
  await importFiles(() => api.pickFiles(), true);
}
function openSettings() {
  $("apiKeyInput").value = "";
  $("apiKeyInput").placeholder = state.hasKey
    ? "已保存密钥，填写新值可更换"
    : "粘贴处理服务 API Key";
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
  const result = await perform(() =>
    api.updateOptions(task.id, { ...task.options, ...patch }),
  );
  if (result === null) render();
}
async function startTasks(ids) {
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
      (task) =>
        task.options.selection === "region" && !task.options.rects.length,
    )
  ) {
    toast("请先为手动框选的任务选定擦除区域。", true);
    return;
  }
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
  return startTasks([task.id]);
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
  const rects = [...(task?.options.rects || [])];
  if (drawing) {
    if (drawing.regionIndex === null) rects.push(drawnRectangle());
    else rects[drawing.regionIndex] = drawnRectangle();
  }
  if (
    !box ||
    !rects.length ||
    task?.options.selection !== "region" ||
    currentView !== "source"
  )
    return;
  overlay.setAttribute(
    "viewBox",
    `0 0 ${box.bounds.width} ${box.bounds.height}`,
  );
  rects.forEach((rect, index) => {
    const x = box.left + rect.top_left_x * box.width;
    const y = box.top + rect.top_left_y * box.height;
    const width = (rect.bottom_right_x - rect.top_left_x) * box.width;
    const height = (rect.bottom_right_y - rect.top_left_y) * box.height;
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
      "stroke-width": selectedRegion === index ? 3 : 2,
    }))
      selection.setAttribute(key, value);
    overlay.append(selection);
    const label = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "text",
    );
    label.setAttribute("x", x + 6);
    label.setAttribute("y", y + 17);
    label.setAttribute("fill", "#fff");
    label.setAttribute("stroke", "#312552");
    label.setAttribute("stroke-width", "3");
    label.setAttribute("paint-order", "stroke");
    label.setAttribute("font-size", "13");
    label.textContent = String(index + 1);
    overlay.append(label);
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
  });
}

$("addFilesBtn").addEventListener("click", pickFiles);
$("emptyImportBtn").addEventListener("click", pickFiles);
$("addLinkBtn").addEventListener("click", () => {
  $("videoURLInput").value = "";
  $("linkDialog").showModal();
});
$("settingsBtn").addEventListener("click", openSettings);
$("keyStatus").addEventListener("click", openSettings);
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
$("processingMode").addEventListener("change", (event) =>
  changeOptions({ mode: event.target.value }),
);
$("clearRectBtn").addEventListener("click", () => {
  selectedRegion = null;
  changeOptions({ rects: [] });
});
$("addRectBtn").addEventListener("click", () => {
  selectedRegion = null;
  renderSettings(current());
  renderOverlay();
});
$("regionList").addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-delete-region]");
  if (remove) {
    const index = Number(remove.dataset.deleteRegion);
    selectedRegion = null;
    await changeOptions({
      rects: current().options.rects.filter(
        (_rect, position) => position !== index,
      ),
    });
    return;
  }
  const button = event.target.closest("[data-region]");
  if (button) {
    selectedRegion = Number(button.dataset.region);
    renderSettings(current());
    renderOverlay();
  }
});
$("timeRangesBtn").addEventListener("click", () => {
  const task = current();
  if (!task || !editable.has(task.state)) return;
  $("video").pause();
  window.timeRanges.open(task);
});
function saveSubtitleFilter() {
  const inputs = [$("minTextHeight"), $("maxTextHeight"), $("centerOffset")];
  if (inputs.some((input) => input.value === "" || !input.checkValidity())) {
    toast("识别参数需为 0% 至 100% 的有效数值。", true);
    renderSettings(current());
    return;
  }
  changeOptions({
    subtitleFilter: {
      min_text_height_ratio: Number(inputs[0].value) / 100,
      max_text_height_ratio: Number(inputs[1].value) / 100,
      center_offset_ratio: Number(inputs[2].value) / 100,
    },
  });
}
$("customFilterEnabled").addEventListener("change", (event) => {
  if (event.target.checked) saveSubtitleFilter();
  else changeOptions({ subtitleFilter: null });
});
for (const id of ["minTextHeight", "maxTextHeight", "centerOffset"])
  $(id).addEventListener("change", saveSubtitleFilter);
$("resetFilterBtn").addEventListener("click", () =>
  changeOptions({ subtitleFilter: null }),
);
$("modelVersion").addEventListener("change", (event) =>
  changeOptions({ modelVersion: event.target.value }),
);
$("encodeMode").addEventListener("change", (event) =>
  changeOptions({ encodeMode: event.target.value }),
);
$("startBtn").addEventListener("click", primaryAction);
$("batchStartBtn").addEventListener("click", () =>
  startTasks(
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
  $("previewLoading").hidden = true;
  $("drawHint").hidden = true;
  $("selectionOverlay").classList.remove("drawing-enabled");
  $("playBtn").disabled = true;
  $("seekBar").disabled = true;
});
$("video").addEventListener("loadeddata", () => {
  $("previewLoading").hidden = true;
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
  if (selectedRegion === null && current().options.rects.length >= 20) {
    toast("最多支持 20 个擦除区域，可选中已有区域重新框选。", true);
    return;
  }
  $("video").pause();
  drawing = {
    taskId: selectedId,
    regionIndex: selectedRegion,
    start: point,
    end: point,
  };
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
  const regionIndex = drawing.regionIndex;
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
    const rects = [...current().options.rects];
    if (regionIndex === null) rects.push(rect);
    else rects[regionIndex] = rect;
    await changeOptions({ rects });
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
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) {
    toast("没有读取到视频文件，请从本地文件夹拖入视频。", true);
    return;
  }
  await importFiles(() => api.dropFiles(files));
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
