"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function run({ win, engine, store, safeStorage, updates }) {
  const output = path.resolve(__dirname, "../validation");
  const fixture = path.join(output, "fixture.mp4");
  const execute = (script) => win.webContents.executeJavaScript(script, true);
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
  await execute(
    'window.smokeErrors = []; window.addEventListener("error", event => window.smokeErrors.push(event.message));',
  );
  // Never use the network or paid service in this smoke test.
  const submits = [];
  let queries = 0;
  engine.client = {
    upload: async (_file, progress) => {
      progress(50, 100);
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
  const [task] = engine.addFiles([fixture]);
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
  const rect = await execute(`(() => {
    const frame = document.getElementById('videoFrame').getBoundingClientRect();
    const scale = Math.min(frame.width / 1280, frame.height / 720);
    const width = 1280 * scale, height = 720 * scale;
    const left = frame.left + (frame.width - width) / 2;
    const top = frame.top + (frame.height - height) / 2;
    return { x1: Math.round(left + width * .1), y1: Math.round(top + height * .78), x2: Math.round(left + width * .9), y2: Math.round(top + height * .93) };
  })()`);
  win.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    x: rect.x1,
    y: rect.y1,
    clickCount: 1,
  });
  win.webContents.sendInputEvent({
    type: "mouseMove",
    x: rect.x2,
    y: rect.y2,
    movementX: rect.x2 - rect.x1,
    movementY: rect.y2 - rect.y1,
  });
  win.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    x: rect.x2,
    y: rect.y2,
    clickCount: 1,
  });
  await until(
    'document.getElementById("clearRectBtn").hidden === false',
    "rectangle persistence",
  );
  assert.ok(Math.abs(task.options.rect.top_left_x - 0.1) < 0.01);
  assert.ok(Math.abs(task.options.rect.top_left_y - 0.78) < 0.01);
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
    'document.getElementById("confirmDialog").open',
    "billing confirmation",
  );
  await execute(
    'document.querySelector("#confirmDialog button[value=start]").click();',
  );
  const deadline = Date.now() + 15000;
  while (task.state !== "completed" && Date.now() < deadline) await sleep(100);
  if (task.state !== "completed") {
    await screenshot("failure-after-start.png");
    const details = await execute(
      `({ dialogOpen: document.getElementById('confirmDialog').open, dialogValue: document.getElementById('confirmDialog').returnValue, toast: document.getElementById('toast').textContent, errors: window.smokeErrors })`,
    );
    throw new Error(
      `Start flow failed: ${JSON.stringify({ taskState: task.state, ...details })}`,
    );
  }
  assert.equal(task.state, "completed");
  assert.equal(submits.length, 1);
  assert.equal(submits[0].mode, "Text");
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
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
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
    '!document.getElementById("updateActionBtn").hidden && document.getElementById("updateStatus").textContent.includes("1.2.0")',
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
  return {
    passed: true,
    mode: "simulated upstream, isolated profile, no paid calls",
    checks: [
      "preload bridge",
      "Windows encrypted key save and decrypt",
      "local video preview",
      "normalized rectangle via pointer input",
      "v5.6 parameters",
      "billing confirmation",
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
    ],
    screenshots: [
      "01-empty-light.png",
      "02-region-light.png",
      "03-result-light.png",
      "04-result-dark.png",
      "05-compact-dark.png",
      "07-video-comparison.png",
      "08-update-settings.png",
    ],
  };
}

module.exports = { run };
