"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.eraser;
  let mode = "home";
  let snapshot = { tasks: [], settings: {} };
  let selectedId = null;
  let previewKey = "";
  let draft = {};
  let version = "standard";
  let pending = false;
  let errorMessage = "";
  const statuses = {
    draft: "待开始",
    queued: "排队中",
    uploading: "上传中",
    submitting: "提交中",
    processing: "处理中",
    query_error: "等待恢复查询",
    submission_unknown: "提交待核对",
    downloading: "下载中",
    download_pending: "等待下载",
    download_error: "下载待重试",
    completed: "已完成",
    cloud_failed: "处理失败",
    error: "待调整",
  };
  const definitions = [
    {
      key: "scene",
      label: "增强场景",
      group: "画面",
      versions: ["standard", "professional"],
      choices: [
        ["common", "通用"],
        ["ugc", "短视频"],
        ["short_series", "短剧"],
        ["aigc", "AI 生成"],
        ["old_film", "老片修复"],
      ],
    },
    {
      key: "enhance_style",
      label: "增强风格",
      group: "画面",
      versions: ["standard", "professional"],
      choices: [
        ["natural", "自然"],
        ["soft", "柔和"],
        ["balanced", "均衡"],
        ["clear", "清晰"],
        ["hd", "高清"],
      ],
    },
    {
      key: "color_style",
      label: "色彩风格",
      group: "画面",
      versions: ["professional"],
      choices: [
        ["original", "原色"],
        ["natural", "自然"],
        ["vivid", "鲜艳"],
      ],
    },
    {
      key: "skin_smoothing",
      label: "人像磨皮 0–100",
      group: "画面",
      versions: ["professional"],
      min: 0,
      max: 100,
    },
    {
      key: "face_sharpness",
      label: "人脸清晰度 0–100",
      group: "画面",
      versions: ["professional"],
      min: 0,
      max: 100,
    },
    {
      key: "glare_suppression",
      label: "眩光抑制",
      group: "画面",
      versions: ["professional"],
      choices: [
        ["close", "关闭"],
        ["generic", "通用"],
        ["face_safe", "保护人像"],
      ],
    },
    {
      key: "resolution",
      label: "目标分辨率",
      group: "输出",
      choices: [
        ["240p", "240P"],
        ["360p", "360P"],
        ["480p", "480P"],
        ["540p", "540P"],
        ["720p", "720P"],
        ["1080p", "1080P"],
        ["2k", "2K"],
        ["4k", "4K"],
        ["6k", "6K"],
        ["8k", "8K"],
      ],
    },
    {
      key: "resolution_limit",
      label: "短边像素",
      group: "输出",
      versions: ["standard", "professional", "fast"],
      min: 128,
      max: 4320,
    },
    {
      key: "bitrate_level",
      label: "码率档位",
      group: "输出",
      choices: [
        ["low", "低"],
        ["medium", "中"],
        ["high", "高"],
      ],
    },
    {
      key: "bitrate",
      label: "精确码率 kbps",
      group: "输出",
      min: 10,
      max: 150000,
    },
    {
      key: "fps",
      label: "目标帧率 fps",
      group: "输出",
      min: 15,
      max: 120,
      step: "0.01",
    },
    {
      key: "bit_depth",
      label: "色深",
      group: "专业输出",
      versions: ["professional"],
      numeric: true,
      choices: [
        [8, "8 bit"],
        [10, "10 bit"],
        [12, "12 bit"],
        [16, "16 bit"],
      ],
    },
    {
      key: "codec",
      label: "编码",
      group: "专业输出",
      versions: ["professional"],
      choices: [
        ["h264", "H.264"],
        ["h265", "H.265"],
        ["prores", "ProRes"],
        ["ffv1", "FFV1"],
        ["exr", "EXR"],
      ],
    },
    {
      key: "pix_fmt",
      label: "像素格式",
      group: "专业输出",
      versions: ["professional"],
      choices: [["gbrp16le", "GBR 16 bit"]],
    },
    {
      key: "dynamic_range",
      label: "动态范围",
      group: "专业输出",
      versions: ["professional"],
      choices: [
        ["sdr", "SDR"],
        ["hdr", "HDR"],
      ],
    },
    {
      key: "media_output_destination",
      label: "云端保存地址",
      group: "任务高级设置",
      text: true,
      placeholder: "vod:// 或 tos://",
    },
    {
      key: "queue_id",
      label: "任务队列 ID",
      group: "任务高级设置",
      text: true,
    },
    {
      key: "callback_url",
      label: "回调地址",
      group: "任务高级设置",
      text: true,
      placeholder: "https://",
    },
    {
      key: "callback_args",
      label: "回调参数",
      group: "任务高级设置",
      text: true,
    },
  ];
  function task() {
    return snapshot.tasks.find(
      (item) => item.id === selectedId && item.kind === "enhance",
    );
  }
  function escape(value) {
    return String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  function showError(error) {
    errorMessage = error?.message || String(error);
    $("enhanceMessage").textContent = errorMessage;
  }
  async function action(fn) {
    try {
      return await fn();
    } catch (error) {
      showError(error);
      return null;
    }
  }
  function available(field) {
    return !field.versions || field.versions.includes(version);
  }
  function fieldChoices(field) {
    if (field.key === "resolution") {
      if (version === "generative")
        return field.choices.filter(([value]) =>
          ["720p", "1080p", "2k", "4k"].includes(value),
        );
      if (version === "fast")
        return field.choices.filter(([value]) => !["6k", "8k"].includes(value));
    }
    if (field.key === "enhance_style" && version === "standard")
      return field.choices.filter(([value]) =>
        ["balanced", "clear"].includes(value),
      );
    return field.choices;
  }
  function renderFields() {
    const element = $("enhanceFields");
    element.replaceChildren();
    for (const group of ["画面", "输出", "专业输出", "任务高级设置"]) {
      const fields = definitions.filter(
        (field) => field.group === group && available(field),
      );
      if (!fields.length) continue;
      const details = document.createElement("details");
      details.open = group === "输出";
      const summary = document.createElement("summary");
      summary.textContent = group;
      details.append(summary);
      for (const field of fields) {
        const label = document.createElement("label");
        label.className = "enhance-field";
        label.textContent = field.label;
        const input = document.createElement(
          field.choices ? "select" : "input",
        );
        input.name = field.key;
        if (field.choices) {
          input.add(new Option("使用默认设置", ""));
          for (const [value, title] of fieldChoices(field))
            input.add(new Option(title, String(value)));
        } else {
          input.type = field.text ? "text" : "number";
          if (field.min !== undefined) input.min = field.min;
          if (field.max !== undefined)
            input.max =
              field.key === "resolution_limit" && version === "fast"
                ? 2160
                : field.max;
          if (!field.text) input.step = field.step || "1";
          input.placeholder = field.placeholder || "使用默认设置";
        }
        input.value = draft[field.key] ?? "";
        input.disabled = !task() || !["draft", "error"].includes(task().state);
        input.addEventListener("change", () => {
          if (!input.value) delete draft[field.key];
          else
            draft[field.key] =
              field.text || (field.choices && !field.numeric)
                ? input.value
                : Number(input.value);
          const opposites = {
            resolution: "resolution_limit",
            resolution_limit: "resolution",
            bitrate: "bitrate_level",
            bitrate_level: "bitrate",
          };
          if (input.value && opposites[field.key]) {
            delete draft[opposites[field.key]];
            const other = element.querySelector(
              `[name="${opposites[field.key]}"]`,
            );
            if (other) other.value = "";
          }
          if (field.key === "scene" && input.value === "old_film") {
            for (const key of [
              "enhance_style",
              "color_style",
              "skin_smoothing",
              "face_sharpness",
              "glare_suppression",
            ])
              delete draft[key];
            renderFields();
          }
        });
        if (
          draft.scene === "old_film" &&
          [
            "enhance_style",
            "color_style",
            "skin_smoothing",
            "face_sharpness",
            "glare_suppression",
          ].includes(field.key)
        )
          input.disabled = true;
        label.append(input);
        details.append(label);
      }
      element.append(details);
    }
  }
  function render() {
    const jobs = snapshot.tasks.filter((item) => item.kind === "enhance");
    if (!jobs.some((item) => item.id === selectedId))
      selectedId = jobs[0]?.id || null;
    const current = task();
    $("enhanceList").innerHTML = jobs.length
      ? jobs
          .map(
            (item) =>
              `<div class="enhance-task ${item.id === selectedId ? "selected" : ""}"><button data-job="${escape(item.id)}">${escape(item.name)}<small>${escape(statuses[item.state] || item.state)}</small></button>${["draft", "error", "completed", "cloud_failed", "download_error"].includes(item.state) ? `<button data-remove-job="${escape(item.id)}" aria-label="移除任务">×</button>` : ""}</div>`,
          )
          .join("")
      : '<p class="help-text">添加视频后，任务显示在这里。</p>';
    $("enhanceTitle").textContent = current?.name || "视频预览";
    const hasPreview = Boolean(
      current?.sourcePreview || current?.outputPreview,
    );
    $("enhanceEmpty").hidden = hasPreview;
    $("enhanceEmpty").textContent = current
      ? "当前素材地址无法直接预览"
      : "添加视频，开始画质增强";
    $("enhanceVideo").hidden = !hasPreview;
    $("enhanceResult").disabled = !current?.outputPreview;
    $("enhanceSource").disabled = !current?.sourcePreview;
    $("enhanceCompare").disabled =
      !current?.sourcePreview || !current?.outputPreview;
    $("enhanceReveal").hidden = !current?.outputPath;
    $("enhanceCopyCloud").hidden = !current?.cloudOutput;
    $("enhanceFolderLabel").textContent = snapshot.settings.outputDir || "";
    $("enhanceVersion").disabled =
      !current || !["draft", "error"].includes(current.state);
    const label =
      current?.state === "completed"
        ? "已完成"
        : current?.state === "download_error"
          ? "重试下载"
          : current?.state === "query_error"
            ? "恢复查询"
            : current?.state === "submission_unknown"
              ? "恢复原请求"
              : current?.canUnqueue
                ? "取消排队"
                : ["draft", "error"].includes(current?.state)
                  ? "开始增强"
                  : statuses[current?.state] || "开始增强";
    $("enhanceStart").textContent = label;
    $("enhanceStart").disabled =
      pending ||
      !current ||
      !(
        [
          "draft",
          "error",
          "download_error",
          "query_error",
          "submission_unknown",
        ].includes(current.state) || current.canUnqueue
      ) ||
      (current.state === "submission_unknown" && !current.canRestoreSubmission);
    $("enhanceSave").disabled =
      !current || !["draft", "error"].includes(current.state);
    const progress = Number.isFinite(current?.progress)
      ? ` ${current.progress}%`
      : "";
    $("enhanceMessage").textContent =
      errorMessage ||
      current?.error ||
      current?.cloudOutput ||
      (current ? `${statuses[current.state] || ""}${progress}` : "");
    for (const input of $("enhanceFields").querySelectorAll("input, select"))
      input.disabled =
        !current ||
        !["draft", "error"].includes(current.state) ||
        (draft.scene === "old_film" &&
          [
            "enhance_style",
            "color_style",
            "skin_smoothing",
            "face_sharpness",
            "glare_suppression",
          ].includes(input.name));
    const end = current?.completedAt || current?.finishedAt || Date.now();
    let elapsed = current?.startedAt
      ? `${current.state === "completed" ? "总耗时" : "已耗时"} ${Math.max(0, Math.floor((end - current.startedAt) / 1000))} 秒`
      : "";
    if (
      current?.cloudCreatedAt > 0 &&
      current.cloudFinishedAt >= current.cloudCreatedAt
    )
      elapsed += ` · 云端任务耗时 ${Math.floor((current.cloudFinishedAt - current.cloudCreatedAt) / 1000)} 秒`;
    $("enhanceElapsed").textContent = elapsed;
    if (
      current &&
      previewKey !== `${current.id}/source` &&
      !previewKey.startsWith(`${current.id}/`)
    )
      setPreview(current.sourcePreview ? "source" : "output");
    if (!current && previewKey) {
      previewKey = "";
      $("enhanceVideo").removeAttribute("src");
      $("enhanceVideo").load();
    }
  }
  function select(id) {
    errorMessage = "";
    selectedId = id;
    const current = task();
    version = current?.options.version || "standard";
    draft = { ...(current?.options.settings || {}) };
    $("enhanceVersion").value = version;
    previewKey = "";
    renderFields();
    render();
  }
  function setPreview(which) {
    const current = task();
    if (!current) return;
    const src =
      which === "output" ? current.outputPreview : current.sourcePreview;
    if (!src) return;
    previewKey = `${current.id}/${which}`;
    $("enhanceEmpty").hidden = true;
    $("enhanceVideo").hidden = false;
    $("enhanceVideo").src = src;
    $("enhanceVideo").load();
  }
  async function open(next, id) {
    mode = next;
    $("toolHome").hidden = next !== "home";
    $("subtitleView").hidden = next !== "subtitle";
    $("enhanceView").hidden = next !== "enhance";
    if (next !== "subtitle") $("video").pause();
    if (next !== "enhance") $("enhanceVideo").pause();
    if (next === "enhance") {
      if (id) {
        snapshot = await api.getState();
        selectedId = id;
      }
      select(selectedId);
    }
  }
  window.toolbox = Object.freeze({
    open,
    get mode() {
      return mode;
    },
  });
  for (const button of document.querySelectorAll("[data-open-tool]"))
    button.addEventListener("click", () => open(button.dataset.openTool));
  for (const button of document.querySelectorAll(".toolbox-back"))
    button.addEventListener("click", () => open("home"));
  for (const id of ["homeSettings", "enhanceSettings"])
    $(id).addEventListener("click", () => $("settingsBtn").click());
  for (const id of ["homeTheme", "enhanceTheme"])
    $(id).addEventListener("click", () => $("themeBtn").click());
  $("enhanceVersion").addEventListener("change", (event) => {
    version = event.target.value;
    draft =
      version === task()?.options.version ? { ...task().options.settings } : {};
    renderFields();
  });
  $("enhanceList").addEventListener("click", async (event) => {
    const remove = event.target.closest("[data-remove-job]");
    if (remove) {
      await action(() => api.remove(remove.dataset.removeJob));
      return;
    }
    const item = event.target.closest("[data-job]");
    if (item) select(item.dataset.job);
  });
  async function importVideos(request) {
    if (pending) return;
    pending = true;
    $("enhanceAdd").disabled = true;
    errorMessage = "正在导入视频…";
    render();
    await new Promise(requestAnimationFrame);
    try {
      const ids = await request();
      errorMessage = "";
      if (ids?.length) {
        await refresh();
        select(ids[0]);
      }
    } catch (error) {
      showError(error);
    } finally {
      pending = false;
      $("enhanceAdd").disabled = false;
      render();
    }
  }
  $("enhanceAdd").addEventListener("click", () =>
    importVideos(() => api.pickFiles("enhance")),
  );
  $("enhanceAddURL").addEventListener("click", () => {
    $("enhanceURL").value = "";
    $("enhanceURLError").textContent = "";
    $("enhanceURLDialog").showModal();
  });
  for (const id of ["closeEnhanceURL", "cancelEnhanceURL"])
    $(id).addEventListener("click", () => $("enhanceURLDialog").close());
  $("enhanceURLForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const id = await api.addURL($("enhanceURL").value, "enhance");
      $("enhanceURLDialog").close();
      await refresh();
      select(id);
    } catch (error) {
      $("enhanceURLError").textContent = error.message;
    }
  });
  $("enhanceFolder").addEventListener("click", () =>
    action(() => api.chooseFolder()),
  );
  $("enhanceSource").addEventListener("click", () => setPreview("source"));
  $("enhanceResult").addEventListener("click", () => setPreview("output"));
  function compare() {
    const current = task();
    if (current?.sourcePreview && current.outputPreview) {
      $("enhanceVideo").pause();
      window.videoComparison.open(current, $("enhanceVideo").currentTime);
    }
  }
  $("enhanceCompare").addEventListener("click", compare);
  $("enhanceVideo").addEventListener("dblclick", compare);
  $("enhanceVideo").addEventListener("loadedmetadata", () => {
    const video = $("enhanceVideo");
    if (previewKey.endsWith("/source") && task())
      action(() =>
        api.metadata(selectedId, {
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
        }),
      );
  });
  $("enhanceVideo").addEventListener("error", () => {
    if (task())
      $("enhanceMessage").textContent =
        "当前视频格式无法预览，文件可在成片文件夹中查看。";
  });
  $("enhanceReveal").addEventListener("click", () =>
    action(() => api.reveal(selectedId)),
  );
  $("enhanceCopyCloud").addEventListener("click", () =>
    action(async () => {
      await api.copyCloudOutput(selectedId);
      $("enhanceMessage").textContent = "云端结果地址已复制";
    }),
  );
  async function save() {
    const current = task();
    if (!current) return false;
    await api.updateOptions(current.id, { version, settings: draft });
    return true;
  }
  $("enhanceForm").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      await save();
      $("enhanceMessage").textContent = "参数已保存";
    });
  });
  $("enhanceStart").addEventListener("click", async () => {
    const current = task();
    if (!current || pending) return;
    errorMessage = "";
    pending = true;
    try {
      if (["draft", "error"].includes(current.state)) {
        await save();
        await api.start([current.id]);
      } else if (current.canUnqueue) await api.unqueue(current.id);
      else await api.retry(current.id);
    } catch (error) {
      showError(error);
    } finally {
      pending = false;
      render();
    }
  });
  async function refresh() {
    snapshot = await api.getState();
    render();
  }
  api.onState((value) => {
    snapshot = value;
    if (!task()) {
      selectedId =
        snapshot.tasks.find((item) => item.kind === "enhance")?.id || null;
      select(selectedId);
    } else render();
  });
  refresh();
  setInterval(() => {
    if (mode === "enhance") render();
  }, 1000);
  document.addEventListener("dragover", (event) => {
    if (mode === "enhance") event.preventDefault();
  });
  document.addEventListener("drop", async (event) => {
    if (mode !== "enhance") return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    await importVideos(() => api.dropFiles(files, "enhance"));
  });
})();
