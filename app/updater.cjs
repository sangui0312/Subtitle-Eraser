"use strict";

const REPOSITORY = "https://github.com/sangui0312/Subtitle-Eraser";

function newer(version, current) {
  const valid = (value) =>
    typeof value === "string" &&
    /^\d+\.\d+\.\d+$/.test(value) &&
    value.length < 50;
  if (!valid(version) || !valid(current)) return false;
  const left = version.split(".").map(Number);
  const right = current.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function releaseNotes(notes) {
  if (typeof notes === "string") return notes.slice(0, 16000);
  if (Array.isArray(notes))
    return notes
      .map((item) => (typeof item.note === "string" ? item.note : ""))
      .join("\n")
      .slice(0, 16000);
  return "";
}

class UpdateController {
  constructor({
    native,
    version,
    enabled,
    onChange = () => {},
    prepareInstall = () => {},
    recoverInstall = () => {},
  }) {
    Object.assign(this, {
      native,
      enabled,
      onChange,
      prepareInstall,
      recoverInstall,
    });
    this.busy = false;
    this.state = {
      currentVersion: version,
      phase: "idle",
      version: "",
      notes: "",
      percent: 0,
      error: "",
      enabled,
    };
    if (!enabled) return;
    native.logger = null;
    native.requestHeaders = null;
    native.autoDownload = false;
    native.autoInstallOnAppQuit = false;
    native.allowDowngrade = false;
    native.allowPrerelease = false;
    native.disableDifferentialDownload = true;
    native.on("update-available", (info) => {
      if (this.state.phase === "checking") this.available(info);
    });
    native.on("update-not-available", () => {
      if (this.state.phase === "checking") this.set({ phase: "current" });
    });
    native.on("download-progress", (progress) => {
      if (this.state.phase !== "downloading") return;
      const percent = Number.isFinite(progress.percent)
        ? Math.max(0, Math.min(100, progress.percent))
        : 0;
      this.set({ percent });
    });
    native.on("update-downloaded", (info) => {
      if (this.state.phase !== "downloading") return;
      if (info.version !== this.state.version)
        return this.fail("下载版本不匹配，请重新检查更新。");
      this.set({ phase: "downloaded", percent: 100 });
    });
    native.on("error", () => {
      if (this.state.phase === "installing") this.restore();
      else if (["checking", "downloading"].includes(this.state.phase))
        this.fail("更新请求失败，请检查 GitHub 网络连接后重试。");
    });
  }
  getState() {
    return { ...this.state };
  }
  set(values) {
    Object.assign(this.state, values);
    this.onChange(this.getState());
  }
  fail(message) {
    this.set({ phase: "error", error: message });
  }
  assert(phases) {
    if (!this.enabled) throw new Error("请使用正式安装版检查更新。");
    if (this.busy || !phases.includes(this.state.phase))
      throw new Error("请等待当前更新操作完成。");
  }
  available(info) {
    const name = `SubtitleEraser-Setup-${info.version}-x64.exe`;
    const allowedURL = `${REPOSITORY}/releases/download/v${info.version}/${name}`;
    const validFile = info.files?.some(
      (file) =>
        (file.url === name || file.url === allowedURL) &&
        typeof file.sha512 === "string" &&
        /^[A-Za-z0-9+/]{86}==$/.test(file.sha512),
    );
    if (!newer(info.version, this.state.currentVersion) || !validFile)
      return this.fail("更新信息无效，请在 GitHub 发布页面核对版本。");
    this.set({
      phase: "available",
      version: info.version,
      notes: releaseNotes(info.releaseNotes),
      error: "",
    });
  }
  async check() {
    this.assert(["idle", "current", "available", "error"]);
    this.busy = true;
    this.set({
      phase: "checking",
      version: "",
      notes: "",
      percent: 0,
      error: "",
    });
    try {
      const response = await this.native.checkForUpdates();
      if (this.state.phase === "checking") {
        if (newer(response?.updateInfo?.version, this.state.currentVersion))
          this.available(response.updateInfo);
        else this.set({ phase: "current" });
      }
    } catch {
      this.fail("检查更新失败，请稍后重试或访问 GitHub 发布页面。");
    } finally {
      this.busy = false;
    }
    return this.getState();
  }
  async download() {
    this.assert(["available"]);
    this.busy = true;
    this.set({ phase: "downloading", percent: 0, error: "" });
    try {
      await this.native.downloadUpdate();
      if (this.state.phase === "downloading")
        this.fail("下载或校验未完成，请重新检查更新。");
    } catch {
      this.fail("下载或校验失败，请重新检查更新。");
    } finally {
      this.busy = false;
    }
    return this.getState();
  }
  restore(message = "安装未能启动，下载文件已保留，可重试安装。") {
    this.recoverInstall();
    this.set({ phase: "downloaded", error: message });
  }
  async install() {
    this.assert(["downloaded"]);
    this.busy = true;
    try {
      this.prepareInstall();
      this.set({ phase: "installing", error: "" });
      if (this.native.quitAndInstall(false, true) === false) this.restore();
    } catch (error) {
      this.restore(error.message || "安装准备失败，请稍后重试。");
    } finally {
      this.busy = false;
    }
    return this.getState();
  }
}

module.exports = { UpdateController, REPOSITORY, newer };
