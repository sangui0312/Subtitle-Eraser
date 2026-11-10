"use strict";
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  protocol,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const { Store, writeJSON } = require("./store.cjs");
const { Client, MIME } = require("./client.cjs");
const { Engine } = require("./engine.cjs");
const { UpdateController, REPOSITORY } = require("./updater.cjs");

const smoke = !app.isPackaged && process.argv.includes("--smoke");
if (smoke)
  app.setPath(
    "userData",
    path.resolve(__dirname, `../validation/profile-${Date.now()}`),
  );
else
  app.setPath("userData", path.join(app.getPath("appData"), "SubtitleEraser"));
app.setAppUserModelId("local.subtitleeraser.desktop");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
const locked = app.requestSingleInstanceLock();
let win,
  store,
  engine,
  updates,
  apiKey = "",
  credentialError = "";
const page = path.resolve(__dirname, "../ui/index.html");
const keyFile = path.join(app.getPath("userData"), "credentials.json");
// A lightweight workspace also works on machines with older display drivers.
app.disableHardwareAcceleration();

function snapshot() {
  return {
    settings: store.data.settings,
    hasKey: Boolean(apiKey),
    credentialError,
    fatalError: engine.fatalError || "",
    version: app.getVersion(),
    tasks: engine.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      state: task.state,
      options: task.options,
      duration: task.duration,
      width: task.width,
      height: task.height,
      error: task.error,
      progress: task.progress,
      taskId: task.taskId || "",
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      sourceType: task.source.type,
      size: task.source.size || 0,
      sourcePreview:
        task.source.type === "local"
          ? `media://video/${task.id}/source`
          : task.source.url,
      outputPreview:
        task.state === "completed" ? `media://video/${task.id}/output` : "",
      outputPath: task.state === "completed" ? task.outputPath : "",
      canRestoreSubmission:
        task.state === "submission_unknown" &&
        Boolean(task.request) &&
        Date.now() - task.submittedAt <= 23 * 3600000,
      canUnqueue: task.state === "queued" && !task.request,
    })),
  };
}

function broadcast() {
  if (win && !win.isDestroyed())
    win.webContents.send("workspace:state", snapshot());
}

function trusted(event) {
  return (
    win &&
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame.url === pathToFileURL(page).href
  );
}

function handle(name, action) {
  ipcMain.handle(name, async (event, ...args) => {
    if (!trusted(event)) throw new Error("请求来源无效。");
    try {
      return { ok: true, value: await action(...args) };
    } catch (error) {
      return { ok: false, error: error.message || "操作未完成。" };
    }
  });
}

function installIPC() {
  handle("updates:get", () => updates.getState());
  handle("updates:check", () => updates.check());
  handle("updates:download", () => updates.download());
  handle("updates:install", () => updates.install());
  handle("updates:releases", () =>
    shell.openExternal(`${REPOSITORY}/releases`),
  );
  handle("workspace:get", snapshot);
  handle("files:pick", async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: "添加待擦除字幕的视频",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "视频",
          extensions: Object.keys(MIME).map((item) => item.slice(1)),
        },
      ],
    });
    return picked.canceled
      ? []
      : engine.addFiles(picked.filePaths).map((task) => task.id);
  });
  handle("files:drop", (files) =>
    engine.addFiles(files).map((task) => task.id),
  );
  handle("tasks:add-url", (url) => engine.addURL(url).id);
  handle("tasks:options", (id, value) => engine.update(id, value));
  handle("tasks:metadata", (id, value) => engine.metadata(id, value));
  handle("tasks:start", (ids) => engine.enqueue(ids));
  handle("tasks:retry", (id) => engine.retry(id));
  handle("tasks:remove", (id) => engine.remove(id));
  handle("tasks:unqueue", (id) => engine.cancelQueued(id));
  handle("files:reveal", (id) => {
    const task = engine.task(id);
    if (
      !task.outputPath ||
      task.state !== "completed" ||
      !fs.existsSync(task.outputPath)
    )
      throw new Error("成片文件已被移动或删除。");
    shell.showItemInFolder(task.outputPath);
  });
  handle("settings:folder", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "选择成片保存位置",
      defaultPath: store.data.settings.outputDir,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    store.data.settings.outputDir = result.filePaths[0];
    engine.commit();
    return result.filePaths[0];
  });
  handle("settings:save", (input) => {
    if (!input || !["light", "dark"].includes(input.theme))
      throw new Error("设置无效。");
    if (input.newKey !== undefined || input.clearKey) {
      if (engine.busy)
        throw new Error("当前有请求正在执行，请稍后再保存 API Key。");
      const next = input.clearKey ? "" : String(input.newKey).trim();
      if (next.length > 4096 || /\s/.test(next))
        throw new Error("API Key 格式无效，请检查是否包含空格或换行。");
      if (next) {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("Windows 加密存储暂不可用，无法保存 API Key。");
        writeJSON(keyFile, {
          encrypted: safeStorage.encryptString(next).toString("base64"),
        });
      } else if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
      apiKey = next;
      credentialError = "";
    }
    store.data.settings.theme = input.theme;
    engine.commit();
    engine.schedule(0);
  });
}

