"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.eraser.updates;
  let state;
  function render(value) {
    state = value;
    $("updateVersion").textContent = `当前版本 ${value.currentVersion}`;
    const descriptions = {
      idle: "从 GitHub Releases 获取新版安装包。",
      checking: "正在检查 GitHub 更新…",
      current: "当前已是最新版本。",
      available: `发现新版本 ${value.version}`,
      downloading: `正在下载并校验更新，${Math.round(value.percent)}%`,
      downloaded: "更新已下载并校验，准备好后可重启安装。",
      installing: "正在启动安装程序…",
      error: "更新暂时不可用。",
    };
    $("updateStatus").textContent = value.error || descriptions[value.phase];
    $("checkUpdateBtn").disabled =
      !value.enabled ||
      ["checking", "downloading", "downloaded", "installing"].includes(
        value.phase,
      );
    $("updateActionBtn").hidden = !["available", "downloaded"].includes(
      value.phase,
    );
    $("updateActionBtn").textContent =
      value.phase === "downloaded" ? "重启并安装" : "下载更新";
    $("updateProgress").hidden = !["downloading", "downloaded"].includes(
      value.phase,
    );
    $("updateProgress").value = value.percent;
    $("updateNotes").hidden = !value.notes;
    $("updateNotes").textContent = value.notes;
    if (!value.enabled)
      $("updateStatus").textContent = "在线更新在正式安装版中可用。";
  }
  async function perform(action) {
    try {
      render(await action());
    } catch (error) {
      $("updateStatus").textContent = error.message;
    }
  }
  $("checkUpdateBtn").addEventListener("click", () =>
    perform(() => api.check()),
  );
  $("updateActionBtn").addEventListener("click", () =>
    perform(() =>
      state.phase === "downloaded" ? api.install() : api.download(),
    ),
  );
  $("releasesBtn").addEventListener("click", () =>
    api.releases().catch(() => {
      $("updateStatus").textContent = "无法打开浏览器，请稍后重试。";
    }),
  );
  api.onState(render);
  perform(() => api.get());
})();
