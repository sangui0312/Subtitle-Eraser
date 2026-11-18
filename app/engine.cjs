"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { MIME, publicURL, safeMessage } = require("./client.cjs");
const { enhanceOptions, enhanceRequest } = require("./enhance.cjs");

const EDITABLE = new Set(["draft", "error"]);
const TRACKED = new Set(["processing", "query_error", "download_pending"]);
const DEFAULT_OPTIONS = {
  modelVersion: "v5",
  mode: "Subtitle",
  selection: "auto",
  encodeMode: "Quality",
  rects: [],
  timeFilter: { mode: "all", segments: [] },
  subtitleFilter: null,
};

function options(input = {}) {
  const value = { ...DEFAULT_OPTIONS, ...input };
  value.mode =
    input.mode ?? (input.selection === "region" ? "Text" : "Subtitle");
  if (!["v5", "v5.6", "v4"].includes(value.modelVersion))
    throw new Error("请选择有效的算法版本。");
  if (!["auto", "region"].includes(value.selection))
    throw new Error("请选择有效的擦除模式。");
  if (!["Subtitle", "Text"].includes(value.mode))
    throw new Error("请选择字幕模式或画面文字模式。");
  if (!["Quality", "Size"].includes(value.encodeMode))
    throw new Error("请选择有效的输出质量。");
  const rects = input.rects ?? (input.rect ? [input.rect] : []);
  if (!Array.isArray(rects) || rects.length > 20)
    throw new Error("最多支持 20 个擦除区域。");
  value.rects = rects.map((rect) => {
    const keys = [
      "top_left_x",
      "top_left_y",
      "bottom_right_x",
      "bottom_right_y",
    ];
    if (
      keys.some(
        (key) =>
          !rect ||
          !Number.isFinite(rect[key]) ||
          rect[key] < 0 ||
          rect[key] > 1,
      ) ||
      rect.top_left_x >= rect.bottom_right_x ||
      rect.top_left_y >= rect.bottom_right_y
    ) {
      throw new Error("框选区域无效，请重新框选。");
    }
    return Object.fromEntries(keys.map((key) => [key, rect[key]]));
  });
  const timeFilter = value.timeFilter;
  if (
    !timeFilter ||
    !["all", "selected", "skip"].includes(timeFilter.mode) ||
    !Array.isArray(timeFilter.segments)
  )
    throw new Error("处理时间段设置无效。");
  const segments = timeFilter.segments
    .map((segment) => {
      if (
        !segment ||
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end) ||
        segment.start < 0 ||
        segment.end <= segment.start
      )
        throw new Error(
          "时间段结束时间必须大于开始时间，且开始时间不能小于零。",
        );
      return { start: segment.start, end: segment.end };
    })
    .sort((left, right) => left.start - right.start);
  value.timeFilter = { mode: timeFilter.mode, segments };
  if (value.subtitleFilter !== null) {
    const keys = [
      "min_text_height_ratio",
      "max_text_height_ratio",
      "center_offset_ratio",
    ];
    const filter = value.subtitleFilter;
    if (
      !filter ||
      keys.some(
        (key) =>
          !Number.isFinite(filter[key]) || filter[key] < 0 || filter[key] > 1,
      ) ||
      filter.min_text_height_ratio > filter.max_text_height_ratio
    )
      throw new Error(
        "字幕识别参数需在 0% 至 100% 之间，最小高度不能大于最大高度。",
      );
    value.subtitleFilter = Object.fromEntries(
      keys.map((key) => [key, filter[key]]),
    );
  }
  return {
    modelVersion: value.modelVersion,
    mode: value.mode,
    selection: value.selection,
    encodeMode: value.encodeMode,
    rects: value.rects,
    timeFilter: value.timeFilter,
    subtitleFilter: value.subtitleFilter,
  };
}

