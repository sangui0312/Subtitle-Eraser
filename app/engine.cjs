"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { MIME, publicURL, safeMessage } = require("./client.cjs");

const EDITABLE = new Set(["draft", "error"]);
const TRACKED = new Set(["processing", "query_error", "download_pending"]);
const DEFAULT_OPTIONS = {
  modelVersion: "v5",
  selection: "auto",
  encodeMode: "Quality",
  rect: null,
};

function options(input = {}) {
  const value = { ...DEFAULT_OPTIONS, ...input };
  if (!["v5", "v5.6", "v4"].includes(value.modelVersion))
    throw new Error("请选择有效的算法版本。");
  if (!["auto", "region"].includes(value.selection))
    throw new Error("请选择有效的擦除模式。");
  if (!["Quality", "Size"].includes(value.encodeMode))
    throw new Error("请选择有效的输出质量。");
  if (value.rect) {
    const rect = value.rect;
    const keys = [
      "top_left_x",
      "top_left_y",
      "bottom_right_x",
      "bottom_right_y",
    ];
    if (
      keys.some(
        (key) => !Number.isFinite(rect[key]) || rect[key] < 0 || rect[key] > 1,
      ) ||
      rect.top_left_x >= rect.bottom_right_x ||
      rect.top_left_y >= rect.bottom_right_y
    ) {
      throw new Error("框选区域无效，请重新框选。");
    }
    value.rect = Object.fromEntries(keys.map((key) => [key, rect[key]]));
  }
  return {
    modelVersion: value.modelVersion,
    selection: value.selection,
    encodeMode: value.encodeMode,
    rect: value.rect,
  };
}

function localSource(file) {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw new Error("视频文件路径无效。");
  const extension = path.extname(file).toLowerCase();
  if (!MIME[extension])
    throw new Error("请选择 MP4、MOV、MKV、AVI、FLV、TS、WMV 或 WebM 视频。");
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw new Error("视频文件为空或无法读取。");
  if (stat.size > 5 * 1024 ** 3) throw new Error("单个视频最大支持 5 GB。");
  return { type: "local", path: file, size: stat.size, mtime: stat.mtimeMs };
}

