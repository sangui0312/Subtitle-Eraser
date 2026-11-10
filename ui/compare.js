"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $("comparisonDialog");
  const original = $("compareOriginal");
  const result = $("compareResult");
  const divider = $("comparisonDivider");
  let paired = false;
  let playing = false;
  let starting = false;
  let seekTarget = 0;
  let dragging = false;
  let split = 50;
  let timer;
  let session = 0;

  function time(value) {
    const seconds = Math.max(0, Math.floor(value || 0));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function videos() {
    return paired ? [original, result] : [original];
  }
  function duration() {
    const durations = videos()
      .map((video) => video.duration)
      .filter((value) => Number.isFinite(value) && value > 0);
    return durations.length ? Math.min(...durations) : 0;
  }
  function controls() {
    const total = duration();
    $("comparePlayBtn").innerHTML =
      `<svg><use href="#i-${playing ? "pause" : "play"}"/></svg>`;
    $("compareTime").textContent = time(original.currentTime);
    $("compareDuration").textContent = time(total);
    $("compareSeek").value = total ? (1000 * original.currentTime) / total : 0;
  }
  function pause() {
    playing = false;
    videos().forEach((video) => video.pause());
    controls();
  }
  function stopForBuffer() {
    if (playing) videos().forEach((video) => video.pause());
  }
  async function playWhenReady() {
    if (
      !dialog.open ||
      !playing ||
      starting ||
      videos().some((video) => video.readyState < 3 || video.seeking)
    )
      return;
    starting = true;
    const startedSession = session;
    try {
      await Promise.all(videos().map((video) => video.play()));
    } catch (error) {
      if (
        startedSession === session &&
        dialog.open &&
        error.name !== "AbortError"
      ) {
        pause();
        $("comparisonError").textContent =
          "播放暂时失败，请重试或检查视频编码。";
        $("comparisonError").hidden = false;
      }
    } finally {
      if (startedSession === session) {
        starting = false;
        controls();
      }
    }
  }
  function seek(value) {
    const total = duration();
    seekTarget = Math.max(0, Math.min(value, total || value));
    videos().forEach((video) => {
      video.pause();
      if (video.readyState >= 1) video.currentTime = seekTarget;
    });
    controls();
  }
  function align() {
    const screen = $("comparisonScreen");
    const ratio =
      original.videoWidth && original.videoHeight
        ? original.videoWidth / original.videoHeight
        : 16 / 9;
    const width = Math.min(screen.clientWidth, screen.clientHeight * ratio);
    $("comparisonStage").style.width = `${width}px`;
    $("comparisonStage").style.height = `${width / ratio}px`;
  }
  function setSplit(value) {
    split = Math.max(0, Math.min(100, value));
    original.style.clipPath = paired ? `inset(0 ${100 - split}% 0 0)` : "none";
    divider.style.left = `${split}%`;
    divider.setAttribute("aria-valuenow", Math.round(split));
  }
  function sync() {
    if (!dialog.open) return;
    if (
      paired &&
      playing &&
      !original.seeking &&
      !result.seeking &&
      result.readyState >= 2
    ) {
      const drift = original.currentTime - result.currentTime;
      if (Math.abs(drift) > 0.15) result.currentTime = original.currentTime;
      else
        result.playbackRate =
          Math.abs(drift) > 0.035 ? (drift > 0 ? 1.04 : 0.96) : 1;
    }
    if (playing && original.currentTime >= duration() && duration() > 0)
      pause();
    controls();
  }
  function cleanup() {
    session++;
    pause();
    starting = false;
    clearInterval(timer);
    dragging = false;
    for (const video of [original, result]) {
      video.removeAttribute("src");
      video.load();
      video.playbackRate = 1;
    }
  }
  function open(task, currentTime = 0) {
    if (!task) return;
    if (dialog.open) dialog.close();
    paired = Boolean(task.outputPreview);
    playing = false;
    starting = false;
    seekTarget = currentTime;
    $("comparisonTitle").textContent = task.name;
    $("comparisonHint").textContent = paired
      ? "左右拖动中线，查看擦除前后"
      : "原视频大预览";
    $("comparisonError").hidden = true;
    $("resultLabel").hidden = !paired;
    divider.hidden = !paired;
    result.hidden = !paired;
    result.muted = true;
    original.muted = false;
    original.src = task.sourcePreview;
    if (paired) result.src = task.outputPreview;
    setSplit(50);
    dialog.showModal();
    align();
    controls();
    timer = setInterval(sync, 100);
  }
  function moveDivider(event) {
    const bounds = $("comparisonStage").getBoundingClientRect();
    if (bounds.width)
      setSplit((100 * (event.clientX - bounds.left)) / bounds.width);
  }
  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    divider.setPointerCapture(event.pointerId);
    moveDivider(event);
  });
  divider.addEventListener("pointermove", (event) => {
    if (dragging) moveDivider(event);
  });
  divider.addEventListener("pointerup", (event) => {
    dragging = false;
    if (divider.hasPointerCapture(event.pointerId))
      divider.releasePointerCapture(event.pointerId);
  });
  divider.addEventListener("pointercancel", () => {
    dragging = false;
  });
  divider.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") setSplit(0);
    else if (event.key === "End") setSplit(100);
    else setSplit(split + (event.key === "ArrowLeft" ? -5 : 5));
  });
  for (const video of [original, result]) {
    video.addEventListener("loadedmetadata", () => {
      if (!dialog.open) return;
      video.currentTime = Math.min(seekTarget, video.duration || seekTarget);
      align();
      controls();
    });
    video.addEventListener("canplay", playWhenReady);
    video.addEventListener("seeked", playWhenReady);
    video.addEventListener("waiting", stopForBuffer);
    video.addEventListener("ended", pause);
    video.addEventListener("error", () => {
      if (!dialog.open || !video.getAttribute("src")) return;
      pause();
      $("comparisonError").textContent =
        video === original
          ? "原视频无法预览，请检查文件是否存在及编码是否支持。"
          : "擦除结果无法预览，请检查成片文件是否存在。";
      $("comparisonError").hidden = false;
    });
  }
  $("comparePlayBtn").addEventListener("click", () => {
    if (playing) pause();
    else {
      if (duration() && original.currentTime >= duration() - 0.03) seek(0);
      playing = true;
      controls();
      playWhenReady();
    }
  });
  $("compareSeek").addEventListener("input", (event) =>
    seek((Number(event.target.value) / 1000) * duration()),
  );
  $("closeComparisonBtn").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", cleanup);
  dialog.addEventListener("cancel", pause);
  new ResizeObserver(align).observe($("comparisonScreen"));
  window.videoComparison = Object.freeze({ open });
})();