function localSource(file, kind = "subtitle") {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw new Error("视频文件路径无效。");
  const extension = path.extname(file).toLowerCase();
  if (!MIME[extension])
    throw new Error("请选择 MP4、MOV、MKV、AVI、FLV、TS、WMV 或 WebM 视频。");
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw new Error("视频文件为空或无法读取。");
  if (kind !== "enhance" && stat.size > 5 * 1024 ** 3)
    throw new Error("单个视频最大支持 5 GB。");
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
    const normalized = this.tasks.map((task) =>
      task.kind === "enhance"
        ? enhanceOptions(task.options)
        : options(task.options),
    );
    const needsMigration = normalized.some(
      (config, index) =>
        JSON.stringify(config) !== JSON.stringify(this.tasks[index].options),
    );
    if (needsMigration && fs.existsSync(store.file)) {
      const backup = path.join(
        path.dirname(store.file),
        "backups",
        `workspace-before-options-${Date.now()}-${randomUUID()}.json`,
      );
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(store.file, backup, fs.constants.COPYFILE_EXCL);
      if (!fs.readFileSync(store.file).equals(fs.readFileSync(backup)))
        throw new Error(
          "任务记录备份校验失败，请保留个人数据目录并联系维护者。",
        );
    }
    this.tasks.forEach((task, index) => {
      task.options = normalized[index];
    });
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
          "上次提交尚未取得任务 ID。可在 23 小时内使用原请求恢复提交，或核对服务端任务记录。";
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
  add(source, name, kind = "subtitle") {
    if (!["subtitle", "enhance"].includes(kind))
      throw new Error("工具类型无效。");
    const task = {
      id: randomUUID(),
      kind,
      name,
      source,
      options: kind === "enhance" ? enhanceOptions() : options(),
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
  addFiles(files, kind = "subtitle") {
    if (Array.isArray(files) && !files.length)
      throw new Error("没有读取到视频文件，请重新添加。");
    if (!Array.isArray(files) || files.length > 100)
      throw new Error("一次最多添加 100 个视频。");
    const checked = files.map((file) => ({
      source: localSource(file, kind),
      name: path.basename(file),
    }));
    return checked.map((item) => this.add(item.source, item.name, kind));
  }
  addURL(value, kind = "subtitle") {
    if (typeof value !== "string" || value.length > 12000)
      throw new Error("视频地址过长或无效。");
    const raw = value.trim();
    const url =
      kind === "enhance" && /^(vod|tos|mediakit):\/\/.+/.test(raw)
        ? raw
        : publicURL(raw);
    let name = "网络视频.mp4";
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop()) || name;
    } catch {}
    return this.add({ type: "url", url }, name.slice(0, 200), kind);
  }
  enhanceOutput(id) {
    const source = this.task(id);
    if (source.state !== "completed" || !source.outputPath)
      throw new Error("请先完成并保存视频结果。");
    return this.add(
      localSource(source.outputPath, "enhance"),
      path.basename(source.outputPath),
      "enhance",
    );
  }
  update(id, input) {
    const task = this.task(id);
    if (!EDITABLE.has(task.state))
      throw new Error("当前任务已提交，请完成后重新导入以更改参数。");
    this.patch(task, {
      options: task.kind === "enhance" ? enhanceOptions(input) : options(input),
      error: "",
    });
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
    if (this.suspended)
      throw new Error("正在准备安装更新，请等待软件重新启动。");
    if (!this.hasKey()) throw new Error("请先在设置中填写 API Key。");
    if (!Array.isArray(ids) || !ids.length)
      throw new Error("请先添加待处理视频。");
    const jobs = ids.map((id) => this.task(id));
    for (const task of jobs) {
      if (!EDITABLE.has(task.state))
        throw new Error("所选任务已有处理记录，请使用恢复查询或重试下载。");
      if (task.kind === "enhance") {
        const config = enhanceOptions(task.options);
        const short = Math.min(task.width, task.height);
        const long = Math.max(task.width, task.height);
        const maxShort = config.version === "generative" ? 1080 : 1440;
        const maxLong = config.version === "generative" ? 1920 : 2560;
        if (
          short &&
          (short < 360 || short > maxShort || long < 360 || long > maxLong)
        )
          throw new Error(`“${task.name}”的尺寸不符合所选增强版本要求。`);
        if (
          (config.settings.bit_depth === 16 ||
            config.settings.pix_fmt === "gbrp16le") &&
          task.duration > 40
        )
          throw new Error("16 位增强的视频时长不能超过 40 秒。");
        if (task.source.type === "local")
          localSource(task.source.path, "enhance");
        continue;
      }
      const config = options(task.options);
      if (config.selection === "region" && !config.rects.length)
        throw new Error(`请先为“${task.name}”框选擦除区域。`);
      if (
        config.selection === "region" &&
        config.mode === "Subtitle" &&
        config.rects.every((rect) => rect.bottom_right_y <= 0.5)
      )
        throw new Error(
          "字幕模式仅处理画面下半部分，请调整选区或选择画面文字模式。",
        );
      if (config.timeFilter.mode !== "all") {
        if (!config.timeFilter.segments.length)
          throw new Error("请至少添加一个处理时间段。");
        if (
          task.duration > 0 &&
          config.timeFilter.segments.some(
            (segment) => segment.end > task.duration + 0.001,
          )
        )
          throw new Error(`“${task.name}”的时间段超出视频时长。`);
      }
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
        startedAt: null,
        finishedAt: null,
        completedAt: null,
        cloudCreatedAt: null,
        cloudFinishedAt: null,
        cloudOutput: null,
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
          "原请求已超出安全恢复时间，请先核对服务端任务记录，避免重复提交。",
        );
      }
      if (task.identity !== this.identity())
        throw new Error("恢复提交需要使用提交时的同一个 API Key。");
      this.patch(task, { state: "queued", error: "", finishedAt: null });
    } else if (
      task.taskId &&
      ["query_error", "download_error"].includes(task.state)
    ) {
      this.patch(task, {
        state: task.resultURL ? "download_pending" : "processing",
        error: "",
        finishedAt: null,
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
        this.patch(task, { startedAt: Date.now(), finishedAt: null });
        let videoURL = task.source.url;
        if (task.source.type === "local") {
          const current = localSource(task.source.path, task.kind);
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
        let request = {
          video_url: videoURL,
          client_token: task.token,
          model_version: config.modelVersion,
          mode: config.mode,
          output_encode_mode: config.encodeMode,
        };
        let requestRoute = null;
        if (task.kind === "enhance") {
          const enhancement = enhanceRequest(config, videoURL, task.token);
          request = enhancement.body;
          requestRoute = enhancement.route;
        }
        if (task.kind !== "enhance" && config.selection === "region")
          request.erase_ratio_location = config.rects;
        if (task.kind !== "enhance" && config.timeFilter.mode !== "all")
          request.time_segment_filter = {
            mode: config.timeFilter.mode,
            segments: config.timeFilter.segments.map((segment) => ({
              start_time: segment.start,
              end_time: segment.end,
            })),
          };
        if (
          task.kind !== "enhance" &&
          config.mode === "Subtitle" &&
          config.subtitleFilter
        )
          request.subtitle_filter = config.subtitleFilter;
        this.patch(task, {
          request,
          requestRoute,
          identity: this.identity(),
          submittedAt: Date.now(),
        });
      }
      this.patch(task, { state: "submitting", progress: null });
      const response =
        task.kind === "enhance"
          ? await this.client.submitEnhance(
              task.requestRoute,
              task.request,
              this.controller.signal,
            )
          : await this.client.submit(task.request, this.controller.signal);
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
        finishedAt: Date.now(),
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
      const timestamps = {};
      if (Number.isFinite(response.created_at) && response.created_at > 0)
        timestamps.cloudCreatedAt = response.created_at * 1000;
      if (Number.isFinite(response.finished_at) && response.finished_at > 0)
        timestamps.cloudFinishedAt = response.finished_at * 1000;
      Object.assign(task, timestamps);
      if (response.status === "failed") {
        this.patch(task, {
          state: "cloud_failed",
          finishedAt: Date.now(),
          error: safeMessage(
            response.error?.message || "处理失败，请核对服务端任务记录。",
          ),
        });
      } else if (response.status === "completed") {
        if (!response.result?.video_url)
          throw new Error("云端任务已完成，但结果缺少视频地址。");
        const rawResult = response.result.video_url;
        if (task.kind === "enhance" && /^(vod|tos):\/\/.+/.test(rawResult)) {
          this.patch(task, {
            state: "completed",
            cloudOutput: rawResult,
            completedAt: Date.now(),
            error: "",
            progress: null,
          });
          return;
        }
        const resultURL = publicURL(rawResult);
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
        this.patch(task, {
          state: "completed",
          error: "",
          progress: null,
          completedAt: task.completedAt || Date.now(),
        });
        return;
      }
      if (task.expiresAt && Date.now() / 1000 >= task.expiresAt)
        throw new Error(
          "成片下载链接已过期，请核对服务端产物记录。原任务将保留。",
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
        const base = `${stem}_${task.kind === "enhance" ? "画质增强" : "去字幕"}_${task.id.slice(0, 8)}`;
        const codec =
          task.kind === "enhance" ? task.options.settings.codec : "";
        const urlExtension = path
          .extname(new URL(task.resultURL).pathname)
          .toLowerCase();
        const extension =
          codec === "exr"
            ? [".exr", ".zip"].includes(urlExtension)
              ? urlExtension
              : ".bin"
            : ["ffv1", "prores"].includes(codec) ||
                task.options.settings?.pix_fmt ||
                task.options.settings?.bit_depth === 16
              ? ".mov"
              : ".mp4";
        let candidate = path.join(directory, `${base}${extension}`);
        let index = 1;
        while (fs.existsSync(candidate))
          candidate = path.join(directory, `${base}_${index++}${extension}`);
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
      if (
        task.kind === "enhance" &&
        task.options.settings.codec === "exr" &&
        path.extname(task.outputPath) === ".bin"
      ) {
        const handle = fs.openSync(partial, "r");
        const signature = Buffer.alloc(4);
        try {
          fs.readSync(handle, signature, 0, signature.length, 0);
        } finally {
          fs.closeSync(handle);
        }
        const ext = signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
          ? ".zip"
          : signature.equals(Buffer.from([0x76, 0x2f, 0x31, 0x01]))
            ? ".exr"
            : "";
        if (ext) {
          const base = task.outputPath.slice(0, -4);
          let candidate = `${base}${ext}`;
          let index = 1;
          while (fs.existsSync(candidate))
            candidate = `${base}_${index++}${ext}`;
          this.patch(task, { outputPath: candidate });
        }
      }
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
          finishedAt: Date.now(),
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
    if (this.stopped || this.suspended || this.busy || !this.hasKey()) return;
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