class Engine {
  constructor({
    store,
    client,
    hasKey,
    identity = () => "",
    onChange = () => {},
    pollMs = 15000,
  }) {
    Object.assign(this, { store, client, hasKey, identity, onChange, pollMs });
    this.busy = false;
    this.stopped = false;
    this.controller = new AbortController();
    for (const task of this.tasks) {
      task.progress = null;
      if (task.taskId) {
        if (
          !["completed", "cloud_failed", "download_error", "error"].includes(
            task.state,
          )
        )
          task.state = task.resultURL ? "download_pending" : "processing";
      } else if (
        task.request &&
        ["queued", "uploading", "submitting", "submission_unknown"].includes(
          task.state,
        )
      ) {
        task.state = "submission_unknown";
        task.error =
          "上次提交尚未取得任务 ID。可在 23 小时内使用原请求恢复提交，或在火山控制台核对任务。";
      } else if (["queued", "uploading"].includes(task.state)) {
        task.state = "draft";
        task.error = "软件已重新打开，请点击开始处理继续。";
      }
    }
    this.store.save();
  }
  get tasks() {
    return this.store.data.tasks;
  }
  task(id) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error("任务不存在。");
    return task;
  }
  commit() {
    this.store.save();
    this.onChange();
  }
  patch(task, values) {
    Object.assign(task, values, { updatedAt: Date.now() });
    this.commit();
  }
  add(source, name) {
    const task = {
      id: randomUUID(),
      name,
      source,
      options: { ...DEFAULT_OPTIONS },
      state: "draft",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 0,
      width: 0,
      height: 0,
      error: "",
      progress: null,
    };
    this.tasks.push(task);
    this.commit();
    return task;
  }
  addFiles(files) {
    if (!Array.isArray(files) || files.length > 100)
      throw new Error("一次最多添加 100 个视频。");
    const checked = files.map((file) => ({
      source: localSource(file),
      name: path.basename(file),
    }));
    return checked.map((item) => this.add(item.source, item.name));
  }
  addURL(value) {
    if (typeof value !== "string" || value.length > 12000)
      throw new Error("视频地址过长或无效。");
    const url = publicURL(value.trim());
    let name = "网络视频.mp4";
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop()) || name;
    } catch {}
    return this.add({ type: "url", url }, name.slice(0, 200));
  }
  update(id, input) {
    const task = this.task(id);
    if (!EDITABLE.has(task.state))
      throw new Error("当前任务已提交，请完成后重新导入以更改参数。");
    this.patch(task, { options: options(input), error: "" });
  }
  metadata(id, { duration, width, height }) {
    const task = this.task(id);
    if (
      ![duration, width, height].every(Number.isFinite) ||
      duration <= 0 ||
      width <= 0 ||
      height <= 0
    )
      return;
    if (
      task.duration === duration &&
      task.width === width &&
      task.height === height
    )
      return;
    this.patch(task, { duration, width, height });
  }
  enqueue(ids) {
    if (!this.hasKey()) throw new Error("请先在设置中填写 API Key。");
    if (!Array.isArray(ids) || !ids.length)
      throw new Error("请先添加待处理视频。");
    const jobs = ids.map((id) => this.task(id));
    for (const task of jobs) {
      if (!EDITABLE.has(task.state))
        throw new Error("所选任务已有处理记录，请使用恢复查询或重试下载。");
      const config = options(task.options);
      if (config.selection === "region" && !config.rect)
        throw new Error(`请先为“${task.name}”框选擦除区域。`);
      if (
        task.width &&
        (Math.min(task.width, task.height) > 1440 ||
          Math.max(task.width, task.height) > 2560)
      ) {
        throw new Error(`“${task.name}”超过 2K 输入限制，请先缩小视频。`);
      }
      if (task.source.type === "local") localSource(task.source.path);
    }
    fs.mkdirSync(this.store.data.settings.outputDir, { recursive: true });
    for (const task of jobs)
      Object.assign(task, {
        state: "queued",
        error: "",
        token: randomUUID(),
        request: null,
        outputDir: this.store.data.settings.outputDir,
        progress: null,
      });
    this.commit();
    this.schedule(0);
  }
  retry(id) {
    const task = this.task(id);
    if (!this.hasKey()) throw new Error("请先配置 API Key。");
    if (task.state === "submission_unknown") {
      if (!task.request || Date.now() - task.submittedAt > 23 * 3600000) {
        throw new Error(
          "原请求已超出安全恢复时间，请先在火山控制台核对，避免重复计费。",
        );
      }
      if (task.identity !== this.identity())
        throw new Error("恢复提交需要使用提交时的同一个 API Key。");
      this.patch(task, { state: "queued", error: "" });
    } else if (
      task.taskId &&
      ["query_error", "download_error"].includes(task.state)
    ) {
      this.patch(task, {
        state: task.resultURL ? "download_pending" : "processing",
        error: "",
      });
    } else throw new Error("当前任务无法恢复，请查看任务状态。");
    this.schedule(0);
  }
  cancelQueued(id) {
    const task = this.task(id);
    if (task.state !== "queued" || task.request)
      throw new Error("只能取消尚未提交的排队任务。");
    this.patch(task, { state: "draft", error: "" });
  }
  remove(id) {
    const task = this.task(id);
    if (
      [
        "queued",
        "uploading",
        "submitting",
        "processing",
        "query_error",
        "downloading",
        "download_pending",
        "submission_unknown",
      ].includes(task.state)
    ) {
      throw new Error("任务仍在执行或等待核对，请完成后移除记录。");
    }
    this.store.data.tasks = this.tasks.filter((item) => item.id !== id);
    this.commit();
  }
  progress(task) {
    let last = 0;
    return (received, total) => {
      if (Date.now() - last < 250 && received !== total) return;
      last = Date.now();
      task.progress = total
        ? Math.min(100, Math.round((100 * received) / total))
        : null;
      this.onChange();
    };
  }
  async submit(task) {
    try {
      if (!task.request) {
        let videoURL = task.source.url;
        if (task.source.type === "local") {
          const current = localSource(task.source.path);
          if (
            current.size !== task.source.size ||
            current.mtime !== task.source.mtime
          )
            throw new Error("原视频文件已发生变化，请重新导入。");
          this.patch(task, { state: "uploading", progress: 0 });
          videoURL = await this.client.upload(
            task.source.path,
            this.progress(task),
            this.controller.signal,
          );
        }
        const config = task.options;
        const request = {
          video_url: videoURL,
          client_token: task.token,
          model_version: config.modelVersion,
          mode: config.selection === "region" ? "Text" : "Subtitle",
          output_encode_mode: config.encodeMode,
        };
        if (config.selection === "region")
          request.erase_ratio_location = [config.rect];
        this.patch(task, {
          request,
          identity: this.identity(),
          submittedAt: Date.now(),
        });
      }
      this.patch(task, { state: "submitting", progress: null });
      const response = await this.client.submit(
        task.request,
        this.controller.signal,
      );
      if (!response.task_id || typeof response.task_id !== "string")
        throw new Error("提交响应缺少任务 ID，请恢复原请求或在控制台核对。");
      this.patch(task, {
        taskId: response.task_id,
        state: "processing",
        error: "",
      });
    } catch (error) {
      if (this.stopped) return;
      const uncertain = task.state === "submitting" && !error.definite;
      this.patch(task, {
        state: uncertain ? "submission_unknown" : "error",
        error: safeMessage(error),
        progress: null,
      });
    }
  }
  async query(task) {
    try {
      const response = await this.client.query(
        task.taskId,
        this.controller.signal,
      );
      if (response.status === "failed") {
        this.patch(task, {
          state: "cloud_failed",
          error: safeMessage(
            response.error?.message || "云端处理失败，请在火山控制台核对。",
          ),
        });
      } else if (response.status === "completed") {
        if (!response.result?.video_url)
          throw new Error("云端任务已完成，但结果缺少视频地址。");
        const resultURL = publicURL(response.result.video_url);
        this.patch(task, {
          state: "download_pending",
          resultURL,
          expiresAt: response.expires_at || 0,
          error: "",
        });
        await this.download(task);
      } else if (["running", "pending", "queued"].includes(response.status)) {
        this.patch(task, { state: "processing", error: "" });
      } else throw new Error("云端返回了暂时无法识别的状态，稍后继续查询。");
    } catch (error) {
      if (!this.stopped)
        this.patch(task, { state: "query_error", error: safeMessage(error) });
    }
  }
  async download(task) {
    let partial;
    try {
      if (
        task.outputPath &&
        task.outputSize > 0 &&
        fs.existsSync(task.outputPath) &&
        fs.statSync(task.outputPath).size === task.outputSize
      ) {
        this.patch(task, { state: "completed", error: "", progress: null });
        return;
      }
      if (task.expiresAt && Date.now() / 1000 >= task.expiresAt)
        throw new Error(
          "成片下载链接已过期，请在火山控制台核对产物。原任务将保留。",
        );
      const directory = task.outputDir || this.store.data.settings.outputDir;
      fs.mkdirSync(directory, { recursive: true });
      if (task.outputPath && fs.existsSync(task.outputPath)) {
        this.patch(task, { outputPath: null, outputSize: null });
      }
      if (!task.outputPath) {
        const stem =
          path
            .parse(task.name)
            .name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
            .slice(0, 90)
            .replace(/[. ]+$/g, "") || "视频";
        const base = `${stem}_去字幕_${task.id.slice(0, 8)}`;
        let candidate = path.join(directory, `${base}.mp4`);
        let index = 1;
        while (fs.existsSync(candidate))
          candidate = path.join(directory, `${base}_${index++}.mp4`);
        this.patch(task, { outputPath: candidate });
      }
      partial = `${task.outputPath}.part`;
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
      this.patch(task, { state: "downloading", progress: 0 });
      await this.client.download(
        task.resultURL,
        partial,
        this.progress(task),
        this.controller.signal,
      );
      const outputSize = fs.statSync(partial).size;
      if (!outputSize) throw new Error("下载结果为空，请重试下载。");
      this.patch(task, { outputSize });
      // link() publishes the finished file atomically without replacing another file.
      try {
        fs.linkSync(partial, task.outputPath);
      } catch (error) {
        if (
          !["ENOTSUP", "EPERM", "EXDEV", "EINVAL", "ENOSYS"].includes(
            error.code,
          )
        )
          throw error;
        // Some external drives do not support hard links. Copy exclusively there.
        const reservation = fs.openSync(task.outputPath, "wx");
        fs.closeSync(reservation);
        try {
          fs.copyFileSync(partial, task.outputPath);
        } catch (copyError) {
          if (fs.existsSync(task.outputPath)) fs.unlinkSync(task.outputPath);
          throw copyError;
        }
      }
      fs.unlinkSync(partial);
      this.patch(task, {
        state: "completed",
        error: "",
        progress: null,
        completedAt: Date.now(),
      });
    } catch (error) {
      if (partial && fs.existsSync(partial)) {
        try {
          fs.unlinkSync(partial);
        } catch {}
      }
      if (!this.stopped)
        this.patch(task, {
          state: "download_error",
          error: safeMessage(error),
          progress: null,
        });
    }
  }
  schedule(delay = this.pollMs) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.pump().catch((error) => {
          this.fatalError = safeMessage(error);
          this.onChange();
        }),
      delay,
    );
  }
  async pump() {
    if (this.stopped || this.busy || !this.hasKey()) return;
    const task =
      this.tasks.find((item) => TRACKED.has(item.state)) ||
      this.tasks.find((item) => item.state === "queued");
    if (!task) return;
    this.busy = true;
    try {
      if (task.state === "queued") await this.submit(task);
      else if (task.state === "download_pending") await this.download(task);
      else await this.query(task);
    } finally {
      this.busy = false;
      const waiting = this.tasks.some((item) => TRACKED.has(item.state));
      this.schedule(waiting ? this.pollMs : 0);
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller.abort();
  }
}

module.exports = { Engine, options, localSource, DEFAULT_OPTIONS, EDITABLE };
