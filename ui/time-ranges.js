"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $("timeRangesDialog");
  const video = $("rangeVideo");
  let task;
  let saving = false;

  function addRow(segment) {
    const row = document.createElement("div");
    row.className = "time-range-row";
    for (const [key, label] of [
      ["start", "开始（秒）"],
      ["end", "结束（秒）"],
    ]) {
      const field = document.createElement("label");
      field.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.required = true;
      input.dataset.time = key;
      input.value = segment[key];
      field.append(input);
      const fill = document.createElement("button");
      fill.type = "button";
      fill.className = "text-button";
      fill.textContent = "设为播放位置";
      fill.addEventListener("click", () => {
        input.value = Math.floor(video.currentTime * 100) / 100;
        $("timeRangeError").textContent = "";
      });
      field.append(fill);
      row.append(field);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => row.remove());
    row.append(remove);
    $("timeRangeRows").append(row);
    updateMode();
  }

  function updateMode() {
    const all = $("timeRangeMode").value === "all";
    $("timeRangeEditor").hidden = all;
    for (const input of $("timeRangeRows").querySelectorAll("input"))
      input.disabled = all || saving;
  }

  $("timeRangeMode").addEventListener("change", updateMode);
  $("timeRangesForm").addEventListener("input", () => {
    $("timeRangeError").textContent = "";
  });
  $("addTimeRangeBtn").addEventListener("click", () => {
    const duration = video.duration || task.duration;
    const start = Number(video.currentTime.toFixed(2));
    const end = duration > start ? Math.min(duration, start + 5) : start + 5;
    addRow({ start, end: Math.floor(end * 100) / 100 });
  });
  for (const id of ["closeTimeRangesBtn", "cancelTimeRangesBtn"])
    $(id).addEventListener("click", () => {
      if (!saving) dialog.close();
    });
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
    task = null;
  });
  $("timeRangesForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!task || saving) return;
    const mode = $("timeRangeMode").value;
    const segments = Array.from($("timeRangeRows").children).map((row) => ({
      start: Number(row.querySelector('[data-time="start"]').value),
      end: Number(row.querySelector('[data-time="end"]').value),
    }));
    const duration = task.duration || video.duration;
    if (
      mode !== "all" &&
      (!segments.length ||
        segments.some(
          (segment) =>
            !Number.isFinite(segment.start) ||
            !Number.isFinite(segment.end) ||
            segment.start < 0 ||
            segment.end <= segment.start ||
            (Number.isFinite(duration) &&
              duration > 0 &&
              segment.end > duration + 0.001),
        ))
    ) {
      $("timeRangeError").textContent =
        "请添加有效时间段，结束时间需大于开始时间并位于视频时长内。";
      return;
    }
    saving = true;
    for (const button of dialog.querySelectorAll("button"))
      button.disabled = true;
    $("timeRangeMode").disabled = true;
    updateMode();
    try {
      await window.eraser.updateOptions(task.id, {
        ...task.options,
        timeFilter: { mode, segments: mode === "all" ? [] : segments },
      });
      dialog.close();
    } catch (error) {
      $("timeRangeError").textContent = error.message;
    } finally {
      saving = false;
      for (const button of dialog.querySelectorAll("button"))
        button.disabled = false;
      $("timeRangeMode").disabled = false;
      updateMode();
    }
  });

  window.timeRanges = Object.freeze({
    open(value) {
      task = value;
      $("timeRangeMode").value = task.options.timeFilter.mode;
      $("timeRangeRows").replaceChildren();
      $("timeRangeError").textContent = "";
      for (const segment of task.options.timeFilter.segments) addRow(segment);
      video.src = task.sourcePreview;
      video.load();
      updateMode();
      dialog.showModal();
    },
  });
})();
