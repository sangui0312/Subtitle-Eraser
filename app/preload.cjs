"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");
async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}
contextBridge.exposeInMainWorld(
  "eraser",
  Object.freeze({
    getState: () => invoke("workspace:get"),
    pickFiles: () => invoke("files:pick"),
    dropFiles: (files) => {
      if (!Array.isArray(files) || !files.length)
        throw new Error("没有读取到视频文件，请重新拖入或使用添加视频。");
      const paths = files.map((file) => webUtils.getPathForFile(file));
      if (paths.some((file) => !file))
        throw new Error("无法读取拖入文件的本地路径，请使用添加视频。");
      return invoke("files:drop", paths);
    },
    addURL: (url) => invoke("tasks:add-url", url),
    updateOptions: (id, value) => invoke("tasks:options", id, value),
    metadata: (id, value) => invoke("tasks:metadata", id, value),
    start: (ids) => invoke("tasks:start", ids),
    retry: (id) => invoke("tasks:retry", id),
    remove: (id) => invoke("tasks:remove", id),
    unqueue: (id) => invoke("tasks:unqueue", id),
    reveal: (id) => invoke("files:reveal", id),
    chooseFolder: () => invoke("settings:folder"),
    saveSettings: (input) => invoke("settings:save", input),
    updates: Object.freeze({
      get: () => invoke("updates:get"),
      check: () => invoke("updates:check"),
      download: () => invoke("updates:download"),
      install: () => invoke("updates:install"),
      releases: () => invoke("updates:releases"),
      onState: (callback) => {
        const listener = (_event, value) => callback(value);
        ipcRenderer.on("updates:state", listener);
        return () => ipcRenderer.removeListener("updates:state", listener);
      },
    }),
    onState: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("workspace:state", listener);
      return () => ipcRenderer.removeListener("workspace:state", listener);
    },
  }),
);
