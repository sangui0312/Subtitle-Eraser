"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function run({ win, engine, store, safeStorage, updates }) {
  const output = path.resolve(__dirname, "../validation");
  const fixture = path.join(output, "fixture.mp4");
  const updateVersion = require("./updater-fixture.cjs").release().version;
  const execute = async (script) => {
    try {
      return await win.webContents.executeJavaScript(script, true);
    } catch (error) {
      throw new Error(`Smoke renderer script failed: ${script}`, {
        cause: error,
      });
    }
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(script, description) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await execute(script)) return;
      await sleep(100);
    }
    throw new Error(`Timed out: ${description}`);
  }
  async function screenshot(name) {
    await sleep(400);
    try {
      fs.writeFileSync(
        path.join(output, name),
        (await win.webContents.capturePage()).toPNG(),
      );
    } catch (error) {
      throw new Error(`Screenshot ${name}: ${error.message}`);
    }
  }
  await until(
    'Boolean(window.eraser) && document.getElementById("keyStatus").textContent.length > 0',
    "preload and renderer",
  );
  win.show();
  await sleep(1200);
  await until(
    `document.getElementById("updateDialog").open && document.getElementById("updateStatus").textContent.includes(${JSON.stringify(updateVersion)})`,
    "automatic startup update popup without clicking check",
  );
  await screenshot("09-startup-update.png");
  await execute(
    'document.querySelector("#updateDialog .close-dialog").click();',
  );
  // A dismissed version must stay dismissed across repeated notifications.
  updates.set({ phase: "available" });
  await sleep(100);
  assert.equal(
    await execute('document.getElementById("updateDialog").open'),
    false,
  );
  const checkForUpdates = updates.native.checkForUpdates;
  updates.native.checkForUpdates = async () => ({
    updateInfo: { version: updates.state.currentVersion },
  });
  await updates.check();
  await sleep(100);
  assert.equal(updates.state.phase, "current");
  assert.equal(
    await execute('document.getElementById("updateDialog").open'),
    false,
  );
  updates.native.checkForUpdates = async () => {
    throw new Error("offline");
  };
  await updates.check();
  await sleep(100);
  assert.equal(updates.state.phase, "error");
  assert.equal(
    await execute('document.getElementById("updateDialog").open'),
    false,
  );
  updates.native.checkForUpdates = checkForUpdates;
  await execute(
    'window.smokeErrors = []; window.addEventListener("error", event => window.smokeErrors.push(event.message));',
  );
  assert.equal(
    await execute(
      '!/火山|费用|计费|AI MediaKit|¥/.test(document.body.innerText + Array.from(document.querySelectorAll("[placeholder]")).map(element => element.placeholder).join(" "))',
    ),
    true,
  );
  await execute(`window.importLoadingSeen = false; window.previewLoadingSeen = false; new MutationObserver(() => {
    if (!document.getElementById('importLoading').hidden) window.importLoadingSeen = true;
    if (!document.getElementById('previewLoading').hidden) window.previewLoadingSeen = true;
  }).observe(document.getElementById('previewStage'), { attributes: true, subtree: true, attributeFilter: ['hidden'] });`);
  // Never use the network or paid service in this smoke test.
  const submits = [];
  let queries = 0;
  engine.client = {
    upload: async (_file, progress) => {
      progress(50, 100);
      await sleep(2200);
      return "mediakit://smoke-video";
    },
    submit: async (body) => {
      submits.push(structuredClone(body));
      return { task_id: "smoke-cloud-task" };
    },
    query: async () => {
      queries++;
      if (queries === 1) return { status: "running" };
      return {
        status: "completed",
        created_at: 100,
        finished_at: 142,
        result: { video_url: "https://example.invalid/smoke-output.mp4" },
      };
    },
    download: async (_url, destination, progress) => {
      fs.copyFileSync(fixture, destination);
      progress(100, 100);
    },
  };
  engine.pollMs = 50;
  store.data.settings.outputDir = path.join(output, "output");
  engine.commit();
  await screenshot("01-empty-light.png");
  await execute('document.getElementById("settingsBtn").click();');
  await until(
    'document.getElementById("settingsDialog").open',
    "settings dialog",
  );
  await execute(
    `document.getElementById('apiKeyInput').value = 'smoke-placeholder-key'; document.getElementById('settingsForm').requestSubmit();`,
  );
  await until(
    '!document.getElementById("settingsDialog").open && document.getElementById("keyStatus").classList.contains("ready")',
    "encrypted settings save",
  );
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  const credentialFile = path.join(
    path.dirname(store.file),
    "credentials.json",
  );
  assert.equal(
    fs.readFileSync(credentialFile, "utf8").includes("smoke-placeholder-key"),
    false,
  );
  const credentials = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
  assert.equal(
    safeStorage.decryptString(Buffer.from(credentials.encrypted, "base64")),
    "smoke-placeholder-key",
  );
  const draggedFixture = path.join(output, "拖入测试 video.mp4");
  const invalidFixture = path.join(output, "invalid-input.txt");
  fs.copyFileSync(fixture, draggedFixture);
  fs.writeFileSync(invalidFixture, "unsupported file");
  win.webContents.debugger.attach("1.3");
  async function dropFiles(files) {
    const point = await execute(
      `(() => { const rect = document.getElementById('previewStage').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`,
    );
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"])
      await win.webContents.debugger.sendCommand("Input.dispatchDragEvent", {
        type,
        ...point,
        data,
      });
  }
  await dropFiles([invalidFixture]);
  await until(
    '!document.getElementById("toast").hidden && document.getElementById("toast").textContent.includes("请选择")',
    "invalid dropped file error",
  );
  assert.equal(engine.tasks.length, 0);
  await dropFiles([draggedFixture]);
  await until(
    'document.getElementById("taskCount").textContent === "1"',
    "native file drag through preload bridge",
  );
  const task = engine.tasks[0];
  assert.equal(task.source.path, draggedFixture);
  await until(
    'document.getElementById("video").videoWidth === 1280',
    "local video metadata",
  );
  await until(
    `document.getElementById('videoMeta').textContent.includes('1280 × 720')`,
    "persisted video metadata",
  );
  assert.equal(task.width, 1280);
  assert.equal(task.height, 720);
  await until(
    'document.getElementById("previewLoading").hidden && document.getElementById("importLoading").hidden',
    "import and preview loading completion",
  );
  assert.equal(
    await execute("window.importLoadingSeen && window.previewLoadingSeen"),
    true,
  );
  await execute(
    'document.getElementById("previewStage").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));',
  );
  await until(
    'document.getElementById("comparisonDialog").open && document.getElementById("compareOriginal").videoWidth === 1280 && document.getElementById("comparisonDivider").hidden',
    "single original large preview",
  );
  await execute('document.getElementById("closeComparisonBtn").click();');
  await until(
    '!document.getElementById("compareOriginal").getAttribute("src")',
    "single preview cleanup",
  );
  await execute('document.getElementById("regionModeBtn").click();');
  await until(
    'document.getElementById("selectionOverlay").classList.contains("drawing-enabled")',
    "manual rectangle mode",
  );
  assert.equal(task.options.mode, "Subtitle");
  await execute(
    `document.getElementById('processingMode').value = 'Text'; document.getElementById('processingMode').dispatchEvent(new Event('change'));`,
  );
  await until(
    'document.getElementById("processingModeHelp").textContent.includes("全画面")',
    "independent full-frame text mode",
  );
  const rect = await execute(`(() => {
    const frame = document.getElementById('videoFrame').getBoundingClientRect();
    const scale = Math.min(frame.width / 1280, frame.height / 720);
    const width = 1280 * scale, height = 720 * scale;
    const left = frame.left + (frame.width - width) / 2;
    const top = frame.top + (frame.height - height) / 2;
    return { x1: Math.round(left + width * .1), y1: Math.round(top + height * .78), x2: Math.round(left + width * .9), y2: Math.round(top + height * .93) };
  })()`);
  function drawRegion(bounds) {
    win.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      x: bounds.x1,
      y: bounds.y1,
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: "mouseMove",
      x: bounds.x2,
      y: bounds.y2,
      movementX: bounds.x2 - bounds.x1,
      movementY: bounds.y2 - bounds.y1,
    });
    win.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      x: bounds.x2,
      y: bounds.y2,
      clickCount: 1,
    });
  }
  drawRegion(rect);
  await until(
    'document.getElementById("clearRectBtn").hidden === false',
    "rectangle persistence",
  );
  assert.ok(Math.abs(task.options.rects[0].top_left_x - 0.1) < 0.01);
  assert.ok(Math.abs(task.options.rects[0].top_left_y - 0.78) < 0.01);
  const secondRect = {
    x1: rect.x1 + 40,
    x2: rect.x2 - 50,
    y1: rect.y1 - 90,
    y2: rect.y2 - 80,
  };
  drawRegion(secondRect);
  await until(
    'document.querySelectorAll("[data-region]").length === 2',
    "multiple regions",
  );
  await execute(`document.querySelector('[data-region="0"]').click();`);
  drawRegion({ ...rect, x1: rect.x1 + 20 });
  await until(
    'document.querySelector(".region-item.active") !== null',
    "selected region redraw",
  );
  await sleep(150);
  assert.equal(task.options.rects.length, 2);
  assert.ok(task.options.rects[0].top_left_x > 0.11);
  await execute(`document.querySelector('[data-delete-region="1"]').click();`);
  await until(
    'document.querySelectorAll("[data-region]").length === 1',
    "delete region",
  );
  await execute('document.getElementById("addRectBtn").click();');
  drawRegion(secondRect);
  await until(
    'document.querySelectorAll("[data-region]").length === 2',
    "add region after removal",
  );
  await execute(
    `document.getElementById('processingMode').value = 'Subtitle'; document.getElementById('processingMode').dispatchEvent(new Event('change'));`,
  );
  await until(
    '!document.getElementById("customFilterEnabled").disabled',
    "subtitle-only controls",
  );
  await execute(
    'document.getElementById("advancedOptions").open = true; document.getElementById("customFilterEnabled").click();',
  );
  await until(
    '!document.getElementById("subtitleFilterFields").hidden',
    "custom subtitle filter",
  );
  await execute(
    `document.getElementById('maxTextHeight').value = 15; document.getElementById('maxTextHeight').dispatchEvent(new Event('change'));`,
  );
  await until(
    'document.getElementById("maxTextHeight").value === "15"',
    "custom maximum height",
  );
  await sleep(100);
  assert.equal(task.options.subtitleFilter.max_text_height_ratio, 0.15);
  await execute('document.getElementById("resetFilterBtn").click();');
  await until(
    'document.getElementById("subtitleFilterFields").hidden',
    "restore algorithm defaults",
  );
  await execute('document.getElementById("customFilterEnabled").click();');
  await until(
    '!document.getElementById("subtitleFilterFields").hidden',
    "enable subtitle filter again",
  );
  await execute(
    `document.getElementById('maxTextHeight').value = 15; document.getElementById('maxTextHeight').dispatchEvent(new Event('change'));`,
  );
  await sleep(150);
  await execute('document.getElementById("timeRangesBtn").click();');
  await until(
    'document.getElementById("timeRangesDialog").open && document.getElementById("rangeVideo").videoWidth === 1280',
    "time range editor preview",
  );
  await execute(
    `document.getElementById('timeRangeMode').value = 'selected'; document.getElementById('timeRangeMode').dispatchEvent(new Event('change')); document.getElementById('addTimeRangeBtn').click();`,
  );
  await execute(
    `document.querySelector('[data-time="start"]').value = 1; document.querySelector('[data-time="end"]').value = 0.5; document.getElementById('timeRangesForm').requestSubmit();`,
  );
  await until(
    'document.getElementById("timeRangeError").textContent.includes("有效时间段")',
    "invalid time range feedback",
  );
  await execute('document.getElementById("rangeVideo").currentTime = .25;');
  await until(
    'Math.abs(document.getElementById("rangeVideo").currentTime - .25) < .01 && !document.getElementById("rangeVideo").seeking && document.getElementById("rangeVideo").readyState >= 2',
    "seek time range preview",
  );
  await execute(
    `document.querySelector('.time-range-row .text-button').click(); document.querySelector('[data-time="end"]').value = 1.5;`,
  );
  await screenshot("10-time-ranges.png");
  await execute('document.getElementById("timeRangesForm").requestSubmit();');
  await until(
    '!document.getElementById("timeRangesDialog").open && document.getElementById("timeRangesSummary").textContent.includes("仅处理 1")',
    "save time ranges",
  );
  assert.deepEqual(task.options.timeFilter, {
    mode: "selected",
    segments: [{ start: 0.25, end: 1.5 }],
  });
  await until(
    '!document.getElementById("rangeVideo").getAttribute("src")',
    "time range preview cleanup",
  );
  await execute(
    'document.getElementById("advancedOptions").open = false; document.querySelector(".settings-scroll").scrollTop = 0;',
  );
  await execute(
    `document.getElementById('modelVersion').value = 'v5.6'; document.getElementById('modelVersion').dispatchEvent(new Event('change'));`,
  );
  await until(
    'document.getElementById("modelVersion").value === "v5.6"',
    "algorithm selection",
  );
  await until(
    'document.getElementById("toast").hidden',
    "saved notice dismissal",
  );
  await screenshot("02-region-light.png");
  await execute('document.getElementById("startBtn").click();');
  await until(
    'document.getElementById("elapsedTime").textContent === "已耗时 1秒"',
    "live elapsed time while uploading",
  );
  const deadline = Date.now() + 15000;
  while (task.state !== "completed" && Date.now() < deadline) await sleep(100);
  if (task.state !== "completed") {
    await screenshot("failure-after-start.png");
    const details = await execute(
      `({ toast: document.getElementById('toast').textContent, errors: window.smokeErrors })`,
    );
    throw new Error(
      `Start flow failed: ${JSON.stringify({ taskState: task.state, ...details })}`,
    );
  }
  assert.equal(task.state, "completed");
  const elapsed = await execute(
    'document.getElementById("elapsedTime").textContent',
  );
  assert.match(elapsed, /^总耗时 \d+秒$/);
  await sleep(1100);
  assert.equal(
    await execute('document.getElementById("elapsedTime").textContent'),
    elapsed,
  );
  assert.equal(submits.length, 1);
  assert.equal(submits[0].mode, "Subtitle");
  assert.equal(submits[0].erase_ratio_location.length, 2);
  assert.deepEqual(submits[0].time_segment_filter, {
    mode: "selected",
    segments: [{ start_time: 0.25, end_time: 1.5 }],
  });
  assert.equal(submits[0].subtitle_filter.max_text_height_ratio, 0.15);
  await until(
    'document.getElementById("cloudElapsedTime").textContent === "云端任务耗时 42秒"',
    "cloud task duration",
  );
  assert.equal(submits[0].model_version, "v5.6");
  assert.equal(fs.statSync(task.outputPath).size, fs.statSync(fixture).size);
  await execute('document.getElementById("outputTab").click();');
  await until(
    'document.getElementById("video").currentSrc.includes("/output") && document.getElementById("video").videoWidth === 1280',
    "output preview",
  );
  await screenshot("03-result-light.png");
  await execute(
    'document.getElementById("previewStage").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));',
  );
  await until(
    'document.getElementById("comparisonDialog").open && document.getElementById("compareOriginal").videoWidth === 1280 && document.getElementById("compareResult").videoWidth === 1280',
    "double-click video comparison",
  );
  assert.equal(
    await execute(
      'document.getElementById("comparisonDivider").getAttribute("aria-valuenow")',
    ),
    "50",
  );
  assert.equal(
    await execute('document.getElementById("compareResult").muted'),
    true,
  );
  const line = await execute(
    `(() => { const rect = document.getElementById('comparisonStage').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: Math.round(rect.left + rect.width * .7) }; })()`,
  );
  win.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    x: line.x,
    y: line.y,
    clickCount: 1,
  });
  win.webContents.sendInputEvent({
    type: "mouseMove",
    x: line.target,
    y: line.y,
  });
  win.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    x: line.target,
    y: line.y,
    clickCount: 1,
  });
  await until(
    'Number(document.getElementById("comparisonDivider").getAttribute("aria-valuenow")) >= 69',
    "comparison divider drag",
  );
  await screenshot("07-video-comparison.png");
  await execute('document.getElementById("comparePlayBtn").click();');
  await until(
    'document.getElementById("compareOriginal").currentTime > .15 && document.getElementById("compareResult").currentTime > .15',
    "synchronized playback",
  );
  const drift = await execute(
    'Math.abs(document.getElementById("compareOriginal").currentTime - document.getElementById("compareResult").currentTime)',
  );
  assert.ok(drift < 0.15);
  await execute(
    'document.getElementById("comparePlayBtn").click(); document.getElementById("compareSeek").value = 500; document.getElementById("compareSeek").dispatchEvent(new Event("input"));',
  );
  await until(
    'Math.abs(document.getElementById("compareOriginal").currentTime - 1) < .1 && Math.abs(document.getElementById("compareResult").currentTime - 1) < .1',
    "synchronized seek",
  );
  await execute('document.getElementById("closeComparisonBtn").focus();');
  await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await until(
    '!document.getElementById("comparisonDialog").open && !document.getElementById("compareOriginal").getAttribute("src")',
    "comparison escape cleanup",
  );
  await execute('document.getElementById("playBtn").click();');
  await until(
    'document.getElementById("video").currentTime > .1',
    "video playback",
  );
  await execute(
    'document.getElementById("playBtn").click(); document.getElementById("themeBtn").click();',
  );
  await until(
    'document.documentElement.dataset.theme === "dark"',
    "dark theme",
  );
  await screenshot("04-result-dark.png");
  win.setContentSize(1100, 740);
  await sleep(300);
  const bounds = await execute(`(() => {
    const button = document.getElementById('startBtn').getBoundingClientRect();
    return { horizontalOverflow: document.documentElement.scrollWidth > innerWidth, stageHeight: document.getElementById('previewStage').clientHeight, startVisible: button.bottom <= innerHeight };
  })()`);
  assert.equal(bounds.horizontalOverflow, false);
  assert.ok(bounds.stageHeight > 200);
  assert.equal(bounds.startVisible, true);
  await screenshot("05-compact-dark.png");
  await execute(
    'document.getElementById("settingsBtn").click(); document.getElementById("checkUpdateBtn").click();',
  );
  await until(
    `document.getElementById("updateDialog").open && !document.getElementById("updateActionBtn").hidden && document.getElementById("updateStatus").textContent.includes(${JSON.stringify(updateVersion)})`,
    "update check UI",
  );
  await execute('document.getElementById("updateActionBtn").click();');
  await until(
    'document.getElementById("updateActionBtn").textContent.includes("重启并安装")',
    "verified update download UI",
  );
  assert.equal(updates.getState().phase, "downloaded");
  await screenshot("08-update-settings.png");
  await execute('document.getElementById("updateActionBtn").click();');
  await until(
    'document.getElementById("updateStatus").textContent.includes("安装未能启动")',
    "installer failure recovery UI",
  );
  assert.equal(engine.suspended, false);
  await execute(
    'document.querySelector("#updateDialog .close-dialog").click();',
  );
  await execute(
    'document.querySelector("#settingsDialog .close-dialog").click();',
  );
  const errors = await execute("window.smokeErrors");
  assert.deepEqual(errors, []);
  const saved = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(
    saved.tasks.find((item) => item.id === task.id).taskId,
    "smoke-cloud-task",
  );
  assert.equal(saved.settings.theme, "dark");
  assert.equal(saved.tasks[0].startedAt, task.startedAt);
  assert.equal(saved.tasks[0].completedAt, task.completedAt);
  assert.deepEqual(saved.tasks[0].options, task.options);
  await win.loadFile(path.resolve(__dirname, "../ui/index.html"));
  await until(
    'document.querySelectorAll("[data-region]").length === 2 && document.getElementById("cloudElapsedTime").textContent.includes("42秒")',
    "restored task options after renderer restart",
  );
  return {
    passed: true,
    mode: "simulated upstream, isolated profile, no paid calls",
    checks: [
      "preload bridge",
      "Windows encrypted key save and decrypt",
      "local video preview",
      "normalized rectangle via pointer input",
      "v5.6 parameters",
      "company UI without pricing or provider branding",
      "native drag/drop through preload bridge, Chinese paths, invalid input errors",
      "import and preview loading indicators",
      "single submission",
      "cloud query",
      "automatic download",
      "result playback",
      "light and dark themes",
      "1100x740 layout",
      "persisted task and settings",
      "no renderer errors",
      "double-click comparison and draggable split",
      "synchronized playback and seek, muted result, escape cleanup",
      "update check, verified download UI and failed-install recovery",
      "automatic startup update popup, silent current version and offline failure",
      "live elapsed time, fixed completion time and saved timestamps",
      "independent processing modes, multiple regions, selection redraw and removal",
      "subtitle filter editing and reset, time range editor and validation",
      "cloud duration and restored options after renderer restart",
    ],
    screenshots: [
      "01-empty-light.png",
      "02-region-light.png",
      "03-result-light.png",
      "04-result-dark.png",
      "05-compact-dark.png",
      "07-video-comparison.png",
      "08-update-settings.png",
      "09-startup-update.png",
      "10-time-ranges.png",
    ],
  };
}

module.exports = { run };
