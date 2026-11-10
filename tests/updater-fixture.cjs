"use strict";
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");

function release(version = "1.2.0") {
  return {
    version,
    files: [
      {
        url: `SubtitleEraser-Setup-${version}-x64.exe`,
        sha512: createHash("sha512")
          .update("simulated installer")
          .digest("base64"),
      },
    ],
    releaseNotes: "模拟更新说明，用于验证下载与安装入口。",
  };
}
function createUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    const info = release();
    updater.emit("update-available", info);
    return { updateInfo: info };
  };
  updater.downloadUpdate = async () => {
    updater.emit("download-progress", { percent: 50 });
    updater.emit("update-downloaded", release());
  };
  updater.quitAndInstall = () => false;
  return updater;
}
module.exports = { createUpdater, release };