function mediaResponse(request) {
  try {
    const url = new URL(request.url);
    const [id, kind] = url.pathname.split("/").filter(Boolean);
    if (url.hostname !== "video" || !["source", "output"].includes(kind))
      return new Response(null, { status: 404 });
    const task = engine.task(id);
    const file =
      kind === "output"
        ? task.outputPath
        : task.source.type === "local"
          ? task.source.path
          : null;
    if (!file || (kind === "output" && task.state !== "completed"))
      return new Response(null, { status: 404 });
    const size = fs.statSync(file).size;
    let start = 0,
      end = size - 1,
      status = 200;
    const headers = {
      "Content-Type":
        MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (start > end || start >= size)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    if (request.method === "HEAD")
      return new Response(null, { status, headers });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream), { status, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

async function launch() {
  store = new Store(
    app.getPath("userData"),
    path.join(app.getPath("videos"), "字幕擦除"),
  );
  if (fs.existsSync(keyFile)) {
    try {
      apiKey = safeStorage.decryptString(
        Buffer.from(
          JSON.parse(fs.readFileSync(keyFile, "utf8")).encrypted,
          "base64",
        ),
      );
    } catch {
      credentialError = "已保存的 API Key 暂时无法解密，请在设置中重新填写。";
    }
  }
  const client = new Client(() => apiKey);
  engine = new Engine({
    store,
    client,
    hasKey: () => Boolean(apiKey),
    identity: () => createHash("sha256").update(apiKey).digest("hex"),
    onChange: broadcast,
  });
  const nativeUpdater = smoke
    ? require("../tests/updater-fixture.cjs").createUpdater()
    : app.isPackaged
      ? require("electron-updater").autoUpdater
      : null;
  updates = new UpdateController({
    native: nativeUpdater,
    version: app.getVersion(),
    enabled: app.isPackaged || smoke,
    onChange: (value) => {
      if (win && !win.isDestroyed())
        win.webContents.send("updates:state", value);
    },
    prepareInstall: () => {
      if (
        engine.busy ||
        engine.tasks.some((task) =>
          ["queued", "uploading", "submitting", "downloading"].includes(
            task.state,
          ),
        )
      ) {
        throw new Error("请等待当前排队、上传或下载完成后再安装更新。");
      }
      engine.suspended = true;
      clearTimeout(engine.timer);
      engine.commit();
      const backup = path.join(
        app.getPath("userData"),
        "backups",
        `workspace-${app.getVersion()}-${Date.now()}.json`,
      );
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(store.file, backup);
      if (!fs.readFileSync(backup).equals(fs.readFileSync(store.file)))
        throw new Error("任务备份校验失败，请稍后重试更新。");
    },
    recoverInstall: () => {
      engine.suspended = false;
      engine.schedule(0);
    },
  });
  protocol.handle("media", mediaResponse);
  installIPC();
  win = new BrowserWindow({
    title: "字幕擦除",
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 740,
    backgroundColor:
      store.data.settings.theme === "dark" ? "#0b1020" : "#f8fafc",
    autoHideMenuBar: true,
    show: false,
    icon: path.resolve(__dirname, "../ui/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  win.once("ready-to-show", () => win.show());
  await win.loadFile(page);
  if (!smoke) engine.schedule(0);
  if (smoke) {
    try {
      const report = await require("../tests/smoke.cjs").run({
        win,
        engine,
        store,
        app,
        safeStorage,
        updates,
      });
      writeJSON(
        path.resolve(__dirname, "../validation/smoke-report.json"),
        report,
      );
      app.quit();
    } catch (error) {
      fs.writeFileSync(
        path.resolve(__dirname, "../validation/smoke-error.txt"),
        error.stack,
        "utf8",
      );
      app.exit(1);
    }
  }
}

if (!locked) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(launch)
    .catch(async (error) => {
      if (smoke) {
        process.stderr.write(`${error.stack}\n`);
        app.exit(1);
        return;
      }
      await dialog.showMessageBox({
        type: "error",
        title: "字幕擦除",
        message: "软件未能启动",
        detail: error.message,
      });
      app.quit();
    });
  app.on("before-quit", () => engine?.stop());
  app.on("window-all-closed", () => app.quit());
}
